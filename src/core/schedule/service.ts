import { randomUUID } from 'node:crypto';
import type { NoticeEvent } from '../notify.js';
import { carriedPrompt } from '../agent-switch.js';
import { decodeFailure, failureText } from '../../shared/run-failure.js';
import type { GuestSchedule } from '../../protocol.js';
import type { ScheduleMark } from '../store.js';
import {
  MAX_BLIND_RUNS,
  MAX_COMPACT_FAILURES,
  RUN_LIMIT_MS,
  applyDecision,
  applyEdit,
  applyEnd,
  checkWhen,
  clock,
  compactInstructions,
  decide,
  guestSchedule,
  newSchedule,
  nextTime,
  overLimit,
  pauseSchedule,
  resumeSchedule,
  runLine,
  scheduleBrief,
  scheduleView,
  skipLine,
  type Decision,
  type ScheduleOutcome,
  type ScheduleView,
  whenInSentence,
} from './model.js';
import { ScheduleInputSchema, SchedulePatchSchema, type Schedule, type ScheduleWhen } from './schema.js';
import { ScheduleFile } from './store.js';

/**
 * Schedules in chats: the tick, the runs and what they leave. The rules are in model.ts; this
 * saves their answers and does what they decide. A run is marked started and saved before it's
 * asked, so neither a second tick nor a restart can start it again.
 */

export const TICK_MS = 30_000;
const FIRST_TICK_MS = 10_000;
export const MAX_PER_CHAT = 10;

/** Whether a chat can have a schedule now. `wait`: Beluga can't tell yet, so nothing fires. */
export type ChatCheck = { readonly kind: 'ok' | 'gone' | 'wait' } | { readonly kind: 'refused'; readonly reason: string };

export interface SchedulesDeps {
  /** ~/.beluga (null: in memory). */
  readonly dir: string | null;
  readonly now: () => number;
  /** The setting chatSchedules, read at each use. */
  readonly enabled: () => boolean;
  /** 0: no timers, the tests tick. */
  readonly tickMs?: number;
  readonly tz?: string;
  /** Anything the chat does first: a run, a queue, a held lane, its terminal. */
  readonly busy: (channel: string) => boolean;
  readonly check: (channel: string) => ChatCheck;
  /** Load the chat's saved conversation, so a line written now is kept with it. */
  readonly ensureLoaded: (channel: string) => void;
  readonly line: (channel: string, text: string, level: 'info' | 'warn', schedule?: ScheduleMark) => void;
  /** Your own agent, with no message of yours in the chat → the request's id. */
  readonly ask: (prompt: string, channel: string) => string | undefined;
  readonly wait: (requestId: string) => Promise<string>;
  readonly cancel: (requestId: string, note: string) => void;
  readonly notify: (event: NoticeEvent) => void;
  /** Every schedule as screens see it, after each change and when the service starts. */
  readonly publish: (items: readonly ScheduleView[]) => void;
  /** How full the chat's conversation is against the threshold. `unknown`: its runtime reported no numbers. */
  readonly fill: (channel: string) => 'past' | 'under' | 'unknown';
  /** Compact the chat in its lane. `refused`: it did not run to its end (Codex compacts itself), and that is no failure. */
  readonly compact: (channel: string, instructions: string) => Promise<'done' | 'refused' | 'failed'>;
  /** The chat's next run starts a new session. The chat stays. */
  readonly forget: (channel: string) => void;
  /** The recent conversation in plain lines, for a new session. */
  readonly transcript: (channel: string) => string;
}

/** Why a chat with a contributor has no schedule on: a run has your full scope and reads their words. */
export const CONTRIBUTOR_REASON = 'Someone can contribute in this chat. A scheduled run has your full access and reads their messages, so it stays off while they can contribute.';
const COMPACT_FAILED = 'Compacting this chat failed';
const COMPACT_PAUSE = 'Compacting this chat failed twice, so the schedule is paused. Clear the chat, or give the schedule a fresh session for each run';
/** Who a carried transcript comes from, in carriedPrompt's words. */
const EARLIER_SESSION = 'an earlier session';
const LIMIT_WORDS = `It passed the ${RUN_LIMIT_MS / 60_000}-minute time limit`;

