import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ArrangeError, arrangedOrder, move, topLevel } from '../src/workspaces/arrange.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

describe('arranging (pure)', () => {
  const roots = ['/a', '/b', '/c', '/d'];

  it('shows loose projects alphabetically, then groups, until you arrange something', () => {
    const layout = { groups: [{ name: 'Work', projects: ['/c', '/b'] }] };
    expect(topLevel(layout, roots)).toEqual(['/a', '/d', 'group:Work']);
    const shown = arrangedOrder(layout, roots.map((root) => ({ root })));
    // Nothing moves: the list stays alphabetical, a group's projects too.
    expect(shown.projects.map((p) => p.root)).toEqual(roots);
    expect(shown.groups).toEqual([{ name: 'Work', projects: ['/b', '/c'] }]);
  });

  it('reorders the top level, interleaving projects and groups', () => {
    let layout = move({ groups: [{ name: 'Work', projects: ['/c'] }] }, roots, { project: '/d' }, { before: { project: '/a' } });
    expect(layout.order).toEqual(['/d', '/a', '/b', 'group:Work']);
    layout = move(layout, roots, { group: 'Work' }, { before: { project: '/a' } });
    expect(layout.order).toEqual(['/d', 'group:Work', '/a', '/b']);
    layout = move(layout, roots, { project: '/d' }, {});
    expect(layout.order).toEqual(['group:Work', '/a', '/b', '/d']);
    const shown = arrangedOrder(layout, roots.map((root) => ({ root })));
    expect(shown.projects.map((p) => p.root)).toEqual(['/c', '/a', '/b', '/d']);
  });

  it('moves projects into a group at a position, and back out', () => {
    let layout = move({ groups: [{ name: 'Work', projects: ['/c', '/a'] }] }, roots, { project: '/d' }, { into: 'Work', before: { project: '/c' } });
    // The group's alphabetical order is pinned down first, then /d goes before /c.
    expect(layout.groups).toEqual([{ name: 'Work', projects: ['/a', '/d', '/c'] }]);
    expect(layout.order).toEqual(['/b', 'group:Work']);
    layout = move(layout, roots, { project: '/a' }, { before: { group: 'Work' } });
    expect(layout.groups[0]!.projects).toEqual(['/d', '/c']);
    expect(layout.order).toEqual(['/b', '/a', 'group:Work']);
    // Moving the last ones out leaves the group (empty) where it is.
    layout = move(move(layout, roots, { project: '/d' }, {}), roots, { project: '/c' }, {});
    expect(layout.groups).toEqual([{ name: 'Work', projects: [] }]);
    expect(layout.order).toEqual(['/b', '/a', 'group:Work', '/d', '/c']);
  });

  it('keeps hidden projects’ places', () => {
    const layout = move({ order: ['/x', '/a', '/b'], groups: [] }, roots, { project: '/c' }, { before: { project: '/a' } }, new Set(['/x']));
    expect(layout.order).toEqual(['/x', '/c', '/a', '/b', '/d']);
  });

  it('refuses what isn’t there', () => {
    const layout = { groups: [{ name: 'Work', projects: ['/c'] }] };
    expect(() => move(layout, roots, { project: '/nope' }, {})).toThrow(ArrangeError);
    expect(() => move(layout, roots, { group: 'Nope' }, {})).toThrow(/No group/);
    expect(() => move(layout, roots, { project: '/a' }, { into: 'Nope' })).toThrow(/No group/);
    expect(() => move(layout, roots, { group: 'Work' }, { into: 'Work' })).toThrow(/inside another group/);
    expect(() => move(layout, roots, { project: '/a' }, { into: 'Work', before: { project: '/b' } })).toThrow(/isn’t in "Work"/);
    // Before a project that's inside a group, at the top level: not a place.
    expect(() => move(layout, roots, { project: '/a' }, { before: { project: '/c' } })).toThrow(/can’t go there/);
  });
});

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' });

