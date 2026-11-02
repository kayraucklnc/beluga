import { needIssues } from '../core/issues/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `issues.*` method does (see issues-api.ts): you act as yourself. */

type IssuesMethod = Extract<Method, `issues.${string}`>;
type IssuesHandlers = { readonly [M in IssuesMethod]: (s: Session, ...args: Args<M>) => unknown };

export const ISSUES_HANDLERS = {
  'issues.list': (s, projectId, query) => needIssues(s).list(projectId, query ?? {}),
  'issues.pulls': (s, projectId, opts) => needIssues(s).pulls(projectId, opts?.force ?? false),
  'issues.get': (s, projectId, number, opts) => needIssues(s).get(projectId, number, opts?.force),
  'issues.investigate': (s, projectId, number, opts) => needIssues(s).investigate(projectId, number, { ...(opts?.note ? { note: opts.note } : {}), ...(opts?.anyway ? { anyway: true } : {}) }),
  'issues.fix': (s, projectId, number, opts) => needIssues(s).fix(projectId, number, { ...(opts?.note ? { note: opts.note } : {}), ...(opts?.anyway ? { anyway: true } : {}) }),
  'issues.toTask': (s, projectId, number, opts) => needIssues(s).toTask(projectId, number, { ...(opts?.look ? { look: true } : {}), ...(opts?.note ? { note: opts.note } : {}) }),
  'issues.comment': (s, projectId, number, body) => needIssues(s).comment(projectId, number, body),
} satisfies IssuesHandlers;
