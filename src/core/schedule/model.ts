import { COMPACT_INSTRUCTIONS } from '../../shared/context-usage.js';
import { dueNow, LATE_MS, nextRunAt } from '../../shared/schedule/clock.js';
import { scheduleWords, type ScheduleTrigger } from '../../shared/schedule/trigger.js';
import type { GuestSchedule } from '../../protocol.js';
import type { Schedule, ScheduleInput, SchedulePatch, ScheduleWhen } from './schema.js';

/**
 * Every timing and merge decision of a schedule in a chat: pure functions, no I/O. The service
 * ticks them, saves what they return and does what they decide.
 */

export const RUN_LIMIT_MS = 60 * 60 * 1000;
/** Failures in a row that pause a schedule (usage limits and interrupted runs don't count). */
export const MAX_FAILURES = 3;
/** Compactions in a row that fail before the schedule pauses. */
export const MAX_COMPACT_FAILURES = 2;
/** Runs one session may have when its runtime reports no context numbers: the next starts a new session. */
export const MAX_BLIND_RUNS = 50;

export type ScheduleStatus = 'never' | 'waiting' | 'running' | 'ok' | 'failed' | 'interrupted';
/** What a row says of a schedule: its status, or paused. */
export type RowStatus = ScheduleStatus | 'paused';

/** A schedule as screens see it. */
export type ScheduleView = Schedule & { readonly status: ScheduleStatus; readonly next?: number };

export interface ClockOpts {
  /** An IANA zone, for tests: without it, the Mac's local time. */
  readonly tz?: string;
}

/** What the chat is doing now, as the service sees it. */
export interface LaneState {
  readonly busy: boolean;
}

export type Decision =
  /** Not due (`at`: the next time, if it has one). */
  | { readonly kind: 'nothing'; readonly at?: number }
  /** Start now: `due` is the first slot it answers, `slots` how many merged, `missed` how many passed while off. */
  | { readonly kind: 'run'; readonly slot?: number; readonly due: number; readonly slots: number; readonly missed: number; readonly late: boolean }
  /** Due on a busy chat: keep one pending occurrence. */
  | { readonly kind: 'hold'; readonly slot: number; readonly slots: number; readonly missed: number }
  /** One more slot on the pending occurrence. */
  | { readonly kind: 'merge'; readonly slot: number; readonly slots: number; readonly missed: number }
  /** Drop the slot and write one line. */
  | { readonly kind: 'skip'; readonly slot: number; readonly why: SkipWhy };

export type SkipWhy = 'busy' | 'missed';

export type ScheduleOutcome =
  | { readonly kind: 'ok' }
  /** `usageLimit`: the plan ran out, so the next slot tries again and it doesn't count. */
  | { readonly kind: 'failed'; readonly error: string; readonly usageLimit?: boolean; readonly pause?: string }
  /** The daemon stopped during the run: not the schedule's fault. */
  | { readonly kind: 'interrupted' };

type NewSchedule = Pick<Schedule, 'id' | 'channel' | 'title' | 'prompt' | 'when'> & Partial<Pick<ScheduleInput, 'missed' | 'ifBusy' | 'context' | 'enabled'>>;

interface DueSlots {
  /** The latest slot at or before now. */
  readonly slot: number;
  readonly slots: number;
  readonly missed: number;
  readonly late: boolean;
}

/**
 * What a schedule does now. The lane counts as busy during its own run too, so a slot that passes
 * during that run waits for it. A held occurrence starts as soon as the chat is idle.
 */
export function decide(schedule: Schedule, lane: LaneState, now: number, opts: ClockOpts = {}): Decision {
  if (!schedule.enabled) return { kind: 'nothing' };
  const busy = lane.busy || Boolean(schedule.running);
  const { pending, when } = schedule;
  const due = dueSlots(schedule, now, opts);
  if (due?.late && schedule.missed === 'skip' && when.kind !== 'once') return { kind: 'skip', slot: due.slot, why: 'missed' };
  if (busy) {
    if (!due) return nothingUntil(schedule, now, opts);
    if (schedule.ifBusy === 'skip' && when.kind !== 'once') return { kind: 'skip', slot: due.slot, why: 'busy' };
    return { kind: pending ? 'merge' : 'hold', slot: due.slot, slots: due.slots, missed: due.missed };
  }
  if (!due && !pending) return nothingUntil(schedule, now, opts);
  return {
    kind: 'run',
    ...(due ? { slot: due.slot } : {}),
    due: pending?.due ?? due!.slot,
    slots: (pending?.slots ?? 0) + (due?.slots ?? 0),
    missed: (pending?.missed ?? 0) + (due?.missed ?? 0),
    late: due?.late ?? false,
  };
}

