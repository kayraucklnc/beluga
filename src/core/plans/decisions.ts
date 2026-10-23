import type { ClaudeAnswer, ClaudeQuestion } from '../../protocol.js';
import type { Actor, BoardState, Issue } from '../board/model.js';
import type { Store } from '../store.js';
import { type Plan, planTitle } from './model.js';
import { FINISHED, type PlanView, type TaskState, type TaskView, planView } from './progress.js';

/**
 * A plan task that's yours (assignee "me": accounts, secrets, decisions) never gets a worktree.
 * When it's ready, Beluga asks you in the plan's conversation instead: a card with the question,
 * its options (pick one, or several) and room for your own words, which also raises the on-screen
 * pop-up. Your answer is written on the task (its Decisions and a comment), the task is done, and
 * what waited on it goes on; the head Claude hears what you decided.
 */

const PREFIX = 'decide:';

/** The card's id for one plan task (stable, so it's asked once and found again after a restart). */
export const decisionQid = (planId: string, taskId: string): string => `${PREFIX}${planId}:${taskId}`;

/** The plan and task a decision card is about (undefined: it's not a decision). */
export function parseDecisionQid(qid: string): { readonly plan: string; readonly task: string } | undefined {
  if (!qid.startsWith(PREFIX)) return undefined;
  const rest = qid.slice(PREFIX.length);
  const at = rest.indexOf(':');
  return at > 0 && at < rest.length - 1 ? { plan: rest.slice(0, at), task: rest.slice(at + 1) } : undefined;
}

export const isDecisionQid = (qid: string): boolean => parseDecisionQid(qid) !== undefined;

/** Not yours to answer yet: its milestone hasn't opened, or it waits on other tasks. */
const NOT_YET: ReadonlySet<TaskState> = new Set(['draft', 'later', 'blocked']);

/**
 * The plan's tasks that wait on your decision right now: yours, on the board, in an open milestone,
 * nothing left to wait on, never started in a worktree, not finished. None while the plan is paused.
 */
