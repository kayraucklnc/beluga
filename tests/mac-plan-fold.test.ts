import { describe, expect, it } from 'vitest';
import { NO_BOARD, type Issue } from '../src/core/board/model.js';
import { normalizeBody } from '../src/core/plans/edit.js';
import type { Plan } from '../src/core/plans/model.js';
import type { Action, AppState } from '../src/core/store.js';
import { type ScreenAction, initialAppState, reduceApp } from '../src/client/screen.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { dockCount, planSignal, projectTally, unreadEntries } from '../packages/mac/src/layout/attention-model.js';
import { overviewItems } from '../packages/mac/src/views/overview/overview-model.js';
import { confirmMerge, mergeNeedsWarning } from '../packages/mac/src/lib/plan-merge.js';

/** A running plan is one thing at the top level: one Unread entry, one tally, one Overview item (KLD-29). */

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w', projectRoot: '/p', name: 'w', path: '/wt/w', kind: 'worktree', branch: 'klaud/w', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over,
});
const api: Project = {
  id: 'p1', name: 'api', root: '/p', base: 'origin/main',
  workspaces: [ws({ id: 'main', name: 'main', kind: 'main' }), ws({ id: 'home', name: 'Plan: Checkout', kind: 'chat' }), ws({ id: 't1', name: 'checkout-auth' }), ws({ id: 't2', name: 'checkout-events' }), ws({ id: 't3', name: 'checkout-ui' }), ws({ id: 'solo', name: 'fix-typo' })],
};
const issue = (id: string, key: string, wt: string): Issue =>
  ({ id, key, number: 1, projectId: 'p1', title: id, status: 'in_progress', priority: 'medium', labels: [], blockedBy: [], related: [], rank: 0, brief: {}, revisions: [], worktrees: [wt] }) as unknown as Issue;
const body = normalizeBody({ title: 'Checkout', goal: 'g', milestones: [{ id: 'm', title: 'M', tasks: [{ id: 'a', title: 'A', issueId: 'ia' }, { id: 'b', title: 'B', issueId: 'ib' }, { id: 'c', title: 'C', issueId: 'ic' }] }] });
const plan: Plan = { id: 'pl', projectId: 'p1', home: 'ws:home', status: 'active', body, draftRev: 1, autonomy: 'gated', maxParallel: 3, paused: false, testsAt: 'end', runs: {}, activity: [], createdAt: 0, updatedAt: 0 };

const apply = (s: AppState, ...actions: Array<Action | ScreenAction>): AppState => actions.reduce<AppState>((st, a) => reduceApp(st, a), s);
const done = (channel: string, requestId: string): Action => ({ type: 'agent_event', owner: 'me', requestId, requester: 'me', event: 'done', text: 'All set.', ts: 5, channel });
const base = (): AppState => {
  const s = apply(initialAppState('room'), { type: 'welcome', self: { peerId: 'me', name: 'kay', agent: true, shares: [] } }, { type: 'projects', projects: [api] }, { type: 'view', view: { kind: 'overview' } });
  return { ...s, plans: { enabled: true, plans: [plan], style: '' }, board: { ...NO_BOARD, issues: [issue('ia', 'KLD-11', 't1'), issue('ib', 'KLD-12', 't2'), issue('ic', 'KLD-13', 't3')] } };
};
const answered = (): AppState => apply(base(), done('ws:t1', 'r1'), done('ws:t2', 'r2'), done('ws:t3', 'r3'));

describe('a running plan in Unread', () => {
  it('three task chats that got answers: one row for the plan, not three (nor four with its home)', () => {
    const list = unreadEntries(answered());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'plan', channel: 'plan:pl', name: 'Checkout', signal: { level: 'unread', unread: 3, tip: '3 updates' } });
    // The Dock counts it once too.
    expect(dockCount(answered())).toBe(1);
  });

  it('nothing new in it: it isn’t there', () => {
    expect(unreadEntries(base())).toEqual([]);
  });

  it('a task’s question makes the plan’s row need you, saying which task asks; opening goes to that task', () => {
    const s = apply(answered(), { type: 'question_add', question: { qid: 'q1', requestId: 'r9', owner: 'me', channel: 'ws:t2', picked: {}, question: { kind: 'question', questions: [{ question: 'Which?', header: '', options: [], multiSelect: false }] } } });
    const [entry] = unreadEntries(s);
    expect(entry).toMatchObject({ kind: 'plan', signal: { level: 'needs', need: 'question' }, at: { ws: 't2', task: 'b' } });
    expect(entry!.signal.tip).toBe('KLD-12 asks a question · 3 updates');
  });

  it('a conversation outside the plan still stands on its own', () => {
    const s = apply(answered(), done('ws:solo', 'r4'));
    expect(unreadEntries(s).map((e) => e.channel).sort()).toEqual(['plan:pl', 'ws:solo']);
  });
});

describe('a running plan in tallies and Overview', () => {
  it('the project counts the plan as one conversation with news', () => {
    expect(projectTally(answered(), api)).toMatchObject({ unread: 1, needs: 0 });
    expect(planSignal(answered(), plan).unread).toBe(3);
  });

  it('Overview lists the plan once (where its conversation is) and leaves its tasks’ worktrees out', () => {
    const items = overviewItems(answered());
    expect(items.map((i) => i.ws.id)).toEqual(['main', 'home', 'solo']);
    expect(items[1]!.plan).toMatchObject({ title: 'Checkout', unread: 3 });
  });

  it('once the plan is done, its worktrees are plain again', () => {
    const s = { ...answered(), plans: { enabled: true, plans: [{ ...plan, status: 'done' as const }], style: '' } };
    expect(unreadEntries(s)).toHaveLength(3);
    expect(overviewItems(s).some((i) => i.plan)).toBe(false);
  });
});

describe('merging a plan task’s worktree locally always warns first (⌘K, ⇧⌘M, toolbar, menus)', () => {
  it('a plan task asks (Merge Anyway); only the merge you confirmed goes through, once', () => {
    const s = base();
    expect(mergeNeedsWarning(s, 'solo')).toBe(false);
    expect(mergeNeedsWarning(s, 't1')).toBe(true);
    // Merge Anyway in the sheet (runPlanAction) confirms it, then dispatches the merge.
    confirmMerge('t1');
    expect(mergeNeedsWarning(s, 't1')).toBe(false);
    expect(mergeNeedsWarning(s, 't1')).toBe(true);
  });
});
