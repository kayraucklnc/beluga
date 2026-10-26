import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { generateIdentity } from '../../src/net/crypto.js';
import { initialNetwork, reduceNetwork } from '../../src/core/network-store.js';
import { type NetworkService, attachNetwork, startNetwork } from '../../src/core/network.js';
import { receiveFriendOffer } from '../../src/core/friend-offers.js';
import { Store, initialState } from '../../src/core/store.js';
import type { Session } from '../../src/core/session.js';
import type { NoticeEvent } from '../../src/core/notify.js';
import { HANDLERS } from '../../src/ipc/handlers.js';
import { parseArgs } from '../../src/ipc/api.js';
import { Body, type BodyInput, type PeerInfo } from '../../src/protocol.js';
import { needsYou } from '../../src/companion/views.js';
import { FAST, settle } from './helpers.js';

/** Friend requests between people in one room (BLG-202): the room carries the invitation, the network pairs. */

let testnet: Testnet;
const services: NetworkService[] = [];
beforeAll(async () => {
  testnet = await createTestnet(3, { host: '127.0.0.1' });
}, 30_000);
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
});
afterAll(async () => {
  await testnet?.destroy();
});

interface Person {
  readonly name: string;
  readonly store: Store;
  readonly service: NetworkService;
  readonly session: Session;
  readonly peerId: string;
  readonly notices: NoticeEvent[];
  /** What this person's session sent over the room, and to whom. */
  readonly sent: Array<{ body: BodyInput; to?: string }>;
}

/** A daemon's worth of network and a room session that sends directed messages to the others in `room`. */
async function person(name: string, room: Person[]): Promise<Person> {
  const store = new Store(initialState('room'));
  const identity = generateIdentity();
  const dir = mkdtempSync(path.join(os.tmpdir(), `beluga-offer-${name}-`));
  const service = await startNetwork({ store, identity, name, dir, bootstrap: testnet.bootstrap, host: '127.0.0.1', timing: FAST });
  services.push(service);
  const notices: NoticeEvent[] = [];
  const sent: Person['sent'] = [];
  const session = {
    store,
    notify: (e: NoticeEvent) => notices.push(e),
    send: (body: BodyInput, o: { to?: string }) => {
      sent.push({ body, ...(o.to ? { to: o.to } : {}) });
      const to = room.find((p) => p.peerId === o.to);
      if (!to) return false;
      const parsed = Body.parse(body);
      if (parsed.kind === 'friend_offer') receiveFriendOffer(to.session as unknown as Parameters<typeof receiveFriendOffer>[0], me.peerId, parsed);
      return true;
    },
  } as unknown as Session;
  attachNetwork(session, service);
  const me: Person = { name, store, service, session, peerId: service.mesh.peerId, notices, sent };
  store.dispatch({ type: 'welcome', self: { peerId: me.peerId, name, agent: false, shares: [] } as PeerInfo });
  room.push(me);
  return me;
}

/** Everyone in the room sees everyone (as a room's `peers` frame says). */
function seat(room: readonly Person[], guests: readonly string[] = []): void {
  const peers = room.map((p) => ({ peerId: p.peerId, name: p.name, agent: false, shares: [], ...(guests.includes(p.peerId) ? { guest: true } : {}) })) as PeerInfo[];
  for (const p of room) p.store.dispatch({ type: 'peers', peers });
}

const call = async (session: Session, method: keyof typeof HANDLERS, ...args: unknown[]): Promise<unknown> => {
  const parsed = parseArgs(method, args) as unknown[];
  return (HANDLERS[method] as (s: Session, ...a: unknown[]) => unknown)(session, ...parsed);
};

