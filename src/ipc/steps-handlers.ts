import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `agent.*` method does (see steps-api.ts). Reads only. */

type StepsMethod = Extract<Method, `agent.${string}`>;
type StepsHandlers = { readonly [M in StepsMethod]: (s: Session, ...args: Args<M>) => unknown };

export const STEPS_HANDLERS = {
  'agent.steps': (s, channel, itemId, after) => s.host.stepsFor(channel, itemId, after),
  'agent.step': (s, channel, itemId, stepId) => s.host.stepFor(channel, itemId, stepId),
} satisfies StepsHandlers;
