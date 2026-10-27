import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { labelDef, labelsFor } from '../src/core/board/labels.js';
import { type Actor, type Issue, filterIssues, isEpic, issueForWorkspace } from '../src/core/board/model.js';
import { Store, initialState } from '../src/core/store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/** The board: tasks, their history and brief, what waits on what, and pull requests moving them. */

const me: Actor = { kind: 'person', id: 'p-me', name: 'Kay' };
const claude: Actor = { kind: 'claude', owner: 'p-me', ownerName: 'Kay' };

const ws = (id: string, projectId: string, name: string): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind: 'worktree', projectRoot: '/tmp/p', branch: `klaud/${name}`, createdAt: 0, external: false }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });

function setup(opts: { dir?: string; clock?: { t: number } } = {}) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [ws('w1', 'api', 'add-auth')]), project('land', 'landing')] });
  const clock = opts.clock ?? { t: 1_000_000 };
  const board = new Board({ store, dir: opts.dir ?? null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name, now: () => clock.t, saveDelayMs: 0 });
  return { store, board, clock };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('making tasks', () => {
  it('keys them per project from its name, in order', () => {
    const { board, store } = setup();
    const a = board.create({ projectId: 'api', title: 'Add auth' }, me);
    const b = board.create({ projectId: 'api', title: '  Webhook   retries ' }, me);
    const c = board.create({ projectId: 'land', title: 'Hero' }, me);
    expect([a.key, b.key, c.key]).toEqual(['BOB-1', 'BOB-2', 'LND-1']);
    expect(b.title).toBe('Webhook retries');
    expect(a).toMatchObject({ status: 'todo', priority: 'none', origin: 'manual', createdBy: me });
    expect(a.activity.map((x) => x.text)).toEqual(['created this task']);
    expect(store.getState().board.issues).toHaveLength(3);
    expect(store.getState().board.projects.api).toEqual({ prefix: 'BOB', next: 3 });
  });

  it('refuses a task with no title, in an unknown project, or under a parent elsewhere', () => {
    const { board } = setup();
    expect(() => board.create({ projectId: 'api', title: '   ' }, me)).toThrow(/title/);
    expect(() => board.create({ projectId: 'nope', title: 'x' }, me)).toThrow(/project/);
    const p = board.create({ projectId: 'api', title: 'Parent' }, me);
    expect(() => board.create({ projectId: 'land', title: 'x', parent: p.key }, me)).toThrow(/parent/);
  });

  it('a new prefix applies to new tasks only, and is unique', () => {
    const { board } = setup();
    board.create({ projectId: 'api', title: 'One' }, me);
    board.setPrefix('api', 'pay');
    expect(board.create({ projectId: 'api', title: 'Two' }, me).key).toBe('PAY-2');
    board.create({ projectId: 'land', title: 'L' }, me);
    expect(() => board.setPrefix('land', 'PAY')).toThrow(/already/);
    expect(() => board.setPrefix('land', 'x')).toThrow(/2 to 6/);
  });
});

