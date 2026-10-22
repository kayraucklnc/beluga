import { createServer } from 'node:net';
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionLine } from '../packages/mac/src/views/room/connection-model.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { patientTimeout } from '../src/net/patient-timer.js';
import { PeerClient, type Retry } from '../src/net/peer-client.js';
import { waitFor } from './helpers.js';

const keys = deriveKeys(generateSecret());
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A loopback port nothing listens on (dials fail at once with ECONNREFUSED). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function session(port: number): { session: Session; store: Store; client: PeerClient } {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-conn-')));
  const shares = new ShareService([{ name: 'proj', root, writable: true }]);
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${port}`, keys, profile: { name: 'kayra', shares: shares.infos, agent: false } });
  const s = new Session({ client, store, shares, agentCwd: root, downloadDir: path.join(root, 'downloads') });
  cleanup.push(() => s.stop());
  return { session: s, store, client };
}

const roomLines = (store: Store) => store.getState().log.filter((l) => l.channel === 'room').map((l) => ('text' in l ? l.text : ''));

describe('connection trouble is one status, not a log line per try', () => {
  it('20 failed dials give one chat line and an updating status; reconnecting gives one more', async () => {
    const port = await freePort();
    const { session: s, store, client } = session(port);
    const tries: Retry[] = [];
    // Skip the backoff: dial again as soon as each try fails.
    client.on('retrying', (r) => {
      tries.push(r);
      if (tries.length < 20) setImmediate(() => s.retryConnection());
    });
    s.start();
    await waitFor(() => tries.length >= 20, 10_000);

    const trouble = store.getState().connection;
    expect(trouble).toMatchObject({ state: 'reconnecting', attempt: 20 });
    expect(trouble?.reason).toMatch(/ECONNREFUSED/);
    expect(trouble?.retryAt).toBeGreaterThan(Date.now());
    expect(roomLines(store)).toEqual(['Can’t reach the room yet. Retrying in the background']);
    expect(store.getState().log.some((l) => 'text' in l && /Connection error/.test(l.text))).toBe(false);

    // The room comes up: "Retry now" connects, the status clears, one "Back online".
    const hub: Hub = await startHub({ keys, port, host: '127.0.0.1', roomName: 'test' });
    cleanup.push(() => hub.close());
    s.retryConnection();
    await waitFor(() => store.getState().status === 'connected' && !store.getState().connection, 5_000);
    expect(roomLines(store)).toEqual(['Can’t reach the room yet. Retrying in the background', 'Back online']);
  }, 20_000);

  it('a later outage says "Lost connection" once', async () => {
    const port = await freePort();
    const hub = await startHub({ keys, port, host: '127.0.0.1', roomName: 'test' });
    const { session: s, store, client } = session(port);
    s.start();
    await waitFor(() => store.getState().status === 'connected', 5_000);
    const tries: Retry[] = [];
    client.on('retrying', (r) => {
      tries.push(r);
      if (tries.length < 5) setImmediate(() => s.retryConnection());
    });
    await hub.close();
    await waitFor(() => tries.length >= 5, 10_000);
    expect(roomLines(store).filter((t) => /connection|reach/i.test(t))).toEqual(['Lost connection to the room. Retrying in the background']);
  }, 20_000);
});

describe('patientTimeout', () => {
  it('counts a stalled tick as one step, so a reply waiting behind the stall is read first', () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    patientTimeout(3000, fired, 1000);
    vi.advanceTimersByTime(1000);
    // The loop was blocked for 20 s: the clock jumped, but only one step counts.
    vi.setSystemTime(Date.now() + 20_000);
    vi.advanceTimersByTime(1000);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fired).toHaveBeenCalledOnce();
  });

  it('can be cancelled', () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    patientTimeout(2000, fired, 1000)();
    vi.advanceTimersByTime(5000);
    expect(fired).not.toHaveBeenCalled();
  });
});

describe('connectionLine', () => {
  const base = { attempt: 3, reason: 'Opening handshake has timed out', since: 0 };
  it('counts down to the next try', () => {
    expect(connectionLine({ ...base, state: 'reconnecting', retryAt: 12_000 }, 400)).toEqual({ lead: 'Can’t reach the room', detail: 'retrying in 12s', canRetry: true });
    expect(connectionLine({ ...base, state: 'reconnecting', retryAt: 12_000 }, 12_500)).toMatchObject({ detail: 'retrying now…', canRetry: false });
  });
  it('says why when offline for good', () => {
    expect(connectionLine({ ...base, state: 'offline', reason: 'You were removed' }, 0)).toEqual({ lead: 'Offline', detail: 'You were removed', canRetry: false });
  });
});
