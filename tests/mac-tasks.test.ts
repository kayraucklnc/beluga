import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { type Actor, activityText, prefixFor, titleFromName } from '../src/core/board/model.js';
import { Store, initialState } from '../src/core/store.js';
import { createMockBackend } from '../src/agent/mock.js';
import type { RoomBridge } from '../src/agent/types.js';
import { BoardWork } from '../src/core/board/work.js';
import { DEFAULT_TASKS_PREFS, assigneeChoices, fromV1TasksPrefs, assigneeKey, assigneesIn, checklist, connected, dueText, isFor, isSolo, onIt, onItTip, onItWords, projectToShow, readTasksPrefs, scopeCounts, scoped, statusesFor, taskGraph, toggleCheck, toggleTuck, untucked } from '../packages/mac/src/tasks/tasks-model.js';
import { parseGraph } from '../src/shared/graph-spec.js';
import { NO_TEAM, canAssign } from '../src/core/team/model.js';
import type { Project } from '../src/workspaces/types.js';

/** The Tasks screens' pure parts, and the words tasks are shown in. */

const me: Actor = { kind: 'person', id: 'p-me', name: 'Kay' };

function board() {
  const store = new Store(initialState('room'));
  const projects: Project[] = [{ id: 'api', name: 'bob-api', root: '/tmp/api', base: 'main', workspaces: [] }];
  store.dispatch({ type: 'projects', projects });
  const b = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
  return { store, b };
}

describe('keys and titles', () => {
  it('prefixes from project names, unique', () => {
    expect(prefixFor('bob-api')).toBe('BOB');
    expect(prefixFor('landing')).toBe('LND');
    expect(prefixFor('my-cool-app')).toBe('MCA');
    expect(prefixFor('klaudPlugins')).toBe('KP');
    expect(prefixFor('bob-api', new Set(['BOB']))).toBe('BOB2');
    expect(prefixFor('x')).toBe('XX');
  });

  it('a worktree’s name reads as a title', () => {
    expect(titleFromName('add-rate_limiting')).toBe('Add rate limiting');
    expect(titleFromName('--')).toBe('Untitled task');
  });

  it('assignment reads from where you look', () => {
    const entry = (assignee: Parameters<typeof activityText>[0]['assignee']) => ({ id: 'a', at: 0, by: me, kind: 'assignee' as const, text: 'assigned this to Kay’s Claude', assignee });
    expect(activityText(entry({ kind: 'claude', owner: 'p-me', ownerName: 'Kay' }), 'p-me')).toBe('assigned this to your Claude');
    expect(activityText(entry({ kind: 'person', id: 'p-me', name: 'Kay' }), 'p-me')).toBe('assigned this to you');
    expect(activityText(entry({ kind: 'claude', owner: 'p-me', ownerName: 'Kay' }), 'p-bob')).toBe('assigned this to Kay’s Claude');
    expect(activityText(entry(null), 'p-me')).toBe('unassigned this');
  });
});

