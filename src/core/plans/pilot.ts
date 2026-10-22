import type { Actor } from '../board/model.js';
import type { BoardWork } from '../board/work.js';
import type { Action, Store } from '../store.js';
import { openMilestone } from './apply.js';
import { type Plan, openMilestones } from './model.js';
import type { Plans } from './plans.js';
import { FINISHED, type MilestoneView, type PlanView, type TaskState, type TaskView, liveFrom, planView, startable } from './progress.js';
import { checkPrompt, recapPrompt } from './prompt.js';

/**
 * The scheduler: runs approved plans as far as their autonomy allows. It starts what's ready
 * (never more than the plan's limit, never a blocked task, never twice), asks the head Claude to
 * check a milestone once its tasks are finished, passes it on autopilot when the check passed,
 * opens every milestone whose dependencies have passed (independent ones run side by side, each
 * with its own check and pass), and asks for a recap at the end. Claude can't get around it: starting
 * and passing go through here. It acts a moment after whatever changed (the board, a run, a plan).
 */

export interface PilotDeps {
  readonly store: Store;
  readonly plans: Plans;
  readonly work: BoardWork;
  /** Ask your Claude in a conversation; `echo: false` doesn't show the prompt as your message. */
  readonly askClaude: (prompt: string, channel: string, echo: boolean) => void;
  /** A quiet line in a conversation. */
  readonly system: (channel: string, text: string) => void;
  readonly delayMs?: number;
}

/** What changes can move a plan along. */
const WAKES = new Set(['board_issue', 'board_remove', 'plan_put', 'agent_event', 'question_add', 'question_remove', 'approval_add', 'approval_remove', 'projects']);

export class PlanPilot {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Board tasks being started now (a worktree takes a few seconds to make). */
  private readonly starting = new Set<string>();
  /** Board tasks that failed to start: not tried again by themselves (you can start them). */
  private readonly failed = new Set<string>();
  /** Board tasks whose Claude was nudged to finish (once each). */
  private readonly nudged = new Set<string>();
  private readonly recapped = new Set<string>();
  /** Milestones whose tasks were taken out of the Backlog (`plan:milestone`), once each. */
  private readonly opened = new Set<string>();
  /** Each plan's tasks as last seen (by plan task id): a task that comes back finished is written down once. */
  private readonly seen = new Map<string, ReadonlyMap<string, TaskState>>();
  private readonly off: () => void;
  private stopped = false;

  constructor(private readonly deps: PilotDeps) {
    this.off = deps.store.onAction((a: Action) => {
      if (WAKES.has(a.type)) this.schedule();
    });
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.off();
    clearTimeout(this.timer);
  }

  schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, this.deps.delayMs ?? 300);
    this.timer.unref?.();
  }

  /** A plan where it stands now. */
  view(plan: Plan): PlanView {
    const state = this.deps.store.getState();
    return planView(plan, state.board, liveFrom(state));
  }

  tick(): void {
    for (const plan of this.deps.plans.list()) {
      try {
        if (plan.status === 'active' && !plan.paused && !plan.draft) this.step(plan);
      } catch (err) {
        // Said once (a problem that stays would otherwise fill the history).
        const text = `couldn’t move the plan along: ${err instanceof Error ? err.message : String(err)}`;
        if (plan.activity.at(-1)?.text !== text) this.deps.plans.note(plan.id, 'problem', text, { kind: 'klaud' });
      }
    }
  }

  /** Start one task now (you, or the head Claude when you asked it). */
  async startNow(planId: string, taskId: string, by: Actor): Promise<string> {
    const plan = this.deps.plans.need(planId);
    if (plan.status !== 'active' || !plan.body) throw new Error('The plan isn’t approved yet');
    if (plan.draft) throw new Error('Changes to the plan are waiting for approval: approve or discard them first');
    const view = this.view(plan);
    const t = view.milestones.flatMap((m) => m.tasks).find((x) => x.task.id === taskId || x.issue?.key === taskId.toUpperCase());
    if (!t) throw new Error(`There's no task "${taskId}" in this plan`);
    // Claude starts nothing on a paused plan, nor on one you run step by step (you do).
    const autonomy = view.milestones.find((m) => m.milestone.id === t.milestoneId)?.autonomy ?? plan.autonomy;
    if (by.kind === 'claude' && (plan.paused || autonomy === 'step')) throw new Error(plan.paused ? 'The plan is paused: the user resumes it' : 'This plan runs step by step: the user starts each task');
    if (t.state !== 'ready') throw new Error(`“${t.task.title}” can’t start: ${t.why ?? t.state}`);
    if (view.active.length + this.startingIn(plan) >= plan.maxParallel) throw new Error(`${plan.maxParallel} tasks are already running (the plan’s limit)`);
    this.failed.delete(t.issue!.id);
    return this.start(plan, t, by);
  }

  /** Pass a milestone: those that waited on it open (their tasks come out of the Backlog), or the plan is done. */
  pass(planId: string, milestoneId: string, by: Actor): Plan {
    const before = this.deps.plans.need(planId);
    const passed = before.body?.milestones.find((m) => m.id === milestoneId);
    if (!passed) throw new Error('That milestone isn’t in the approved plan');
    const wasOpen = new Set(openMilestones(before));
    const after = this.deps.plans.pass(planId, milestoneId, by);
    const next = openMilestones(after)
      .filter((id) => !wasOpen.has(id))
      .map((id) => after.body!.milestones.find((m) => m.id === id)!);
    for (const m of next) this.open(after, m.id);
    if (next.length) {
      this.deps.system(after.home, `“${passed.title}” passed. Next: ${next.map((m) => `“${m.title}”`).join(', ')}${next.length > 1 ? ', side by side' : ''}.`);
    } else if (after.status !== 'done') {
      this.deps.system(after.home, `“${passed.title}” passed.`);
    } else if (!this.recapped.has(after.id)) {
      // The last one: the head Claude writes the recap.
      this.recapped.add(after.id);
      this.deps.askClaude(recapPrompt(this.view(after)), after.home, false);
    }
    this.schedule();
    return after;
  }

  /** A milestone's tasks come out of the Backlog (once a session: you can put one back). */
  private open(plan: Plan, milestoneId: string): void {
    const key = `${plan.id}:${milestoneId}`;
    if (this.opened.has(key)) return;
    this.opened.add(key);
    openMilestone(plan, milestoneId, this.deps.work.board, { kind: 'klaud' });
  }

  private step(plan: Plan): void {
    const view = this.view(plan);
    this.noteFinished(plan, view);
    if (!view.open.length) return;
    // Every open milestone runs side by side; the limit on tasks at once is the whole plan's.
    for (const m of view.open) this.open(plan, m.milestone.id);
    for (const t of startable(view, this.failed, this.startingIn(plan))) void this.start(plan, t, { kind: 'klaud' }).catch(() => undefined);
    if (view.open.some((m) => m.state === 'running' && m.autonomy === 'autopilot')) this.nudge(plan, view);
    for (const m of view.open) this.stepMilestone(plan, view, m);
  }

  /** One open milestone: a new round when work came back, its check when it's finished, its pass on autopilot. */
  private stepMilestone(plan: Plan, view: PlanView, m: MilestoneView): void {
    // Work came back to a milestone that was being checked: the next check is a new one.
    if (m.state === 'running' && m.run.checkAsked !== undefined) this.deps.plans.newRound(plan.id, m.milestone.id);
    if (m.state !== 'gate' && m.state !== 'checking') return;
    // Nothing to check: autopilot moves on, otherwise it's yours to pass.
    if (!m.milestone.criteria.length) {
      if (m.autonomy === 'autopilot') this.pass(plan.id, m.milestone.id, { kind: 'klaud' });
      return;
    }
    if (m.run.checkAsked === undefined) {
      // Asked first: if asking fails, the check isn't marked as asked (it's tried again).
      this.deps.askClaude(checkPrompt(view, m), plan.home, false);
      this.deps.plans.checkAsked(plan.id, m.milestone.id);
      this.deps.system(plan.home, `Every task of “${m.milestone.title}” is finished: Claude is checking its pass criteria.`);
      return;
    }
    const check = m.run.check;
    if (m.autonomy === 'autopilot' && check?.verdict === 'pass' && check.at >= m.run.checkAsked) this.pass(plan.id, m.milestone.id, check.by);
  }

  /** Tasks that came back finished since the last look go in the plan's activity (what was there at the first look doesn't). */
  private noteFinished(plan: Plan, view: PlanView): void {
    const tasks = view.milestones.flatMap((m) => m.tasks);
    const before = this.seen.get(plan.id);
    this.seen.set(plan.id, new Map(tasks.map((t) => [t.task.id, t.state])));
    if (!before) return;
    for (const t of tasks) {
      const was = before.get(t.task.id);
      if (!t.issue || (t.state !== 'review' && t.state !== 'done') || !was || FINISHED.has(was)) continue;
      const by = [...t.issue.activity].reverse().find((a) => a.kind === 'status')?.by ?? { kind: 'klaud' };
      this.deps.plans.note(plan.id, 'finished', `finished ${t.issue.key} “${t.task.title}”`, by);
    }
  }

  /** Board tasks of this plan being started right now. */
  private startingIn(plan: Plan): number {
    const mine = new Set((plan.body?.milestones ?? []).flatMap((m) => m.tasks.flatMap((t) => (t.issueId ? [t.issueId] : []))));
    return [...this.starting].filter((id) => mine.has(id)).length;
  }

  /** Check a milestone again (a check that never came back, or work fixed since): the head Claude is asked anew. */
  recheck(planId: string, milestoneId: string): void {
    this.deps.plans.newRound(planId, milestoneId);
    this.schedule();
  }

  private async start(plan: Plan, t: TaskView, by: Actor): Promise<string> {
    const issue = t.issue;
    if (!issue) throw new Error('That task isn’t on the board');
    if (this.starting.has(issue.id)) return `${issue.key} is starting`;
    this.starting.add(issue.id);
    try {
      await this.deps.work.start(issue.id, { claude: true, quiet: true, ...(t.base ? { base: t.base } : {}) });
      this.deps.plans.note(plan.id, 'started', `started ${issue.key} “${t.task.title}”${t.base ? ` from ${t.base}` : ''}`, by);
      return `Started ${issue.key} “${t.task.title}” in a new worktree${t.base ? ` from ${t.base}` : ''}`;
    } catch (err) {
      this.failed.add(issue.id);
      const why = err instanceof Error ? err.message : String(err);
      this.deps.plans.note(plan.id, 'problem', `couldn’t start ${issue.key}: ${why}`, { kind: 'klaud' });
      throw err;
    } finally {
      this.starting.delete(issue.id);
      this.schedule();
    }
  }

  /** On autopilot, a task whose Claude stopped without finishing gets one nudge to go on. */
  private nudge(plan: Plan, view: PlanView): void {
    const log = this.deps.store.getState().log;
    const autopilot = new Set(view.open.filter((m) => m.autonomy === 'autopilot').map((m) => m.milestone.id));
    for (const t of view.active) {
      if (!autopilot.has(t.milestoneId) || t.state !== 'idle' || !t.worktree || !t.issue || this.nudged.has(t.issue.id)) continue;
      const channel = `ws:${t.worktree}`;
      const last = [...log].reverse().find((l) => l.type === 'agent' && l.channel === channel);
      // Only after a run that ended normally (not stopped by you, not failed).
      if (!last || last.type !== 'agent' || last.status !== 'done') continue;
      this.nudged.add(t.issue.id);
      this.deps.askClaude(`The plan “${view.body?.title ?? ''}” runs on autopilot. Go on with ${t.issue.key} until every acceptance criterion is true; then commit, rewrite the handoff and call task_update with status in_review. If you're stuck on something only the user can decide, say so clearly.`, channel, false);
    }
    void plan;
  }
}
