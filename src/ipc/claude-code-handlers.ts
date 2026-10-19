import { claudeCodeOf } from '../core/claude-code/launch.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `claudeCode.*` method does (see claude-code-api.ts). Reads only. */

type ClaudeCodeMethod = Extract<Method, `claudeCode.${string}`>;
type ClaudeCodeHandlers = { readonly [M in ClaudeCodeMethod]: (s: Session, ...args: Args<M>) => unknown };

export const CLAUDE_CODE_HANDLERS = {
  'claudeCode.steps': (s, sessionId, agentId, page) =>
    claudeCodeOf(s).steps(sessionId, agentId, { ...(page?.before !== undefined ? { before: page.before } : {}), ...(page?.after !== undefined ? { after: page.after } : {}), ...(page?.limit !== undefined ? { limit: page.limit } : {}) }),
  'claudeCode.step': (s, sessionId, agentId, seq) => claudeCodeOf(s).step(sessionId, agentId, seq),
  'claudeCode.findAgent': (s, agentId) => claudeCodeOf(s).adopt(agentId),
  'claudeCode.outputs': (s, sessionId, agentId) => claudeCodeOf(s).outputs(sessionId, agentId),
  'claudeCode.output': (s, sessionId, agentId, file) => claudeCodeOf(s).output(sessionId, agentId, file),
} satisfies ClaudeCodeHandlers;
