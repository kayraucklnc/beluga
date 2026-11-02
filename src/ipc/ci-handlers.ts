import { needCi } from '../core/ci/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `ci.*` method does (see ci-api.ts): gh runs as you. */

type CiMethod = Extract<Method, `ci.${string}`>;
type CiHandlers = { readonly [M in CiMethod]: (s: Session, ...args: Args<M>) => unknown };

export const CI_HANDLERS = {
  'ci.runs': (s, projectId, query) => needCi(s).list(projectId, query ?? {}),
  'ci.run': (s, projectId, id, opts) => needCi(s).get(projectId, id, opts?.force ?? false),
  'ci.workflows': (s, projectId, opts) => needCi(s).workflows(projectId, opts?.force ?? false),
  'ci.log': (s, projectId, id) => needCi(s).log(projectId, id),
  'ci.rerun': (s, projectId, id, opts) => needCi(s).rerun(projectId, id, opts?.failed ?? false),
  'ci.cancel': (s, projectId, id) => needCi(s).cancel(projectId, id),
} satisfies CiHandlers;
