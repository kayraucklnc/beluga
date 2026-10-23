import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core/store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { OUTSIDE_MANY, OUTSIDE_SHOWN, folderTail, isOutside, orderOutside, outsideActivity, outsideLocation, outsideOf, tildePath, visibleOutside } from '../packages/mac/src/layout/outside-model.js';
import { asksBeforeWork } from '../packages/mac/src/lib/work-asked.js';

/** Worktrees made outside Beluga in the Mac sidebar (packages/mac/src/layout/outside-model.ts), and what asks before it starts work. */

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w', projectRoot: '/p', name: 'w', path: '/Users/k/code/w', kind: 'worktree', branch: 'w', base: 'origin/main',
  createdAt: 0, projectId: 'p1', external: true, ...over,
});
const many = (n: number): Workspace[] => Array.from({ length: n }, (_, i) => ws({ id: `o${i}`, name: `wt-${String(i).padStart(2, '0')}` }));
const log = [] as unknown as AppState['log'];

describe('worktrees made outside Beluga', () => {
  it('are the external, live worktrees: not Beluga’s own, chats, the main folder or archived ones', () => {
    const p: Project = {
      id: 'p1', name: 'app', root: '/p', base: 'origin/main',
      workspaces: [ws({ id: 'mine', external: false }), ws({ id: 'main', kind: 'main', external: false }), ws({ id: 'chat', kind: 'chat', external: false }), ws({ id: 'old', archived: true }), ws({ id: 'madrid' })],
    };
    expect(outsideOf(p).map((w) => w.id)).toEqual(['madrid']);
    expect(isOutside(ws({ external: false }))).toBe(false);
  });

  it('say where they are under your home folder (the folder after the name, the whole path in the tooltip)', () => {
    const home = '/Users/k';
    expect(outsideLocation({ home }, ws({ path: '/Users/k/conductor/workspaces/klaude/madrid', name: 'madrid' }))).toEqual({ folder: '…/workspaces/klaude', path: '~/conductor/workspaces/klaude/madrid' });
    expect(outsideLocation({ home }, ws({ path: '/Users/k/Desktop/ratel/ratel-turns' }))).toEqual({ folder: '~/Desktop/ratel', path: '~/Desktop/ratel/ratel-turns' });
    expect(outsideLocation({ home }, ws({ path: '/Users/k/code/app/.claude/worktrees/agent-1' }))?.folder).toBe('…/.claude/worktrees');
    expect(outsideLocation({ home }, ws({ path: '/tmp/scratch' }))).toEqual({ folder: '/tmp', path: '/tmp/scratch' });
    expect(outsideLocation({ home }, ws({ external: false }))).toBeUndefined();
    expect(tildePath(home, '/Users/kay/x')).toBe('/Users/kay/x');
    expect(tildePath('', '/Users/k/x')).toBe('/Users/k/x');
    // Beluga's folder by its name, even where it's really the old ~/.klaude.
    expect(tildePath(home, '/Users/k/.klaude/workspaces/api-1/fix')).toBe('~/.beluga/workspaces/api-1/fix');
    expect(tildePath(home, '/Users/k/.klauder/x')).toBe('~/.klauder/x');
    expect(folderTail('/private/var/folders/x')).toBe('…/folders/x');
  });

  it('are ordered by when something last happened (git, a conversation or usage), then by name', () => {
    const a = ws({ id: 'a', name: 'alpha' });
    const b = ws({ id: 'b', name: 'beta', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, runs: 1, lastAt: 500 } });
    const c = ws({ id: 'c', name: 'gamma' });
    const d = ws({ id: 'd', name: 'delta' });
    const git = { c: 900, a: 100 };
    const at = (w: Workspace): number => outsideActivity({ log }, w, git);
    expect(orderOutside([a, b, c, d], at).map((w) => w.name)).toEqual(['gamma', 'beta', 'alpha', 'delta']);
    // Nothing known yet: by name.
    expect(orderOutside([c, a, b], () => 0).map((w) => w.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it(`show all when there are ${OUTSIDE_MANY} or fewer; past that, the ${OUTSIDE_SHOWN} most recent and the rest behind "Show N more"`, () => {
    expect(visibleOutside(many(OUTSIDE_MANY), false)).toMatchObject({ hidden: [] });
    expect(visibleOutside(many(OUTSIDE_MANY), false).shown).toHaveLength(OUTSIDE_MANY);
    const nine = many(9);
    const folded = visibleOutside(nine, false);
    expect(folded.shown.map((w) => w.id)).toEqual(['o0', 'o1', 'o2', 'o3', 'o4']);
    expect(folded.hidden).toHaveLength(4);
    expect(visibleOutside(nine, true)).toEqual({ shown: nine, hidden: [] });
  });

  it('keep the one you’re in visible even when it’s further down', () => {
    const { shown, hidden } = visibleOutside(many(9), false, 'o7');
    expect(shown.map((w) => w.id)).toEqual(['o0', 'o1', 'o2', 'o3', 'o4', 'o7']);
    expect(hidden.map((w) => w.id)).toEqual(['o5', 'o6', 'o8']);
  });
});

describe('the Mac app never names Conductor', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : /\.(tsx?|css)$/.test(f) ? [path.join(dir, f)] : []));
  it('in any of its copy (identifiers and the conductor.json file name are fine)', () => {
    const hits = files('packages/mac/src').flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ f, i: i + 1, line }))
        .filter(({ line }) => /Conductor/.test(line)),
    );
    expect(hits).toEqual([]);
  });
});

describe('work that asks first', () => {
  it('is everything that starts Claude or changes git; opening, running and showing things just happen', () => {
    for (const a of ['review_claude', 'commit', 'merge', 'merge_claude', 'compact', 'fix_checks']) expect(asksBeforeWork(a)).toBe(true);
    // Run is fine as is; PR, Fork, Archive and Hand Off open their own sheet or alert.
    for (const a of ['run', 'stop_run', 'finder', 'pr', 'fork', 'archive', 'delete', 'handoff', 'share', 'setup', 'restore']) expect(asksBeforeWork(a)).toBe(false);
  });
});
