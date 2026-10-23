import { mkdtempSync, realpathSync } from 'node:fs';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { People } from '../src/core/people.js';
import { ReplayGuard } from '../src/core/replay.js';
import { Session } from '../src/core/session.js';
import { loadSettings, saveSettings } from '../src/core/settings.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { type Identity, type RoomKeys, deriveKeys, generateIdentity, generateSecret } from '../src/net/crypto.js';
import { ALREADY_HERE, type Hub, startHub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import type { PeerInfo } from '../src/protocol.js';
import { waitFor } from './helpers.js';

/**
 * One person in several rooms at once (BLG-3): each room is its own Beluga (its own core and
 * room client), all signing as the same identity and sharing one ~/.beluga.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-rooms-')));

interface Room {
  readonly hub: Hub;
  readonly keys: RoomKeys;
}

async function room(name: string, opts: { twinProbeMs?: number } = {}): Promise<Room> {
  const keys = deriveKeys(generateSecret());
  const hub = await startHub({ keys, host: '127.0.0.1', roomName: name, ...opts });
  cleanup.push(() => hub.close());
  return { hub, keys };
}

interface Seat {
  readonly session: Session;
  readonly store: Store;
  readonly client: PeerClient;
  /** Directed messages this seat got, as `from: text`. */
  readonly got: string[];
  peers(): string[];
}

