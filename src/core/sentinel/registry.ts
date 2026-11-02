import type { Sentinels } from './sentinels.js';

/** Which sentinels serve a session (the daemon's), so the API and Claude's runs can reach them. */
const all = new WeakMap<object, Sentinels>();

export const attachSentinel = (session: object, sentinels: Sentinels): void => void all.set(session, sentinels);
export const detachSentinel = (session: object): void => void all.delete(session);
export const sentinelOf = (session: object): Sentinels | undefined => all.get(session);

/** The session's sentinels, or a clear error where there are none (the terminal on its own). */
export function needSentinel(session: object): Sentinels {
  const s = all.get(session);
  if (!s) throw new Error('Sentinel needs the Beluga app (its daemon): it is not available here.');
  return s;
}
