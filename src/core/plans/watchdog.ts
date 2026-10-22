import type { Issue } from '../board/model.js';
import type { Store } from '../store.js';
import type { Plan, TaskWatch } from './model.js';
import type { Plans } from './plans.js';
import type { PlanView, TaskView } from './progress.js';
import { CONTINUE_PROMPT, CRASH_RETRY_MS, type RunFailure, decodeFailure, failureText, resetWords } from '../../shared/run-failure.js';

/**
 * The watchdog: a plan's started task never sits "working" while nothing happens. Each task has a
 * heartbeat (its Claude's last run in its worktree: when it last took a step, whether a turn runs,
 * whether the Claude Code process is still there). A task whose Claude stopped without finishing
 * (its turn ended or its process went, and it isn't In Review or asking you) is woken once, with
 * where it was and the messages that waited for it; stalling again within half an hour, it waits
 * for you, with the reason. A turn with no new step for 20 minutes counts as stopped, unless it's
 * inside a command that runs long (tests, a build, waiting on someone).
 *
 * A run that ended on your usage limit isn't a stall: the task shows "Paused · usage limit", and
 * once the limit resets Klaud resumes the head Claude, then each such task, one at a time within
 * the plan's task limit. A run that crashed is retried once after 30s; crashing again, it waits
 * for you (see shared/run-failure.ts).
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
/** A message the head Claude steered in, unread this long: delivered again (interrupting, or a fresh turn). */
export const STEER_UNREAD_MS = 2 * 60_000;
/** Deliveries of one steered message after the first, before it's left to you. */
const STEER_RETRIES = 2;
/** What a steered message's card says while it waits in the running turn for Claude's next step (AgentHost's READS_AFTER_STEP). */
const READS_AFTER_STEP = 'Claude reads this after its current step';

/** A usage limit with no known reset: try again this long after it stopped. */
export const LIMIT_UNKNOWN_MS = 30 * 60_000;
/** Resuming a moment after the reset, so the first message isn't refused again. */
export const LIMIT_MARGIN_MS = 60_000;

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
  /** How far the step it's on has got, from its output ("137/215"). */
  readonly progress?: string;
  /** The last command it ran (a step watching a command's output names it). */
  readonly command?: string;
}

/** A message waiting for a conversation's Claude (in its queue, or in the running turn for its next step). */
export interface WaitingMessage {
  readonly requestId: string;
  readonly prompt: string;
  /** Still in the queue: Steer Now sends it at once. False: in the running turn, read at Claude's next step. */
  readonly queued: boolean;
}

/**
 * A message of yours (or your head Claude's) as the log has it: in the queue, in the running turn
 * for Claude's next step, its turn just started (nothing done yet), or read (Claude acted on it, or it ended).
 */
export function messageState(item: { readonly status: string; readonly text?: string; readonly steps?: readonly string[] } | undefined): 'unsent' | 'queued' | 'in_turn' | 'started' | 'read' {
  if (!item) return 'unsent';
  if (item.status === 'queued') return 'queued';
  if (item.status === 'started' && !item.steps?.length) return item.text === READS_AFTER_STEP ? 'in_turn' : item.text ? 'read' : 'started';
  return 'read';
}

/** Waiting messages as a card says them: “1 message waiting”, and the one Steer Now sends (the first still in the queue). */
export function waitingWords(list: readonly WaitingMessage[]): { readonly text: string; readonly steer?: string } {
  const queued = list.find((w) => w.queued);
  return { text: `${list.length} ${list.length === 1 ? 'message' : 'messages'} waiting`, ...(queued ? { steer: queued.requestId } : {}) };
}

/** A step as a card says it: "Running npx playwright test", "Watching npx playwright test". */
export function stepWords(step: string, command?: string): string {
  const run = /^Bash (.+)$/.exec(step)?.[1];
  if (run) return `Running ${run}`;
  if (/^(BashOutput|Monitor)\b/.test(step)) return command ? `Watching ${/^Bash (.+)$/.exec(command)?.[1] ?? command}` : 'Watching a command';
  return step;
}