describe('changing tasks', () => {
  it('says what changed, in words, by whom', () => {
    const { board, clock } = setup();
    const t = board.create({ projectId: 'api', title: 'Add auth' }, me);
    clock.t += 5000;
    const next = board.update(t.key, { status: 'in_progress', priority: 'high', assignee: { kind: 'claude', owner: 'p-me', ownerName: 'Kay' }, labels: ['Security', 'security', 'api'] }, me);
    expect(next.labels).toEqual(['security', 'api']);
    expect(next.activity.slice(1).map((a) => a.text)).toEqual(['moved this from Ready to In Progress', 'set the priority to High', 'assigned this to Kay’s Claude', 'added security, api']);
    expect(next.updatedAt).toBe(1_005_000);
    // Nothing changed: nothing written.
    expect(board.update(t.key, { status: 'in_progress' }, me).activity).toHaveLength(next.activity.length);
  });

  it('remembers when a task closed, and forgets it when it reopens', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'x' }, me);
    expect(board.update(t.id, { status: 'done' }, me).closedAt).toBeDefined();
    expect(board.update(t.id, { status: 'todo' }, me).closedAt).toBeUndefined();
  });

  it('a renamed task stops following its worktree’s name', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'Add auth', autoTitle: true }, me);
    expect(board.retitle(t.id, 'Add auth middleware').title).toBe('Add auth middleware');
    const renamed = board.update(t.id, { title: 'Auth for payments' }, me);
    expect(renamed.autoTitle).toBeUndefined();
    expect(board.retitle(t.id, 'Something else').title).toBe('Auth for payments');
  });

  it('keeps sub-tasks in their tree (no loops)', () => {
    const { board } = setup();
    const a = board.create({ projectId: 'api', title: 'A' }, me);
    const b = board.create({ projectId: 'api', title: 'B', parent: a.key }, me);
    const c = board.create({ projectId: 'api', title: 'C', parent: b.key }, me);
    expect(() => board.update(a.id, { parent: c.id }, me)).toThrow(/itself/);
    expect(() => board.update(a.id, { parent: a.id }, me)).toThrow(/itself/);
    expect(board.update(c.id, { parent: null }, me).parent).toBeUndefined();
  });

  it('drops a card between two others', () => {
    const { board } = setup();
    const a = board.create({ projectId: 'api', title: 'A' }, me);
    const b = board.create({ projectId: 'api', title: 'B' }, me);
    const c = board.create({ projectId: 'api', title: 'C', status: 'in_progress' }, me);
    const moved = board.move(c.key, 'todo', { before: a.key, after: b.key }, me);
    expect(moved.status).toBe('todo');
    expect(moved.rank).toBeGreaterThan(a.rank);
    expect(moved.rank).toBeLessThan(b.rank);
  });
});

describe('the brief', () => {
  it('keeps every version, with who and why, and puts one back', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'x', brief: { goal: 'First goal' } }, me);
    board.editBrief(t.key, 'goal', 'Better goal', claude, { reason: 'clearer' });
    board.editBrief(t.key, 'decisions', '- Signed cookies', claude);
    const after = board.editBrief(t.key, 'decisions', '- 401 with no body', claude, { mode: 'append', reason: 'how to reject' });
    expect(after.brief).toEqual({ goal: 'Better goal', decisions: '- Signed cookies\n- 401 with no body' });
    expect(after.revisions.map((r) => [r.section, r.before, r.reason])).toEqual([
      ['goal', 'First goal', 'clearer'],
      ['decisions', '', undefined],
      ['decisions', '- Signed cookies', 'how to reject'],
    ]);
    expect(after.activity.at(-1)?.text).toBe('updated Decisions — how to reject');
    const restored = board.restoreRevision(t.key, after.revisions[0]!.id, me);
    expect(restored.brief.goal).toBe('First goal');
    expect(restored.revisions.at(-1)?.reason).toBe('restored an earlier version');
  });

  it('an emptied section is gone; the same text changes nothing', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'x', brief: { context: 'c' } }, me);
    expect(board.editBrief(t.key, 'context', '', me).brief.context).toBeUndefined();
    const again = board.editBrief(t.key, 'goal', 'g', me);
    expect(board.editBrief(t.key, 'goal', 'g', me).revisions).toHaveLength(again.revisions.length);
  });

  it('comments are people’s, notes are Claude’s', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'x' }, me);
    board.comment(t.key, 'Looks good', me);
    const after = board.comment(t.key, 'Wired it in. 27 tests pass.', claude);
    expect(after.activity.slice(-2).map((a) => [a.kind, a.text, a.body])).toEqual([
      ['comment', 'commented', 'Looks good'],
      ['note', 'left a note', 'Wired it in. 27 tests pass.'],
    ]);
    expect(() => board.comment(t.key, '  ', me)).toThrow();
  });
});

