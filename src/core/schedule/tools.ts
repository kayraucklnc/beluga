import { SCHEDULE_RUN_TOOLS } from '../../agent/schedule-tools.js';
import type { ScheduleTools } from '../../agent/types.js';
import { ScheduleInputSchema, SchedulePatchSchema, type Schedule, type ScheduleWhen } from './schema.js';
import type { Schedules } from './service.js';

/**
 * The agent's side of schedules: the tools of one chat's run, and what the approval card says. The
 * tools use the service as the user's actions do, and each is bound to the chat of its run.
 */

const CHAT_BRIEF =
  '\n\nSchedules: mcp__beluga_schedule__* (schedule_list, schedule_create, schedule_update, schedule_pause, schedule_remove) manage runs that repeat in this chat. Each run continues the conversation of this chat and writes in this chat. ' +
  'When the user asks for work to repeat here ("check this every morning"), use schedule_create. Use a Sentinel only for a watcher with its own steps or triggers. ' +
  'schedule_create, schedule_update and schedule_remove ask the user first: use them only when the user asked, and say that they wait for the approval of the user. These tools can only reach this chat.\n';
const RUN_BRIEF = '\n\nSchedules: this scheduled run can only use schedule_list and schedule_pause. It cannot make, change or remove a schedule. If such a change is necessary, say it in your answer.\n';

const NOT_HERE = 'This chat has no schedule with that id. Call schedule_list.';

/** The tools for a run, or nothing where a chat can't have a schedule. `requestId`: a schedule's own run gets fewer. */
export function scheduleToolsFor(schedules: Schedules, channel: string, requestId?: string): { readonly tools: ScheduleTools; readonly brief: string } | undefined {
  if (!schedules.isOn() || !schedules.fits(channel)) return undefined;
  const tools = chatTools(schedules, channel);
  return requestId !== undefined && schedules.briefFor(channel, requestId) !== undefined ? { tools: { ...tools, only: SCHEDULE_RUN_TOOLS }, brief: RUN_BRIEF } : { tools, brief: CHAT_BRIEF };
}

/**
 * What the approval card says for a tool that asks you, read from what the tool will really do.
 * Nothing when the call would be refused anyway: the card falls back to the tool's name and input.
 */
export function scheduleCard(schedules: Schedules, toolName: string, input: Record<string, unknown>, channel: string): { readonly title: string; readonly detail: string } | undefined {
  if (toolName === 'mcp__beluga_schedule__schedule_create') {
    const made = ScheduleInputSchema.safeParse(input);
    return made.success ? { title: runSentence(schedules, made.data.title, made.data.when), detail: made.data.prompt } : undefined;
  }
  const s = schedules.get(String(input.id ?? ''));
  if (s?.channel !== channel) return undefined;
  if (toolName === 'mcp__beluga_schedule__schedule_remove') return { title: `Remove ${quoted(s.title)}, which runs ${schedules.whenInSentence(s.when)} in this chat`, detail: s.prompt };
  if (toolName !== 'mcp__beluga_schedule__schedule_update') return undefined;
  const patch = SchedulePatchSchema.safeParse(input);
  if (!patch.success) return undefined;
  const after = { ...s, ...patch.data };
  const sentence = runSentence(schedules, after.title, after.when);
  if (input.resume === true && !s.enabled) return { title: `Turn on ${quoted(s.title)}: ${sentence}`, detail: after.prompt };
  return { title: `Change ${quoted(s.title)}: ${sentence}${s.enabled ? '' : ' (it stays paused)'}`, detail: after.prompt };
}

function chatTools(schedules: Schedules, channel: string): ScheduleTools {
  /** A schedule of this chat. An id from another chat is refused as one that isn't here. */
  const own = (id: string): Schedule => {
    if (!schedules.isOn()) throw new Error('Schedules are off. The user can turn on the setting chatSchedules.');
    const s = schedules.get(id);
    if (s?.channel !== channel) throw new Error(NOT_HERE);
    return s;
  };
  return {
    list: () => {
      const items = schedules.list(channel);
      return items.length ? items.map((s) => line(schedules, s)).join('\n\n') : 'This chat has no schedules.';
    },
    create: (input) => {
      if (!schedules.isOn()) throw new Error('Schedules are off. The user can turn on the setting chatSchedules.');
      // Approval turns it on: nothing the tool is given can save it off.
      const made = schedules.create(channel, { ...ScheduleInputSchema.parse(input), enabled: true });
      return `${quoted(made.title)} is on. ${nextWords(schedules, made)}`;
    },
    update: (id, patch, resume) => {
      own(id);
      const parsed = SchedulePatchSchema.parse(patch);
      if (!Object.keys(parsed).length && !resume) throw new Error('Name what to change, or set resume to true.');
      schedules.update(id, parsed);
      const s = resume ? schedules.setEnabled(id, true) : schedules.get(id)!;
      return `${quoted(s.title)} is changed. ${s.enabled ? nextWords(schedules, s) : 'It is still paused.'}`;
    },
    pause: (id) => {
      const s = own(id);
      if (!s.enabled) return `${quoted(s.title)} is already paused.`;
      schedules.setEnabled(id, false, 'Paused by your agent');
      return `${quoted(s.title)} is paused.`;
    },
    remove: (id) => {
      const s = own(id);
      schedules.remove(id);
      return `${quoted(s.title)} is removed.`;
    },
  };
}

function runSentence(schedules: Schedules, title: string, when: ScheduleWhen): string {
  return `Run ${quoted(title)} ${schedules.whenInSentence(when)} in this chat`;
}

function quoted(title: string): string {
  return `"${title.replace(/\s+/g, ' ').trim()}"`;
}

function nextWords(schedules: Schedules, s: Schedule): string {
  const next = schedules.view(s).next;
  return next === undefined ? `It runs ${schedules.whenInSentence(s.when)}.` : `It runs ${schedules.whenInSentence(s.when)}. Next run: ${new Date(next).toLocaleString()}.`;
}

function line(schedules: Schedules, s: Schedule): string {
  const view = schedules.view(s);
  const state = s.enabled ? 'on' : `paused${s.pausedReason ? ` (${s.pausedReason})` : ''}`;
  const next = view.next === undefined ? '' : ` · next ${new Date(view.next).toLocaleString()}`;
  const error = s.lastError ? `: ${s.lastError}` : '';
  return `${s.id} · ${quoted(s.title)} · ${state} · ${schedules.whenInSentence(s.when)}${next} · last ${view.status}${error}\nPrompt: ${s.prompt}`;
}
