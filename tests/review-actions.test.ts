import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { chipText, registerAttachment, roomAttachmentsDir } from '../src/core/attachments.js';
import type { Session } from '../src/core/session.js';
import { Store, initialState } from '../src/core/store.js';
import { expandOutgoing } from '../src/ui/attach-actions.js';
import { openUrl, scrollForLine } from '../src/ui/link-actions.js';

const spawned = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (cmd: string, args: string[]) => {
    spawned.push([cmd, ...args]);
    return { on: () => ({ unref: () => undefined }) };
  },
}));

describe('opening links', () => {
  it('only hands http(s) URLs to the system opener', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', '/Applications/Calculator.app', '-a Terminal', 'ssh://x']) openUrl(bad);
    expect(spawned).toEqual([]);
    openUrl('https://example.com/x');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.at(-1)).toBe('https://example.com/x');
  });

  it('scrolls a little above the linked line', () => {
    expect(scrollForLine(1)).toBe(0);
    expect(scrollForLine(40)).toBe(36);
  });
});

describe('sending pasted images', () => {
  function fakeSession(friends: boolean, view: 'room' | 'ws') {
    const store = new Store(initialState('test', 'ask'));
    const me = { peerId: 'me', name: 'me', shares: [], agent: true };
    store.dispatch({ type: 'peers', peers: friends ? [me, { peerId: 'bob', name: 'bob', shares: [], agent: true }] : [me] });
    if (view === 'ws') store.dispatch({ type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } } as never);
    const served: Array<[string, string, string[]]> = [];
    const session = { store, selfId: 'me', invites: { isRestricted: () => false }, serveFolder: (share: string, dir: string, to: string[]) => void served.push([share, dir, to]) } as unknown as Session;
    return { session, served };
  }
  const image = () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'klaud-img-')), `shot-${Math.random().toString(36).slice(2)}.png`);
    writeFileSync(file, 'png');
    return { a: registerAttachment(file, 3), file };
  };

  it('publishes a copy for friends only when sent to the room', () => {
    const { a, file } = image();
    const room = fakeSession(true, 'room');
    const out = expandOutgoing(room.session, `look ${chipText(a.n)}`);
    expect(out).toContain(`(klaud-attachment:me/${path.basename(file)})`);
    expect(room.served).toEqual([['klaud-attachments', roomAttachmentsDir(), ['bob']]]);
    expect(existsSync(path.join(roomAttachmentsDir(), path.basename(file)))).toBe(true);
  });

  it('keeps images private when alone, in a workspace, or in a slash command', () => {
    const { a, file } = image();
    for (const s of [fakeSession(false, 'room'), fakeSession(true, 'ws')]) {
      expect(expandOutgoing(s.session, chipText(a.n))).toContain(path.basename(file));
      expect(s.served).toEqual([]);
    }
    expect(existsSync(path.join(roomAttachmentsDir(), path.basename(file)))).toBe(false);
    const cmd = `/run ${chipText(a.n)}`;
    expect(expandOutgoing(fakeSession(true, 'room').session, cmd)).toBe(cmd);
  });
});
