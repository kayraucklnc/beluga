import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProjectIcons } from '../src/companion/icons.js';
import { macViewFor } from '../src/companion/open-on-mac.js';
import { COMPANION_API } from '../src/ipc/companion-api.js';
import { COMPANION_HANDLERS } from '../src/ipc/companion-handlers.js';
import { type DomainState, Store, initialState } from '../src/core/store.js';
import type { Intent } from '../src/core/intents.js';
import type { Session } from '../src/core/session.js';

/** Open on your Mac (BLG-40) and projects' icons for the phone (BLG-45). */

function state(): DomainState {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'landing', root: '/x/landing', base: 'main', workspaces: [{ id: 'w1', projectRoot: '/x/landing', projectId: 'p1', name: 'auth', path: '/x/landing/.w/w1', kind: 'worktree', createdAt: 1, external: false }] }] as never });
  return store.getState();
}

describe('Open on your Mac', () => {
  const st = state();

  it('maps what the phone has open to the Mac window’s view', () => {
    expect(macViewFor(st, { topic: 'conv:ws:w1' })).toEqual({ kind: 'workspace', id: 'w1', tab: 'chat' });
    expect(macViewFor(st, { topic: 'conv:room' })).toEqual({ kind: 'room' });
    expect(macViewFor(st, { topic: 'conv:task:t_1' })).toEqual({ kind: 'requests' });
    expect(macViewFor(st, { topic: 'chat:dm:abc' })).toEqual({ kind: 'conversation', id: 'dm:abc' });
    expect(macViewFor(st, { topic: 'tasks' })).toEqual({ kind: 'tasks' });
    expect(macViewFor(st, { need: 'request:t_9' })).toEqual({ kind: 'requests' });
    expect(macViewFor(st, { need: 'join:g1:p2' })).toEqual({ kind: 'conversation', id: 'group:g1' });
    // Gone: nothing to show.
    expect(macViewFor(st, { topic: 'conv:ws:gone' })).toBeUndefined();
    expect(macViewFor(st, { topic: 'plan:gone' })).toBeUndefined();
    expect(macViewFor(st, { topic: 'task:gone' })).toBeUndefined();
  });

  it('tells every screen where to go and raises the window, or says why not', async () => {
    const shown: Intent[] = [];
    const session = (raised: boolean) =>
      ({
        store: { getState: () => st },
        workspaces: { ensureLoaded: vi.fn() },
        showOnScreens: async (intent: Intent) => {
          shown.push(intent);
          return raised;
        },
      }) as unknown as Session;
    const target = COMPANION_API['companion.openOnMac'].args.parse([{ topic: 'conv:ws:w1' }])[0];
    expect(await COMPANION_HANDLERS['companion.openOnMac'](session(true), target)).toEqual({ opened: true });
    expect(shown).toEqual([{ type: 'navigate', view: { kind: 'workspace', id: 'w1', tab: 'chat' } }]);
    expect(await COMPANION_HANDLERS['companion.openOnMac'](session(false), target)).toEqual({ opened: false, why: 'Beluga isn’t open on your Mac' });
    expect(await COMPANION_HANDLERS['companion.openOnMac'](session(true), { topic: 'plan:gone' })).toMatchObject({ opened: false });
    expect(COMPANION_API['companion.openOnMac'].args.safeParse([{}]).success).toBe(false);
    expect(COMPANION_API['companion.openOnMac'].args.safeParse([{ topic: 'conv:ws:w1', path: '/etc' }]).success).toBe(false);
  });
});

describe('projects’ icons', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-icons-'));
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  it('are made small once, in the background, and handed out by checksum', async () => {
    const changed = vi.fn();
    const shrink = vi.fn(async (_src: string, dest: string, px: number) => {
      expect(px).toBe(128);
      writeFileSync(dest, Buffer.concat([png, Buffer.from('small')]));
    });
    const icons = new ProjectIcons({ dir, root: (id) => (id === 'p1' ? '/x/landing' : undefined), changed, read: () => ({ mime: 'image/png', data: Buffer.concat([png, Buffer.from('big')]).toString('base64') }), shrink });
    // Not made yet: no icon in the view, and it's being made.
    expect(icons.sumFor('p1')).toBeUndefined();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    const sum = icons.sumFor('p1')!;
    expect(sum).toMatch(/^[0-9a-f]{32}$/);
    expect(icons.get(sum)).toEqual({ sum, mime: 'image/png', b64: Buffer.concat([png, Buffer.from('small')]).toString('base64') });
    // Asked again: the same, nothing made twice.
    expect(icons.sumFor('p1')).toBe(sum);
    expect(shrink).toHaveBeenCalledTimes(1);
    expect(icons.sumFor('nope')).toBeUndefined();
    expect(icons.get('0'.repeat(32))).toBeUndefined();
  });

  it('send a small SVG as it is, and none for a project without one', async () => {
    const changed = vi.fn();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const icons = new ProjectIcons({ dir, root: (id) => `/x/${id}`, changed, read: (root) => (root.endsWith('a') ? { mime: 'image/svg+xml', data: Buffer.from(svg).toString('base64') } : undefined) });
    icons.sumFor('a');
    icons.sumFor('b');
    await vi.waitFor(() => expect(icons.sumFor('a')).toBeDefined());
    expect(icons.get(icons.sumFor('a')!)?.mime).toBe('image/svg+xml');
    expect(icons.sumFor('b')).toBeUndefined();
  });
});
