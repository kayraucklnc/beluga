import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import { Plans } from '../src/core/plans/plans.js';
import { planView } from '../src/core/plans/progress.js';
import { PlansWork } from '../src/core/plans/work.js';
import { decisionQid } from '../src/core/plans/decisions.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { NotifySettings } from '../src/shared/settings-schema.js';
import { isNeed, isNeedId, isPreviewId, popupNeeds, popupRequests, previewItems } from '../packages/mac/src/gateway/popup-model.js';
import { chosenOf, planAskOf } from '../packages/mac/src/plans/plan-ask-model.js';
import { nextWords } from '../packages/mac/src/plans/plans-model.js';

/** BLG-9: the request pop-up also says when your own Claude, or a plan, needs you. */

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree', extra: Partial<Workspace> = {}): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `klaud/${name}`, createdAt: 0, external: false, ...extra }) as unknown as Workspace;
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const question = (q: string, options: string[] = [], multiSelect = false) => ({ kind: 'question' as const, questions: [{ question: q, header: '', options: options.map((label) => ({ label, description: '' })), multiSelect }] });

function setup() {
  const store = new Store(initialState('room'));
  const project: Project = { id: 'api', name: 'bob-api', root: '/tmp/bob-api', base: 'main', workspaces: [ws('w9', 'api', 'add-auth')] };
  store.dispatch({ type: 'projects', projects: [project] });
  let n = 0;
  const add = (w: Workspace): void => store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === w.projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
  const controller = {
    onWorktree: () => () => undefined,
    newWorktree: async (projectId: string, name: string) => {
      const w = ws(`w${++n}`, projectId, name);
      add(w);
      return w;
    },
    newChat: async (projectId: string, title: string) => {
      const w = ws(`c${++n}`, projectId, title, 'chat', { askOnly: true } as Partial<Workspace>);
      add(w);
      return w;
    },
    renameChat: async () => undefined,
  } as unknown as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: () => 'bob-api' });
  const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
  const plans = new Plans({ store, dir: null });
  const work = new PlansWork({ store, plans, board: boardWork, controller, askClaude: () => undefined, intend: () => undefined, delayMs: 0, git: null });
  return { store, board, plans, work, me: boardWork.me() };
}

describe('what your Claude needs, on the pop-up', () => {
  it('says what and where: a question with its choices, an approval, a plan to approve', () => {
    const t = setup();
    t.store.dispatch({ type: 'question_add', question: { qid: 'q1', requestId: 'r1', owner: 'p-me', channel: 'ws:w9', question: question('Which **database**?', ['Postgres', 'SQLite']), picked: {} } });
    t.store.dispatch({ type: 'question_add', question: { qid: 'q2', requestId: 'r2', owner: 'p-me', channel: 'ws:w9', question: { kind: 'plan', plan: 'Do it' }, picked: {} } });
    t.store.dispatch({ type: 'approval_add', approval: { id: 'a1', kind: 'tool', title: 'Your Claude wants to use Bash', detail: 'rm -rf build', channel: 'ws:w9' } });
    const needs = popupNeeds(t.store.getState(), { quiet: false });
    expect(needs.map((n) => [n.tag, n.title])).toEqual([
      ['plan', 'Claude has a plan in add-auth'],
      ['question', 'Claude asks in add-auth'],
      ['approval', 'Approval needed in add-auth'],
    ]);
    const q = needs.find((n) => n.tag === 'question')!;
    expect(q.body).toBe('Which database?');
    expect(q.options).toEqual(['Postgres', 'SQLite']);
    expect(q.channel).toBe('ws:w9');
    expect(needs.find((n) => n.tag === 'approval')!.body).toBe('Your Claude wants to use Bash: rm -rf build');
    expect(needs.every((n) => isNeed(n) && isNeedId(n.approval))).toBe(true);
  });

  it('a friend’s request stays theirs (Allow / Decline on its own card), never shown twice', () => {
    const t = setup();
    const approval = { id: 'ap1', kind: 'request' as const, title: 'mia wants', detail: '', peer: 'mia-peer-0001', task: 't_abcdefghijk' };
    t.store.dispatch({ type: 'approval_add', approval });
    const tasks = [{ id: 't_abcdefghijk', direction: 'received', peerId: 'mia-peer-0001', peerName: 'mia', kind: 'ask', ask: 'hi', needs: [], by: 'agent', state: 'awaiting_approval', steps: [], createdAt: 1, updatedAt: 1 }] as never;
    const st = { ...t.store.getState(), gateway: { ...t.store.getState().gateway, tasks } };
    expect(popupRequests(st.approvals, tasks, false)).toHaveLength(1);
    expect(popupNeeds(st, { quiet: false })).toEqual([]);
  });

  it('keeps quiet on Do Not Disturb, with the pop-up or "Claude needs you" off, and about what’s on screen', () => {
    const t = setup();
    t.store.dispatch({ type: 'question_add', question: { qid: 'q1', requestId: 'r1', owner: 'p-me', channel: 'ws:w9', question: question('Go?'), picked: {} } });
    const st = t.store.getState();
    expect(popupNeeds(st, { quiet: true })).toEqual([]);
    expect(popupNeeds({ ...st, prefs: { ...st.prefs, notify: { ...st.prefs.notify, popup: false } } }, { quiet: false })).toEqual([]);
    expect(popupNeeds({ ...st, prefs: { ...st.prefs, notify: { ...st.prefs.notify, needsYou: false } } }, { quiet: false })).toEqual([]);
    expect(popupNeeds(st, { quiet: false, showing: (c) => c === 'ws:w9' })).toEqual([]);
    expect(popupNeeds(st, { quiet: false, showing: (c) => c === 'ws:other' })).toHaveLength(1);
  });

  it('is on by default (Settings › Notifications)', () => {
    expect(NotifySettings.parse({}).popup).toBe(true);
  });

  it('a decision of yours in a plan reads as your call; a milestone waiting for you opens the plan', async () => {
    const t = setup();
    const plan = await t.work.create({ projectId: 'api', goal: 'Pay' });
    t.work.forRun(plan.home, 'p-me')!.tools!.write({ title: 'Payments', goal: '', milestones: [{ id: 'm1', title: 'Set up', criteria: [], tasks: [{ id: 'keys', title: 'Live keys', assignee: 'me' }] }] });
    t.work.approve(plan.id);
    await tick(5);
    t.store.dispatch({ type: 'question_add', question: { qid: decisionQid(plan.id, 'keys'), requestId: 'x', owner: 'p-me', channel: plan.home, question: question('**Live keys**', ['Done', 'Not needed']), picked: {} } });
    const [decision] = popupNeeds(t.store.getState(), { quiet: false });
    expect(decision).toMatchObject({ tag: 'decision', title: 'Payments: your call', body: 'Live keys', channel: plan.home });
    // Done on the board: the milestone waits for you to pass it.
    const issue = t.plans.need(plan.id).body!.milestones[0]!.tasks[0]!.issueId!;
    t.board.update(issue, { status: 'done' }, t.me);
    t.store.dispatch({ type: 'question_remove', qid: decisionQid(plan.id, 'keys') });
    expect(planView(t.plans.need(plan.id), t.store.getState().board).next.kind).toBe('pass');
    const [pass] = popupNeeds(t.store.getState(), { quiet: false });
    expect(pass).toMatchObject({ tag: 'milestone', title: 'Payments: “Set up” is ready for you', plan: plan.id, channel: plan.home });
    // Looking at the plan already: no card.
    expect(popupNeeds(t.store.getState(), { quiet: false, showing: (_c, p) => p === plan.id })).toEqual([]);
  });
});