export class Schedules {
  private readonly file: ScheduleFile;
  private items: Schedule[];
  /** Runs this daemon cancelled for the time limit. */
  private readonly overTime = new Set<string>();
  /** Schedules whose chat is leaving while they compact, with no request to cancel yet: they must not ask. */
  private readonly noAsk = new Set<string>();
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private closed = false;
  private recovered = false;

  constructor(private readonly deps: SchedulesDeps) {
    this.file = new ScheduleFile(deps.dir);
    this.items = this.file.read();
    this.publish();
    const every = deps.tickMs ?? TICK_MS;
    if (!every) return;
    const first = setTimeout(() => this.tick(), Math.min(FIRST_TICK_MS, every));
    const timer = setInterval(() => this.tick(), every);
    first.unref?.();
    timer.unref?.();
    this.timers.push(first, timer);
  }

  /** The clock: end what's over its limit, then do what each schedule decides, chat by chat. */
  tick(): void {
    if (this.closed || !this.deps.enabled()) return;
    this.recover();
    const now = this.deps.now();
    for (const s of this.items) if (overLimit(s, now)) this.stopOverTime(s);
    const opts = this.clockOpts();
    // The earliest due first: within a chat they run in order, and the others wait for its idle.
    const inOrder = [...this.items].sort((a, b) => dueOrder(a, now, opts) - dueOrder(b, now, opts));
    for (const { id } of inOrder) {
      const s = this.get(id);
      if (!s?.enabled || !this.chatStillFits(s)) continue;
      const decision = decide(s, { busy: this.busy(s.channel) }, now, opts);
      if (decision.kind !== 'nothing') this.act(s, decision, now);
    }
  }

  get(id: string): Schedule | undefined {
    return this.items.find((s) => s.id === id);
  }

  list(channel?: string): readonly Schedule[] {
    return channel ? this.items.filter((s) => s.channel === channel) : this.items;
  }

  /** What a screen shows of it. */
  view(s: Schedule): ScheduleView {
    return scheduleView(s, this.deps.now(), this.clockOpts());
  }

  /** What people who follow this chat see of its schedules: nothing while the setting is off. */
  forGuests(channel: string): readonly GuestSchedule[] {
    return this.deps.enabled() ? this.list(channel).map((s) => guestSchedule(this.view(s), this.clockOpts())) : [];
  }

  /** When it runs, inside a sentence. */
  whenInSentence(when: ScheduleWhen): string {
    return whenInSentence(when, this.clockOpts());
  }

  /** A new schedule in a chat. It throws a message the user can act on. */
  create(channel: string, input: unknown): Schedule {
    const parsed = ScheduleInputSchema.parse(input);
    const now = this.deps.now();
    const refused = this.refusal(channel);
    if (refused) throw new Error(refused);
    const late = checkWhen(parsed.when, now);
    if (late) throw new Error(late);
    if (this.list(channel).length >= MAX_PER_CHAT) throw new Error(`This chat already has ${MAX_PER_CHAT} schedules, the most it can have. Remove one first.`);
    const made = newSchedule({ id: randomUUID(), channel, ...parsed }, now);
    this.items = [...this.items, made];
    this.save();
    return made;
  }

  /** A saved edit, on the schedule as it is now. A run under way ends on these values. */
  update(id: string, patch: unknown): Schedule {
    const s = this.need(id);
    const parsed = SchedulePatchSchema.parse(patch);
    const now = this.deps.now();
    const late = parsed.when ? checkWhen(parsed.when, now) : undefined;
    if (late) throw new Error(late);
    return this.replace(applyEdit(s, parsed, now));
  }

  /** Run it now, on or paused. On a busy chat it waits its turn when it's on, as a due slot does. */
  runNow(id: string): Schedule {
    const s = this.need(id);
    if (s.running) throw new Error('This schedule is already running. Wait for that run to end.');
    const refused = this.refusal(s.channel);
    if (refused) throw new Error(refused);
    const now = this.deps.now();
    if (this.busy(s.channel)) {
      if (!s.enabled) throw new Error('This chat is busy. Try again when it is idle.');
      if (s.pending) return s;
      return this.replace({ ...s, pending: { due: now, slots: 1, missed: 0 } });
    }
    this.fire(s, { kind: 'run', due: s.pending?.due ?? now, slots: s.pending?.slots ?? 1, missed: s.pending?.missed ?? 0, late: false }, now);
    return this.need(id);
  }

