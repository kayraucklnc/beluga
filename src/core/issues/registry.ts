import type { GitHubIssues } from './issues.js';

/** Which GitHub issues serve a session (the daemon's), so the API can reach them. */
const services = new WeakMap<object, GitHubIssues>();

export const attachIssues = (session: object, issues: GitHubIssues): void => void services.set(session, issues);
export const detachIssues = (session: object): void => void services.delete(session);

/** The session's GitHub issues, or a clear error where there are none (the terminal on its own). */
export function needIssues(session: object): GitHubIssues {
  const issues = services.get(session);
  if (!issues) throw new Error('GitHub issues need the Beluga app (its daemon): they are not available here.');
  return issues;
}
