import type { Issue } from '../board/model.js';
import type { Store } from '../store.js';
import type { Plan, TaskWatch } from './model.js';
import type { Plans } from './plans.js';
import type { PlanView, TaskView } from './progress.js';

/**
 * The watchdog: a plan's started task never sits "working" while nothing happens. Each task has a
 * heartbeat (its Claude's last run in its worktree: when it last took a step, whether a turn runs,
 * whether the Claude Code process is still there). A task whose Claude stopped without finishing
 * (its turn ended or its process went, and it isn't In Review or asking you) is woken once, with
 * where it was and the messages that waited for it; stalling again within half an hour, it waits
 * for you, with the reason. A turn with no new step for 20 minutes counts as stopped, unless it's
 * inside a command that runs long (tests, a build, waiting on someone).
 *
 * The pure parts (a run's pulse, its words) are browser-safe: the Mac app draws them.
 */

/** No new step for this long (outside a long command): the turn is stalled. */
export const STALL_MS = 20 * 60_000;
/** Inside a long command, nothing new for this long: stalled too (a command that hangs). */
export const COMMAND_LIMIT_MS = 2 * 60 * 60_000;
/** Stalling again this soon after a wake: it waits for you instead. */
export const REPEAT_MS = 30 * 60_000;
/** A wake's run gets this long to start before it counts as not having worked. */
export const WAKE_GRACE_MS = 3 * 60_000;
/** A started task with no run of Claude's in sight for this long (since Klaud looked) is stopped. */
export const NO_RUN_MS = 2 * 60_000;
/** A command shows as "Running a long command" once it has run this long. */
export const LONG_SHOWN_MS = 60_000;

/** Steps that may take long without anything new: commands, and waiting on other people or Claudes. */
const LONG_STEP = /^(Bash|BashOutput|Monitor|KillShell|wait_for|ask_agent|ask_person|run_on|run_on_peer|mcp__klaud_\w+__wait\w*)\b/;
/** Runs you stopped yourself: shown as stopped, never woken behind your back. */
const BY_YOU = /stopped by owner|cancelled by owner|taken out of the queue/i;
const TURN = new Set(['queued', 'awaiting_approval', 'started', 'answered']);

/** A conversation's latest run of Claude's, as the shared log has it. */
export interface RunInfo {
  readonly requestId: string;
  readonly status: string;
  readonly ts: number;
  /** When Claude last did something in it (its heartbeat). */
  readonly lastAt: number;
  /** When the step it's on began, and that step (“Bash npm test”). */
  readonly stepAt?: number;
  readonly step?: string;
  /** What Claude said last (or why the run ended). */
  readonly text: string;
}

/** How a started task is doing right now, as its card says it. */
export type TaskPulse =
  | { readonly kind: 'working'; readonly step?: string; readonly since: number }
  | { readonly kind: 'command'; readonly step: string; readonly since: number }
  | { readonly kind: 'stopped'; readonly reason: string }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'needs_you'; readonly reason: string };

export const isTurn = (run: RunInfo | undefined): boolean => Boolean(run && TURN.has(run.status));
export const isLongStep = (step: string | undefined): boolean => Boolean(step && LONG_STEP.test(step));

/** Why a run that's over ended, in words. */
export function endedWhy(run: RunInfo | undefined): string {
  if (!run) return 'no Claude is working on it';
  if (run.status === 'error') return BY_YOU.test(run.text) ? 'you stopped it' : `its run failed: ${run.text.replace(/\s+/g, ' ').slice(0, 120)}`;
  if (run.status === 'denied') return 'its run was declined';
  return 'it ended its turn without handing off';
}

/** A started task's pulse, from its last run (what screens can know: not whether the process is there). */
export function pulseOf(run: RunInfo | undefined, asking: boolean, watch: TaskWatch | undefined): TaskPulse {
  if (asking) return { kind: 'waiting' };
  if (isTurn(run)) {
    const step = run!.step;
    // The step it's on is the last thing it did (nothing said since): it's still in it.
    const inStep = step !== undefined && run!.stepAt !== undefined && run!.stepAt >= run!.lastAt;
    if (inStep && isLongStep(step)) return { kind: 'command', step: step!, since: run!.stepAt! };
    return { kind: 'working', ...(step ? { step } : {}), since: inStep ? run!.stepAt! : run!.lastAt };
  }
  if (watch?.needsYou) return { kind: 'needs_you', reason: watch.reason };
  return { kind: 'stopped', reason: watch && watch.run === run?.requestId ? watch.reason : endedWhy(run) };
}

