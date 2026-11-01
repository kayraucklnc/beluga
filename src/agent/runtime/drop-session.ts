import { claudeConfigDir, dropSession } from './claude/claude-sessions.js';
import { codexDataDir, dropCodexSessions } from './codex/codex-sessions.js';

/** Where each agent keeps its own records (tests point them at temporary folders). */
export interface AgentHomes {
  readonly claude?: string;
  readonly codex?: string;
}

/**
 * Forget an agent's own record of a deleted chat (BLG-571): Claude Code's transcript, or Codex's
 * rollout for that thread. `runtime` is the agent the session is of (none: Claude, as before any
 * other ran). Other agents keep nothing of their own to drop.
 */
export async function dropAgentSession(dir: string, sessionId: string, runtime: string | undefined, homes: AgentHomes = {}): Promise<void> {
  if (runtime === 'codex') await dropCodexSessions({ threadId: sessionId }, homes.codex ?? codexDataDir()).catch(() => 0);
  else if (!runtime || runtime === 'claude') await dropSession(dir, sessionId, homes.claude ?? claudeConfigDir()).catch(() => undefined);
}
