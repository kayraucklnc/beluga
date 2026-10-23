import type { CombineResult } from '../../workspaces/git.js';
import type { Actor, BoardState, Issue } from '../board/model.js';
import type { BoardWork } from '../board/work.js';
import type { Action, Store } from '../store.js';
import { openMilestone } from './apply.js';
import { type Plan, type PlanMerge, allTasks, openMilestones, planBranchName } from './model.js';
import type { PlanGit } from './plan-git.js';
import type { Plans } from './plans.js';
import { FINISHED, type MilestoneView, type PlanView, type TaskState, type TaskView, liveFrom, planView, startable, tidyOffer } from './progress.js';
import { checkPrompt, criteriaNeedCheck, fixupPrompt, mergeFixupPrompt, recapPrompt } from './prompt.js';
import { TaskWatchdog } from './watchdog.js';

/**
 * The scheduler: runs approved plans as far as their autonomy allows. It starts what's ready
 * (never more than the plan's limit, never a blocked task, never twice), asks the head Claude to
 * check a milestone once its tasks are finished, passes it on autopilot when the check passed,
 * opens every milestone whose dependencies have passed (independent ones run side by side, each
 * with its own check and pass), and asks for a recap at the end. A task that builds on several
 * unmerged tasks starts from their branches combined (a conflict there goes to the head Claude). Claude can't get around it: starting
 * and passing go through here. It acts a moment after whatever changed (the board, a run, a plan).
 *
 * With git (`git`), the plan owns a branch, plan/<slug> from main: every task starts from it as it is
 * then, a passed milestone's task branches merge into it (its tasks go Merged into Plan, their worktrees are
 * archived and their branches deleted), and the plan ends as one pull request into main, which
 * moves every Merged into Plan task to Done when it merges. Plans that ran before this catch up once.
 *
 * A started task whose Claude stopped without finishing is woken once, and waits for you when it
 * stops again soon after (see watchdog.ts); time alone can stall a turn, so it looks every minute.
 */

export interface PilotDeps {
  readonly store: Store;
  readonly plans: Plans;
  readonly work: BoardWork;
  /** Ask your Claude in a conversation; `echo: false` doesn't show the prompt as your message. Returns the request's id, when it can. */
  readonly askClaude: (prompt: string, channel: string, echo: boolean) => string | void;
  /** Steer a waiting message in now (the agent host's Steer Now: interrupts a long command or a dead run). */
  readonly promote?: (requestId: string) => boolean;
  /** A quiet line in a conversation. */
  readonly system: (channel: string, text: string) => void;
  /** Combine unmerged branches into the start of a task (its key): see WorkspaceManager.combineBase. */
  readonly combine?: (projectId: string, key: string, branches: readonly string[], into?: string) => Promise<CombineResult>;
  /** The plan's branch, merges into it, clearing merged worktrees away, its pull request. */
  readonly git?: PlanGit;
  /** Let a plan's conversation edit a hidden worktree (a conflict to fix there), or no longer (undefined). */
  readonly allowFixup?: (channel: string, dir: string | undefined) => void;
  /** Whether a run of Claude's is under way in a conversation: its Claude Code process is there (the agent runner's run state). */
  readonly alive?: (channel: string) => boolean;
  /** Stop what runs in a conversation; resolves once nothing does, with the messages that waited there. */
  readonly takeOver?: (channel: string) => Promise<readonly string[]>;
  readonly now?: () => number;
  readonly delayMs?: number;
  /** A run's events re-check its plans at most this often (they stream all the time): default 1 s, or delayMs when that's given. */
  readonly eventMs?: number;
}

/** How many times the head Claude is asked to fix one task's combining conflict before it waits for you. */
const FIXUP_ASKS = 2;
/** A conflict left to you is looked at again this often (it starts once no markers are left). */
const STUCK_RETRY_MS = 30_000;
/** How often a plan's pull request is looked at on GitHub. */
const PR_POLL_MS = 2 * 60_000;
/** How often started tasks are looked at when nothing else happens (a turn can stall in silence). */
const HEARTBEAT_MS = 60_000;


/** Why a milestone can't be merged yet: a task of it still being worked on (undefined: none). */
function stillWorking(m: MilestoneView): string | undefined {
  const words: Partial<Record<TaskState, string>> = { running: 'is running', asking: 'asks you something', idle: 'is still open', stalled: 'stopped without finishing' };
  const busy = m.tasks.filter((t) => t.issue && !t.issue.worktreeGone && words[t.state]);
  if (!busy.length) return undefined;
  const who = busy.map((t) => `${t.issue!.key} ${words[t.state]}`).join(', ');
  return `“${m.milestone.title}” can’t be merged yet: ${who}. Merging retires each task’s worktree and branch, so only tasks In Review are merged: let them finish (or stop them), then pass it.`;
}