/** How a started task is doing right now, as its card says it. */
export type TaskPulse =
  | { readonly kind: 'working'; readonly step?: string; readonly since: number; readonly progress?: string }
  | { readonly kind: 'command'; readonly step: string; readonly since: number; readonly progress?: string }
  | { readonly kind: 'stopped'; readonly reason: string; readonly crashed?: boolean }
  | { readonly kind: 'paused'; readonly until: number }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'needs_you'; readonly reason: string };

export const isTurn = (run: RunInfo | undefined): boolean => Boolean(run && TURN.has(run.status));
export const isLongStep = (step: string | undefined): boolean => Boolean(step && LONG_STEP.test(step));

/** How a run that failed ended, when the runner said (a usage limit, a crash). */
export const failureOf = (run: RunInfo | undefined): RunFailure | undefined => (run?.status === 'error' ? decodeFailure(run.text) : undefined);

/** When a run stopped by your usage limit may go on (the reset, or a guess when it's unknown). */
export const limitUntil = (run: RunInfo, f: RunFailure): number => f.resetsAt ?? run.lastAt + LIMIT_UNKNOWN_MS;

/** Why a run that's over ended, in words. */
export function endedWhy(run: RunInfo | undefined): string {
  if (!run) return 'no Claude is working on it';
  const failure = failureOf(run);
  if (failure && failure.kind !== 'stopped') return failureText(run.text).split('\n')[0]!;
  if (run.status === 'error') return BY_YOU.test(run.text) ? 'you stopped it' : `its run failed: ${run.text.replace(/\s+/g, ' ').slice(0, 120)}`;
  if (run.status === 'denied') return 'its run was declined';
  return 'it ended its turn without handing off';
}