/** The next time after `after` (the end of the last interval run, or the last slot handled); undefined when there is none. */
export function nextDue(when: ScheduleWhen, after: number | undefined, now: number, opts: ClockOpts = {}): number | undefined {
  switch (when.kind) {
    case 'interval':
      return (after ?? now) + when.minutes * 60_000;
    case 'once':
      return after === undefined ? when.at : undefined;
    default:
      return nextRunAt(asTrigger(when), after, now, opts.tz);
  }
}

/** What a decision changes in the saved schedule. A run is marked started here, before any ask. */
export function applyDecision(schedule: Schedule, decision: Decision, now: number): Schedule {
  switch (decision.kind) {
    case 'nothing':
      return schedule;
    case 'skip':
      return { ...schedule, anchor: decision.slot };
    case 'hold':
      return { ...schedule, anchor: decision.slot, pending: { due: decision.slot, slots: decision.slots, missed: decision.missed } };
    case 'merge': {
      const pending = schedule.pending ?? { due: decision.slot, slots: 0, missed: 0 };
      return { ...schedule, anchor: decision.slot, pending: { ...pending, slots: pending.slots + decision.slots, missed: pending.missed + decision.missed } };
    }
    case 'run': {
      const { pending: _done, ...rest } = schedule;
      return {
        ...rest,
        ...(decision.slot !== undefined ? { anchor: decision.slot } : {}),
        running: { due: decision.due, slots: decision.slots, missed: decision.missed, startedAt: now },
      };
    }
  }
}

/**
 * The end of a run, on the schedule as saved now: an edit that raced the run keeps its values. An
 * interval counts from this end. A once schedule is off, however it ended.
 */
export function applyEnd(schedule: Schedule, outcome: ScheduleOutcome, now: number): Schedule {
  const { running: _done, lastError: _old, ...rest } = schedule;
  const ended: Schedule = {
    ...rest,
    last: outcome.kind,
    lastEnd: now,
    ...(outcome.kind === 'failed' ? { lastError: outcome.error } : {}),
    ...(schedule.when.kind === 'interval' ? { anchor: now } : {}),
    failures: failuresAfter(schedule.failures, outcome),
  };
  if (schedule.when.kind === 'once') return { ...ended, enabled: false };
  if (outcome.kind === 'failed' && outcome.pause && schedule.enabled) return pauseSchedule(ended, outcome.pause, now);
  return ended.failures >= MAX_FAILURES && schedule.enabled ? pauseSchedule(ended, `Paused after ${MAX_FAILURES} failed runs in a row`, now) : ended;
}

/** A schedule as it starts: its timing counts from now. */
export function newSchedule(input: NewSchedule, now: number): Schedule {
  return {
    missed: 'catch-up',
    ifBusy: 'hold',
    context: 'continue',
    enabled: true,
    ...input,
    createdAt: now,
    updatedAt: now,
    failures: 0,
    ...anchorFrom(input.when, now),
  };
}

/** Why this `when` can't be saved, in words the user can act on. */
export function checkWhen(when: ScheduleWhen, now: number): string | undefined {
  if (when.kind === 'once' && when.at <= now) return 'That time is in the past. Pick a time in the future.';
  return undefined;
}

/** Paused with a reason. A held occurrence is dropped; a run under way finishes. */
export function pauseSchedule(schedule: Schedule, reason: string, now: number): Schedule {
  const { pending: _dropped, ...rest } = schedule;
  return { ...rest, enabled: false, pausedReason: reason, updatedAt: now };
}

/** On again: failures cleared, and the slots that passed while paused don't catch up. */
export function resumeSchedule(schedule: Schedule, now: number): Schedule {
  const { pausedReason: _reason, pending: _pending, compactFailures: _compacts, ...rest } = schedule;
  return { ...rest, enabled: true, failures: 0, updatedAt: now, ...(rest.when.kind === 'once' ? {} : { anchor: now }) };
}