describe('the Tasks view', () => {
  it('reads saved prefs kindly', () => {
    expect(readTasksPrefs(null)).toEqual(DEFAULT_TASKS_PREFS);
    expect(readTasksPrefs('{oops')).toEqual(DEFAULT_TASKS_PREFS);
    expect(readTasksPrefs(JSON.stringify({ scope: 'backlog', display: 'board', project: 'api', who: 'claude:p-me', folded: ['done', 'nope'], tucked: ['i-1', 2] }))).toEqual({ scope: 'backlog', display: 'board', project: 'api', who: 'claude:p-me', folded: ['done'], tucked: ['i-1'] });
    // "My Tasks" mixed projects: it's gone (an old window's choice reads as Active).
    expect(readTasksPrefs(JSON.stringify({ scope: 'mine', display: 1 }))).toMatchObject({ scope: 'active', display: 'board', who: '' });
    expect(readTasksPrefs(fromV1TasksPrefs(JSON.stringify({ scope: 'backlog', display: 'list' })))).toMatchObject({ scope: 'backlog', display: 'board' });
  });

  it('shows the statuses a scope is about', () => {
    expect(statusesFor('active')).toEqual(['todo', 'in_progress', 'in_review', 'in_plan']);
    expect(statusesFor('backlog')).toEqual(['backlog']);
    expect(statusesFor('all')).toHaveLength(7);
  });

  it('tucks an epic’s sub-tasks under it, unless the epic isn’t shown or a filter is on', () => {
    const { store, b } = board();
    const epic = b.create({ projectId: 'api', title: 'Epic' }, me);
    const a = b.create({ projectId: 'api', title: 'A', parent: epic.key }, me);
    const c = b.create({ projectId: 'api', title: 'C' }, me);
    const all = store.getState().board.issues;
    const ids = (r: ReturnType<typeof untucked>) => r.shown.map((i) => i.id);
    expect(untucked(all, [])).toEqual({ shown: all, hidden: 0 });
    expect(untucked(all, [epic.id]).hidden).toBe(1);
    expect(ids(untucked(all, [epic.id]))).not.toContain(a.id);
    expect(ids(untucked(all, [epic.id]))).toContain(c.id);
    expect(untucked(all.filter((i) => i.id !== epic.id), [epic.id]).hidden).toBe(0);
    expect(untucked(all, [epic.id], 'A').hidden).toBe(0);
    expect(toggleTuck(toggleTuck([], epic.id), epic.id)).toEqual([]);
  });

  it('counts a project’s open tasks per scope, for everyone or someone', () => {
    const { store, b } = board();
    b.create({ projectId: 'api', title: 'A', assignee: { kind: 'person', id: 'p-me', name: 'Kay' }, status: 'in_progress' }, me);
    b.create({ projectId: 'api', title: 'B', status: 'backlog' }, me);
    b.create({ projectId: 'api', title: 'C', status: 'done' }, me);
    const s = store.getState().board;
    expect(scopeCounts(s, 'api', '', 'p-me')).toEqual({ active: 1, backlog: 1, all: 2, archived: 0 });
    expect(scopeCounts(s, 'api', 'person:p-me', 'p-me')).toEqual({ active: 1, backlog: 0, all: 1, archived: 0 });
    expect(scopeCounts(s, 'api', 'nobody', 'p-me')).toEqual({ active: 0, backlog: 1, all: 1, archived: 0 });
  });

  it('never mixes projects', () => {
    const { store, b } = board();
    store.dispatch({ type: 'projects', projects: [...store.getState().projects, { id: 'land', name: 'landing', root: '/tmp/l', base: 'main', workspaces: [] }] });
    b.create({ projectId: 'api', title: 'Api task' }, me);
    b.create({ projectId: 'land', title: 'Landing task' }, me);
    expect(scoped(store.getState().board, { scope: 'all', project: 'land', who: '' }, 'p-me').map((i) => i.title)).toEqual(['Landing task']);
  });

  it('opens on the project asked for, else the one you were in, else the busiest', () => {
    const { store, b } = board();
    const projects = [{ id: 'api' }, { id: 'land' }];
    b.create({ projectId: 'api', title: 'x' }, me);
    const s = store.getState().board;
    expect(projectToShow(s, projects, 'land', 'api')).toBe('land');
    expect(projectToShow(s, projects, 'gone', 'land')).toBe('land');
    expect(projectToShow(s, projects, undefined, '')).toBe('api');
    expect(projectToShow(s, [], undefined, '')).toBeUndefined();
  });

  it('alone on a project: no one else around and nothing for anyone else', () => {
    const { store, b } = board();
    b.create({ projectId: 'api', title: 'Mine', assignee: { kind: 'person', id: 'p-me', name: 'Kay' } }, me);
    expect(isSolo(store.getState().board, 'api', 'p-me', 0)).toBe(true);
    expect(isSolo(store.getState().board, 'api', 'p-me', 2)).toBe(false);
    b.create({ projectId: 'api', title: 'Theirs', assignee: { kind: 'person', id: 'p-bob', name: 'bob' } }, me);
    expect(isSolo(store.getState().board, 'api', 'p-me', 0)).toBe(false);
  });

  it('the people a project’s tasks are for: you first', () => {
    const { store, b } = board();
    const bob = { kind: 'person' as const, id: 'p-bob', name: 'bob' };
    const t1 = b.create({ projectId: 'api', title: 'A', assignee: bob }, me);
    b.create({ projectId: 'api', title: 'B', assignee: { kind: 'person', id: 'p-me', name: 'Kay' } }, me);
    b.create({ projectId: 'api', title: 'C' }, me);
    const s = store.getState().board;
    expect(assigneesIn(s, 'api', 'p-me').map((p) => p.label)).toEqual(['You', 'bob']);
    expect(isFor(b.need(t1.key), 'person:p-bob')).toBe(true);
    expect(isFor(b.need(t1.key), 'nobody')).toBe(false);
  });

  it('who is on a task now, apart from who it is for: you first, teammates, whose Claude is at work (BLG-278)', () => {
    const me = { id: 'p-me', name: 'Kay' };
    expect(onIt(me, { here: false, running: false }, [])).toEqual([]);
    const both = onIt(me, { here: true, running: true }, [{ peerId: 'p-me', name: 'Kay' }, { peerId: 'p-ata', name: 'ata' }]);
    expect(both.map((p) => [p.name, p.you, p.running])).toEqual([['Kay', true, true], ['ata', false, false]]);
    expect(onItWords(both)).toBe('You and ata · working');
    expect(onItWords(onIt(me, { here: false, running: false }, [{ peerId: 'p-ata', name: 'ata' }]))).toBe('ata · on it');
    expect(onItWords(onIt(me, { here: false, running: false }, [{ peerId: 'a', name: 'a' }, { peerId: 'b', name: 'b' }, { peerId: 'c', name: 'c' }]))).toBe('a, b and 1 more · on it');
    expect(onItTip(both[0]!, 'Running npm test')).toBe('Your Claude is working: Running npm test');
    expect(onItTip({ ...both[1]!, running: true })).toBe('ata’s Claude is working on it');
  });

  it('offers you, then people, never a Claude (BLG-278)', () => {
    const choices = assigneeChoices({ id: 'p-me', name: 'Kay' }, [
      { id: 'p-mia', name: 'mia' },
      { id: 'p-bob', name: 'bob' },
      { id: 'p-me', name: 'Kay' },
    ]);
    expect(choices.map((c) => c.label)).toEqual(['You', 'bob', 'mia']);
    expect(choices.every((c) => c.assignee.kind === 'person')).toBe(true);
    expect(assigneeKey(choices[0]!.assignee)).toBe('person:p-me');
    expect(assigneeKey(undefined)).toBe('');
  });

  it('keeps someone a task is already for in the list, even off the team (BLG-299)', () => {
    const choices = assigneeChoices({ id: 'p-me', name: 'Kay' }, [{ id: 'p-mia', name: 'mia' }], { kind: 'person', id: 'p-old', name: 'old' });
    expect(choices.map((c) => c.label)).toEqual(['You', 'mia', 'old']);
  });

  it('gives a project’s tasks only to you or its teammates (BLG-299)', () => {
    const team = { ...NO_TEAM, enabled: true, teams: { api: { projectId: 'api', repo: 'acme/api', mates: [{ peerId: 'p-ata', name: 'ata', since: 1 }] } } };
    expect(canAssign(team, 'api', 'p-me', 'p-ata')).toBe(true);
    expect(canAssign(team, 'api', 'p-me', 'p-me')).toBe(true);
    expect(canAssign(team, 'api', 'p-me', undefined)).toBe(true);
    expect(canAssign(team, 'api', 'p-me', 'p-mia')).toBe(false);
    expect(canAssign(team, 'web', 'p-me', 'p-ata')).toBe(false);
  });

  it('draws what waits on what: parents as boxes, blockers in the problem color until done', () => {
    const { store, b } = board();
    const epic = b.create({ projectId: 'api', title: 'Epic' }, me);
    const a = b.create({ projectId: 'api', title: 'A', parent: epic.key, status: 'done' }, me);
    const c = b.create({ projectId: 'api', title: 'C', parent: epic.key, blockedBy: [a.key] }, me);
    const d = b.create({ projectId: 'api', title: 'D', blockedBy: [c.key] }, me);
    b.create({ projectId: 'api', title: 'Alone' }, me);
    const s = store.getState().board;
    const tied = connected(s, s.issues);
    expect(tied.map((i) => i.title)).toEqual(['Epic', 'A', 'C', 'D']);
    const graph = taskGraph(s, tied);
    expect(graph.nodes.find((n) => n.id === epic.id)).toMatchObject({ type: 'group', tag: epic.key });
    expect(graph.nodes.find((n) => n.id === c.id)).toMatchObject({ group: epic.id, status: 'todo' });
    expect(graph.nodes.find((n) => n.id === d.id)).toMatchObject({ status: 'blocked' });
    expect(graph.edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      [a.id, c.id, 'depends'],
      [c.id, d.id, 'blocks'],
    ]);
    // A real klaud-graph: it parses with nothing left out.
    const parsed = parseGraph(JSON.stringify(graph));
    expect(parsed.ok && parsed.warnings).toEqual([]);
  });
});

