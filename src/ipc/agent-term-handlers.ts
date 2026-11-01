import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `agentTerm.*` method does (see agent-term-api.ts). */

type AgentTermMethod = Extract<Method, `agentTerm.${string}`>;
type AgentTermHandlers = { readonly [M in AgentTermMethod]: (s: Session, ...args: Args<M>) => unknown };

const terms = (s: Session) => {
  if (!s.agentTerms) throw new Error('The terminal view needs Beluga’s workspaces.');
  return s.agentTerms;
};

export const AGENT_TERM_HANDLERS = {
  'agentTerm.open': (s, wsId, size) => terms(s).open(wsId, size),
  'agentTerm.takeOver': (s, wsId) => terms(s).takeOver(wsId),
  'agentTerm.visual': (s, wsId, n) => terms(s).visual(wsId, n) ?? null,
} satisfies AgentTermHandlers;