describe('what waits on what', () => {
  it('blockers both ways, and never a loop', () => {
    const { board } = setup();
    const a = board.create({ projectId: 'api', title: 'A' }, me);
    const b = board.create({ projectId: 'api', title: 'B' }, me);
    const c = board.create({ projectId: 'api', title: 'C' }, me);
    board.relate(b.key, 'blocked_by', a.key, true, me);
    board.relate(b.key, 'blocks', c.key, true, me);
    expect(board.need(c.key).blockedBy).toEqual([b.id]);
    expect(() => board.relate(a.key, 'blocked_by', c.key, true, me)).toThrow(/loop/);
    expect(board.need(a.key).activity.at(-1)?.text).toBe('marked this as blocking BOB-2');
    board.relate(b.key, 'blocked_by', a.key, false, me);
    expect(board.need(b.key).blockedBy).toEqual([]);
  });

  it('related goes both ways; deleting a task frees what pointed at it', () => {
    const { board } = setup();
    const a = board.create({ projectId: 'api', title: 'A' }, me);
    const b = board.create({ projectId: 'api', title: 'B', parent: a.key, blockedBy: [a.key] }, me);
    board.relate(a.key, 'related', b.key, true, me);
    expect(board.need(b.key).related).toEqual([a.id]);
    board.remove(a.key);
    const freed = board.need(b.key);
    expect(freed).toMatchObject({ blockedBy: [], related: [] });
    expect('parent' in freed).toBe(false);
    expect(board.get(a.key)).toBeUndefined();
  });
});

describe('worktrees and pull requests', () => {
  const pr = (over: Partial<Parameters<Board['prChanged']>[1] & object> = {}) => ({ number: 7, url: 'https://x/7', state: 'OPEN' as const, title: 'T', draft: false, checks: 'pending' as const, ...over });

  it('a pull request opening moves the task to In Review; merging, to Done', () => {
    const { board, store } = setup();
    const t = board.create({ projectId: 'api', title: 'x', status: 'in_progress' }, me);
    board.linkWorktree(t.key, 'w1', { branch: 'klaud/add-auth', name: 'add-auth' }, me);
    expect(issueForWorkspace(store.getState().board, 'w1')?.key).toBe(t.key);
    board.prChanged('w1', pr());
    expect(board.need(t.key)).toMatchObject({ status: 'in_review', pr: { number: 7 } });
    // The same again: nothing new.
    const seen = board.need(t.key).activity.length;
    board.prChanged('w1', pr());
    expect(board.need(t.key).activity).toHaveLength(seen);
    board.prChanged('w1', pr({ review: 'CHANGES_REQUESTED' }));
    expect(board.need(t.key).status).toBe('in_progress');
    board.prChanged('w1', pr({ state: 'MERGED' }));
    const done = board.need(t.key);
    expect(done.status).toBe('done');
    expect(done.activity.filter((a) => a.by.kind === 'beluga').map((a) => a.text)).toEqual([
      'opened pull request #7',
      'moved this from In Progress to In Review',
      'changes were requested on the pull request',
      'moved this from In Review to In Progress',
      'pull request #7 was merged',
      'moved this from In Progress to Done',
    ]);
  });

  it('a draft stays In Progress; a canceled task stays canceled', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'x', status: 'in_progress' }, me);
    board.linkWorktree(t.key, 'w1', {}, me);
    board.prChanged('w1', pr({ draft: true }));
    expect(board.need(t.key).status).toBe('in_progress');
    board.update(t.key, { status: 'canceled' }, me);
    board.prChanged('w1', pr({ state: 'MERGED', draft: true }));
    expect(board.need(t.key).status).toBe('canceled');
  });

  it('a worktree merged here finishes its task; one archived asks what next', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'x', status: 'in_progress' }, me);
    board.linkWorktree(t.key, 'w1', {}, me);
    board.worktreeGone('w1', true, 'archived');
    expect(board.need(t.key).worktreeGone).toBe(true);
    expect(board.settleGone(t.key, 'backlog', me)).toMatchObject({ status: 'backlog' });
    expect(board.need(t.key).worktreeGone).toBeUndefined();
    board.worktreeMerged('w1');
    expect(board.need(t.key).status).toBe('done');
  });

  it('one task per worktree', () => {
    const { board } = setup();
    const a = board.create({ projectId: 'api', title: 'A' }, me);
    const b = board.create({ projectId: 'api', title: 'B' }, me);
    board.linkWorktree(a.key, 'w1', {}, me);
    board.linkWorktree(b.key, 'w1', {}, me);
    expect(board.need(a.key).worktrees).toEqual([]);
    expect(board.need(b.key).worktrees).toEqual(['w1']);
  });
});

