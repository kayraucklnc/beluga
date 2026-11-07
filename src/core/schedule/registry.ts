import type { Schedules } from './service.js';

/** Which schedules serve a session (the daemon's), so the API and the agent's runs can reach them. */
const all = new WeakMap<object, Schedules>();

export const attachSchedules = (session: object, schedules: Schedules): void => void all.set(session, schedules);
export const detachSchedules = (session: object): void => void all.delete(session);
export const schedulesOf = (session: object): Schedules | undefined => all.get(session);

/** The session's schedules for the API and /schedule, or a clear error while the setting is off. */
export function needSchedules(session: object): Schedules {
  const s = all.get(session);
  if (!s) throw new Error('Schedules need the Beluga app (its daemon): they are not available here.');
  if (!s.isOn()) throw new Error('Schedules are off. Turn on the setting chatSchedules to use them.');
  return s;
}
