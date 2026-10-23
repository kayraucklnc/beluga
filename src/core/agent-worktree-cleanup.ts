import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { CcSession } from './claude-code/model.js';
import { agentWorktreesOf } from './claude-code/agent-worktrees.js';
import { worktreeOrigin } from '../workspaces/origin.js';
import { removeWorktreeKeepingBranch } from '../workspaces/others.js';
import type { Project, Workspace } from '../workspaces/types.js';

/**
 * A conversation's sub-agents go with it: archiving or deleting a worktree (or chat) also removes
 * the worktrees Claude Code's sub-agents made from it. Their branches always stay; a worktree with
 * uncommitted changes, or whose agent is still working, is kept.
 */

export interface AgentCleanup {
  readonly removed: number;
  /** Kept: still working (or wrote lately), uncommitted changes, no branch, or git refused. */
  readonly kept: number;
}

const same = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** An agent that wrote this lately may still be working (in a session Beluga doesn't follow): its worktree stays. */
export const QUIET_MS = 5 * 60_000;

/** The sub-agent worktrees in a project that conversations in `parent`'s folder started (with when each agent last wrote). */
export function agentWorktreesFrom(parent: Pick<Workspace, 'path'>, project: Pick<Project, 'workspaces'>, home: string): Array<Workspace & { readonly agentLastAt: number }> {
  const made = new Map(agentWorktreesOf(home, parent.path).map((a) => [same(a.path), a.lastAt]));
  if (!made.size) return [];
  return project.workspaces
    .filter((w) => !w.archived && w.path !== parent.path && worktreeOrigin(w) === 'agent' && made.has(same(w.path)))
    .map((w) => ({ ...w, agentLastAt: made.get(same(w.path)) ?? 0 }));
}

/**
 * Remove them (branches kept), leaving any still working (or written to lately), with uncommitted
 * changes, or without a branch (its commits would have nothing left pointing at them).
 */
export async function removeAgentWorktrees(root: string, list: ReadonlyArray<Workspace & { readonly agentLastAt?: number }>, sessions: readonly CcSession[], now = Date.now()): Promise<AgentCleanup> {
  const working = new Set(sessions.flatMap((s) => s.agents.filter((a) => a.status === 'running' && a.worktree).map((a) => same(a.worktree!.path))));
  let removed = 0;
  let kept = 0;
  for (const w of list) {
    if (working.has(same(w.path)) || !w.branch || now - (w.agentLastAt ?? 0) < QUIET_MS) {
      kept++;
      continue;
    }
    try {
      await removeWorktreeKeepingBranch(root, w.path, false);
      removed++;
    } catch {
      kept++;
    }
  }
  return { removed, kept };
}

/** What to tell you afterwards (nothing when there were none). */
export function cleanupText(c: AgentCleanup): string | undefined {
  const n = (k: number): string => `${k} sub-agent worktree${k === 1 ? '' : 's'}`;
  const removed = c.removed ? `Removed its ${n(c.removed)} too (branches kept).` : '';
  const kept = c.kept ? `Kept ${n(c.kept)}: still working, uncommitted changes or no branch.` : '';
  return [removed, kept].filter(Boolean).join(' ') || undefined;
}
