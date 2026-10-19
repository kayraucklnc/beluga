import type { CcSession } from '../../../../src/core/claude-code/model.js';
import { worktreeOrigin } from '../../../../src/workspaces/origin.js';
import type { Project } from '../../../../src/workspaces/types.js';
import { isAgentWorktree, looseAgentWorktrees, subAgentsUnder } from '../claude-code/subagents-model.js';
import { outsideOf } from './outside-model.js';

/**
 * Whether unfolding a project shows anything: its worktrees and chats, worktrees made outside
 * Klaud, sub-agents its main folder started, or sub-agent worktrees on their own. Without any,
 * its row has no fold arrow. Pure (tests/mac-project-rows.test.ts).
 */
export function hasRowsInside(p: Project, sessions: readonly CcSession[]): boolean {
  const live = p.workspaces.filter((w) => !w.archived);
  if (live.some((w) => w.kind !== 'main' && worktreeOrigin(w) === 'klaud')) return true;
  if (outsideOf(p).some((w) => !isAgentWorktree(w))) return true;
  const main = live.find((w) => w.kind === 'main');
  if (main && subAgentsUnder(sessions, main.id).length) return true;
  // The conversations above show their own sub-agents; here none do, so every sub-agent worktree is on its own.
  return looseAgentWorktrees(p, sessions, () => false).length > 0;
}
