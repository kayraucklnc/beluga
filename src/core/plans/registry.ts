import type { PlansWork } from './work.js';

/** Which plans serve a session (the daemon's), so the API and Claude's runs can reach them. */
const all = new WeakMap<object, PlansWork>();

export const attachPlans = (session: object, plans: PlansWork): void => void all.set(session, plans);
export const detachPlans = (session: object): void => void all.delete(session);
export const plansOf = (session: object): PlansWork | undefined => all.get(session);

/** The session's plans, or a clear error where there are none (the terminal on its own). */
export function needPlans(session: object): PlansWork {
  const plans = all.get(session);
  if (!plans) throw new Error('Plans need the Beluga app (its daemon): they are not available here.');
  return plans;
}