/** "45s", "12m", "2h 5m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/** A pulse in words: the card's label, and the line under it. */
export function pulseWords(p: TaskPulse, now: number): { readonly label: string; readonly sub?: string; readonly tone: 'claude' | 'warn' } {
  switch (p.kind) {
    case 'working':
      return { label: 'Working', sub: `${p.step ?? 'Thinking'} · ${elapsed(now - p.since)}`, tone: 'claude' };
    case 'command':
      return now - p.since >= LONG_SHOWN_MS ? { label: `Running a long command · ${elapsed(now - p.since)}`, sub: p.step, tone: 'claude' } : { label: 'Working', sub: `${p.step} · ${elapsed(now - p.since)}`, tone: 'claude' };
    case 'stopped':
      return { label: 'Stopped without finishing', sub: p.reason, tone: 'warn' };
    case 'waiting':
      return { label: 'Waiting for you', sub: 'Claude asked you something', tone: 'warn' };
    case 'needs_you':
      return { label: 'Needs you', sub: `Stopped twice: ${p.reason}`, tone: 'warn' };
  }
}

/**
 * Has this task's Claude stalled, and why? `alive`: whether its Claude Code process is still
 * there (the agent runner knows; undefined: can't tell). `seenAt`: when Klaud first saw it with
 * no run at all. `talkedAt`: when you last wrote in its chat (a turn ending then is you talking
 * with it: shown as stopped, not woken).
 */
export function assess(input: { readonly run?: RunInfo; readonly asking: boolean; readonly alive?: boolean; readonly now: number; readonly seenAt?: number; readonly talkedAt?: number }): { readonly stall?: string; readonly woken: boolean } {
  const { run, asking, alive, now } = input;
  // Asking you: it waits for you, that's not a stall.
  if (asking) return { woken: false };
  if (!run) {
    const quiet = input.seenAt !== undefined && now - input.seenAt >= NO_RUN_MS;
    return quiet ? { stall: 'no Claude is working on it', woken: true } : { woken: false };
  }
  if (isTurn(run)) {
    if (run.status === 'queued' || run.status === 'awaiting_approval') return { woken: false };
    if (alive === false) return { stall: 'its Claude Code process ended mid-turn', woken: true };
    const pulse = pulseOf(run, false, undefined);
    const quiet = now - run.lastAt;
    if (pulse.kind === 'command') return quiet >= COMMAND_LIMIT_MS ? { stall: `${pulse.step} ran ${elapsed(quiet)} with nothing new`, woken: true } : { woken: false };
    return quiet >= STALL_MS ? { stall: `no new step for ${elapsed(quiet)}`, woken: true } : { woken: false };
  }
  // Its turn is over but its process is still there: background work it waits on.
  if (alive === true) return now - run.lastAt >= COMMAND_LIMIT_MS ? { stall: `nothing new in the background for ${elapsed(now - run.lastAt)}`, woken: true } : { woken: false };
  const why = endedWhy(run);
  // You stopped it, or you're talking with it: shown as stopped, and yours to go on with.
  const yours = why === 'you stopped it' || (input.talkedAt !== undefined && now - input.talkedAt < REPEAT_MS);
  return { stall: why, woken: !yours };
}

/** "11:13". */
export const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** What a woken Claude is told: where it was, what isn't true yet, and what waited for it. */
export function wakePrompt(issue: Issue, reason: string, run: RunInfo | undefined, waited: readonly string[]): string {
  const open = (issue.brief.acceptance ?? '').split('\n').flatMap((l) => (/^\s*[-*]\s+\[ \]\s+(.*)$/.exec(l)?.[1] ? [/^\s*[-*]\s+\[ \]\s+(.*)$/.exec(l)![1]!.trim()] : []));
  const said = run?.text.replace(/\s+/g, ' ').trim();
  return [
    `You stopped before handing off ${issue.key} “${issue.title}” (${reason}). Here is where you were:`,
    ...(run?.step ? [`- Your last step: ${run.step}`] : []),
    ...(said ? [`- The last thing you said: “${said.length > 400 ? `${said.slice(0, 400)}…` : said}”`] : []),
    open.length ? `- Not true yet: ${open.map((c) => `“${c}”`).join('; ')}` : '- Check the acceptance criteria in the task’s brief.',
    ...(waited.length ? ['', 'Messages that waited for you while you were stopped:', ...waited.map((w) => `---\n${w.trim()}`), '---'] : []),
    '',
    'Go on from there until every acceptance criterion is true; then commit, rewrite the handoff and call task_update with status in_review. If only the user can decide something, say so in one clear line and end your turn: Klaud asks them.',
  ].join('\n');
}

export interface WatchdogDeps {
  readonly store: Store;
  readonly plans: Plans;
  readonly askClaude: (prompt: string, channel: string, echo: boolean) => void;
  readonly system: (channel: string, text: string) => void;
  /** Whether a run of Claude's is under way in a conversation (its process is there). */
  readonly alive?: (channel: string) => boolean;
  /**
   * Stop whatever runs in a conversation, and resolve once nothing does with the messages that
   * waited there (taken out of its queue, in order) so the wake carries them.
   */
  readonly takeOver?: (channel: string) => Promise<readonly string[]>;
  readonly now?: () => number;
}

