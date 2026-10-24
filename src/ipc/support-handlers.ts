import type { Session } from '../core/session.js';
import { supportOf } from '../core/merge-counter.js';
import type { Args, Method } from './api.js';

/** What each `support.*` method does (see support-api.ts). */

type SupportMethod = Extract<Method, `support.${string}`>;
type SupportHandlers = { readonly [M in SupportMethod]: (s: Session, ...args: Args<M>) => unknown };

export const SUPPORT_HANDLERS = {
  'support.answer': (s, ask, answer) => supportOf(s).answer(ask, answer),
} satisfies SupportHandlers;