/** A started task's pulse, from its last run (what screens can know: not whether the process is there). */
export function pulseOf(run: RunInfo | undefined, asking: boolean, watch: TaskWatch | undefined): TaskPulse {
  if (asking) return { kind: 'waiting' };
  if (isTurn(run)) {
    const step = run!.step ? stepWords(run!.step, run!.command) : undefined;
    // The step it's on is the last thing it did (nothing said since; a count from its output is it going on): it's still in it.
    const inStep = step !== undefined && run!.stepAt !== undefined && (run!.stepAt >= run!.lastAt || run!.progress !== undefined);
    const progress = inStep && run!.progress ? { progress: run!.progress } : {};
    if (inStep && isLongStep(run!.step)) return { kind: 'command', step: step!, since: run!.stepAt!, ...progress };
    return { kind: 'working', ...(step ? { step } : {}), since: inStep ? run!.stepAt! : run!.lastAt, ...progress };
  }
  if (watch?.needsYou) return { kind: 'needs_you', reason: watch.reason };
  // Stopped by your usage limit or a crash: never "working", and said as such.
  const failure = failureOf(run);
  if (failure?.kind === 'usage_limit') return { kind: 'paused', until: limitUntil(run!, failure) };
  if (failure?.kind === 'crash') return { kind: 'stopped', reason: endedWhy(run), crashed: true };
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

const nowLine = (step: string, progress: string | undefined, ms: number): string => [step, progress, elapsed(ms)].filter(Boolean).join(' · ');

/** A pulse in words: the card's label, and the line under it. */
export function pulseWords(p: TaskPulse, now: number): { readonly label: string; readonly sub?: string; readonly tone: 'claude' | 'warn' } {
  switch (p.kind) {
    case 'working':
      return { label: 'Working', sub: nowLine(p.step ?? 'Thinking', p.progress, now - p.since), tone: 'claude' };
    case 'command':
      // Busy, not dead: the command, how far it got, and for how long ("Running npx playwright test · 137/215 · 12m").
      return { label: now - p.since >= LONG_SHOWN_MS ? 'Running a long command' : 'Working', sub: nowLine(p.step, p.progress, now - p.since), tone: 'claude' };
    case 'stopped':
      return p.crashed ? { label: 'Stopped · Claude Code crashed', sub: p.reason, tone: 'warn' } : { label: 'Stopped without finishing', sub: p.reason, tone: 'warn' };
    case 'paused':
      return { label: 'Paused · usage limit', sub: now < p.until ? `Resumes at ${resetWords(p.until, now)}` : 'Resuming', tone: 'warn' };
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
export function assess(input: { readonly run?: RunInfo; readonly asking: boolean; readonly alive?: boolean; readonly now: number; readonly seenAt?: number; readonly talkedAt?: number }): { readonly stall?: string; readonly woken: boolean; readonly limitUntil?: number } {
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
    if (pulse.kind === 'command') return quiet >= COMMAND_LIMIT_MS ? { stall: `${run.step} ran ${elapsed(quiet)} with nothing new`, woken: true } : { woken: false };
    return quiet >= STALL_MS ? { stall: `no new step for ${elapsed(quiet)}`, woken: true } : { woken: false };
  }
  // Its turn is over but its process is still there: background work it waits on.
  if (alive === true) return now - run.lastAt >= COMMAND_LIMIT_MS ? { stall: `nothing new in the background for ${elapsed(now - run.lastAt)}`, woken: true } : { woken: false };
  const why = endedWhy(run);
  const failure = failureOf(run);
  // Your usage limit: it waits for the reset (see TaskWatchdog.step), not woken as a stall.
  if (failure?.kind === 'usage_limit') return { stall: why, woken: false, limitUntil: limitUntil(run, failure) };
  // Claude Code crashed: retried once, 30s after.
  if (failure?.kind === 'crash') return now - run.lastAt >= CRASH_RETRY_MS ? { stall: why, woken: true } : { woken: false };
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

/** What a task's Claude is told when a message the head Claude steered in is sent again in a fresh turn. */
export function steerAgainPrompt(text: string, waited: readonly string[]): string {
  const others = waited.filter((w) => w.trim() !== text.trim());
  return [
    'An urgent message from the head of the plan waited more than 2 minutes without you reading it. Read it now and act on it before going on:',
    '',
    text.trim(),
    ...(others.length ? ['', 'Other messages that waited for you:', ...others.map((w) => `---\n${w.trim()}`), '---'] : []),
  ].join('\n');
}

/** A message the head Claude steered into a task, watched until its Claude reads it. */
interface Steered {
  readonly planId: string;
  readonly taskId: string;
  readonly key: string;
  readonly channel: string;
  /** The message as Claude is given it. */
  readonly prompt: string;
  requestId: string;
  /** When it was (last) sent. */
  at: number;
  /** Sent on with Steer Now (it left the queue). */
  promoted: boolean;
  retries: number;
}

export interface WatchdogDeps {
  readonly store: Store;
  readonly plans: Plans;
  /** Ask your Claude in a conversation; returns the request's id (to follow it), when it can. */
  readonly askClaude: (prompt: string, channel: string, echo: boolean) => string | void;
  /** Steer a waiting message in now (AgentHost.promote: interrupts a long command or a dead run). */
  readonly promote?: (requestId: string) => boolean;
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
  /** Messages the head Claude steered in, until their Claude reads them (by request id). */
  private readonly steered = new Map<string, Steered>();
  /** Head Claude runs sent on after a limit or a crash (by request id), and plans whose head was retried after a crash. */
  private readonly homeResumed = new Set<string>();
  private readonly homeCrashed = new Set<string>();

  constructor(private readonly deps: WatchdogDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * The head Claude steers a message into a task (sent already, as `requestId`, into its queue):
   * it goes in at once (Steer Now) and is watched until that task's Claude reads it.
   */
  steer(plan: Plan, t: TaskView, channel: string, requestId: string, prompt: string): void {
    const s: Steered = { planId: plan.id, taskId: t.task.id, key: t.issue?.key ?? t.task.title, channel, prompt, requestId, at: this.now(), promoted: false, retries: 0 };
    this.steered.set(requestId, s);
    this.follow(s, this.now());
  }

  /** Has a steered message been read? Sent on while it waits; unread after 2 minutes, delivered again, and said in the plan's feed. */
  private follow(s: Steered, now: number): void {
    const item = this.deps.store.getState().log.find((l): l is Extract<typeof l, { type: 'agent' }> => l.type === 'agent' && l.requestId === s.requestId);
    const state = messageState(item);
    if (state === 'read') {
      this.steered.delete(s.requestId);
      return;
    }
    // In the queue (it got there after a run started): Steer Now, through the agent host's own path.
    if (state === 'queued' && !s.promoted) {
      s.promoted = true;
      this.deps.promote?.(s.requestId);
      return;
    }
    if (now - s.at < STEER_UNREAD_MS || this.waking.has(s.taskId)) return;
    const waitedFor = elapsed(now - s.at);
    if (s.retries >= STEER_RETRIES) {
      this.steered.delete(s.requestId);
      this.deps.plans.note(s.planId, 'problem', `${s.key} still hasn't read the head Claude's message after ${waitedFor}: open its chat`, { kind: 'klaud' });
      return;
    }
    s.retries += 1;
    s.at = now;
    // Still in the queue: steered again (it interrupts what runs). Else a fresh turn with it.
    if (state === 'queued' && this.deps.promote?.(s.requestId)) {
      this.deps.plans.note(s.planId, 'note', `${s.key} hadn't read the head Claude's message in ${waitedFor}: interrupted it again`, { kind: 'klaud' });
      return;
    }
    this.steered.delete(s.requestId);
    // Taken into the turn but never read: sent again and steered in the agent host's one way (planSteer):
    // a long command or a quiet turn is interrupted, a dead run restarted; what queued there keeps its place.
    if (this.deps.promote) {
      const id = this.deps.askClaude(steerAgainPrompt(s.prompt, []), s.channel, false);
      this.deps.plans.note(s.planId, 'note', `${s.key} hadn't read the head Claude's message in ${waitedFor}: steered it in again`, { kind: 'klaud' });
      // Followed like the first one: Steer Now once it queues, sent again if still unread.
      if (id) this.track({ ...s, requestId: id, at: now, promoted: false });
      return;
    }
    this.deps.plans.note(s.planId, 'note', `${s.key} hadn't read the head Claude's message in ${waitedFor}: started a fresh turn with it`, { kind: 'klaud' });
    this.waking.add(s.taskId);
    void (async () => {
      const waited = this.deps.takeOver ? await this.deps.takeOver(s.channel).catch(() => []) : [];
      this.deps.system(s.channel, 'Klaud restarted Claude: an urgent message from the plan’s Claude waited 2 minutes unread.');
      const id = this.deps.askClaude(steerAgainPrompt(s.prompt, waited), s.channel, false);
      if (id) this.track({ ...s, requestId: id, at: this.now(), promoted: false });
    })().finally(() => this.waking.delete(s.taskId));
  }

  private track(s: Steered): Steered {
    this.steered.set(s.requestId, s);
    return s;
  }

  /** Look at every started task of a plan: wake what stopped, or ask you. */
  step(plan: Plan, view: PlanView, runOf: (channel: string) => RunInfo | undefined): void {
    const now = this.now();
    // Steered messages first: they're followed even while the plan is paused.
    for (const s of [...this.steered.values()]) {
      if (s.planId !== plan.id) continue;
      const t = view.milestones.flatMap((m) => m.tasks).find((x) => x.task.id === s.taskId);
      // Finished, or gone: nobody to tell any more.
      if (!t || !t.worktree || `ws:${t.worktree}` !== s.channel || !(t.state === 'running' || t.state === 'idle' || t.state === 'asking' || t.state === 'stalled')) this.steered.delete(s.requestId);
      else this.follow(s, now);
    }
    const tasks = view.milestones.flatMap((m) => m.tasks);
    if (!plan.paused && plan.status === 'active') this.resumeHome(plan, runOf(plan.home), now);
    // Tasks paused by your usage limit go on one at a time, within the plan's task limit.
    let room = plan.maxParallel - tasks.filter((t) => t.state === 'running' || this.waking.has(t.task.id)).length;
    for (const t of tasks) {
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
      const { stall, woken, limitUntil: until } = assess({ run, asking: t.state === 'asking', ...(alive !== undefined ? { alive } : {}), now, ...(this.noRun.has(channel) ? { seenAt: this.noRun.get(channel)! } : {}), ...(talkedAt !== undefined ? { talkedAt } : {}) });
      if (until !== undefined && run) {
        if (w?.resumed === run.requestId) continue; // resumed already; its run is on its way
        if (now < until + LIMIT_MARGIN_MS || room <= 0) {
          if (w?.run !== run.requestId || w.limitUntil !== until) this.deps.plans.setWatch(plan.id, t.task.id, { at: now, reason: stall!, run: run.requestId, limitUntil: until, line: `${t.issue.key} paused: usage limit · resumes at ${resetWords(until, now)}` });
          continue;
        }
        room--;
        this.wake(plan, t, t.issue, channel, stall!, run, `Usage is back: resumed ${t.issue.key} at ${clock(now)}`, { counts: false });
        continue;
      }
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

  /**
   * The plan's head Claude stopped by your usage limit: sent on once it resets (once per run). A
   * crash of its is retried once, 30s after.
   */
  private resumeHome(plan: Plan, run: RunInfo | undefined, now: number): void {
    const failure = failureOf(run);
    // A run of its that didn't crash: a later crash is retried again.
    if (run && !failure && run.status !== 'error') this.homeCrashed.delete(plan.id);
    if (!run || !failure || this.homeResumed.has(run.requestId)) return;
    const retry = failure.kind === 'crash' && now - run.lastAt >= CRASH_RETRY_MS && !this.homeCrashed.has(plan.id);
    const back = failure.kind === 'usage_limit' && now >= limitUntil(run, failure) + LIMIT_MARGIN_MS;
    if (!retry && !back) return;
    this.homeResumed.add(run.requestId);
    if (retry) this.homeCrashed.add(plan.id);
    this.deps.plans.note(plan.id, 'note', back ? `Usage is back: resumed the plan’s Claude at ${clock(now)}` : `The plan’s Claude crashed (${endedWhy(run)}): retried at ${clock(now)}`, { kind: 'klaud' });
    this.deps.askClaude(CONTINUE_PROMPT, plan.home, false);
  }

  private wake(plan: Plan, t: TaskView, issue: Issue, channel: string, reason: string, run: RunInfo | undefined, line: string, { counts = true }: { counts?: boolean } = {}): void {
    const now = this.now();
    this.waking.add(t.task.id);
    // A resume after your usage limit isn't a wake: stopping again soon after doesn't make it wait for you.
    this.deps.plans.setWatch(plan.id, t.task.id, counts ? { at: now, reason, ...(run ? { run: run.requestId } : {}), wokeAt: now, line } : { at: now, reason, ...(run ? { run: run.requestId, resumed: run.requestId } : {}), line });
    this.deps.plans.note(plan.id, 'note', `${line} (${reason})`, { kind: 'klaud' });
    void (async () => {
      const waited = this.deps.takeOver ? await this.deps.takeOver(channel).catch(() => []) : [];
      this.deps.system(channel, `Klaud woke Claude: it stopped before handing off (${reason}).`);
      this.deps.askClaude(wakePrompt(issue, reason, run, waited), channel, false);
    })().finally(() => this.waking.delete(t.task.id));
  }
}