export function awaitingYou(view: PlanView): readonly TaskView[] {
  const { plan } = view;
  if (plan.status !== 'active' || !plan.body || plan.paused) return [];
  const open = new Set(view.open.map((m) => m.milestone.id));
  return view.milestones.flatMap((m) => m.tasks).filter((t) => t.forYou && t.issue && open.has(t.milestoneId) && !t.worktree && !t.issue.worktrees.length && !FINISHED.has(t.state) && !NOT_YET.has(t.state));
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** When the plan said nothing to choose from: it's done, or it isn't needed (your own words always fit too). */
function fallbackOptions(t: TaskView): Array<{ label: string; description: string }> {
  const done = t.task.acceptance.length ? `Done: ${t.task.acceptance.join('; ')}` : 'Done: the plan carries on';
  return [
    { label: 'Done', description: clip(done, 600) },
    { label: 'Not needed', description: 'Skip it: the plan carries on without it' },
  ];
}

/** The card a task of yours gets: the plan's question for it (or what the task is), and its options. */
export function decisionQuestion(t: TaskView): Extract<ClaudeQuestion, { kind: 'question' }> {
  const d = t.task.decision;
  const what = [`**${t.task.title}**`, t.task.goal ?? '', d?.question ?? (t.task.acceptance.length ? `Done when: ${t.task.acceptance.join('; ')}` : '')].filter(Boolean).join('\n\n');
  const options = d?.options.length ? d.options.map((o) => ({ label: clip(o.label, 200), description: clip(o.description ?? '', 600) })) : fallbackOptions(t);
  return {
    kind: 'question',
    questions: [{ question: clip(what, 1000), header: clip(t.issue?.key ? `${t.issue.key} · Your call` : 'Your call', 40), options: options.slice(0, 6), multiSelect: Boolean(d?.multi && d.options.length) }],
  };
}

/** What you answered, in words: the option(s) you picked, or what you wrote. */
export function answerText(answer: ClaudeAnswer): string | undefined {
  if (answer.kind !== 'answers') return undefined;
  const text = Object.values(answer.answers)
    .map((v) => v.trim())
    .filter((v) => v && v !== '(none)')
    .join('; ');
  return text || undefined;
}

/** The questions a card can ask about, by plan: every task of every running plan waiting on you. */
export function decisionsDue(plans: readonly Plan[], board: BoardState): Array<{ readonly qid: string; readonly plan: Plan; readonly task: TaskView }> {
  return plans.flatMap((plan) => (plan.status === 'active' && plan.body ? awaitingYou(planView(plan, board)).map((task) => ({ qid: decisionQid(plan.id, task.task.id), plan, task })) : []));
}

export interface PlanDecisionsDeps {
  readonly store: Store;
  readonly plans: { readonly list: () => readonly Plan[]; readonly get: (id: string) => Plan | undefined; note(id: string, kind: 'finished', text: string, by: Actor): unknown };
  readonly board: {
    readonly me: () => Actor;
    readonly board: {
      get(ref: string): Issue | undefined;
      editBrief(ref: string, section: 'decisions', text: string, by: Actor, opts: { readonly reason?: string; readonly mode?: 'append' }): unknown;
      comment(ref: string, text: string, by: Actor): unknown;
      update(ref: string, patch: { readonly status: 'done' }, by: Actor): unknown;
    };
  };
  readonly questions: { pose(qid: string, channel: string, question: ClaudeQuestion, onAnswer: (a: ClaudeAnswer) => void): void; withdraw(qid: string): void };
  /** Tell the plan's head Claude (queued behind what it's doing; not echoed as yours). */
  readonly askClaude: (prompt: string, channel: string) => void;
  /** Move the plan along now (what waited on the task can start). */
  readonly schedule: () => void;
}

/** Keeps a decision card up for every plan task that waits on you, and carries out your answer. */
export class PlanDecisions {
  private readonly asked = new Set<string>();
  private readonly told = new Set<string>();
  private seen: { plans: unknown; board: unknown } = { plans: undefined, board: undefined };
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: PlanDecisionsDeps) {
    this.unsubscribe = deps.store.subscribe(() => this.sync());
    this.sync();
  }

  stop(): void {
    this.unsubscribe();
    for (const qid of this.asked) this.deps.questions.withdraw(qid);
    this.asked.clear();
  }

  /** Ask what's due, take back what isn't any more. */
  sync(): void {
    const state = this.deps.store.getState();
    if (this.seen.plans === state.plans && this.seen.board === state.board) return;
    this.seen = { plans: state.plans, board: state.board };
    const due = decisionsDue(this.deps.plans.list(), state.board);
    const want = new Set(due.map((d) => d.qid));
    for (const qid of [...this.asked]) {
      if (want.has(qid)) continue;
      this.asked.delete(qid);
      this.deps.questions.withdraw(qid);
    }
    for (const d of due) {
      if (this.asked.has(d.qid)) continue;
      this.asked.add(d.qid);
      const { plan, task } = d;
      this.deps.questions.pose(d.qid, plan.home, decisionQuestion(task), (answer) => this.decided(plan.id, task.task.id, d.qid, answer));
      if (!this.told.has(d.qid)) {
        this.told.add(d.qid);
        this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `${task.issue?.key ?? task.task.id} “${task.task.title}” is yours: no worktree for it. Answer it here, and the plan carries on.`, level: 'info' });
      }
    }
  }

  /** Your answer: on the task, the task done, the plan moving on, and the head Claude told. */
  private decided(planId: string, taskId: string, qid: string, answer: ClaudeAnswer): void {
    this.asked.delete(qid);
    const plan = this.deps.plans.get(planId);
    const task = plan?.body?.milestones.flatMap((m) => m.tasks).find((t) => t.id === taskId);
    const issue = task?.issueId ? this.deps.board.board.get(task.issueId) : undefined;
    const text = answerText(answer);
    if (!plan || !task || !issue) return;
    if (!text) {
      // Nothing picked (an empty multi-select): it's asked again.
      this.seen = { plans: undefined, board: undefined };
      this.sync();
      return;
    }
    const me = this.deps.board.me();
    try {
      this.deps.board.board.editBrief(issue.id, 'decisions', `- ${text}`, me, { mode: 'append', reason: 'decided in the plan’s conversation' });
      this.deps.board.board.comment(issue.id, `Decided: ${text}`, me);
      this.deps.board.board.update(issue.id, { status: 'done' }, me);
      this.deps.plans.note(planId, 'finished', `${issue.key} decided: ${text}`, me);
    } catch (err) {
      this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `Couldn’t record your answer on ${issue.key}: ${err instanceof Error ? err.message : String(err)}`, level: 'error' });
      return;
    }
    this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `You decided ${issue.key} “${task.title}”: ${text}. It’s done, and what waited on it goes on.`, level: 'info' });
    this.deps.askClaude(
      [
        `The user decided ${issue.key} “${task.title}” (a task of theirs in the plan “${planTitle(plan)}”): ${text}`,
        '',
        'It’s marked done and what waited on it starts by itself. If the answer changes the plan, change it with plan_update, and tell running tasks it affects with plan_message_task. Otherwise answer with one short line.',
      ].join('\n'),
      plan.home,
    );
    this.deps.schedule();
  }
}