/** The saved edit. A new `when` restarts the timing from now, so there is always one next time. */
export function applyEdit(schedule: Schedule, patch: SchedulePatch, now: number): Schedule {
  const whenChanged = patch.when !== undefined && JSON.stringify(patch.when) !== JSON.stringify(schedule.when);
  if (!whenChanged) return { ...schedule, ...patch, updatedAt: now };
  const { pending: _pending, anchor: _anchor, ...rest } = schedule;
  return { ...rest, ...patch, updatedAt: now, ...anchorFrom(patch.when!, now) };
}

/** The one next time a screen shows: none while paused, and none for an interval until its run ends. */
export function nextTime(schedule: Schedule, now: number, opts: ClockOpts = {}): number | undefined {
  if (!schedule.enabled) return undefined;
  if (schedule.running && schedule.when.kind === 'interval') return undefined;
  return nextDue(schedule.when, schedule.anchor, now, opts);
}

/** Past the time limit: the service cancels the run. */
export function overLimit(schedule: Schedule, now: number): boolean {
  return schedule.running !== undefined && now - schedule.running.startedAt > RUN_LIMIT_MS;
}

export function scheduleView(schedule: Schedule, now: number, opts: ClockOpts = {}): ScheduleView {
  const next = nextTime(schedule, now, opts);
  return { ...schedule, status: scheduleStatus(schedule), ...(next !== undefined ? { next } : {}) };
}

export function scheduleStatus(schedule: Schedule): ScheduleStatus {
  if (schedule.running) return 'running';
  if (schedule.pending) return 'waiting';
  return schedule.last ?? 'never';
}

/** What a row says. A run under way shows first; a once schedule that ran is off without being paused. */
export function rowStatus(s: ScheduleView): RowStatus {
  if (s.status === 'running') return 'running';
  if (!s.enabled && (s.pausedReason || s.when.kind !== 'once' || !s.last)) return 'paused';
  return s.status;
}

/** The reason a row shows under its line: why it failed or was paused. Your own pause needs no reason. */
export function scheduleProblem(s: Pick<ScheduleView, 'pausedReason' | 'last' | 'lastError'>): string | undefined {
  const reason = s.pausedReason && s.pausedReason !== 'Paused by you' ? s.pausedReason : undefined;
  const error = s.last === 'failed' ? s.lastError : undefined;
  if (reason && error) return `${reason}. The last one: ${error}`;
  return reason ?? error;
}

/** What goes to someone who follows the chat. Nothing of the run itself, and no reason that speaks to the owner ("Paused by you"). */
export function guestSchedule(s: ScheduleView, opts: ClockOpts = {}): GuestSchedule {
  const sentence = whenInSentence(s.when, opts);
  const reason = s.pausedReason && !s.pausedReason.startsWith('Paused by you') ? s.pausedReason.slice(0, 500) : undefined;
  return {
    id: s.id,
    title: s.title,
    prompt: s.prompt,
    sentence: sentence.charAt(0).toUpperCase() + sentence.slice(1),
    status: rowStatus(s),
    enabled: s.enabled,
    ...(s.next !== undefined ? { next: s.next } : {}),
    ...(reason ? { pausedReason: reason } : {}),
  };
}

/** When it runs, in words. */
export function whenWords(when: ScheduleWhen, opts: ClockOpts = {}): string {
  if (when.kind === 'interval') return when.minutes === 1 ? 'Every minute' : `Every ${when.minutes} minutes`;
  if (when.kind === 'once') return `Once at ${clock(when.at, opts)}`;
  return scheduleWords(asTrigger(when));
}

/** When it runs, inside a sentence ("every day at 21:00"). A once time says its date, because it can be far away. */
export function whenInSentence(when: ScheduleWhen, opts: ClockOpts = {}): string {
  if (when.kind === 'once') return `once on ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(opts.tz ? { timeZone: opts.tz } : {}) }).format(new Date(when.at))} at ${clock(when.at, opts)}`;
  const words = whenWords(when, opts);
  return words.charAt(0).toLowerCase() + words.slice(1);
}

/** The chat line of a run. */
export function runLine(title: string, run: { readonly due: number; readonly slots: number; readonly missed: number }, opts: ClockOpts = {}): string {
  return [`Scheduled run · ${title} · due ${clock(run.due, opts)}`, ...runExtras(run)].join(' · ');
}

