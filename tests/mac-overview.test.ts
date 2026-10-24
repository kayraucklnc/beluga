import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core/store.js';
import { initialAppState as initialState, reduceApp as reduce } from '../src/client/screen.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import {
  emptyText,
  filterCounts,
  groupItems,
  inFilter,
  matchesSearch,
  narrow,
  overviewItems,
  readOverviewPrefs,
  rowOrder,
  sortItems,
  stepRow,
} from '../packages/mac/src/views/overview/overview-model.js';

/** The Mac Overview's list: what it shows, filters, finds and sorts (packages/mac/src/views/overview/overview-model.ts). */

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w', projectRoot: '/p', name: 'w', path: '/wt/w', kind: 'worktree', branch: 'klaud/w', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over,
});
const api: Project = {
  id: 'p1', name: 'api', root: '/p', base: 'origin/main',
  workspaces: [
    ws({ id: 'main', name: 'main', kind: 'main', branch: 'main', createdAt: 0 }),
    ws({ id: 'auth', name: 'add-auth', branch: 'klaud/add-auth', status: { changed: 0, ahead: 2, behind: 0 }, createdAt: 5 }),
    ws({ id: 'hooks', name: 'webhooks', branch: 'klaud/webhooks', status: { changed: 3, ahead: 1, behind: 0 }, createdAt: 6 }),
    ws({ id: 'old', name: 'old-spike', branch: 'klaud/old-spike', archived: true, createdAt: 2 }),
    ws({ id: 'agent', name: 'agent-1234abcd', path: '/p/.claude/worktrees/agent-1234abcd', branch: 'worktree-agent-1234abcd', external: true, createdAt: 7 }),
  ],
};
const site: Project = {
  id: 'p2', name: 'site', root: '/s', base: 'origin/main',
  workspaces: [ws({ id: 'hero', name: 'new-hero', projectId: 'p2', projectRoot: '/s', branch: 'klaud/new-hero', archived: true, createdAt: 3 })],
};
const chats: Project = {
  id: 'chats', name: 'Chats', root: '', base: '',
  workspaces: [ws({ id: 'q', name: 'deploy question', kind: 'chat', projectId: 'chats', projectRoot: '', branch: undefined, status: undefined, createdAt: 4 })],
};

const base = (): AppState => {
  let s = reduce(initialState('room'), { type: 'projects', projects: [chats, api, site] });
  s = reduce(s, { type: 'chat', id: 'm1', from: 'me', text: 'How do deploys work on fly?', ts: 50, byAgent: false, channel: 'ws:q' });
  s = reduce(s, { type: 'disk', sizes: { auth: 2_000, hooks: 9_000, main: 50_000, old: 7_000 } });
  return s;
};
const ids = (items: readonly { ws: Workspace }[]) => items.map((i) => i.ws.id);

describe('Mac Overview: what it shows', () => {
  it('shows live workspaces and everything archived, but not sub-agents’ scratch worktrees nor the main checkout (BLG-70)', () => {
    const items = overviewItems(base());
    expect(ids(items)).toEqual(['q', 'auth', 'hooks', 'old', 'hero']);
    expect(items.find((i) => i.ws.id === 'old')?.archived).toBe(true);
  });

  it('has no size for an archived worktree (its folder is gone), but keeps a live one’s', () => {
    const items = overviewItems(base());
    expect(items.find((i) => i.ws.id === 'old')?.size).toBeUndefined();
    expect(items.find((i) => i.ws.id === 'hooks')?.size).toBe(9_000);
  });

  it('knows a conversation’s last line, for search', () => {
    expect(overviewItems(base()).find((i) => i.ws.id === 'q')?.last).toBe('How do deploys work on fly?');
  });
});

describe('Mac Overview: segments', () => {
  it('counts each segment', () => {
    expect(filterCounts(overviewItems(base()))).toEqual({ all: 5, active: 3, needs: 0, ready: 1, archived: 2 });
  });

  it('ready to merge: committed work and nothing uncommitted', () => {
    const items = overviewItems(base());
    expect(ids(items.filter((i) => inFilter(i, 'ready')))).toEqual(['auth']);
  });

  it('ready to merge: not once its PR is merged or closed', () => {
    const pr = { number: 4, url: '', title: '', draft: false, checks: 'passing' as const };
    for (const state of ['MERGED', 'CLOSED'] as const) {
      const items = overviewItems({ ...base(), prs: { auth: { ...pr, state } } });
      expect(items.find((i) => i.ws.id === 'auth')?.ready).toBe(false);
    }
    expect(overviewItems({ ...base(), prs: { auth: { ...pr, state: 'OPEN' } } }).find((i) => i.ws.id === 'auth')?.ready).toBe(true);
  });

  it('needs you: a merge conflict, a pending approval or failing checks; never an archived one', () => {
    const s: AppState = { ...base(), conflicts: { hooks: ['a.ts'] }, prs: { auth: { number: 4, url: '', state: 'OPEN', title: '', draft: false, checks: 'failing' } } };
    const items = overviewItems(s);
    expect(ids(items.filter((i) => inFilter(i, 'needs')))).toEqual(['auth', 'hooks']);
    // A conflict isn't "ready" even with commits ahead.
    expect(items.find((i) => i.ws.id === 'hooks')?.ready).toBe(false);
    const archivedConflict = overviewItems({ ...s, conflicts: { old: ['b.ts'] } });
    expect(archivedConflict.find((i) => i.ws.id === 'old')?.needs).toBe(false);
  });
});

