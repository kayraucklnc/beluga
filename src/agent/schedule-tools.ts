import { tool, toolSuite } from './tool-kit.js';
import { z } from 'zod';
import { ScheduleWhenSchema, SchedulePatchSchema } from '../core/schedule/schema.js';
import type { ScheduleTools } from './types.js';

/**
 * A chat's schedules as the agent's tools (server `beluga_schedule`), bound to the chat of the run:
 * no tool takes a channel, so another chat can't be named. Create, update and remove ask you first
 * (policy ALWAYS_ASK_YOU). A scheduled run has only list and pause.
 */

export const SCHEDULE_TOOL_NAMES = ['schedule_list', 'schedule_create', 'schedule_update', 'schedule_pause', 'schedule_remove'].map((n) => `mcp__beluga_schedule__${n}`);
/** What a scheduled run may use (short names): a run can't make, change or remove a schedule. */
export const SCHEDULE_RUN_TOOLS: readonly string[] = ['schedule_list', 'schedule_pause'];

const { title, prompt, missed, ifBusy, context } = SchedulePatchSchema.shape;
const id = z.string().min(1).max(80).describe('The id of a schedule of this chat (from schedule_list)');
const WHEN = ScheduleWhenSchema.describe(
  'When it runs. {kind:"interval",minutes}: the next run starts this many minutes after the last run ended. {kind:"schedule",every,at,hours,days,day}: every is hours, day, other-day, week or month; at is local time like "21:00"; hours (1, 2, 3, 6 or 12) goes with every hours; days (0 is Sunday) goes with every week; day (1 to 28) goes with every month. {kind:"once",at}: one run at this time, in milliseconds since 1970.',
);
const OPTIONS = {
  missed: missed.describe('A run that passed while this computer was off: catch-up (the default) runs it once; skip drops it'),
  ifBusy: ifBusy.describe('A run that comes due while this chat is busy: hold (the default) keeps one until the chat is idle; skip drops it'),
  context: context.describe('continue (the default) continues the conversation of this chat; fresh starts a new session'),
};

function guarded(fn: () => string): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return Promise.resolve()
    .then(fn)
    .then(
      (text) => ({ content: [{ type: 'text' as const, text }] }),
      (err: unknown) => ({ content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }),
    );
}

export function createScheduleToolDefs(s: ScheduleTools) {
  const defs = [
    tool('schedule_list', 'The schedules of this chat: id, title, whether each is on, when it runs, its next run, its last result and its prompt.', {}, () => guarded(() => s.list())),
    tool(
      'schedule_create',
      'Make a schedule in this chat: a run that repeats, continues the conversation of this chat and writes in this chat. Use it when the user asks for work to repeat here ("check this every morning"). The user is asked to approve it first. When they approve, the schedule is on.',
      { title: title.unwrap().describe('A short name, like "Nightly triage"'), prompt: prompt.unwrap().describe('What the agent is told at each run'), when: WHEN, ...OPTIONS },
      (a) => guarded(() => s.create(a)),
    ),
    tool(
      'schedule_update',
      'Change a schedule of this chat, or turn on a paused one. Name only what changes. The user is asked to approve it first. A run that is going now ends on the new values.',
      { id, title: title.describe('A new name'), prompt: prompt.describe('A new prompt'), when: WHEN.optional(), ...OPTIONS, resume: z.boolean().optional().describe('true: turn a paused schedule on') },
      ({ id: which, resume, ...patch }) => guarded(() => s.update(which, patch, resume === true)),
    ),
    tool('schedule_pause', 'Pause a schedule of this chat. It starts no new runs, and a run that is going now finishes.', { id }, (a) => guarded(() => s.pause(a.id))),
    tool('schedule_remove', 'Remove a schedule of this chat (only when the user asks). A run that is going now finishes. The user is asked to approve it first.', { id }, (a) => guarded(() => s.remove(a.id))),
  ];
  return s.only ? defs.filter((d) => s.only!.includes(d.name)) : defs;
}

export function createScheduleTools(s: ScheduleTools) {
  return toolSuite({ name: 'beluga_schedule', version: '0.1.0', tools: createScheduleToolDefs(s) });
}
