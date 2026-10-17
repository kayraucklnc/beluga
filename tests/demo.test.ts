import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockBackend } from '../src/agent/mock.js';
import type { RoomBridge } from '../src/agent/types.js';
import { createDemoFolders, startDemoFriend } from '../src/demo.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { waitFor } from './helpers.js';

const reports: string[] = [];
const bridge = { writeReport: async (title: string) => void reports.push(title) } as unknown as RoomBridge;
const run = (prompt: string) => {
  const events: string[] = [];
  const result = createMockBackend(bridge, 0).run({
    prompt,
    requesterName: 'kay',
    viaAgent: false,
    context: [],
    scope: 'folder',
    signal: new AbortController().signal,
    onEvent: (_k, t) => events.push(t),
    onFileTouched: () => undefined,
    canUseTool: async () => true,
  });
  return { result, events };
};

describe('mock Claude', () => {
  it('answers by topic with visible steps', async () => {
    const auth = run('what is the auth plan?');
    expect(await auth.result).toContain('Plan');
    expect(auth.events).toContain('Read NOTES.md');
    expect(await run('write a summary report').result).toContain('Project overview');
    expect(reports).toEqual(['Project overview']);
    expect(await run('run the tests').result).toContain('24 tests');
    expect(await run('hello?').result).toContain('TypeScript API');
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const p = createMockBackend(bridge, 1).run({
      prompt: 'x',
      requesterName: 'kay',
      viaAgent: false,
      context: [],
      scope: 'folder',
      signal: controller.signal,
      onEvent: () => undefined,
      onFileTouched: () => undefined,
      canUseTool: async () => true,
    });
    controller.abort();
    await expect(p).rejects.toThrow('aborted');
  });
});

describe('demo', () => {
  let hub: Hub;
  const sessions: Session[] = [];
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.stop();
    await hub?.close();
  });

  it('creates sample folders', () => {
    const { mine, bob } = createDemoFolders();
    expect(existsSync(path.join(mine, 'README.md'))).toBe(true);
    expect(readFileSync(path.join(bob, 'NOTES.md'), 'utf8')).toContain('TODO: add auth');
  });

  it('adds a pretend friend who chats back and lends their Claude', async () => {
    const keys = deriveKeys(generateSecret());
    hub = await startHub({ keys });
    const url = `ws://127.0.0.1:${hub.port}`;
    const { bob: folder } = createDemoFolders();
    const store = new Store(initialState('room'));
    const me = new Session({ client: new PeerClient({ url, keys, profile: { name: 'kay', shares: [], agent: false } }), store, shares: new ShareService([]), agentCwd: '/tmp' });
    me.start();
    sessions.push(me, startDemoFriend(url, keys, folder));
    await waitFor(() => store.getState().log.some((l) => l.type === 'chat' && l.text === 'hey! just pushed my API notes'), 5000);
    expect(store.getState().peers.find((p) => p.name === 'bob')?.usage?.fiveHour?.pct).toBe(64);
    me.submit('@claude:bob thoughts on auth?');
    await waitFor(() => store.getState().log.some((l) => l.type === 'agent' && l.status === 'done'), 8000);
  }, 15000);
});