describe('quick changes are one line in the activity', () => {
  it('clicking through estimates leaves one line; back to where it was leaves none', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'T' }, me);
    const before = board.need(t.key).activity.length;
    for (const e of [1, 2, 3, 5]) board.update(t.key, { estimate: e }, me);
    const after = board.need(t.key).activity;
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)?.text).toBe('estimated this at 5 points');
    board.update(t.key, { estimate: null }, me);
    expect(board.need(t.key).activity).toHaveLength(before);
  });

  it('status moves read from where it started; someone else’s change starts a new line', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'T', status: 'todo' }, me);
    board.update(t.key, { status: 'in_progress' }, me);
    board.update(t.key, { status: 'in_review' }, me);
    expect(board.need(t.key).activity.at(-1)?.text).toBe('moved this from Ready to In Review');
    board.update(t.key, { status: 'done' }, { kind: 'person', id: 'p-bob', name: 'bob' });
    expect(board.need(t.key).activity.at(-1)?.text).toBe('moved this from In Review to Done');
    expect(board.need(t.key).activity.filter((a) => a.kind === 'status')).toHaveLength(2);
  });
});

describe('saving', () => {
  it('writes board.json and reads it back', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-board-'));
    dirs.push(dir);
    const first = setup({ dir });
    const t = first.board.create({ projectId: 'api', title: 'Kept', brief: { goal: 'g' } }, me);
    first.board.setAutoTasks(false);
    first.board.flush();
    const saved = JSON.parse(readFileSync(path.join(dir, 'board.json'), 'utf8')) as { issues: Issue[]; worktreeTasks: boolean };
    expect(saved.worktreeTasks).toBe(false);
    expect(saved.issues[0]?.key).toBe('BOB-1');
    const again = setup({ dir });
    expect(again.board.need(t.key).brief.goal).toBe('g');
    expect(again.store.getState().board).toMatchObject({ enabled: true, autoTasks: false });
    expect(again.board.create({ projectId: 'api', title: 'Next' }, me).key).toBe('BOB-2');
  });
});

describe('what screens show', () => {
  it('scopes: mine, active, backlog, and recently finished', () => {
    const { board, store, clock } = setup();
    board.create({ projectId: 'api', title: 'Mine', assignee: { kind: 'person', id: 'p-me', name: 'Kay' }, status: 'in_progress' }, me);
    board.create({ projectId: 'api', title: 'Later', status: 'backlog' }, me);
    const old = board.create({ projectId: 'api', title: 'Old', status: 'done' }, me);
    clock.t += 8 * 24 * 60 * 60 * 1000;
    board.create({ projectId: 'land', title: 'Theirs', assignee: { kind: 'person', id: 'p-bob', name: 'bob' } }, me);
    const s = store.getState().board;
    const titles = (f: Parameters<typeof filterIssues>[1]) => filterIssues(s, { now: clock.t, selfId: 'p-me', ...f }).map((i) => i.title);
    expect(titles({ scope: 'mine' })).toEqual(['Mine']);
    expect(titles({ scope: 'active' })).toEqual(['Theirs', 'Mine']);
    expect(titles({ scope: 'backlog' })).toEqual(['Later']);
    expect(titles({ scope: 'all' })).not.toContain(old.title);
    expect(titles({ scope: 'all', projectId: 'land' })).toEqual(['Theirs']);
    expect(titles({ query: 'lat' })).toEqual(['Later']);
  });
});

