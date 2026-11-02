import type { GitHubCi } from './ci.js';

/** Which GitHub Actions serve a session (the daemon's), so the API can reach them. */
const services = new WeakMap<object, GitHubCi>();

export const attachCi = (session: object, ci: GitHubCi): void => void services.set(session, ci);
export const detachCi = (session: object): void => void services.delete(session);

/** The session's GitHub Actions, or a clear error where there are none (the terminal on its own). */
export function needCi(session: object): GitHubCi {
  const ci = services.get(session);
  if (!ci) throw new Error('GitHub Actions need the Beluga app (its daemon): they are not available here.');
  return ci;
}