describe('arranging projects (manager)', () => {
  let base: string;
  let store: WorkspaceStore;
  let mgr: WorkspaceManager;
  const names = () => mgr.arrangement().projects.filter((p) => p.root).map((p) => p.name);
  const id = (name: string) => mgr.list.find((p) => p.name === name)!.id;

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-arrange-')));
    for (const name of ['alpha', 'bravo', 'charlie', 'delta']) {
      const dir = path.join(base, 'code', name);
      mkdirSync(dir, { recursive: true });
      sh(dir, 'init', '-b', 'main');
      writeFileSync(path.join(dir, 'a.txt'), name);
      sh(dir, 'add', '.');
      sh(dir, 'commit', '-m', 'init');
    }
    store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
    mgr = new WorkspaceManager(store);
    await mgr.refresh();
  });

  it('reorders, groups and persists across restarts', async () => {
    expect(names()).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    expect(mgr.settings.order).toBeUndefined();
    mgr.arrange({ project: id('delta') }, { before: { project: id('alpha') } });
    expect(names()).toEqual(['delta', 'alpha', 'bravo', 'charlie']);
    mgr.newGroup('Clients', { project: id('bravo') });
    mgr.arrange({ project: id('charlie') }, { into: 'Clients', before: { project: id('bravo') } });
    expect(mgr.arrangement().order.map((k) => (k.startsWith('group:') ? k : path.basename(k)))).toEqual(['delta', 'alpha', 'group:Clients']);
    expect(mgr.arrangement().groups.map((g) => [g.name, g.projects.map((r) => path.basename(r))])).toEqual([['Clients', ['charlie', 'bravo']]]);
    mgr.arrange({ group: 'Clients' }, { before: { project: id('delta') } });

    const again = new WorkspaceManager(new WorkspaceStore(path.join(base, 'home')));
    await again.refresh();
    expect(again.arrangement().projects.filter((p) => p.root).map((p) => p.name)).toEqual(['charlie', 'bravo', 'delta', 'alpha']);
    expect(JSON.parse(readFileSync(path.join(base, 'home', 'projects.json'), 'utf8')).order).toHaveLength(3);
  });

  it('keeps places when renaming and ungrouping, and keeps empty groups you made', async () => {
    mgr.newGroup('Empty');
    mgr.newGroup('Work', { before: { project: id('alpha') }, project: id('charlie') });
    expect(mgr.arrangement().order.map((k) => path.basename(k))).toEqual(['group:Work', 'alpha', 'bravo', 'delta', 'group:Empty']);
    mgr.renameGroup('Work', 'Jobs');
    expect(mgr.arrangement().order[0]).toBe('group:Jobs');
    mgr.ungroup('Jobs');
    expect(names()).toEqual(['charlie', 'alpha', 'bravo', 'delta']);
    expect(mgr.groups).toEqual([{ name: 'Empty', projects: [] }]);
    await mgr.refresh();
    expect(mgr.groups).toEqual([{ name: 'Empty', projects: [] }]);
  });

  it('brings a hidden project back where it was', async () => {
    mgr.arrange({ project: id('delta') }, { before: { project: id('alpha') } });
    const root = mgr.list.find((p) => p.name === 'delta')!.root;
    mgr.hideProject(id('delta'));
    await mgr.refresh();
    expect(names()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(mgr.hiddenProjects).toEqual([root]);
    mgr.showProject(root);
    await mgr.refresh();
    expect(names()).toEqual(['delta', 'alpha', 'bravo', 'charlie']);
    expect(mgr.hiddenProjects).toEqual([]);
    expect(() => mgr.showProject(root)).toThrow(/isn’t hidden/);
  });

  it('refuses unknown projects, groups and places, and duplicate group names', () => {
    expect(() => mgr.arrange({ project: 'nope' })).toThrow(/Project not found/);
    expect(() => mgr.arrange({ group: 'nope' })).toThrow(/No group/);
    expect(() => mgr.arrange({ project: id('alpha') }, { into: 'nope' })).toThrow(/No group/);
    mgr.newGroup('Work');
    expect(() => mgr.newGroup(' Work ')).toThrow(/already a group/);
    expect(() => mgr.newGroup('   ')).toThrow(/needs a name/);
    expect(mgr.settings.order).toEqual([...mgr.list.filter((p) => p.root).map((p) => p.root), 'group:Work']);
  });

  it('a project taken out of its group (the old way) lands right after it once arranged', () => {
    mgr.setGroup(id('alpha'), 'Work');
    mgr.arrange({ group: 'Work' }, { before: { project: id('bravo') } });
    mgr.setGroup(id('charlie'), 'Work');
    mgr.setGroup(id('alpha'), undefined);
    expect(names()).toEqual(['charlie', 'alpha', 'bravo', 'delta']);
    // Its last project leaving the old way takes the group with it, as before.
    mgr.setGroup(id('charlie'), undefined);
    expect(mgr.groups).toEqual([]);
    expect(names()).toEqual(['charlie', 'alpha', 'bravo', 'delta']);
  });
});