/** pass() said no because a task is still being worked on: Autopilot waits for it instead of reporting a problem. */
class StillWorkingError extends Error {}

/** What changes can move a plan along. */
const WAKES = new Set(['board_issue', 'board_remove', 'plan_put', 'agent_event', 'question_add', 'question_remove', 'approval_add', 'approval_remove', 'projects']);
const EVENT_MS = 1000;
const WS_PREFIX = 'ws:';

/** The plans each conversation belongs to: a plan's home, and its tasks' worktrees. */
export function plansByChannel(plans: readonly Plan[], board: BoardState): Map<string, Set<string>> {
  const planOfIssue = new Map<string, string>();
  for (const plan of plans) for (const { task } of allTasks(plan.body)) if (task.issueId) planOfIssue.set(task.issueId, plan.id);
  const out = new Map<string, Set<string>>();
  const add = (channel: string, planId: string): void => void (out.get(channel) ?? out.set(channel, new Set()).get(channel)!).add(planId);
  for (const plan of plans) add(plan.home, plan.id);
  for (const issue of board.issues) {
    const planId = planOfIssue.get(issue.id);
    if (planId) for (const ws of issue.worktrees) add(`${WS_PREFIX}${ws}`, planId);
  }
  return out;
}

export class PlanPilot {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Board tasks being started now (a worktree takes a few seconds to make). */
  private readonly starting = new Set<string>();
  /** Board tasks that failed to start: not tried again by themselves (you can start them). */
  private readonly failed = new Set<string>();
  /** Started tasks whose Claude stopped without finishing: woken once, then yours. */
  private readonly watchdog: TaskWatchdog;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly recapped = new Set<string>();
  /** Milestones whose tasks were taken out of the Backlog (`plan:milestone`), once each. */
  private readonly opened = new Set<string>();
  /** Combining conflicts the head Claude was asked to fix, by board task: how often, and its conversation's last run before. */
  private readonly fixAsked = new Map<string, { readonly asks: number; readonly after?: string }>();
  /** When a conflict left to you was last looked at (by board task), and the timer to look again. */
  private readonly stuckTried = new Map<string, number>();
  private stuckTimer: ReturnType<typeof setTimeout> | undefined;
  /** Plans whose branch is being made, and those where that failed (they run without one). */
  private readonly branching = new Set<string>();
  private readonly noBranch = new Set<string>();
  /** Merges into a plan's branch under way (`plan:milestone`), one plan's at a time (its chain). */
  private readonly mergingNow = new Set<string>();
  private readonly mergeChain = new Map<string, Promise<void>>();
  private prTimer: ReturnType<typeof setInterval> | undefined;
  /** Each plan's tasks as last seen (by plan task id): a task that comes back finished is written down once. */
  private readonly seen = new Map<string, ReadonlyMap<string, TaskState>>();
  private readonly off: () => void;
  private stopped = false;
  /** What the next tick looks at: every plan, or only those whose conversations had run events. */
  private dueAll = false;
  private readonly duePlans = new Set<string>();
  private dueAt = 0;
  private lastTick = -Infinity;
  private channels?: { readonly plans: readonly Plan[]; readonly board: BoardState; readonly map: Map<string, Set<string>> };

