import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import { normalizeBody } from '../src/core/plans/edit.js';
import { Plans } from '../src/core/plans/plans.js';
import { planView } from '../src/core/plans/progress.js';
import { PlansWork } from '../src/core/plans/work.js';
import { PlanDecisions, answerText, awaitingYou, decisionQid, decisionQuestion, isDecisionQid, parseDecisionQid } from '../src/core/plans/decisions.js';
import { QuestionBroker } from '../src/core/questions.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { taskInput } from '../src/agent/plan-tools.js';

/** BLG-11: a plan task that's yours is a decision in the plan's conversation, never a worktree. */

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree', extra: Partial<Workspace> = {}): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `klaud/${name}`, createdAt: 0, external: false, ...extra }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

const BODY: BodyInput = {
  title: 'Payments',
  goal: 'Take payments',
  milestones: [
    {
      id: 'setup',
      title: 'Set up',
      criteria: [],
      tasks: [
        { id: 'providers', title: 'Pick the providers', assignee: 'me', decision: { question: 'Which providers at launch?', options: [{ label: 'Stripe' }, { label: 'Apple Pay', description: 'Cards in Wallet' }, { label: 'PayPal' }], multi: true } },
        { id: 'keys', title: 'Live keys', assignee: 'me', acceptance: ['Keys in the keychain'] },
        { id: 'checkout', title: 'Checkout page', blockedBy: ['providers'] },
      ],
    },
  ],
};