  /** Remove it. A run under way finishes, and nothing is kept of it. */
  remove(id: string): void {
    this.need(id);
    this.items = this.items.filter((s) => s.id !== id);
    this.save();
  }

  /** Turn it on or off. On is refused while the chat can't have one, or a once time has passed. */
  setEnabled(id: string, on: boolean, pausedBy = 'Paused by you'): Schedule {
    const s = this.need(id);
    const now = this.deps.now();
    if (!on) return this.replace(pauseSchedule(s, pausedBy, now));
    if (s.enabled) return s;
    const refused = this.refusal(s.channel) ?? checkWhen(s.when, now);
    if (refused) throw new Error(refused);
    return this.replace(resumeSchedule(s, now));
  }

  /** Before a chat is archived or deleted: nothing fires, and what's on the way stops. */
  chatLeaving(channel: string, how: 'archive' | 'delete'): void {
    this.pauseAll(channel, how === 'archive' ? 'This chat was archived' : 'This chat is being deleted', how === 'archive');
    this.stopRuns(channel, how === 'archive' ? 'Stopped: its chat was archived' : 'Stopped: its chat was deleted');
  }

  /** A chat that's gone takes its schedules with it. */
  chatGone(channel: string): void {
    this.stopRuns(channel, 'Stopped: its chat was deleted');
    if (!this.list(channel).length) return;
    this.items = this.items.filter((s) => s.channel !== channel);
    this.save();
  }

  /** Someone can now post here: every schedule of the chat pauses, in the role change itself. */
  contributorJoined(channel: string): void {
    this.pauseAll(channel, CONTRIBUTOR_REASON, true);
  }

  /** What the agent is told for a schedule's request. Other requests in the chat get nothing. */
  briefFor(channel: string, requestId: string): string | undefined {
    const s = this.items.find((x) => x.channel === channel && x.running?.requestId === requestId);
    return s?.running ? scheduleBrief(s.title, s.running, this.clockOpts(), s.context) : undefined;
  }

  /** This chat can have a schedule now. */
  fits(channel: string): boolean {
    return this.deps.check(channel).kind === 'ok';
  }

  /** The setting, for the API: it refuses every method while this is false. */
  isOn(): boolean {
    return this.deps.enabled();
  }

