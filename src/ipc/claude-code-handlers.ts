import { claudeCodeOf, claudeHome } from '../core/claude-code/launch.js';
import { listSkills } from '../core/claude-code/skills.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** Your projects' folders: a server set for one of them is listed (and signed in to) there. */
const projectRoots = (s: Session): string[] => s.store.getState().projects.map((p) => p.root);

/** What each `claudeCode.*` method does (see claude-code-api.ts). Reads only, but for signing in to an MCP server. */

type ClaudeCodeMethod = Extract<Method, `claudeCode.${string}`>;
type ClaudeCodeHandlers = { readonly [M in ClaudeCodeMethod]: (s: Session, ...args: Args<M>) => unknown };

export const CLAUDE_CODE_HANDLERS = {
  'claudeCode.steps': (s, sessionId, agentId, page) =>
    claudeCodeOf(s).steps(sessionId, agentId, { ...(page?.before !== undefined ? { before: page.before } : {}), ...(page?.after !== undefined ? { after: page.after } : {}), ...(page?.limit !== undefined ? { limit: page.limit } : {}) }),
  'claudeCode.step': (s, sessionId, agentId, seq) => claudeCodeOf(s).step(sessionId, agentId, seq),
  'claudeCode.findAgent': (s, agentId) => claudeCodeOf(s).adopt(agentId),
  'claudeCode.outputs': (s, sessionId, agentId) => claudeCodeOf(s).outputs(sessionId, agentId),
  'claudeCode.output': (s, sessionId, agentId, file) => claudeCodeOf(s).output(sessionId, agentId, file),
  'claudeCode.taskOutput': (s, sessionId, agentId, taskId) => claudeCodeOf(s).taskOutput(sessionId, agentId, taskId),
  'claudeCode.skills': (s, channel, draftDir) => listSkills(channel === 'draft' ? draftDir : s.workspaces?.inChannel(channel)?.path, claudeHome()),
  'claudeCode.mcpServers': async (s, runtime) => (await s.backend?.mcpServers?.(projectRoots(s), runtime)) ?? [],
  'claudeCode.mcpSignIn': async (s, name, runtime) => (await s.backend?.mcpSignIn?.(projectRoots(s), name, runtime)) ?? { error: 'Your agent isn’t running here.' },
  'claudeCode.mcpSignedIn': (s, name, runtime) => s.backend?.mcpSignedIn?.(name, runtime),
  'claudeCode.mcpSetEnabled': async (s, name, enabled, runtime) => (await s.backend?.mcpSetEnabled?.(projectRoots(s), name, enabled, runtime)) ?? { error: 'Your agent’s servers are turned on and off in its own settings.' },
} satisfies ClaudeCodeHandlers;