/** What a run stands for beyond its one slot, in words. Nothing for a plain run, or an old saved line with no counts. */
export function runExtras(run: { readonly slots?: number; readonly missed?: number }): string[] {
  const { slots = 1, missed = 0 } = run;
  return [...(slots > 1 ? [`merged ${slots} slots`] : []), ...(missed > 0 ? [`missed ${missed} ${missed === 1 ? 'run' : 'runs'} while this computer was off`] : [])];
}

/** The chat line of a dropped slot. */
export function skipLine(title: string, skip: { readonly slot: number; readonly why: SkipWhy }, opts: ClockOpts = {}): string {
  const line = `Schedule · ${title} · skipped the run at ${clock(skip.slot, opts)}`;
  return skip.why === 'busy' ? `${line} because this chat was busy` : line;
}

/** What the agent is told about a turn a schedule started. */
export function scheduleBrief(title: string, run: { readonly due: number; readonly startedAt: number }, opts: ClockOpts = {}, context: Schedule['context'] = 'continue'): string {
  const name = title.replace(/\s+/g, ' ');
  const session = context === 'fresh' ? 'This turn starts a new session, and only the recent chat lines come with it.' : 'This turn continues the conversation of this chat.';
  return `\n\nA schedule started this turn. No person sent the message of this turn. The schedule is "${name}". The run was due at ${clock(run.due, opts)} and started at ${clock(run.startedAt, opts)}. ${session} Do the work that the message asks for. Keep the report short and do not restate earlier reports. If there is nothing new, report that in one line.\n`;
}

/** What a compaction before a scheduled run keeps, beside what every compaction keeps. */
export function compactInstructions(schedule: Schedule): string {
  const purpose = schedule.prompt.replace(/\s+/g, ' ').slice(0, 500);
  const last = schedule.last ? ` The last run ended as ${schedule.last}${schedule.lastError ? `: ${schedule.lastError.replace(/\s+/g, ' ').slice(0, 300)}` : ''}.` : '';
  return `${COMPACT_INSTRUCTIONS} A schedule named "${schedule.title.replace(/\s+/g, ' ')}" runs in this chat. Keep its purpose ("${purpose}"), the result of its last run and its open items.${last}`;
}

/** "21:00", in local time. */
export function clock(ms: number, opts: ClockOpts = {}): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(opts.tz ? { timeZone: opts.tz } : {}) }).format(new Date(ms));
}

/** What came due since the anchor: nothing, or the latest slot and how many it stands for. */
function dueSlots(schedule: Schedule, now: number, opts: ClockOpts): DueSlots | undefined {
  const { when, anchor } = schedule;
  switch (when.kind) {
    case 'interval': {
      if (schedule.running) return undefined;
      const first = nextDue(when, anchor, now, opts)!;
      if (first > now) return undefined;
      const every = when.minutes * 60_000;
      const count = Math.floor((now - first) / every) + 1;
      const late = now - first > LATE_MS;
      return { slot: first + (count - 1) * every, late, slots: late ? 1 : count, missed: late ? count : 0 };
    }
    case 'once': {
      const at = nextDue(when, anchor, now, opts);
      if (at === undefined || at > now) return undefined;
      const late = now - at > LATE_MS;
      return { slot: at, late, slots: 1, missed: late ? 1 : 0 };
    }
    default: {
      const due = dueNow(asTrigger(when), anchor, now, opts.tz ? { tz: opts.tz } : {});
      if (due.kind === 'wait') return undefined;
      // The clock counts the slot itself: on time, only the earlier ones were missed.
      const late = due.kind === 'skip' || due.late;
      return { slot: due.slot, late, slots: 1, missed: late ? due.missed : due.missed - 1 };
    }
  }
}

function nothingUntil(schedule: Schedule, now: number, opts: ClockOpts): Decision {
  const at = nextTime(schedule, now, opts);
  return at === undefined ? { kind: 'nothing' } : { kind: 'nothing', at };
}

function failuresAfter(failures: number, outcome: ScheduleOutcome): number {
  if (outcome.kind === 'ok') return 0;
  return outcome.kind === 'failed' && !outcome.usageLimit ? failures + 1 : failures;
}

function anchorFrom(when: ScheduleWhen, now: number): { anchor?: number } {
  return when.kind === 'once' ? {} : { anchor: now };
}

function asTrigger(when: Extract<ScheduleWhen, { kind: 'schedule' }>): ScheduleTrigger {
  // `missed` is the schedule's own and the service applies it: here it only has to let the clock run.
  return { ...when, missed: 'catch-up' };
}