describe('fixes that keep the board right', () => {
  const pr = (number: number, state: 'OPEN' | 'MERGED' = 'OPEN') => ({ number, url: `https://x/${number}`, state, title: 'T', draft: false, checks: 'passing' as const });

  it('only the worktree doing a task now moves it (an older one’s pull request is history)', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'x', status: 'in_progress' }, me);
    board.linkWorktree(t.key, 'old', {}, me);
    board.linkWorktree(t.key, 'new', {}, me);
    board.prChanged('new', pr(2));
    const seen = board.need(t.key).activity.length;
    board.prChanged('old', pr(1, 'MERGED'));
    expect(board.need(t.key)).toMatchObject({ status: 'in_review', pr: { number: 2 } });
    expect(board.need(t.key).activity).toHaveLength(seen);
  });

  it('ranks are one order per status across projects, spread out again when two tie', () => {
    const { board } = setup();
    const a = board.create({ projectId: 'api', title: 'A' }, me);
    const b = board.create({ projectId: 'land', title: 'B' }, me);
    expect(b.rank).toBeGreaterThan(a.rank);
    const c = board.create({ projectId: 'api', title: 'C' }, me);
    // Force a tie, then drop between the tied two.
    board.move(b.key, 'todo', { before: a.key, after: a.key }, me);
    const moved = board.move(c.key, 'todo', { before: a.key, after: b.key }, me);
    const [ra, rb] = [board.need(a.key).rank, board.need(b.key).rank];
    expect(moved.rank).toBeGreaterThan(Math.min(ra, rb));
    expect(moved.rank).toBeLessThan(Math.max(ra, rb));
  });

  it('a prefix an older task key still uses is taken', () => {
    const { board } = setup();
    board.setPrefix('api', 'ALP');
    board.create({ projectId: 'api', title: 'kept key' }, me);
    board.setPrefix('api', 'ZZ');
    expect(() => board.setPrefix('land', 'ALP')).toThrow(/already/);
  });

  it('a deleted worktree is no longer the task’s; an archived one still is', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'x', status: 'in_progress' }, me);
    board.linkWorktree(t.key, 'w1', {}, me);
    board.worktreeGone('w1', true, 'archived');
    expect(board.need(t.key).worktrees).toEqual(['w1']);
    board.worktreeGone('w1', true, 'deleted');
    expect(board.need(t.key)).toMatchObject({ worktrees: [], worktreeGone: true });
  });

  it('each brief section keeps its own versions', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'x', brief: { goal: 'g' } }, me);
    board.editBrief(t.key, 'goal', 'g2', me);
    for (let i = 0; i < 30; i++) board.editBrief(t.key, 'decisions', `- d${i}`, claude, { mode: 'append' });
    const revs = board.need(t.key).revisions;
    expect(revs.filter((r) => r.section === 'decisions')).toHaveLength(20);
    expect(revs.filter((r) => r.section === 'goal')).toHaveLength(1);
  });

  it('a board.json it can’t read is set aside, never written over', async () => {
    const { writeFileSync, readdirSync } = await import('node:fs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-board-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ version: 9, issues: [{ id: 'x' }] }));
    const { board } = setup({ dir });
    board.create({ projectId: 'api', title: 'new' }, me);
    board.flush();
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith('board.json.unreadable-'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'board.json'), 'utf8')).issues).toHaveLength(1);
  });

  it('tasks that no longer read are kept beside the board', async () => {
    const { writeFileSync, readdirSync } = await import('node:fs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-board-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ version: 1, issues: [{ id: 'broken' }] }));
    setup({ dir });
    expect(readdirSync(dir).some((f) => f.startsWith('board.dropped-'))).toBe(true);
  });
});

