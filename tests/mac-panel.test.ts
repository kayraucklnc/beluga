import { describe, expect, it } from 'vitest';
import type { View } from '../src/core/store.js';
import {
  DRAWER_MAX,
  PANEL_MIN,
  REMEMBERED_TABS,
  clampPanelWidth,
  clampShare,
  drawerFits,
  migratePrefs,
  panelDigit,
  panelKey,
  panelTabsFor,
  pickPanelTab,
  rememberTab,
} from '../packages/mac/src/lib/panel-model.js';
import { ancestorsOf, filterLoads, treeRows, type Entry } from '../packages/mac/src/layout/panel/tree.js';

const ws: View = { kind: 'workspace', id: 'w1', tab: 'chat' };
const room: View = { kind: 'room' };

describe('the right panel’s tabs', () => {
  it('a workspace has every tab; a chat has no Changes; a friend’s workspace and the Terminal view only Info', () => {
    expect(panelTabsFor(ws, 'worktree')).toEqual(['changes', 'files', 'terminal', 'info', 'history', 'scratch', 'background']);
    expect(panelTabsFor({ kind: 'project', id: 'p' })).toEqual(['terminal', 'info', 'history']);
    expect(panelTabsFor(ws, 'chat')).toEqual(['files', 'terminal', 'info', 'scratch', 'background']);
    expect(panelTabsFor({ kind: 'shared', owner: 'o', id: 'x', tab: 'chat' })).toEqual(['info']);
    expect(panelTabsFor({ kind: 'terminal' })).toEqual(['info']);
    expect(panelTabsFor(room)).toEqual(['terminal', 'info']);
  });

  it('opens on the tab you last picked there, else Changes when there are changes, else Info', () => {
    const tabs = panelTabsFor(ws, 'worktree');
    expect(pickPanelTab(tabs, 'files', true)).toBe('files');
    expect(pickPanelTab(tabs, undefined, true)).toBe('changes');
    expect(pickPanelTab(tabs, undefined, false)).toBe('info');
    // A remembered tab the view doesn't have is ignored.
    expect(pickPanelTab(['terminal', 'info'], 'changes', true)).toBe('info');
  });

  it('remembers per workspace, one for the rest, and forgets the oldest', () => {
    expect(panelKey(ws)).toBe('ws:w1');
    expect(panelKey(room)).toBe('app');
    let map = {};
    for (let i = 0; i < REMEMBERED_TABS + 5; i++) map = rememberTab(map, `ws:${i}`, 'files');
    expect(Object.keys(map)).toHaveLength(REMEMBERED_TABS);
    expect(map).not.toHaveProperty('ws:0');
    expect(Object.keys(rememberTab(map, 'ws:3', 'info')).pop()).toBe('ws:3');
  });

  it('has fixed ⌥⌘ digits', () => {
    expect(['changes', 'files', 'terminal', 'info', 'history', 'scratch', 'background'].map((t) => panelDigit(t as 'changes'))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('is never narrower than the minimum nor wider than 60% of the window', () => {
    expect(clampPanelWidth(100, 1440)).toBe(PANEL_MIN);
    expect(clampPanelWidth(2000, 1440)).toBe(864);
    expect(clampPanelWidth(400, 1440)).toBe(400);
    // A tiny window still gets the minimum.
    expect(clampPanelWidth(400, 400)).toBe(PANEL_MIN);
    expect(clampShare(Number.NaN, 0.2, 0.7)).toBe(0.2);
  });

  it('the drawer goes under anything but the Terminal view and a friend’s workspace', () => {
    expect(drawerFits(ws)).toBe(true);
    expect(drawerFits(room)).toBe(true);
    expect(drawerFits({ kind: 'terminal' })).toBe(false);
    expect(drawerFits({ kind: 'shared', owner: 'o', id: 'x', tab: 'chat' })).toBe(false);
  });
});

describe('preferences from earlier versions', () => {
  it('a terminal docked beside the chat becomes the panel’s Terminal tab', () => {
    expect(migratePrefs({ dock: 'right', dockSize: 0.5, sidebar: true })).toEqual({ termIn: 'panel', drawerSize: 0.5, sidebar: true });
  });

  it('one docked under the chat becomes the open drawer at the same height', () => {
    expect(migratePrefs({ dock: 'bottom', dockSize: 0.9 })).toEqual({ termIn: 'drawer', drawer: true, drawerSize: DRAWER_MAX });
  });

  it('a closed dock keeps the defaults, and new preferences are left alone', () => {
    expect(migratePrefs({ dock: 'off', dockSize: 0.42 })).toEqual({ drawerSize: 0.42 });
    const current = { termIn: 'drawer', drawer: false };
    expect(migratePrefs(current)).toBe(current);
  });
});

describe('the Files tab’s tree', () => {
  const fs: Record<string, Entry[]> = {
    '': [
      { name: 'src', dir: true },
      { name: 'node_modules', dir: true },
      { name: 'README.md', dir: false, size: 10 },
    ],
    src: [
      { name: 'lib', dir: true },
      { name: 'server.ts', dir: false, size: 5 },
    ],
    'src/lib': [{ name: 'auth.ts', dir: false }],
    node_modules: [{ name: 'server-thing', dir: true }],
  };
  const entriesOf = (p: string): Entry[] | undefined => fs[p];

  it('shows opened folders under their parent, with a loading row for one on its way', () => {
    const rows = treeRows((p) => (p === 'src/lib' ? undefined : fs[p]), new Set(['src', 'src/lib']), '');
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.kind === 'loading' ? '…' : r.name}`)).toEqual(['src', '  lib', '    …', '  server.ts', 'node_modules', 'README.md']);
    expect(rows[0]).toMatchObject({ dir: true, open: true });
  });

  it('filters by name, keeping the folders above a match (and never looking into node_modules)', () => {
    const rows = treeRows(entriesOf, new Set(), 'auth');
    expect(rows.map((r) => r.path)).toEqual(['src', 'src/lib', 'src/lib/auth.ts']);
    expect(treeRows(entriesOf, new Set(), 'server').map((r) => r.path)).toEqual(['src', 'src/server.ts']);
    // A folder whose own name matches shows closed.
    expect(treeRows(entriesOf, new Set(), 'lib').map((r) => [r.path, r.open])).toEqual([
      ['src', true],
      ['src/lib', false],
    ]);
    // …and opening it shows everything in it.
    expect(treeRows(entriesOf, new Set(['src/lib']), 'lib').map((r) => r.path)).toEqual(['src', 'src/lib', 'src/lib/auth.ts']);
    expect(treeRows(entriesOf, new Set(), 'zzz')).toEqual([]);
  });

  it('while filtering, loads the folders not looked at yet (skipping dependencies and ones asked for)', () => {
    const partial = (p: string): Entry[] | undefined => (p === '' ? fs[''] : undefined);
    expect(filterLoads(partial, new Set())).toEqual(['src']);
    expect(filterLoads(partial, new Set(['src']))).toEqual([]);
    expect(filterLoads(entriesOf, new Set())).toEqual([]);
  });

  it('knows the folders above a path', () => {
    expect(ancestorsOf('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestorsOf('top.ts')).toEqual([]);
  });
});