  constructor(private readonly deps: PilotDeps) {
    this.watchdog = new TaskWatchdog({
      store: deps.store,
      plans: deps.plans,
      askClaude: deps.askClaude,
      system: deps.system,
      ...(deps.alive ? { alive: deps.alive } : {}),
      ...(deps.takeOver ? { takeOver: deps.takeOver } : {}),
      ...(deps.promote ? { promote: deps.promote } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.off = deps.store.onAction((a: Action) => {
      if (a.type === 'agent_event') this.onRunEvent(a.channel);
      else if (WAKES.has(a.type)) this.schedule();
    });
    this.schedule();
    this.heartbeat = setInterval(() => this.schedule(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    if (deps.git) {
      this.prTimer = setInterval(() => void this.pollPrs(), PR_POLL_MS);
      this.prTimer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    this.off();
    clearTimeout(this.timer);
    clearTimeout(this.stuckTimer);
    clearInterval(this.prTimer);
    clearInterval(this.heartbeat);
  }

  /** Look at every plan a moment from now. */
  schedule(): void {
    this.dueAll = true;
    this.arm(this.deps.delayMs ?? 300);
  }

  /** A run's event: its plans are looked at, at most once every eventMs (none, when it's no plan's). */
  private onRunEvent(channel: string | undefined): void {
    if (this.stopped) return;
    if (channel === undefined) this.dueAll = true;
    else {
      const ids = this.plansOf(channel);
      if (!ids?.size) return;
      for (const id of ids) this.duePlans.add(id);
    }
    const delay = this.deps.delayMs ?? 300;
    this.arm(Math.max(delay, this.lastTick + (this.deps.eventMs ?? this.deps.delayMs ?? EVENT_MS) - Date.now()));
  }

  private plansOf(channel: string): ReadonlySet<string> | undefined {
    const plans = this.deps.plans.list();
    const board = this.deps.store.getState().board;
    if (this.channels?.plans !== plans || this.channels.board !== board) this.channels = { plans, board, map: plansByChannel(plans, board) };
    return this.channels.map.get(channel);
  }

  /** Tick after `wait` (sooner if a tick is already due sooner). */
  private arm(wait: number): void {
    if (this.stopped) return;
    const at = Date.now() + wait;
    if (this.timer) {
      if (this.dueAt <= at) return;
      clearTimeout(this.timer);
    }
    this.dueAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.lastTick = Date.now();
      const only = this.dueAll ? undefined : new Set(this.duePlans);
      this.dueAll = false;
      this.duePlans.clear();
      this.tick(only);
    }, wait);
    this.timer.unref?.();
  }

  /** A plan where it stands now. */
  view(plan: Plan): PlanView {
    const state = this.deps.store.getState();
    return planView(plan, state.board, liveFrom(state));
  }

  /** Move the plans along (only those in `only`, when given). */
  tick(only?: ReadonlySet<string>): void {
    for (const plan of this.deps.plans.list()) {
      if (only && !only.has(plan.id)) continue;
      try {
        // Its branch, catching up, merges: paused or done, they go on (nothing new starts).
        if (plan.body && plan.status !== 'draft') this.tend(plan);
        // Started tasks that stopped without finishing: woken once, then they wait for you.
        if (plan.body && plan.status === 'active') this.watch(this.deps.plans.need(plan.id));
        if (plan.status === 'active' && !plan.paused && !plan.draft) this.step(this.deps.plans.need(plan.id));
      } catch (err) {
        // Said once (a problem that stays would otherwise fill the history).
        const text = `couldn’t move the plan along: ${err instanceof Error ? err.message : String(err)}`;
        if (plan.activity.at(-1)?.text !== text) this.deps.plans.note(plan.id, 'problem', text, { kind: 'beluga' });
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
    // A combine that stopped at a conflict: Start tries it again (fixed since, or asks anew).
    if (t.combining && t.issue) {
      this.fixAsked.delete(t.issue.id);
      this.deps.plans.setCombining(plan.id, t.task.id, { ...t.combining, ...(t.combining.conflict ? { conflict: { ...t.combining.conflict, stuck: false } } : {}) });
    } else if (t.state !== 'ready') throw new Error(`“${t.task.title}” can’t start: ${t.why ?? t.state}`);
    if (view.active.length + this.startingIn(plan) >= plan.maxParallel) throw new Error(`${plan.maxParallel} tasks are already running (the plan’s limit)`);
    this.failed.delete(t.issue!.id);
    return this.start(plan, t, by);
  }

  /**
   * Pass a milestone. With a plan branch, its task branches are merged into it first (it passes once
   * they're in); then those that waited on it open (their tasks come out of the Backlog), or the plan is done.
   */
  pass(planId: string, milestoneId: string, by: Actor): Plan {
    const plan = this.deps.plans.need(planId);
    if (!plan.body?.milestones.some((m) => m.id === milestoneId)) throw new Error('That milestone isn’t in the approved plan');
    if (plan.runs[milestoneId]?.passedAt) return plan;
    if (!this.deps.git || !plan.branch) return this.passed(planId, milestoneId, by);
    if (plan.merging?.[milestoneId]) return plan;
    // Merging retires its tasks' worktrees and branches: never while a Claude still works in one.
    const m = this.view(plan).milestones.find((x) => x.milestone.id === milestoneId);
    const busy = m ? stillWorking(m) : undefined;
    if (busy) throw new StillWorkingError(busy);
    const next = this.deps.plans.setMerging(planId, milestoneId, { at: Date.now(), by });
    this.schedule();
    return next;
  }

  /** It passed (its work is in the plan's branch, or there's none): what waited on it opens. */
  private passed(planId: string, milestoneId: string, by: Actor): Plan {
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
      // The last one: the head Claude writes the recap (and the plan offers its pull request).
      this.recapped.add(after.id);
      if (after.branch) this.deps.system(after.home, `Every milestone passed: ${after.branch} has all the plan’s work. Open its pull request into main, or merge it here, from the plan’s page.`);
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
    openMilestone(plan, milestoneId, this.deps.work.board, { kind: 'beluga' });
  }

  private step(plan: Plan): void {
    // Tasks start from the plan's branch: none starts before it's there.
    if (this.deps.git && !plan.branch && !this.noBranch.has(plan.id)) return;
    const view = this.view(plan);
    this.noteFinished(plan, view);
    if (!view.open.length) return;
    // Every open milestone runs side by side; the limit on tasks at once is the whole plan's.
    for (const m of view.open) this.open(plan, m.milestone.id);
    for (const t of startable(view, this.failed, this.startingIn(plan))) void this.start(plan, t, { kind: 'beluga' }).catch(() => undefined);
    this.stepCombining(plan, view);
    for (const m of view.open) this.stepMilestone(plan, view, m);
  }

  /** One open milestone: a new round when work came back, its check when it's finished, its pass on autopilot. */
  private stepMilestone(plan: Plan, view: PlanView, m: MilestoneView): void {
    if (m.state === 'merging') return;
    // Work came back to a milestone that was being checked: the next check is a new one.
    if (m.state === 'running' && m.run.checkAsked !== undefined) this.deps.plans.newRound(plan.id, m.milestone.id);
    if (m.state !== 'gate' && m.state !== 'checking') return;
    // Nothing to check (no pass criteria, and its tasks' criteria are all settled): autopilot moves on, otherwise it's yours to pass.
    if (!m.milestone.criteria.length && !criteriaNeedCheck(view, m)) {
      if (m.autonomy === 'autopilot') this.autoPass(plan.id, m.milestone.id, { kind: 'beluga' });
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
    if (m.autonomy === 'autopilot' && check?.verdict === 'pass' && check.at >= m.run.checkAsked) this.autoPass(plan.id, m.milestone.id, check.by);
  }

  /** Autopilot's pass: a task still being worked on (see stillWorking) leaves it for the next look. */
  private autoPass(planId: string, milestoneId: string, by: Actor): void {
    try {
      this.pass(planId, milestoneId, by);
    } catch (err) {
      // Not merged under a working Claude: tried again once it's In Review.
      if (err instanceof StillWorkingError) return;
      // Anything else is a real problem: said once in the plan's activity, not swallowed.
      const text = `couldn’t pass the milestone on Autopilot: ${err instanceof Error ? err.message : String(err)}`;
      const plan = this.deps.plans.get(planId);
      if (plan && plan.activity.at(-1)?.text !== text) this.deps.plans.note(planId, 'problem', text, { kind: 'beluga' });
    }
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
      const by = [...t.issue.activity].reverse().find((a) => a.kind === 'status')?.by ?? { kind: 'beluga' };
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

  /**
   * Combines that are under way across a restart, or stopped at a conflict: tried again once the
   * head Claude's fix-up run is over (or right away after a restart); gone once the task started.
   */
  private stepCombining(plan: Plan, view: PlanView): void {
    const combining = plan.combining ?? {};
    const tasks = view.milestones.flatMap((m) => m.tasks);
    const busy = liveFrom(this.deps.store.getState()).busy(plan.home);
    const last = this.lastRun(plan.home);
    for (const id of Object.keys(combining)) {
      const t = tasks.find((x) => x.task.id === id);
      if (t?.issue && this.starting.has(t.issue.id)) continue;
      // Started (or gone, or no longer waiting on several branches): nothing left to combine.
      if (!t?.issue || !t.combining || !t.bases) {
        this.deps.plans.setCombining(plan.id, id, undefined);
        continue;
      }
      const c = t.combining.conflict;
      if (c?.stuck) {
        // Yours to fix: looked at again now and then, and it starts once it's fixed.
        const wait = (this.stuckTried.get(t.issue.id) ?? c.at) + STUCK_RETRY_MS - Date.now();
        if (wait > 0) {
          this.wakeIn(wait);
          continue;
        }
        this.stuckTried.set(t.issue.id, Date.now());
      }
      // Asked to fix it: tried again once its run came and went.
      const asked = this.fixAsked.get(t.issue.id);
      if (c && asked && (busy || last === asked.after)) continue;
      void this.start(plan, t, { kind: 'beluga' }).catch(() => undefined);
    }
  }

  private wakeIn(ms: number): void {
    if (this.stuckTimer || this.stopped) return;
    this.stuckTimer = setTimeout(() => {
      this.stuckTimer = undefined;
      this.schedule();
    }, ms);
    this.stuckTimer.unref?.();
  }

  /**
   * The branch a task that builds on several unmerged tasks starts from: theirs combined. A conflict
   * goes to the head Claude to fix in the hidden worktree (→ undefined: tried again after).
   */
  private async combinedBase(plan: Plan, t: TaskView, issue: Issue): Promise<string | undefined> {
    const bases = t.bases ?? [];
    const issues = this.deps.store.getState().board.issues;
    const from = bases.map((b) => issues.find((i) => i.branch === b && i.projectId === issue.projectId)?.key ?? b);
    const was = this.deps.plans.need(plan.id).combining?.[t.task.id];
    if (!was) {
      this.deps.plans.note(plan.id, 'started', `combining ${from.join(' and ')} for ${issue.key} “${t.task.title}”`, { kind: 'beluga' });
      this.deps.plans.setCombining(plan.id, t.task.id, { at: Date.now(), from });
    }
    const combine = this.deps.combine;
    let res: CombineResult;
    try {
      if (!combine) throw new Error('combining branches needs the project’s folder');
      res = await combine(plan.projectId, issue.key, bases, plan.branch);
    } catch (err) {
      this.deps.plans.setCombining(plan.id, t.task.id, undefined);
      this.deps.allowFixup?.(plan.home, undefined);
      throw new Error(`couldn’t combine ${from.join(' and ')}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) {
      if (was?.conflict) this.deps.allowFixup?.(plan.home, undefined);
      this.fixAsked.delete(issue.id);
      this.stuckTried.delete(issue.id);
      return res.branch;
    }
    const asks = this.fixAsked.get(issue.id)?.asks ?? 0;
    const stuck = asks >= FIXUP_ASKS;
    const conflict = { at: was?.conflict?.stuck && stuck ? was.conflict.at : Date.now(), dir: res.dir, merging: res.merging, files: res.files, ...(stuck ? { stuck } : {}) };
    this.deps.plans.setCombining(plan.id, t.task.id, { at: was?.at ?? Date.now(), from, conflict });
    this.deps.allowFixup?.(plan.home, res.dir);
    if (!stuck) {
      const after = this.lastRun(plan.home);
      this.fixAsked.set(issue.id, { asks: asks + 1, ...(after ? { after } : {}) });
      if (!asks) this.deps.plans.note(plan.id, 'problem', `combining ${from.join(' and ')} for ${issue.key}: ${res.merging} conflicts in ${res.files.join(', ')}; Claude is fixing it`, { kind: 'beluga' });
      this.deps.askClaude(fixupPrompt(issue.key, t.task.title, from, res), plan.home, false);
    } else if (!was?.conflict?.stuck) {
      this.deps.plans.note(plan.id, 'problem', `combining ${from.join(' and ')} for ${issue.key}: the conflict in ${res.files.join(', ')} is still there; fix it in ${res.dir} and ${issue.key} starts`, { kind: 'beluga' });
    }
    return undefined;
  }

  /** The latest run in a conversation (its request id). */
  private lastRun(channel: string): string | undefined {
    const log = this.deps.store.getState().log;
    for (let i = log.length - 1; i >= 0; i--) {
      const l = log[i]!;
      if (l.type === 'agent' && l.channel === channel) return l.requestId;
    }
    return undefined;
  }

  private async start(plan: Plan, t: TaskView, by: Actor): Promise<string> {
    const issue = t.issue;
    if (!issue) throw new Error('That task isn’t on the board');
    if (this.starting.has(issue.id)) return `${issue.key} is starting`;
    this.starting.add(issue.id);
    try {
      const base = t.bases?.length ? await this.combinedBase(plan, t, issue) : t.base;
      if (t.bases?.length && !base) return `${issue.key} builds on several tasks: combining their branches hit a conflict, and Claude is fixing it`;
      await this.deps.work.start(issue.id, { claude: true, quiet: true, ...(base ? { base } : {}) });
      if (t.bases?.length) this.deps.plans.setCombining(plan.id, t.task.id, undefined);
      this.deps.plans.note(plan.id, 'started', `started ${issue.key} “${t.task.title}”${base ? ` from ${base}` : ''}`, by);
      return `Started ${issue.key} “${t.task.title}” in a new worktree${base ? ` from ${base}` : ''}`;
    } catch (err) {
      if (t.bases?.length && this.deps.plans.need(plan.id).combining?.[t.task.id]) this.deps.plans.setCombining(plan.id, t.task.id, undefined);
      this.failed.add(issue.id);
      const why = err instanceof Error ? err.message : String(err);
      this.deps.plans.note(plan.id, 'problem', `couldn’t start ${issue.key}: ${why}`, { kind: 'beluga' });
      throw err;
    } finally {
      this.starting.delete(issue.id);
      this.schedule();
    }
  }

  // ------------------------------------------------------------------ the plan's branch

  /** What goes on whether or not anything may start: its branch, catching up once, merges into it. */
  private tend(plan: Plan): void {
    if (!this.deps.git || this.noBranch.has(plan.id)) return;
    if (!plan.branch) {
      void this.makeBranch(plan);
      return;
    }
    // Catching up (merging and clearing away what passed before the branch) waits for your Yes: see tidyUp.
    this.stepMerges(this.deps.plans.need(plan.id));
  }

  /** plan/<slug> from main (one that's there already is the plan's, never made twice). */
  private async makeBranch(plan: Plan): Promise<void> {
    if (this.branching.has(plan.id)) return;
    this.branching.add(plan.id);
    const branch = planBranchName(plan);
    try {
      const { made } = await this.deps.git!.ensureBranch(plan.projectId, branch);
      this.deps.plans.setBranch(plan.id, branch, made);
    } catch (err) {
      // Without one the plan runs as before: tasks from main.
      this.noBranch.add(plan.id);
      this.deps.plans.note(plan.id, 'problem', `couldn’t make the plan’s branch ${branch}: ${err instanceof Error ? err.message : String(err)}; tasks start from main`, { kind: 'beluga' });
    } finally {
      this.branching.delete(plan.id);
      this.schedule();
    }
  }

  /**
   * Your answer to “Tidy up N merged task worktrees?” (see tidyOffer), asked once, never acted on by
   * itself (not on a restart either). Yes: each passed milestone whose tasks are still in review has
   * them merged into the branch (no second pass), then their worktrees archived and branches
   * deleted if merged; those already in main go to Done. No: nothing changes, and it isn't asked again.
   */
  tidyUp(planId: string, yes: boolean, by: Actor): Plan {
    const plan = this.deps.plans.need(planId);
    if (!plan.branch) throw new Error('The plan has no branch yet');
    if (yes) {
      const offer = new Set(tidyOffer(this.view(plan)).map((t) => t.milestoneId));
      for (const id of offer) this.deps.plans.setMerging(plan.id, id, { at: Date.now(), by, catchUp: true });
    }
    const next = this.deps.plans.setCaughtUp(plan.id);
    this.schedule();
    return next;
  }

  /** Merges waiting: started, or tried again once the head Claude's fix-up run came and went. */
  private stepMerges(plan: Plan): void {
    const busy = liveFrom(this.deps.store.getState()).busy(plan.home);
    const last = this.lastRun(plan.home);
    for (const [id, merge] of Object.entries(plan.merging ?? {})) {
      const key = `merge:${plan.id}:${id}`;
      if (this.mergingNow.has(key)) continue;
      const c = merge.conflict;
      if (c?.stuck) {
        const wait = (this.stuckTried.get(key) ?? c.at) + STUCK_RETRY_MS - Date.now();
        if (wait > 0) {
          this.wakeIn(wait);
          continue;
        }
        this.stuckTried.set(key, Date.now());
      }
      const asked = this.fixAsked.get(key);
      if (c && asked && (busy || last === asked.after)) continue;
      this.mergingNow.add(key);
      const prev = this.mergeChain.get(plan.id) ?? Promise.resolve();
      const run = prev
        .then(() => this.merge(plan.id, id))
        .catch(() => undefined)
        .finally(() => {
          this.mergingNow.delete(key);
          this.schedule();
        });
      this.mergeChain.set(plan.id, run);
    }
  }

  /** One milestone's task branches into the plan's branch; once they're in, it passes. */
  private async merge(planId: string, milestoneId: string): Promise<void> {
    const git = this.deps.git!;
    const plan = this.deps.plans.need(planId);
    const merge = plan.merging?.[milestoneId];
    const branch = plan.branch;
    if (!merge || !branch) return;
    const m = this.view(plan).milestones.find((x) => x.milestone.id === milestoneId);
    if (!m) {
      this.deps.plans.setMerging(planId, milestoneId, undefined);
      return;
    }
    const key = `merge:${planId}:${milestoneId}`;
    const beluga: Actor = { kind: 'beluga' };
    // A task started again since it was passed: its worktree isn't retired under its Claude.
    const busy = stillWorking(m);
    if (busy) {
      this.deps.plans.setMerging(planId, milestoneId, undefined);
      this.deps.plans.note(planId, 'problem', busy, beluga);
      return;
    }
    // Only tasks In Review (finished) are merged and retired.
    let tasks = m.tasks.filter((t) => t.issue?.branch && t.issue.worktrees.length && t.state === 'review');
    if (merge.catchUp) {
      const left: TaskView[] = [];
      for (const t of tasks) {
        if (await git.inMain(plan.projectId, t.issue!.branch!).catch(() => false)) this.deps.work.board.planMoved(t.issue!.id, 'done', 'its branch was already in main');
        else left.push(t);
      }
      tasks = left;
    }
    let res: CombineResult | undefined;
    if (tasks.length) {
      try {
        res = await git.mergeInto(plan.projectId, branch, tasks.map((t) => t.issue!.branch!));
      } catch (err) {
        // Not a conflict (a dirty checkout, no git identity): said once, and you pass it again.
        this.deps.plans.setMerging(planId, milestoneId, undefined);
        this.deps.allowFixup?.(plan.home, undefined);
        this.deps.plans.note(planId, 'problem', `couldn’t merge “${m.milestone.title}” into ${branch}: ${err instanceof Error ? err.message : String(err)}`, beluga);
        return;
      }
    }
    if (res && !res.ok) {
      const conflictKey = tasks.find((t) => t.issue!.branch === res.merging)?.issue?.key ?? res.merging;
      const asks = this.fixAsked.get(key)?.asks ?? 0;
      const stuck = asks >= FIXUP_ASKS;
      const was = merge.conflict;
      const conflict = { at: was?.stuck && stuck ? was.at : Date.now(), dir: res.dir, merging: res.merging, key: conflictKey, files: res.files, ...(stuck ? { stuck } : {}) };
      this.deps.plans.setMerging(planId, milestoneId, { ...merge, conflict });
      this.deps.allowFixup?.(plan.home, res.dir);
      if (!stuck) {
        const after = this.lastRun(plan.home);
        this.fixAsked.set(key, { asks: asks + 1, ...(after ? { after } : {}) });
        if (!asks) this.deps.plans.note(planId, 'problem', `merging “${m.milestone.title}” into ${branch}: ${conflictKey} conflicts in ${res.files.join(', ')}; Claude is fixing it`, beluga);
        this.deps.askClaude(mergeFixupPrompt(m.milestone.title, branch, conflictKey, res), plan.home, false);
      } else if (!was?.stuck) {
        this.deps.plans.note(planId, 'problem', `merging “${m.milestone.title}” into ${branch}: the conflict in ${res.files.join(', ')} is still there; fix it in ${res.dir} and the milestone passes`, beluga);
      }
      return;
    }
    // In: its tasks are Merged into Plan, the milestone passes, and their worktrees go.
    if (merge.conflict) this.deps.allowFixup?.(plan.home, undefined);
    this.fixAsked.delete(key);
    this.stuckTried.delete(key);
    for (const t of tasks) this.deps.work.board.planMoved(t.issue!.id, 'in_plan', `merged into ${branch}: “${m.milestone.title}” passed`);
    this.deps.plans.setMerging(planId, milestoneId, undefined);
    if (tasks.length) this.deps.plans.note(planId, 'passed', `merged ${tasks.map((t) => t.issue!.key).join(', ')} into ${branch}`, beluga);
    if (!merge.catchUp) this.passed(planId, milestoneId, merge.by);
    for (const t of tasks) {
      const ws = t.issue!.worktreeGone ? undefined : t.issue!.worktrees.at(-1);
      try {
        await git.retire(plan.projectId, ws, t.issue!.branch, branch);
      } catch (err) {
        this.deps.plans.note(planId, 'problem', `couldn’t clear away ${t.issue!.key}’s worktree: ${err instanceof Error ? err.message : String(err)}`, beluga);
      }
    }
  }

  // ------------------------------------------------------------------ the plan's pull request

  /** Look at every plan's pull request now (also every few minutes): merged → its tasks are Done. */
  async pollPrs(): Promise<void> {
    const git = this.deps.git;
    if (!git || this.stopped) return;
    for (const plan of this.deps.plans.list()) {
      if (!plan.branch || plan.shipped) continue;
      // Only once there's something to ship (or a PR to follow).
      const waiting = this.deps.store.getState().board.issues.some((i) => i.plan?.id === plan.id && i.status === 'in_plan');
      if (!waiting && !plan.pr) continue;
      try {
        const pr = await git.findPr(plan.projectId, plan.branch);
        if (pr) this.prSeen(plan.id, pr);
      } catch {
        // GitHub couldn't tell (offline): next time.
      }
    }
  }

  private prSeen(planId: string, pr: NonNullable<Plan['pr']>): void {
    const plan = this.deps.plans.setPr(planId, pr);
    if (pr.state === 'MERGED') this.ship(plan, 'pr', pr.number);
  }

  /** The plan's work reached main: every Merged into Plan task of it is Done at once. */
  private ship(plan: Plan, how: 'pr' | 'local', number?: number): void {
    const text = how === 'pr' ? `merged into main via #${number}` : 'merged into main here, with the plan';
    for (const i of this.deps.store.getState().board.issues) if (i.plan?.id === plan.id && i.status === 'in_plan') this.deps.work.board.planMoved(i.id, 'done', text);
    this.deps.plans.setShipped(plan.id, { at: Date.now(), how, ...(number !== undefined ? { number } : {}) });
    this.deps.system(plan.home, how === 'pr' ? `The plan’s pull request #${number} was merged: its tasks are Done.` : `${plan.branch} was merged into main here: the plan’s tasks are Done.`);
  }

  /** Open the plan's pull request (its branch → main). */
  async openPr(planId: string): Promise<Plan> {
    const { git, plan, branch } = this.shippable(planId);
    const view = this.view(plan);
    const body = [
      view.body?.goal ?? '',
      '',
      ...view.milestones.flatMap((m) => [`## ${m.milestone.title}`, ...m.tasks.filter((t) => t.issue && t.state !== 'canceled').map((t) => `- ${t.issue!.key} ${t.task.title}`), '']),
      `One pull request for the plan: each milestone was merged into \`${branch}\` when it passed.`,
    ].join('\n');
    const pr = await git.openPr(plan.projectId, branch, view.body?.title ?? branch, body.trim());
    this.prSeen(planId, pr);
    return this.deps.plans.need(planId);
  }

  /** Merge the plan's pull request on GitHub. */
  async mergePr(planId: string): Promise<Plan> {
    const { git, plan } = this.shippable(planId);
    if (!plan.pr || plan.pr.state !== 'OPEN') throw new Error('The plan has no open pull request');
    await git.mergePr(plan.projectId, plan.pr.number);
    this.prSeen(planId, { ...plan.pr, state: 'MERGED' });
    return this.deps.plans.need(planId);
  }

  /** Merge the plan's branch into main here. */
  async mergeLocal(planId: string): Promise<Plan> {
    const { git, plan, branch } = this.shippable(planId);
    const res = await git.mergeLocal(plan.projectId, branch);
    if (!res.ok) {
      if (res.reason === 'wrong_branch') throw new Error(`The main folder is on ${res.current}, not ${res.expected}: switch it to ${res.expected} first`);
      if (res.reason === 'dirty') throw new Error(`The main folder has uncommitted changes (${res.files.slice(0, 3).join(', ')}): commit or stash them first`);
      throw new Error(`Merging ${branch} into main conflicts in ${res.files.slice(0, 3).join(', ')}: nothing was changed`);
    }
    this.ship(plan, 'local');
    return this.deps.plans.need(planId);
  }

  private shippable(planId: string): { readonly git: PlanGit; readonly plan: Plan; readonly branch: string } {
    const plan = this.deps.plans.need(planId);
    if (!this.deps.git || !plan.branch) throw new Error('This plan has no branch of its own');
    if (plan.shipped) throw new Error('The plan is in main already');
    return { git: this.deps.git, plan, branch: plan.branch };
  }

  /** Look at a plan's started tasks: wake what stopped without finishing, or ask you. */
  private watch(plan: Plan): void {
    const live = liveFrom(this.deps.store.getState());
    this.watchdog.step(plan, this.view(plan), (channel) => live.run?.(channel));
  }

  /** The head Claude steered a message into a task (sent as `requestId`): it goes in now, and is followed until read. */
  steer(planId: string, taskId: string, requestId: string, prompt: string): void {
    const plan = this.deps.plans.need(planId);
    const t = this.view(plan).milestones.flatMap((m) => m.tasks).find((x) => x.task.id === taskId);
    if (t?.worktree) this.watchdog.steer(plan, t, `ws:${t.worktree}`, requestId, prompt);
  }

  /** You resume a task whose Claude stopped (it waits for you): woken now, with what it missed. */
  resume(planId: string, taskId: string): string {
    const plan = this.deps.plans.need(planId);
    const t = this.view(plan)
      .milestones.flatMap((m) => m.tasks)
      .find((x) => x.task.id === taskId || x.issue?.key === taskId.toUpperCase());
    if (!t) throw new Error(`There's no task "${taskId}" in this plan`);
    const live = liveFrom(this.deps.store.getState());
    return this.watchdog.resume(plan, t, (channel) => live.run?.(channel));
  }
}