describe('Mac Overview: search and project', () => {
  const items = () => overviewItems(base());

  it('finds by name, branch, project and last message, every word, any case', () => {
    const find = (q: string) => ids(items().filter((i) => matchesSearch(i, q)));
    expect(find('AUTH')).toEqual(['auth']);
    expect(find('klaud/new')).toEqual(['hero']);
    expect(find('site')).toEqual(['hero']);
    expect(find('fly deploys')).toEqual(['q']);
    expect(find('chats')).toEqual(['q']);
    expect(find('fly nothing')).toEqual([]);
    expect(find('   ')).toHaveLength(5);
  });

  it('narrows to one project, and counts follow', () => {
    const one = narrow(items(), 'p2', '');
    expect(ids(one)).toEqual(['hero']);
    expect(filterCounts(one)).toEqual({ all: 1, active: 0, needs: 0, ready: 0, archived: 1 });
    expect(ids(narrow(items(), undefined, 'spike'))).toEqual(['old']);
  });
});

describe('Mac Overview: sorting, grouping and moving', () => {
  it('sorts by recent (what needs you first), name, or size (unmeasured last)', () => {
    const s = { ...base(), unread: { 'ws:auth': 2 } };
    const live = overviewItems(s).filter((i) => i.project.id === 'p1');
    expect(ids(sortItems(live, 'recent'))).toEqual(['auth', 'hooks', 'old']);
    expect(ids(sortItems(live, 'name'))).toEqual(['auth', 'old', 'hooks']);
    expect(ids(sortItems(live, 'size'))).toEqual(['hooks', 'auth', 'old']);
  });

  it('groups by project, live first then archived, and the arrow keys walk them in order', () => {
    const groups = groupItems(overviewItems(base()), 'name');
    expect(groups.map((g) => [g.project.id, ids(g.active), ids(g.archived)])).toEqual([
      ['chats', ['q'], []],
      ['p1', ['auth', 'hooks'], ['old']],
      ['p2', [], ['hero']],
    ]);
    const order = rowOrder(groups);
    expect(order).toEqual(['q', 'auth', 'hooks', 'old', 'hero']);
    expect(stepRow(order, 'hooks', 'ArrowDown')).toBe('old');
    expect(stepRow(order, 'hero', 'ArrowDown')).toBe('hero');
    expect(stepRow(order, 'q', 'ArrowUp')).toBe('q');
    expect(stepRow(order, undefined, 'ArrowDown')).toBe('q');
    expect(stepRow(order, undefined, 'ArrowUp')).toBe('hero');
    expect(stepRow(order, 'main', 'Home')).toBe('q');
    expect(stepRow(order, 'main', 'End')).toBe('hero');
    expect(stepRow([], 'x', 'ArrowDown')).toBeUndefined();
  });
});

describe('Mac Overview: remembered choices and empty states', () => {
  it('reads saved prefs, falling back on anything unknown', () => {
    expect(readOverviewPrefs(JSON.stringify({ filter: 'archived', sort: 'size', project: 'p2' }))).toEqual({ filter: 'archived', sort: 'size', project: 'p2' });
    expect(readOverviewPrefs(JSON.stringify({ filter: 'weird', sort: 3, project: 7 }))).toEqual({ filter: 'all', sort: 'recent' });
    expect(readOverviewPrefs('not json')).toEqual({ filter: 'all', sort: 'recent' });
    expect(readOverviewPrefs(null)).toEqual({ filter: 'all', sort: 'recent' });
  });

  it('says what each empty segment is for', () => {
    expect(emptyText('archived').title).toBe('Nothing archived yet');
    expect(emptyText('needs', 'api').title).toBe('Nothing needs you in api');
    for (const f of ['all', 'active', 'ready'] as const) expect(emptyText(f).detail.length).toBeGreaterThan(10);
  });
});