/** Someone's Beluga in `r`, signing as `identity`. */
function seat(r: Room, name: string, identity: Identity, opts: { reconnect?: boolean } = {}): Seat {
  const root = tmp();
  const shares = new ShareService([{ name: 'proj', root, writable: true }]);
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${r.hub.port}`, keys: r.keys, profile: { name, shares: shares.infos, agent: false }, identity, ...opts });
  const session = new Session({ client, store, shares, agentCwd: root, downloadDir: path.join(root, 'downloads') });
  const got: string[] = [];
  client.on('message', (m) => {
    if (m.body.kind === 'chat') got.push(`${m.from}: ${m.body.text}`);
  });
  session.start();
  cleanup.push(() => session.stop());
  const peers = () =>
    store
      .getState()
      .peers.map((p: PeerInfo) => p.name)
      .sort();
  return { session, store, client, got, peers };
}

const connected = (s: Seat) => s.store.getState().status === 'connected' && Boolean(s.store.getState().self);

describe('one person in two rooms at once', () => {
  it('is in both, with each room’s own people, and leaving one room leaves the other alone', async () => {
    const a = await room('a');
    const b = await room('b');
    const kay = generateIdentity();
    const bob = generateIdentity();
    const kayA = seat(a, 'kay', kay);
    const kayB = seat(b, 'kay', kay);
    const bobA = seat(a, 'bob', bob);
    const bobB = seat(b, 'bob', bob);
    const mia = seat(b, 'mia', generateIdentity());
    await waitFor(() => [kayA, kayB, bobA, bobB, mia].every(connected), 5_000);
    await waitFor(() => kayA.peers().length === 2 && kayB.peers().length === 3, 5_000);

    // Same person, same id, in both rooms: neither join turned the other away.
    expect(kayA.client.peerId).toBe(kayB.client.peerId);
    expect(kayA.peers()).toEqual(['bob', 'kay']);
    expect(kayB.peers()).toEqual(['bob', 'kay', 'mia']);
    expect(kayA.store.getState().connection).toBeUndefined();
    expect(kayB.store.getState().connection).toBeUndefined();

    // Bob leaves room a: he's gone there, still in b.
    await bobA.session.stop();
    await waitFor(() => kayA.peers().length === 1, 5_000);
    expect(kayA.peers()).toEqual(['kay']);
    expect(kayB.peers()).toEqual(['bob', 'kay', 'mia']);
  }, 20_000);

  it('a message to someone goes to them in the room it was sent in, not the other', async () => {
    const a = await room('a');
    const b = await room('b');
    const kay = generateIdentity();
    const bob = generateIdentity();
    const kayA = seat(a, 'kay', kay);
    const kayB = seat(b, 'kay', kay);
    const bobA = seat(a, 'bob', bob);
    const bobB = seat(b, 'bob', bob);
    await waitFor(() => [kayA, kayB, bobA, bobB].every(connected) && kayA.peers().length === 2 && kayB.peers().length === 2, 5_000);

    kayB.client.send({ kind: 'chat', text: 'only in b' }, { to: bobB.client.peerId });
    kayA.client.send({ kind: 'chat', text: 'only in a' }, { to: bobA.client.peerId });
    await waitFor(() => bobA.got.length === 1 && bobB.got.length === 1, 5_000);
    expect(bobA.got).toEqual([`${kayA.client.peerId}: only in a`]);
    expect(bobB.got).toEqual([`${kayB.client.peerId}: only in b`]);
    // And Bob answering in a reaches Kay's Beluga in a only.
    bobA.client.send({ kind: 'chat', text: 'back in a' }, { to: kay.peerId });
    await waitFor(() => kayA.got.length === 1, 5_000);
    expect(kayB.got).toEqual([]);
  }, 20_000);
});

describe('the same person joining the same room twice', () => {
  it('keeps the seat with whoever has it, and the second one hears why', async () => {
    const a = await room('a');
    const kay = generateIdentity();
    const first = seat(a, 'kay', kay);
    await waitFor(() => connected(first), 5_000);
    const twin = seat(a, 'kay', kay);
    await waitFor(() => twin.store.getState().connection?.reason === ALREADY_HERE, 5_000);
    // The first one answers the hub's ping: it keeps the seat, and the room lists Kay once.
    await new Promise((r) => setTimeout(r, 400));
    expect(connected(first)).toBe(true);
    expect(first.peers()).toEqual(['kay']);
    expect(twin.store.getState().status).not.toBe('connected');
  }, 20_000);

  it('a seat left over from before (asleep, network changed) is dropped at once, so its owner gets back in', async () => {
    const a = await room('a', { twinProbeMs: 200 });
    const kay = generateIdentity();
    const mia = seat(a, 'mia', generateIdentity());
    const stale = seat(a, 'kay', kay, { reconnect: false });
    await waitFor(() => connected(mia) && connected(stale) && mia.peers().length === 2, 5_000);
    // The old connection stops answering, as a Mac that went to sleep does.
    (stale.client as unknown as { socket: { ws: { _socket: Socket } } }).socket.ws._socket.pause();
    const back = seat(a, 'kay', kay);
    back.client.on('retrying', () => setTimeout(() => back.session.retryConnection(), 50));
    await waitFor(() => connected(back), 5_000);
    // Well before the 25 s heartbeat would have noticed.
    await waitFor(() => mia.peers().length === 2, 5_000);
    expect(mia.peers()).toEqual(['kay', 'mia']);
  }, 20_000);
});

describe('what two rooms on one Mac share', () => {
  it('trust chosen in one room is kept when the other room saves its own choice', () => {
    const file = path.join(tmp(), 'settings.json');
    const people = (store: Store) =>
      new People({
        store,
        selfId: () => 'kay-id-0000',
        saved: loadSettings(file).people,
        save: (p) => void saveSettings({ people: p }, file),
        load: () => loadSettings(file).people,
        toast: () => undefined,
      });
    // Both start with nothing saved; each room has someone the other doesn't.
    const inA = people(new Store(initialState('a', 'ask')));
    const storeB = new Store(initialState('b', 'ask'));
    const inB = people(storeB);
    inA.setTrust('bob-id-0000', 'trusted', true);
    inB.setTrust('mia-id-0000', 'full', true);
    expect(loadSettings(file).people).toMatchObject({ 'bob-id-0000': { trust: 'trusted' }, 'mia-id-0000': { trust: 'full' } });
    // Room b's list shows the choice made in room a too.
    expect(storeB.getState().remembered).toMatchObject({ 'bob-id-0000': { trust: 'trusted' } });
    inB.forget('bob-id-0000');
    expect(Object.keys(loadSettings(file).people)).toEqual(['mia-id-0000']);
  });

  it('a request seen in one room can’t be replayed in the other after a restart', () => {
    const file = path.join(tmp(), 'seen.json');
    const now = Date.now();
    const inA = new ReplayGuard(file);
    const inB = new ReplayGuard(file);
    expect(inA.admit('req-a', now)).toBe(true);
    expect(inB.admit('req-b', now)).toBe(true);
    inA.flush();
    inB.flush();
    const later = new ReplayGuard(file);
    expect(later.admit('req-a', now)).toBe(false);
    expect(later.admit('req-b', now)).toBe(false);
  });
});