describe('work carried by another worktree, and sub-tasks done with their parent', () => {
  const pr = (state: 'OPEN' | 'MERGED' = 'OPEN') => ({ number: 9, url: 'https://x/9', state, title: 'Buglist', draft: false, checks: 'passing' as const });

  it('a task carried by a worktree goes Done when that worktree’s pull request merges', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'Fix the badge', status: 'in_review' }, claude);
    board.carry(t.key, { id: 'w1', branch: 'beluga/buglist', name: 'buglist' }, () => false);
    expect(board.need(t.key)).toMatchObject({ carriedBy: 'w1', branch: 'beluga/buglist' });
    board.prChanged('w1', pr('MERGED'));
    expect(board.need(t.key)).toMatchObject({ status: 'done', pr: { number: 9 } });
  });

  it('a task with a live worktree of its own keeps following that one', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'x', status: 'in_progress' }, me);
    board.linkWorktree(t.key, 'w1', {}, me);
    board.carry(t.key, { id: 'w2' }, (id) => id === 'w1');
    expect(board.need(t.key).carriedBy).toBeUndefined();
    board.prChanged('w2', pr('MERGED'));
    expect(board.need(t.key).status).toBe('in_progress');
  });

  it('a worktree merged here finishes the tasks it carried', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'x', status: 'in_review' }, me);
    board.carry(t.key, { id: 'w1' }, () => false);
    board.worktreeMerged('w1');
    expect(board.need(t.key).status).toBe('done');
  });

  it('a parent reaching Done takes its open sub-tasks with it, all the way down; canceled ones stay', () => {
    const { board } = setup();
    const parent = board.create({ projectId: 'api', title: 'Buglist', status: 'in_review' }, me);
    const a = board.create({ projectId: 'api', title: 'A', status: 'in_review', parent: parent.key }, me);
    const b = board.create({ projectId: 'api', title: 'B', status: 'canceled', parent: parent.key }, me);
    const c = board.create({ projectId: 'api', title: 'C', status: 'backlog', parent: a.key }, me);
    board.update(parent.key, { status: 'done' }, claude);
    expect([a, b, c].map((i) => board.need(i.key).status)).toEqual(['done', 'canceled', 'done']);
    expect(board.need(a.key).activity.at(-1)?.text).toBe(`done with its parent ${parent.key}: moved this from In Review to Done`);
    expect(board.need(parent.key).status).toBe('done');
  });
});