describe('words', () => {
  it('due dates', () => {
    const now = new Date(2026, 9, 19, 15).getTime();
    expect(dueText('2026-10-19', now)).toEqual({ text: 'Today', late: false });
    expect(dueText('2026-10-20', now)).toEqual({ text: 'Tomorrow', late: false });
    expect(dueText('2026-10-22', now)).toEqual({ text: 'In 3 days', late: false });
    expect(dueText('2026-10-18', now)).toEqual({ text: '1 day late', late: true });
    expect(dueText('2026-10-10', now)).toEqual({ text: '9 days late', late: true });
  });

  it('checklists: counted, and ticked one at a time', () => {
    const text = '- [x] One\n- [ ] Two\nnote\n* [ ] Three';
    expect(checklist(text)).toEqual({ done: 1, deferred: 0, notDone: 0, open: 2, total: 3 });
    expect(toggleCheck(text, 1)).toBe('- [x] One\n- [x] Two\nnote\n* [ ] Three');
    expect(toggleCheck(text, 0)).toBe('- [ ] One\n- [ ] Two\nnote\n* [ ] Three');
    expect(checklist(undefined)).toMatchObject({ done: 0, total: 0 });
  });
});

describe('the demo’s Claude', () => {
  it('keeps the task it’s doing true: a note, a decision, notes for the next agent', async () => {
    const { store, b } = board();
    const work = new BoardWork({ store, board: b, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
    const issue = b.create({ projectId: 'api', title: 'Auth' }, me);
    b.linkWorktree(issue.key, 'w1', {}, me);
    const tools = work.forRun('ws:w1', 'p-me')!.tools!;
    const events: string[] = [];
    await createMockBackend({} as RoomBridge, 0).run({
      prompt: 'implement the auth middleware',
      requesterName: 'Kay',
      viaAgent: false,
      context: [],
      scope: 'folder',
      signal: new AbortController().signal,
      onEvent: (_k, t) => events.push(t),
      onFileTouched: () => undefined,
      canUseTool: async () => true,
      board: tools,
    });
    const now = b.need(issue.key);
    expect(events).toContain('task_note BOB-1');
    expect(now.brief.decisions).toContain('middleware');
    expect(now.brief.handoff).toContain('Next:');
    expect(now.activity.filter((a) => a.by.kind === 'claude')).toHaveLength(3);
  });
});