  /** Stop ticking. A run under way is left as saved: the next start calls it interrupted. */
  stop(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  private need(id: string): Schedule {
    const s = this.get(id);
    if (!s) throw new Error('That schedule is not here any more.');
    return s;
  }

  /** The race check of each decision: a chat that's gone removes the schedule, one that can't have it pauses it. */
  private chatStillFits(s: Schedule): boolean {
    const chat = this.deps.check(s.channel);
    if (chat.kind === 'ok') return true;
    if (chat.kind === 'gone') this.chatGone(s.channel);
    if (chat.kind === 'refused') this.pauseAll(s.channel, chat.reason, true);
    return false;
  }

  private pauseAll(channel: string, reason: string, sayIt: boolean): void {
    for (const s of this.list(channel)) {
      if (!s.enabled) continue;
      this.replace(pauseSchedule(s, reason, this.deps.now()));
      if (sayIt) this.say(channel, `Schedule · ${s.title} · paused: ${reason}`, 'warn');
    }
  }

  /**
   * Stop the runs of a chat. A request just asked reaches its lane a moment later (delivery is a
   * setImmediate), where a cancel now can't find it, so it's cancelled again then.
   */
  private stopRuns(channel: string, note: string): void {
    for (const s of this.list(channel)) {
      if (s.running && !s.running.requestId) this.noAsk.add(s.id);
      const requestId = s.running?.requestId;
      if (!requestId) continue;
      this.deps.cancel(requestId, note);
      setImmediate(() => this.deps.cancel(requestId, note));
    }
  }

  private refusal(channel: string): string | undefined {
    const chat = this.deps.check(channel);
    if (chat.kind === 'refused') return chat.reason;
    return chat.kind === 'ok' ? undefined : 'That chat is not here any more.';
  }

  private act(s: Schedule, decision: Exclude<Decision, { kind: 'nothing' }>, now: number): void {
    if (decision.kind === 'run') return this.fire(s, decision, now);
    if (decision.kind === 'skip') this.say(s.channel, skipLine(s.title, decision, this.clockOpts()));
    this.replace(applyDecision(s, decision, now));
  }

  private fire(s: Schedule, decision: Extract<Decision, { kind: 'run' }>, now: number): void {
    this.say(s.channel, runLine(s.title, decision, this.clockOpts()), 'info', { id: s.id, title: s.title, prompt: s.prompt, due: decision.due, slots: decision.slots, missed: decision.missed });
    const started = this.replace(applyDecision(s, decision, now));
    if (started.context === 'fresh') {
      this.deps.forget(started.channel);
      return this.ask(started);
    }
    const fill = this.deps.fill(started.channel);
    if (fill === 'past') return void this.compactFirst(started);
    if (fill === 'unknown') return this.askBlind(started);
    this.ask(started.blindRuns ? this.replace({ ...started, blindRuns: 0 }) : started);
  }

  /** Past the threshold: compact in the lane, then ask. A chat that left meanwhile gets no run. */
  private async compactFirst(started: Schedule): Promise<void> {
    const outcome = await this.deps.compact(started.channel, compactInstructions(started));
    const s = this.get(started.id);
    if (this.closed || !s?.running || s.running.startedAt !== started.running?.startedAt) return;
    if (this.noAsk.has(s.id) || !this.chatStillFits(s)) return this.end(s.id, { kind: 'interrupted' });
    // A summary that is still past the threshold would compact again on each run.
    if (outcome === 'failed' || (outcome === 'done' && this.deps.fill(s.channel) === 'past')) return this.compactFailed(s);
    this.ask(outcome === 'done' ? this.replace({ ...s, compactFailures: 0, blindRuns: 0 }) : s);
  }

  /** The run goes on after the first failure, and the schedule pauses at the second. */
  private compactFailed(s: Schedule): void {
    const compactFailures = (s.compactFailures ?? 0) + 1;
    if (compactFailures >= MAX_COMPACT_FAILURES) return this.end(s.id, { kind: 'failed', error: COMPACT_FAILED, pause: COMPACT_PAUSE });
    this.say(s.channel, `Schedule · ${s.title} · ${COMPACT_FAILED.toLowerCase()}. This run goes on.`, 'warn');
    this.ask(this.replace({ ...s, compactFailures }));
  }

  /** A runtime that reports no numbers can't say when it's full: after MAX_BLIND_RUNS runs, a new session with the recent chat. */
  private askBlind(started: Schedule): void {
    const blindRuns = (started.blindRuns ?? 0) + 1;
    if (blindRuns <= MAX_BLIND_RUNS) return this.ask(this.replace({ ...started, blindRuns }));
    const transcript = this.deps.transcript(started.channel);
    this.deps.forget(started.channel);
    this.say(started.channel, `Schedule · ${started.title} · this run starts a new session after ${MAX_BLIND_RUNS} runs, because this agent reports no context use`);
    this.ask(this.replace({ ...started, blindRuns: 1 }), transcript ? carriedPrompt(EARLIER_SESSION, transcript, started.prompt) : started.prompt);
  }

  /** The session is gone. This run starts again once, in a new session with the recent chat, and that counts as no failure. */
  private retryInNewSession(s: Schedule): void {
    const transcript = this.deps.transcript(s.channel);
    this.deps.forget(s.channel);
    this.say(s.channel, `Schedule · ${s.title} · its session could not be resumed, so this run starts again in a new session`, 'warn');
    const { requestId: _failed, ...running } = s.running!;
    this.ask(this.replace({ ...s, running, compactFailures: 0, blindRuns: 0 }), transcript ? carriedPrompt(EARLIER_SESSION, transcript, s.prompt) : s.prompt, true);
  }

  private ask(s: Schedule, prompt = s.prompt, retried = false): void {
    const requestId = this.deps.ask(prompt, s.channel);
    if (!requestId) return this.end(s.id, { kind: 'failed', error: 'Your agent could not be asked in this chat' });
    this.replace({ ...s, running: { ...s.running!, requestId } });
    this.deps.wait(requestId).then(
      () => this.end(s.id, { kind: 'ok' }),
      (err: unknown) => this.endWithError(s.id, requestId, err, retried),
    );
  }

  private endWithError(id: string, requestId: string, err: unknown, retried: boolean): void {
    if (this.closed) return;
    if (this.overTime.delete(requestId)) return this.end(id, { kind: 'failed', error: LIMIT_WORDS });
    const text = err instanceof Error ? err.message : String(err);
    const failure = decodeFailure(text);
    if (failure?.kind === 'stopped' || /^Stopped\b/.test(text)) return this.end(id, { kind: 'interrupted' });
    const s = this.get(id);
    if (failure?.staleSession && !retried && s?.running?.requestId === requestId && this.chatStillFits(s)) return this.retryInNewSession(s);
    this.end(id, { kind: 'failed', error: failureText(text), ...(failure?.kind === 'usage_limit' ? { usageLimit: true } : {}) });
  }

  private end(id: string, outcome: ScheduleOutcome): void {
    const s = this.get(id);
    this.noAsk.delete(id);
    if (!s || this.closed) return;
    const next = applyEnd(s, outcome, this.deps.now());
    this.replace(next);
    if (outcome.kind === 'failed' && outcome.error === LIMIT_WORDS) this.say(s.channel, `Schedule · ${s.title} · stopped: ${LIMIT_WORDS.toLowerCase()}`, 'warn');
    if (s.enabled && !next.enabled && next.pausedReason) {
      const body = outcome.kind === 'failed' ? `The last one: ${outcome.error}` : next.pausedReason;
      this.say(s.channel, `Schedule · ${s.title} · ${next.pausedReason}. ${body}`, 'warn', { id: s.id, title: s.title, prompt: s.prompt, due: s.running?.due ?? this.deps.now(), paused: true });
      this.deps.notify({ kind: 'problems', title: `${s.title} is paused`, body: `${next.pausedReason}. ${body}`, channel: s.channel, key: `schedule:${s.id}:paused:${next.lastEnd ?? 0}` });
    }
  }

  private stopOverTime(s: Schedule): void {
    const requestId = s.running?.requestId;
    if (!requestId) return void this.end(s.id, { kind: 'failed', error: LIMIT_WORDS });
    if (this.overTime.has(requestId)) return;
    this.overTime.add(requestId);
    this.deps.cancel(requestId, `Stopped by Beluga: ${LIMIT_WORDS.toLowerCase()}`);
  }

  /** A run that was active when the daemon stopped: interrupted, with a line. It doesn't count as a failure. */
  private recover(): void {
    if (this.recovered) return;
    this.recovered = true;
    for (const s of this.items) {
      if (!s.running) continue;
      this.say(s.channel, `Schedule · ${s.title} · the run due ${clock(s.running.due, this.clockOpts())} was interrupted when Beluga stopped`, 'warn');
      this.replace(applyEnd(s, { kind: 'interrupted' }, this.deps.now()));
    }
  }

  private say(channel: string, text: string, level: 'info' | 'warn' = 'info', mark?: ScheduleMark): void {
    this.deps.ensureLoaded(channel);
    this.deps.line(channel, text, level, mark);
  }

  /** Your Claude may be between the ask and its lane (delivery is a moment later): its run counts. */
  private busy(channel: string): boolean {
    return this.deps.busy(channel) || this.items.some((s) => s.channel === channel && s.running);
  }

  private replace(next: Schedule): Schedule {
    this.items = this.items.map((s) => (s.id === next.id ? next : s));
    this.save();
    return next;
  }

  private save(): void {
    this.file.write(this.items);
    this.publish();
  }

  private publish(): void {
    this.deps.publish(this.items.map((s) => this.view(s)));
  }

  private clockOpts(): { tz?: string } {
    return this.deps.tz ? { tz: this.deps.tz } : {};
  }
}

function dueOrder(s: Schedule, now: number, opts: { readonly tz?: string }): number {
  return s.pending?.due ?? nextTime(s, now, opts) ?? Number.MAX_SAFE_INTEGER;
}