describe('friends from your room', () => {
  it('sends a one-time invitation over the room; Accept pairs the two Macs as friends', async () => {
    const room: Person[] = [];
    const kay = await person('kay', room);
    const ata = await person('ata', room);
    seat(room);

    expect(await call(kay.session, 'network.friends.addFromRoom', ata.peerId)).toEqual({ name: 'ata' });
    expect(kay.sent).toHaveLength(1);
    expect(kay.sent[0]).toMatchObject({ to: ata.peerId, body: { kind: 'friend_offer' } });
    // The invitation is only for ata, and isn't one kay hands out from Add a Friend.
    await settle(() => kay.store.getState().network.invitations.some((i) => i.for === ata.peerId));
    expect(kay.store.getState().network.offers).toEqual([expect.objectContaining({ peerId: ata.peerId, dir: 'out', name: 'ata' })]);

    // ata sees it (and is told), with Accept and Not now on the phone too; the link never reaches the shared state.
    expect(ata.store.getState().network.offers).toEqual([expect.objectContaining({ peerId: kay.peerId, dir: 'in', name: 'kay' })]);
    expect(JSON.stringify(ata.store.getState())).not.toContain((kay.sent[0]!.body as { link: string }).link);
    expect(ata.notices).toEqual([expect.objectContaining({ kind: 'needsYou', title: 'kay wants to add you as a friend' })]);
    const item = needsYou(ata.store.getState()).find((n) => n.id === `friend:${kay.peerId}`)!;
    expect(item.actions.map((a) => [a.label, a.method, a.args])).toEqual([
      ['Accept', 'network.friends.answerOffer', [kay.peerId, true]],
      ['Not now', 'network.friends.answerOffer', [kay.peerId, false]],
    ]);

    expect(await call(ata.session, 'network.friends.answerOffer', kay.peerId, true)).toMatchObject({ kind: 'friend', peerId: kay.peerId, name: 'kay' });
    await settle(() => kay.store.getState().network.friends.some((f) => f.peerId === ata.peerId) && ata.store.getState().network.friends.some((f) => f.peerId === kay.peerId));
    // Both sides' requests are over once they're friends.
    await settle(() => !kay.store.getState().network.offers && !ata.store.getState().network.offers);
    expect(needsYou(ata.store.getState()).some((n) => n.id.startsWith('friend:'))).toBe(false);
    await expect(call(kay.session, 'network.friends.addFromRoom', ata.peerId)).rejects.toThrow(/already your friend/);
  }, 60_000);

  it('Not now drops it; guests, yourself and people who left are refused', async () => {
    const room: Person[] = [];
    const kay = await person('kay', room);
    const bea = await person('bea', room);
    const gus = await person('gus', room);
    seat(room, [gus.peerId]);

    await call(kay.session, 'network.friends.addFromRoom', bea.peerId);
    expect(bea.store.getState().network.offers).toHaveLength(1);
    await call(bea.session, 'network.friends.answerOffer', kay.peerId, false);
    expect(bea.store.getState().network.offers).toBeUndefined();
    await expect(call(bea.session, 'network.friends.answerOffer', kay.peerId, true)).rejects.toThrow(/gone/);

    await expect(call(kay.session, 'network.friends.addFromRoom', gus.peerId)).rejects.toThrow(/project link/);
    await expect(call(kay.session, 'network.friends.addFromRoom', kay.peerId)).rejects.toThrow(/That’s you/);
    await expect(call(kay.session, 'network.friends.addFromRoom', 'z'.repeat(32))).rejects.toThrow(/aren’t in this room/);
  }, 60_000);

  it('only the person it was for can use it, and Accept checks who is on the other end', async () => {
    const room: Person[] = [];
    const kay = await person('kay', room);
    const ata = await person('ata', room);
    const eve = await person('eve', room);
    seat(room);

    await call(kay.session, 'network.friends.addFromRoom', ata.peerId);
    const link = (kay.sent[0]!.body as { link: string }).link;
    // eve got hold of the link (the room's host relays directed messages): kay's Mac refuses her.
    await expect(eve.service.mesh.accept(link)).rejects.toThrow(/for someone else/);
    expect(kay.store.getState().network.friends).toEqual([]);

    // A request said to be from kay but carrying eve's invitation isn't taken as kay's.
    const evesInvite = await eve.service.mesh.createInvite({ for: ata.peerId });
    await expect(ata.service.mesh.accept(evesInvite.link, { from: kay.peerId })).rejects.toThrow(/came from someone else/);
    // ata can still use kay's own one.
    await call(ata.session, 'network.friends.answerOffer', kay.peerId, true);
    await settle(() => kay.store.getState().network.friends.some((f) => f.peerId === ata.peerId));
  }, 60_000);
});

describe('friend requests in the shared state', () => {
  const offer = (peerId: string, dir: 'in' | 'out') => ({ peerId, name: peerId.slice(0, 3), dir, at: 1, expiresAt: Date.now() + 60_000 });
  it('keeps one per person and direction, survives the network going off, and ends with friendship', () => {
    let s = reduceNetwork(initialNetwork, { type: 'net_offer', offer: offer('a'.repeat(32), 'in') });
    s = reduceNetwork(s, { type: 'net_offer', offer: { ...offer('a'.repeat(32), 'in'), at: 2 } });
    s = reduceNetwork(s, { type: 'net_offer', offer: offer('b'.repeat(32), 'out') });
    expect(s.network.offers?.map((o) => [o.peerId[0], o.dir, o.at])).toEqual([
      ['a', 'in', 2],
      ['b', 'out', 1],
    ]);
    s = reduceNetwork(s, { type: 'net_off' });
    expect(s.network.offers).toHaveLength(2);
    s = reduceNetwork(s, { type: 'net_summary', summary: { enabled: true, friends: [{ peerId: 'b'.repeat(32), name: 'b', online: true, presence: { state: 'online' }, addedAt: 0, unread: 0 }], groups: [], invitations: [], pendingJoins: [] } });
    expect(s.network.offers?.map((o) => o.peerId[0])).toEqual(['a']);
    s = reduceNetwork(s, { type: 'net_offer_gone', peerId: 'a'.repeat(32), dir: 'in' });
    expect(s.network.offers).toBeUndefined();
  });
});
