import { needSchedules } from '../core/schedule/registry.js';
import type { Schedules } from '../core/schedule/service.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `schedule.*` method does (see schedule-api.ts): you act as yourself, on your own chats. */

type ScheduleMethod = Extract<Method, `schedule.${string}`>;
type ScheduleHandlers = { readonly [M in ScheduleMethod]: (s: Session, ...args: Args<M>) => unknown };

/** The schedules, once it's sure the chat is the caller's: someone else's chat is its owner's to schedule. */
function asOwner(s: Session, id: string): Schedules {
  const schedules = needSchedules(s);
  const channel = schedules.get(id)?.channel;
  if (channel && s.sharing.sharedFor(channel)) throw new Error('Only the owner of a chat can change its schedules.');
  return schedules;
}

export const SCHEDULE_HANDLERS = {
  'schedule.list': (s, channel) => {
    const schedules = needSchedules(s);
    return schedules.list(channel).map((x) => schedules.view(x));
  },
  'schedule.create': (s, channel, input) => {
    const schedules = needSchedules(s);
    return schedules.view(schedules.create(channel, input));
  },
  'schedule.update': (s, id, patch) => {
    const schedules = asOwner(s, id);
    return schedules.view(schedules.update(id, patch));
  },
  'schedule.setEnabled': (s, id, on) => {
    const schedules = asOwner(s, id);
    return schedules.view(schedules.setEnabled(id, on));
  },
  'schedule.runNow': (s, id) => {
    const schedules = asOwner(s, id);
    return schedules.view(schedules.runNow(id));
  },
  'schedule.remove': (s, id) => asOwner(s, id).remove(id),
} satisfies ScheduleHandlers;
