import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from './helpers.js';

// Counts the frames the daemon encodes for its screens (and still encodes them).
const encoded = vi.hoisted(() => ({ frames: [] as unknown[] }));
vi.mock('../src/ipc/protocol.js', async (load) => {
  const real = await load<typeof import('../src/ipc/protocol.js')>();
  return { ...real, encodeFrame: (frame: Parameters<typeof real.encodeFrame>[0]) => (encoded.frames.push(frame), real.encodeFrame(frame)) };
});

const { DaemonServer } = await import('../src/daemon/server.js');
const { SocketClient } = await import('../src/ipc/socket-client.js');
const { Store, initialState } = await import('../src/core/store.js');

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

describe('frames to every screen (BLG-407)', () => {
  it('are encoded once, not once per screen, and every screen gets the same', async () => {
    const store = new Store(initialState('room'));
    const token = 'a'.repeat(32);
    const session = { store, intents: { subscribe: () => () => undefined }, attend: () => undefined, detach: () => undefined };
    const daemon = new DaemonServer({ session: session as never, token, version: '1.0.0' });
    const port = await daemon.listen();
    cleanup.push(() => daemon.close());
    const screens = await Promise.all([1, 2, 3].map(() => SocketClient.connect({ url: `ws://127.0.0.1:${port}`, token, kind: 'test', version: '1.0.0' })));
    for (const s of screens) cleanup.push(() => s.close());
    await waitFor(() => screens.every((s) => s.clients === 3));

    const before = encoded.frames.length;
    store.dispatch({ type: 'system', text: 'hello all', id: 'm1', ts: 1 });
    await waitFor(() => screens.every((s) => s.store.getState().log.some((l) => l.id === 'm1')));
    const actions = encoded.frames.slice(before).filter((f) => (f as { t: string }).t === 'action');
    expect(actions).toHaveLength(1);

    // A second, separate frame is encoded again (nothing is kept past its own send).
    store.dispatch({ type: 'system', text: 'and again', id: 'm2', ts: 2 });
    await waitFor(() => screens.every((s) => s.store.getState().log.some((l) => l.id === 'm2' && l.type === 'system' && l.text === 'and again')));
    expect(encoded.frames.slice(before).filter((f) => (f as { t: string }).t === 'action')).toHaveLength(2);
  });
});