export class TaskWatchdog {
  /** Conversations seen with no run of Claude's yet: since when. */
  private readonly noRun = new Map<string, number>();
  /** Tasks being woken right now (by plan task id). */
  private readonly waking = new Set<string>();

  constructor(private readonly deps: WatchdogDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Look at every started task of a plan: wake what stopped, or ask you. */
  step(plan: Plan, view: PlanView, runOf: (channel: string) => RunInfo | undefined): void {
    const now = this.now();
    for (const t of view.milestones.flatMap((m) => m.tasks)) {
      const w = plan.watch?.[t.task.id];
      const started = t.state === 'running' || t.state === 'idle' || t.state === 'asking' || t.state === 'stalled';
      // Finished (or not started): nothing to watch any more.
      if (!started || !t.issue || !t.worktree || t.issue.worktreeGone || t.combining) {
        if (w && !started) this.deps.plans.setWatch(plan.id, t.task.id, undefined);
        continue;
      }
      // Paused: shown as it is, nobody woken.
      if (plan.paused || plan.status !== 'active' || this.waking.has(t.task.id)) continue;
      const channel = `ws:${t.worktree}`;
      const run = runOf(channel);
      if (run) this.noRun.delete(channel);
      else if (!this.noRun.has(channel)) this.noRun.set(channel, now);
      const alive = this.deps.alive?.(channel);
      const talkedAt = this.talkedAt(channel);
      const { stall, woken } = assess({ run, asking: t.state === 'asking', ...(alive !== undefined ? { alive } : {}), now, ...(this.noRun.has(channel) ? { seenAt: this.noRun.get(channel)! } : {}), ...(talkedAt !== undefined ? { talkedAt } : {}) });
      if (!stall || !woken || w?.needsYou) continue;
      // The wake is on its way (its run hasn't started yet).
      if (w?.wokeAt !== undefined && w.run === run?.requestId && now - w.wokeAt < WAKE_GRACE_MS) continue;
      const key = t.issue.key;
      if (w?.wokeAt !== undefined && now - w.wokeAt < REPEAT_MS) {
        const line = `${key} stopped again: ${stall}. It waits for you`;
        this.deps.plans.setWatch(plan.id, t.task.id, { at: now, reason: stall, ...(run ? { run: run.requestId } : {}), wokeAt: w.wokeAt, needsYou: true, line });
        this.deps.plans.note(plan.id, 'problem', `${line} (woken at ${clock(w.wokeAt)}): Resume it, or open its chat.`, { kind: 'klaud' });
        continue;
      }
      this.wake(plan, t, t.issue, channel, stall, run, `${key} stopped, woke it at ${clock(now)}`);
    }
  }

  /** When a person last wrote in a conversation (Klaud's own prompts aren't shown as messages). */
  private talkedAt(channel: string): number | undefined {
    const log = this.deps.store.getState().log;
    for (let i = log.length - 1; i >= 0; i--) {
      const l = log[i]!;
      if (l.type === 'chat' && l.channel === channel && !l.byAgent) return l.ts;
    }
    return undefined;
  }

  /** You resume a task that waits for you (or one that stopped): woken now, with what it missed. */
  resume(plan: Plan, t: TaskView, runOf: (channel: string) => RunInfo | undefined): string {
    if (!t.issue || !t.worktree || t.issue.worktreeGone) throw new Error('That task hasn’t started');
    if (t.state === 'running') throw new Error(`${t.issue.key} is working already`);
    if (this.waking.has(t.task.id)) return `${t.issue.key} is being woken`;
    const channel = `ws:${t.worktree}`;
    const run = runOf(channel);
    const reason = plan.watch?.[t.task.id]?.reason ?? endedWhy(run);
    this.wake(plan, t, t.issue, channel, reason, run, `You resumed ${t.issue.key} at ${clock(this.now())}`);
    return `Resumed ${t.issue.key}`;
  }

  private wake(plan: Plan, t: TaskView, issue: Issue, channel: string, reason: string, run: RunInfo | undefined, line: string): void {
    const now = this.now();
    this.waking.add(t.task.id);
    this.deps.plans.setWatch(plan.id, t.task.id, { at: now, reason, ...(run ? { run: run.requestId } : {}), wokeAt: now, line });
    this.deps.plans.note(plan.id, 'note', `${line} (${reason})`, { kind: 'klaud' });
    void (async () => {
      const waited = this.deps.takeOver ? await this.deps.takeOver(channel).catch(() => []) : [];
      this.deps.system(channel, `Klaud woke Claude: it stopped before handing off (${reason}).`);
      this.deps.askClaude(wakePrompt(issue, reason, run, waited), channel, false);
    })().finally(() => this.waking.delete(t.task.id));
  }
}
