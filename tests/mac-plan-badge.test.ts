import { describe, expect, it } from 'vitest';
import { NO_BOARD, type Issue } from '../src/core/board/model.js';
import { normalizeBody } from '../src/core/plans/edit.js';
import type { Plan } from '../src/core/plans/model.js';
import type { Action, AppState } from '../src/core/store.js';
import { type ScreenAction, attentionOf, initialAppState, initialScreen, reduceApp } from '../src/client/screen.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { planRowSignal, planSignal } from '../packages/mac/src/layout/attention-model.js';

/** The plan's row in the sidebar counts only what's new at the plan's level, never its tasks' worktrees summed up (BLG-12). */

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w', projectRoot: '/p', name: 'w', path: '/wt/w', kind: 'worktree', branch: 'klaud/w', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over,
});
const api: Project = {
  id: 'p1', name: 'api', root: '/p', base: 'origin/main',
  workspaces: [ws({ id: 'main', name: 'main', kind: 'main' }), ws({ id: 'home', name: 'Plan: Checkout', kind: 'chat' }), ws({ id: 't1', name: 'checkout-auth' }), ws({ id: 't2', name: 'checkout-events' })],
};
const issue = (id: string, key: string, wt: string): Issue =>
  ({ id, key, number: 1, projectId: 'p1', title: id, status: 'in_progress', priority: 'medium', labels: [], blockedBy: [], related: [], rank: 0, brief: {}, revisions: [], worktrees: [wt] }) as unknown as Issue;
const body = normalizeBody({ title: 'Checkout', goal: 'g', milestones: [{ id: 'm', title: 'M', tasks: [{ id: 'a', title: 'A', issueId: 'ia' }, { id: 'b', title: 'B', issueId: 'ib' }] }] });
const plan: Plan = { id: 'pl', projectId: 'p1', home: 'ws:home', status: 'active', body, draftRev: 1, autonomy: 'gated', maxParallel: 3, paused: false, testsAt: 'end', runs: {}, activity: [], createdAt: 0, updatedAt: 0 };

const apply = (s: AppState, ...actions: Array<Action | ScreenAction>): AppState => actions.reduce<AppState>((st, a) => reduceApp(st, a), s);
let n = 0;
const said = (channel: string): Action => ({ type: 'agent_event', owner: 'me', requestId: `r${++n}`, requester: 'me', event: 'done', text: 'All set.', ts: 5, channel });
const base = (): AppState => {
  const s = apply(initialAppState('room'), { type: 'welcome', self: { peerId: 'me', name: 'kay', agent: true, shares: [] } }, { type: 'projects', projects: [api] }, { type: 'view', view: { kind: 'overview' } });
  return { ...s, plans: { enabled: true, plans: [plan], style: '' }, board: { ...NO_BOARD, issues: [issue('ia', 'KLD-11', 't1'), issue('ib', 'KLD-12', 't2')] } };
};
/** A busy plan: its tasks' Claudes said a lot (120 messages), its own conversation nothing. */
const busy = (): AppState => apply(base(), ...Array.from({ length: 60 }, () => said('ws:t1')), ...Array.from({ length: 60 }, () => said('ws:t2')));

describe('the plan row’s badge', () => {
  it('news only in its tasks: no count (not 99+), a quiet dot', () => {
    const s = busy();
    expect(planSignal(s, plan).unread).toBe(120);
    const row = planRowSignal(s, plan);
    expect(row).toMatchObject({ unread: 0, inside: true, level: 'idle' });
    expect(row.tip).toBe('New in its tasks');
  });

  it('counts what’s new in the plan’s own conversation', () => {
    const s = apply(busy(), said('ws:home'), said('ws:home'));
    expect(planRowSignal(s, plan)).toMatchObject({ unread: 2, inside: true, level: 'unread', tip: '2 new messages' });
  });

  it('nothing new anywhere: nothing shows', () => {
    expect(planRowSignal(base(), plan)).toMatchObject({ unread: 0, inside: false, level: 'idle', tip: '' });
  });

  it('a task that needs you still makes the row need you, by name, without a count', () => {
    const s = apply(busy(), { type: 'question_add', question: { qid: 'q1', requestId: 'r9', owner: 'me', channel: 'ws:t2', picked: {}, question: { kind: 'question', questions: [{ question: 'Which?', header: '', options: [], multiSelect: false }] } } });
    expect(planRowSignal(s, plan)).toMatchObject({ level: 'needs', need: 'question', unread: 0, tip: 'KLD-12 asks a question' });
  });
});

describe('opening the plan clears it', () => {
  it('its page shows its conversation and its tasks’: their news is seen (only its own is in front)', () => {
    const s = apply(busy(), said('ws:home'));
    expect(attentionOf({ ...initialScreen, view: { kind: 'plan', id: 'pl' } }, s)).toEqual({ shown: ['ws:home', 'ws:t1', 'ws:t2'], visible: ['ws:home'], files: false, front: true });
    const opened = apply(s, { type: 'view', view: { kind: 'plan', id: 'pl' } });
    expect(planRowSignal(opened, plan)).toMatchObject({ unread: 0, inside: false });
    expect(planSignal(opened, plan).unread).toBe(0);
    // While it's open, what its tasks say isn't counted either.
    expect(planRowSignal(apply(opened, said('ws:t1'), said('ws:home')), plan)).toMatchObject({ unread: 0, inside: false });
  });

  it('a plan that isn’t there shows no conversation', () => {
    expect(attentionOf({ ...initialScreen, view: { kind: 'plan', id: 'nope' } }, base()).shown).toEqual([]);
  });
});
