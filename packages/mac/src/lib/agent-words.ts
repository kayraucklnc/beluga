import { type AgentRef, defaultAgentOf } from '@beluga/protocol.js';
import { agentBadge, agentLabel, agentName } from '@beluga/shared/agent-label.js';
import { useApp } from './beluga';

/**
 * The words the Mac app says for agents (BLG-436): your own agent by its name ("Claude",
 * "Codex"), someone else's as "bob's Codex". Nothing on screen writes "Claude" itself, except
 * where the Claude runtime is meant (signing in to Claude, Claude Code sessions, plan usage).
 */

/** Your agent (from your room card; Claude until you pick another). */
export function useMyAgent(): AgentRef {
  return useApp((s) => defaultAgentOf(s.self), (a, b) => a.runtime === b.runtime && a.label === b.label && a.model === b.model);
}

/** Your agent's name: "Claude", "Codex". */
export function useMyAgentName(): string {
  return agentName(useMyAgent());
}

export { agentBadge, agentLabel, agentName };