function setup() {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api')] });
  let n = 0;
  const made: string[] = [];
  const add = (w: Workspace): void => store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === w.projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
  const controller = {
    onWorktree: () => () => undefined,
    newWorktree: async (projectId: string, name: string) => {
      made.push(name);
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
  const asked: Array<{ prompt: string; channel: string }> = [];
  // As launch.ts wires it: the pilot's forYou hook puts the cards up at once.
  let decisions: PlanDecisions | undefined;
  const forYou: string[] = [];
  const work = new PlansWork({
    store,
    plans,
    board: boardWork,
    controller,
    askClaude: (prompt, channel) => void asked.push({ prompt, channel }),
    intend: () => undefined,
    delayMs: 0,
    git: null,
    forYou: (_plan, tasks) => {
      forYou.push(...tasks.map((t) => t.task.id));
      decisions?.sync(true);
    },
  });
  const questions = new QuestionBroker({ store, selfId: () => 'p-me', send: () => true, timeoutMs: () => 60_000, toast: () => undefined });
  let scheduled = 0;
  decisions = new PlanDecisions({
    store,
    plans,
    board: boardWork,
    questions,
    askClaude: (prompt, channel) => void asked.push({ prompt, channel }),
    schedule: () => {
      scheduled++;
      work.pilot.schedule();
    },
  });
  return { store, board, plans, work, questions, decisions: decisions!, asked, made, forYou, scheduled: () => scheduled };
}

async function approved(t: ReturnType<typeof setup>) {
  const plan = await t.work.create({ projectId: 'api', goal: 'Take payments' });
  t.work.forRun(plan.home, 'p-me')!.tools!.write(BODY);
  t.work.approve(plan.id);
  await tick(5);
  return t.plans.need(plan.id);
}

describe('decision ids', () => {
  it('name the plan and the task, and nothing else reads as one', () => {
    const qid = decisionQid('pl_1', 'auth-api');
    expect(isDecisionQid(qid)).toBe(true);
    expect(parseDecisionQid(qid)).toEqual({ plan: 'pl_1', task: 'auth-api' });
    expect(isDecisionQid('3f2a-uuid')).toBe(false);
    expect(parseDecisionQid('decide:nope')).toBeUndefined();
  });
});

describe('a plan task’s decision as Claude writes it', () => {
  it('is kept for a task of yours (trimmed, options deduplicated, at most 6), and dropped for Claude’s', () => {
    const body = normalizeBody({
      title: 'P',
      goal: '',
      milestones: [
        {
          title: 'M',
          tasks: [
            { id: 'a', title: 'A', assignee: 'me', decision: { question: '  Which?  ', options: [{ label: 'x' }, { label: 'x' }, ...'abcdefgh'.split('').map((label) => ({ label }))] } },
            { id: 'b', title: 'B', decision: { question: 'Ignored', options: [] } },
          ],
        },
      ],
    });
    const [a, b] = body.milestones[0]!.tasks;
    expect(a!.decision!.question).toBe('Which?');
    expect(a!.decision!.options.map((o) => o.label)).toEqual(['x', 'a', 'b', 'c', 'd', 'e']);
    expect(b!.decision).toBeUndefined();
  });

  it('comes through the plan tools', () => {
    expect(taskInput({ title: 'T', assignee: 'me', decision: { question: 'Q?', options: [{ label: 'One' }], multi: true } })).toMatchObject({ decision: { question: 'Q?', options: [{ label: 'One' }], multi: true } });
  });
});

describe('the decision card', () => {
  it('asks the plan’s question with its options, and falls back to Done / Not needed', async () => {
    const t = setup();
    const plan = await approved(t);
    const view = planView(plan, t.store.getState().board);
    const [providers, keys] = awaitingYou(view);
    expect([providers?.task.id, keys?.task.id]).toEqual(['providers', 'keys']);
    const q = decisionQuestion(providers!).questions[0]!;
    expect(q.question).toContain('Which providers at launch?');
    expect(q.options.map((o) => o.label)).toEqual(['Stripe', 'Apple Pay', 'PayPal']);
    expect(q.multiSelect).toBe(true);
    expect(q.header).toMatch(/· Your call$/);
    const fallback = decisionQuestion(keys!).questions[0]!;
    expect(fallback.options.map((o) => o.label)).toEqual(['Done', 'Not needed']);
    expect(fallback.options[0]!.description).toContain('Keys in the keychain');
    expect(fallback.multiSelect).toBe(false);
  });

  it('reads your answer: picks or your own words, nothing for a skip or an empty pick', () => {
    expect(answerText({ kind: 'answers', answers: { q: 'Stripe, PayPal' } })).toBe('Stripe, PayPal');
    expect(answerText({ kind: 'answers', answers: { q: '  my own idea ' } })).toBe('my own idea');
    expect(answerText({ kind: 'answers', answers: { q: '(none)' } })).toBeUndefined();
    expect(answerText({ kind: 'skip' })).toBeUndefined();
  });
});

describe('a task of yours in a running plan', () => {
  it('never makes a worktree: a card waits in the plan’s conversation, and Start says so', async () => {
    const t = setup();
    const plan = await approved(t);
    await tick(10);
    expect(t.made).toEqual([]);
    const cards = t.store.getState().questions.filter((q) => isDecisionQid(q.qid));
    expect(cards.map((q) => q.qid).sort()).toEqual([decisionQid(plan.id, 'keys'), decisionQid(plan.id, 'providers')].sort());
    expect(cards.every((q) => q.channel === plan.home)).toBe(true);
    // The pilot told us once each (its forYou hook), and no Claude took them.
    expect([...t.forYou].sort()).toEqual(['keys', 'providers']);
    await expect(t.work.startTask(plan.id, 'providers')).rejects.toThrow(/plan’s conversation/);
    const said = t.store.getState().log.filter((l) => l.type === 'system' && l.channel === plan.home).map((l) => (l as { text: string }).text);
    expect(said.some((s) => s.includes('“Pick the providers” is yours'))).toBe(true);
  });

  it('your answer goes on the task, the task is done, what waited on it starts, and the head Claude hears it', async () => {
    const t = setup();
    const plan = await approved(t);
    const qid = decisionQid(plan.id, 'providers');
    // A skip leaves it waiting: it's yours to answer.
    t.questions.answer(qid, { kind: 'skip' });
    expect(t.store.getState().questions.some((q) => q.qid === qid)).toBe(true);
    t.questions.answer(qid, { kind: 'answers', answers: { 'Which providers at launch?': 'Stripe, Apple Pay' } });
    expect(t.store.getState().questions.some((q) => q.qid === qid)).toBe(false);
    const issue = t.board.get(t.plans.need(plan.id).body!.milestones[0]!.tasks[0]!.issueId!)!;
    expect(issue.status).toBe('done');
    expect(issue.brief.decisions).toContain('Stripe, Apple Pay');
    expect(issue.activity.some((a) => a.body?.includes('Decided: Stripe, Apple Pay'))).toBe(true);
    expect(t.asked.some((a) => a.channel === plan.home && a.prompt.includes('Stripe, Apple Pay'))).toBe(true);
    expect(t.scheduled()).toBeGreaterThan(0);
    // The checkout task waited on it: now it's Claude's to start, in a worktree.
    await tick(20);
    expect(t.made.length).toBe(1);
  });

  it('a card nobody needs any more is taken back (the task was done on the board)', async () => {
    const t = setup();
    const plan = await approved(t);
    const keys = t.plans.need(plan.id).body!.milestones[0]!.tasks[1]!.issueId!;
    t.board.update(keys, { status: 'done' }, { kind: 'person', id: 'p-me' } as never);
    expect(t.store.getState().questions.some((q) => q.qid === decisionQid(plan.id, 'keys'))).toBe(false);
  });

  it('is asked again after a restart (the card isn’t saved; the plan is)', async () => {
    const t = setup();
    const plan = await approved(t);
    t.decisions.stop();
    expect(t.store.getState().questions.filter((q) => isDecisionQid(q.qid))).toEqual([]);
    const again = new PlanDecisions({ store: t.store, plans: t.plans, board: { me: () => ({ kind: 'person', id: 'p-me' }) as never, board: t.board }, questions: t.questions, askClaude: () => undefined, schedule: () => undefined });
    expect(t.store.getState().questions.filter((q) => isDecisionQid(q.qid)).length).toBe(2);
    again.stop();
    void plan;
  });
});

describe('cards Beluga puts up itself', () => {
  it('wait without a timeout, are answered here, and can be taken back', () => {
    const store = new Store(initialState('room'));
    const broker = new QuestionBroker({ store, selfId: () => 'p-me', send: () => true, timeoutMs: () => 1, toast: () => undefined });
    const got: unknown[] = [];
    broker.pose('decide:p:t', 'ws:home', { kind: 'question', questions: [{ question: 'Q?', header: '', options: [], multiSelect: false }] }, (a) => got.push(a));
    expect(store.getState().questions.map((q) => q.qid)).toEqual(['decide:p:t']);
    expect(broker.posing('decide:p:t')).toBe(true);
    broker.answer('decide:p:t', { kind: 'answers', answers: { 'Q?': 'yes' } });
    expect(got).toEqual([{ kind: 'answers', answers: { 'Q?': 'yes' } }]);
    expect(store.getState().questions).toEqual([]);
    broker.pose('decide:p:u', 'ws:home', { kind: 'question', questions: [{ question: 'Q?', header: '', options: [], multiSelect: false }] }, () => undefined);
    broker.withdraw('decide:p:u');
    expect(store.getState().questions).toEqual([]);
    expect(broker.posing('decide:p:u')).toBe(false);
  });
});