describe('the pop-up’s preview (for when nobody else uses Beluga with you)', () => {
  it('shows a pretend friend’s request and a pretend decision, both marked as the preview', () => {
    const items = previewItems(5);
    expect(items).toHaveLength(2);
    expect(items.every((i) => isPreviewId(i.approval))).toBe(true);
    expect(items.filter(isNeed)).toHaveLength(1);
    expect(isPreviewId('ap1')).toBe(false);
  });
});

describe('answering in the plan’s conversation', () => {
  it('asks your decision first, then Claude’s question, only this conversation’s', () => {
    const qs = [
      { qid: 'q1', requestId: '', owner: 'me', channel: 'ws:home', question: question('Claude?'), picked: {} },
      { qid: 'decide:p:t', requestId: '', owner: 'me', channel: 'ws:home', question: question('Yours?'), picked: {} },
      { qid: 'q3', requestId: '', owner: 'me', channel: 'ws:else', question: question('Else?'), picked: {} },
      { qid: 'q4', requestId: '', owner: 'me', channel: 'ws:home', question: { kind: 'plan' as const, plan: 'x' }, picked: {} },
    ];
    expect(planAskOf(qs, 'ws:home')?.qid).toBe('decide:p:t');
    expect(planAskOf(qs.slice(0, 1), 'ws:home')?.qid).toBe('q1');
    expect(planAskOf(qs.slice(2), 'ws:home')).toBeUndefined();
  });

  it('reads a multi-select’s ticks so far', () => {
    expect([...chosenOf({ picked: { 'Q#multi': 'a\u0000b' } }, 'Q')]).toEqual(['a', 'b']);
    expect(chosenOf({ picked: {} }, 'Q').size).toBe(0);
  });

  it('the plan’s main button asks you to answer what’s yours, and starts only Claude’s', () => {
    const yours = { task: { id: 'k', title: 'Live keys' }, forYou: true } as never;
    const claude = { task: { id: 'c', title: 'Checkout' }, forYou: false } as never;
    expect(nextWords({ kind: 'start', tasks: [yours] }).title).toBe('Answer “Live keys”');
    expect(nextWords({ kind: 'start', tasks: [yours, yours] }).title).toBe('Answer 2 Decisions');
    expect(nextWords({ kind: 'start', tasks: [yours, claude] }).title).toBe('Start “Checkout”');
  });
});