describe('a parent following its sub-tasks', () => {
  it('goes In Progress, In Review and Done with them, Canceled ones left out, and says why', () => {
    const { board } = setup();
    const parent = board.create({ projectId: 'api', title: 'Buglist' }, claude);
    const a = board.create({ projectId: 'api', title: 'A', parent: parent.key }, claude);
    const b = board.create({ projectId: 'api', title: 'B', parent: parent.key }, claude);
    const c = board.create({ projectId: 'api', title: 'C', parent: parent.key }, claude);
    expect(board.need(parent.key).status).toBe('todo');
    board.update(a.key, { status: 'in_progress' }, claude);
    expect(board.need(parent.key).status).toBe('in_progress');
    board.update(a.key, { status: 'in_review' }, claude);
    board.update(b.key, { status: 'done' }, claude);
    expect(board.need(parent.key).status).toBe('in_progress');
    board.update(c.key, { status: 'canceled' }, claude);
    expect(board.need(parent.key).status).toBe('in_review');
    board.update(a.key, { status: 'done' }, claude);
    expect(board.need(parent.key)).toMatchObject({ status: 'done', closedAt: expect.any(Number) });
    expect(board.need(parent.key).activity.at(-1)).toMatchObject({ by: { kind: 'beluga' }, text: 'all 2 sub-tasks are done: moved this from In Review to Done' });
  });

  it('opens again when a sub-task does, or a new one comes', () => {
    const { board } = setup();
    const parent = board.create({ projectId: 'api', title: 'Buglist' }, me);
    const a = board.create({ projectId: 'api', title: 'A', status: 'done', parent: parent.key }, me);
    expect(board.need(parent.key).status).toBe('done');
    board.create({ projectId: 'api', title: 'B', parent: parent.key }, me);
    expect(board.need(parent.key).status).toBe('in_progress');
    expect(board.need(parent.key).activity.at(-1)?.text).toBe('a sub-task is open again: moved this from Done to In Progress');
    board.update(a.key, { status: 'in_progress' }, me);
    expect(board.need(parent.key).status).toBe('in_progress');
  });

  it('follows them all the way up, and when one moves to another parent or goes', () => {
    const { board } = setup();
    const top = board.create({ projectId: 'api', title: 'Top' }, me);
    const mid = board.create({ projectId: 'api', title: 'Mid', parent: top.key }, me);
    const leaf = board.create({ projectId: 'api', title: 'Leaf', parent: mid.key }, me);
    const other = board.create({ projectId: 'api', title: 'Other', parent: top.key }, me);
    board.update(leaf.key, { status: 'done' }, me);
    expect([mid, top].map((i) => board.need(i.key).status)).toEqual(['done', 'in_progress']);
    board.update(other.key, { parent: null }, me);
    expect(board.need(top.key).status).toBe('done');
    const late = board.create({ projectId: 'api', title: 'Late', status: 'in_progress', parent: top.key }, me);
    expect(board.need(top.key).status).toBe('in_progress');
    board.remove(late.key);
    expect(board.need(top.key).status).toBe('done');
  });

  it('a parent with work of its own goes no further than In Progress; a canceled or plan one stays put; one by hand stays where it was put', () => {
    const { board } = setup();
    const own = board.create({ projectId: 'api', title: 'Own' }, me);
    board.linkWorktree(own.key, 'w1', {}, me);
    board.create({ projectId: 'api', title: 'A', status: 'done', parent: own.key }, me);
    expect(board.need(own.key).status).toBe('in_progress');
    expect(board.need(own.key).activity.at(-1)?.text).toBe('its sub-task is done: moved this from Ready to In Progress');

    const gone = board.create({ projectId: 'api', title: 'Gone', status: 'canceled' }, me);
    board.create({ projectId: 'api', title: 'B', status: 'done', parent: gone.key }, me);
    expect(board.need(gone.key).status).toBe('canceled');

    const planned = board.create({ projectId: 'api', title: 'Planned', plan: { id: 'p', milestone: 'm', task: 't' } }, me);
    board.create({ projectId: 'api', title: 'C', status: 'done', parent: planned.key }, me);
    expect(board.need(planned.key).status).toBe('todo');

    const held = board.create({ projectId: 'api', title: 'Held' }, me);
    board.create({ projectId: 'api', title: 'D', status: 'done', parent: held.key }, me);
    board.update(held.key, { status: 'todo' }, me);
    expect(board.need(held.key).status).toBe('todo');
  });

  it('a parent carried by the worktree its sub-tasks are done in follows them to In Review and Done; one with its own worktree or pull request stays at In Progress', () => {
    const { board } = setup();
    const shared = board.create({ projectId: 'api', title: 'Sidebar fixes' }, claude);
    board.carry(shared.key, { id: 'w1' }, () => false);
    const kids = ['A', 'B'].map((title) => board.create({ projectId: 'api', title, parent: shared.key }, claude));
    for (const k of kids) {
      board.carry(k.key, { id: 'w1' }, () => false);
      board.update(k.key, { status: 'in_review' }, claude);
    }
    expect(board.need(shared.key).status).toBe('in_review');
    board.prChanged('w1', { number: 9, url: 'https://github.com/o/r/pull/9', state: 'MERGED', title: 'Sidebar fixes', draft: false, checks: 'passing' });
    expect([shared, ...kids].map((i) => board.need(i.key).status)).toEqual(['done', 'done', 'done']);

    const own = board.create({ projectId: 'api', title: 'Own' }, claude);
    board.linkWorktree(own.key, 'w2', {}, claude);
    const elsewhere = board.create({ projectId: 'api', title: 'C', parent: own.key }, claude);
    board.carry(elsewhere.key, { id: 'w3' }, () => false);
    board.update(elsewhere.key, { status: 'in_review' }, claude);
    expect(board.need(own.key).status).toBe('in_progress');

    const pr = { number: 4, url: 'https://github.com/o/r/pull/4', state: 'OPEN', title: 'Own PR', draft: true, checks: 'pending' } as const;
    const byPr = board.create({ projectId: 'api', title: 'By PR' }, claude);
    board.update(byPr.key, { status: 'in_progress' }, claude);
    board.linkWorktree(byPr.key, 'w4', {}, claude);
    board.prChanged('w4', pr);
    const d = board.create({ projectId: 'api', title: 'D', status: 'in_review', parent: byPr.key }, claude);
    expect(board.need(byPr.key).status).toBe('in_progress');
    board.update(d.key, { status: 'done' }, claude);
    expect(board.need(byPr.key).status).toBe('in_progress');
  });
});

