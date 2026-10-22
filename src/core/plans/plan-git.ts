import type { CombineResult, MergeResult } from '../../workspaces/git.js';
import { createPr, findPr, mergePrOnGitHub } from '../../workspaces/pr.js';
import type { IssuePr } from '../board/model.js';
import type { WorkspaceController } from '../workspace-controller.js';

/**
 * What a plan does in git: its branch (plan/<slug>, from main), passed milestones merged into it,
 * merged worktrees cleared away, and the branch reaching main as one pull request (or merged here).
 * The pilot only sees this (tests give it a fake).
 */
export interface PlanGit {
  /** The plan's branch, made from main unless it's there → whether it was made. */
  ensureBranch(projectId: string, branch: string): Promise<{ readonly made: boolean }>;
  /** Merge task branches into the plan's branch (--no-ff; those already in it skipped). */
  mergeInto(projectId: string, into: string, branches: readonly string[]): Promise<CombineResult>;
  /** Whether a branch is in main already. */
  inMain(projectId: string, branch: string): Promise<boolean>;
  /** A merged task's worktree goes: archived (its conversation kept), its branch deleted only if it's in `into` (git branch -d). */
  retire(projectId: string, workspaceId: string | undefined, branch: string | undefined, into: string): Promise<void>;
  /** The branch's pull request (undefined: none). Throws when GitHub couldn't tell. */
  findPr(projectId: string, branch: string): Promise<IssuePr | undefined>;
  openPr(projectId: string, branch: string, title: string, body: string): Promise<IssuePr>;
  mergePr(projectId: string, number: number): Promise<void>;
  /** Merge the branch into the project's main folder (on main). */
  mergeLocal(projectId: string, branch: string): Promise<MergeResult>;
}

export function planGitOf(controller: WorkspaceController): PlanGit {
  const m = controller.manager;
  const root = (projectId: string): string => m.repoProject(projectId).root;
  return {
    ensureBranch: (projectId, branch) => m.planBranch(projectId, branch),
    mergeInto: (projectId, into, branches) => m.mergeIntoPlan(projectId, into, branches),
    inMain: (projectId, branch) => m.inDefaultBranch(projectId, branch),
    retire: async (projectId, workspaceId, branch, into) => {
      const ws = workspaceId ? m.find(workspaceId) : undefined;
      if (ws && !ws.archived) await controller.archive(ws.id, false, { quiet: true });
      // Never -D: a branch with work not in the plan's branch stays.
      if (branch) await m.dropBranch(projectId, branch, into).catch(() => undefined);
    },
    findPr: (projectId, branch) => findPr(root(projectId), branch),
    openPr: async (projectId, branch, title, body) => createPr(root(projectId), { base: await m.defaultBranchName(projectId), head: branch, title, body }),
    mergePr: (projectId, number) => mergePrOnGitHub(root(projectId), number),
    mergeLocal: (projectId, branch) => m.mergeBranchIntoMain(projectId, branch),
  };
}
