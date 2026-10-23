import type { AgentOrigin, CcSession } from '../../../../src/core/claude-code/model.js';
import { worktreeOrigin } from '../../../../src/workspaces/origin.js';
import type { Project } from '../../../../src/workspaces/types.js';
import { isAgentWorktree, subAgentsUnder } from '../claude-code/subagents-model.js';
import { outsideOf } from './outside-model.js';

/**
 * Whether unfolding a project shows anything: its worktrees and chats, worktrees made outside
 * Beluga, or sub-agents its main folder started. Without any,
 * its row has no fold arrow. Pure (tests/mac-project-rows.test.ts).
 */
export function hasRowsInside(p: Project, sessions: readonly CcSession[], origins: readonly AgentOrigin[] = []): boolean {
  const live = p.workspaces.filter((w) => !w.archived);
  if (live.some((w) => w.kind !== 'main' && worktreeOrigin(w) === 'beluga')) return true;
  if (outsideOf(p).some((w) => !isAgentWorktree(w))) return true;
  const main = live.find((w) => w.kind === 'main');
  return Boolean(main && subAgentsUnder(sessions, main.id, origins).length);
}
