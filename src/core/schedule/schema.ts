import { z } from 'zod';
import { ScheduleTriggerSchema } from '../../shared/schedule/schema.js';

/** A schedule in a chat as zod checks: what the API takes and what schedules.json keeps. No I/O. */

export const MAX_TITLE = 80;
export const MAX_PROMPT = 8000;

export const ScheduleWhenSchema = z.discriminatedUnion('kind', [
  /** The next run comes this long after the end of the last one. */
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(525_600) }),
  /** The Sentinel slots (hours, day, other day, week, month), in the Mac's local time. */
  ScheduleTriggerSchema.omit({ missed: true }),
  /** One run at this moment; afterwards the schedule has no next time and is off. */
  z.object({ kind: z.literal('once'), at: z.number().int().positive() }),
]);
export type ScheduleWhen = z.infer<typeof ScheduleWhenSchema>;

/** A slot that passed while this computer was off: run once when it's back, or skip it. */
const Missed = z.enum(['catch-up', 'skip']);
/** A slot that comes due while the chat is busy: hold one occurrence until it's idle, or drop it. */
const IfBusy = z.enum(['hold', 'skip']);
/** What a run continues from: the chat's conversation, or a fresh session. */
const Context = z.enum(['continue', 'fresh']);

const fields = {
  title: z.string().trim().min(1, 'A schedule needs a title').max(MAX_TITLE),
  prompt: z.string().trim().min(1, 'A schedule needs a prompt').max(MAX_PROMPT),
  when: ScheduleWhenSchema,
};
const withDefaults = {
  ...fields,
  missed: Missed.default('catch-up'),
  ifBusy: IfBusy.default('hold'),
  context: Context.default('continue'),
  enabled: z.boolean().default(true),
};

export const ScheduleInputSchema = z.object(withDefaults);
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

/** A saved edit: only what it names changes. Pause and resume have their own method. */
export const SchedulePatchSchema = z.object({ ...fields, missed: Missed, ifBusy: IfBusy, context: Context }).partial();
export type SchedulePatch = z.infer<typeof SchedulePatchSchema>;

/** The occurrence that waits for the chat to be idle: one, however many slots merged into it. */
export const SchedulePendingSchema = z.object({
  due: z.number(),
  slots: z.number().int().min(1),
  missed: z.number().int().min(0),
});
export type SchedulePending = z.infer<typeof SchedulePendingSchema>;

/** The run under way. It is saved before the ask, so a restart sees it and never starts it twice. */
export const ScheduleRunningSchema = SchedulePendingSchema.extend({
  startedAt: z.number(),
  /** The agent request that carries it, once it was asked. */
  requestId: z.string().optional(),
});
export type ScheduleRunning = z.infer<typeof ScheduleRunningSchema>;

export const ScheduleSchema = z.object({
  ...withDefaults,
  id: z.string().min(1),
  channel: z.string().min(1),
  /** Why it is paused (archived, three failures…): shown to the user. */
  pausedReason: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Where the timing counts from: the last slot handled, or the end of the last interval run. */
  anchor: z.number().optional(),
  lastEnd: z.number().optional(),
  last: z.enum(['ok', 'failed', 'interrupted']).optional(),
  lastError: z.string().optional(),
  failures: z.number().int().min(0).default(0),
  /** Compactions in a row that failed before a run. */
  compactFailures: z.number().int().min(0).optional(),
  /** Runs in this session in a row whose runtime reported no context numbers. */
  blindRuns: z.number().int().min(0).optional(),
  pending: SchedulePendingSchema.optional(),
  running: ScheduleRunningSchema.optional(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;