describe('the archive', () => {
  it('archives every Done task in one go; they leave the board and Claude’s lists, and can come back', () => {
    const { board, store, clock } = setup();
    const a = board.create({ projectId: 'api', title: 'Shipped', status: 'done' }, me);
    const b = board.create({ projectId: 'api', title: 'Open' }, me);
    const now = clock.t;
    expect(board.archiveDone(me)).toBe(1);
    expect(board.need(a.key).archivedAt).toBeDefined();
    expect(filterIssues(store.getState().board, { now }).map((i) => i.key)).toEqual([b.key]);
    expect(filterIssues(store.getState().board, { scope: 'archived' }).map((i) => i.key)).toEqual([a.key]);
    expect(() => board.archive(b.key, me)).toThrow(/finished/);
    board.unarchive(a.key, me);
    expect(filterIssues(store.getState().board, { now }).map((i) => i.key).sort()).toEqual([a.key, b.key].sort());
  });

  it('emptying the archive deletes for good, and keys are never given out again', () => {
    const { board } = setup();
    const a = board.create({ projectId: 'api', title: 'Shipped', status: 'done' }, me);
    board.archiveDone(me);
    expect(board.emptyArchive()).toBe(1);
    expect(board.get(a.key)).toBeUndefined();
    expect(board.create({ projectId: 'api', title: 'Next' }, me).key).toBe('BOB-2');
  });
});

describe('labels come from a set (BLG-269)', () => {
  it('every board has the built-in labels; a project adds its own on purpose, and they are saved', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-board-'));
    dirs.push(dir);
    const first = setup({ dir });
    expect(labelsFor(first.board.state(), 'api').map((l) => l.name)).toEqual(['bug', 'important', 'feature', 'design', 'docs', 'chore']);
    expect(first.board.createLabel('api', { name: 'Dark Mode', icon: 'star', color: 'purple' })).toEqual({ name: 'dark-mode', icon: 'star', color: 'purple' });
    expect(() => first.board.createLabel('api', { name: 'bug', icon: 'bug', color: 'red' })).toThrow(/already/);
    expect(() => first.board.createLabel('api', { name: 'not a label, a sentence really', icon: 'tag', color: 'red' })).toThrow(/short words/);
    // The screens hear of it (board_meta).
    expect(labelsFor(first.store.getState().board, 'api').at(-1)?.name).toBe('dark-mode');
    expect(labelsFor(first.board.state(), 'land')).toHaveLength(6);
    first.board.flush();
    const again = setup({ dir });
    expect(labelDef(again.board.state(), 'api', 'dark-mode')).toEqual({ name: 'dark-mode', icon: 'star', color: 'purple' });
    again.board.removeLabel('api', 'dark-mode');
    expect(labelDef(again.board.state(), 'api', 'dark-mode')).toBeUndefined();
    expect(() => again.board.removeLabel('api', 'bug')).toThrow(/Only a label the project added/);
  });

  it('Claude only sets labels from the set, and keeps the ones a task already had', () => {
    const { board } = setup();
    const t = board.create({ projectId: 'api', title: 'Old', labels: ['legacy'] }, me);
    expect(board.update(t.key, { labels: ['legacy', 'bug', 'made-up'] }, claude).labels).toEqual(['legacy', 'bug']);
    expect(board.create({ projectId: 'api', title: 'New', labels: ['important', 'whatever'] }, claude, 'claude').labels).toEqual(['important']);
    // People pick from the set on screen; sync brings a tracker's own.
    expect(board.create({ projectId: 'api', title: 'Synced', labels: ['billing'] }, { kind: 'beluga' }, 'sync').labels).toEqual(['billing']);
  });
});

describe('epics (BLG-267)', () => {
  it('a task with sub-tasks is an epic', () => {
    const { board } = setup();
    const epic = board.create({ projectId: 'api', title: 'Auth' }, me);
    expect(isEpic(board.state(), epic)).toBe(false);
    board.create({ projectId: 'api', title: 'Login', parent: epic.key }, me);
    expect(isEpic(board.state(), epic)).toBe(true);
  });
});
