import type { BoardState, Issue } from '../board/model.js';
import { type Plan, type PlanMilestone, type PlanTask, type PlansState, allTasks } from './model.js';

/**
 * Which plan a worktree belongs to: one doing a task of a plan that's still running (its task not
 * canceled). Such a worktree is part of the plan, not something of its own: the sidebar shows the
 * plan instead of it, and Klaud (not you) merges it into the plan. Pure and browser-safe
 * (tests/plan-owner.test.ts).
 */

export interface PlanOwner {
  readonly plan: Plan;
  readonly task: PlanTask;
  readonly milestone: PlanMilestone;
  readonly issue: Issue;
}

/** Plans that show in the sidebar as one row: being written, or running. */
export const isLivePlan = (plan: Plan): boolean => plan.status !== 'done';

/** Every worktree that belongs to a running plan (workspace id → its plan's id). */
export function planWorktrees(plans: PlansState, board: BoardState): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const issues = new Map(board.issues.map((i) => [i.id, i]));
  for (const plan of plans.plans) {
    if (plan.status !== 'active') continue;
    for (const { task } of allTasks(plan.body)) {
      const issue = task.issueId ? issues.get(task.issueId) : undefined;
      if (!issue || issue.status === 'canceled') continue;
      for (const ws of issue.worktrees) out.set(ws, plan.id);
    }
  }
  return out;
}

/** The running plan a worktree does a task of, if any. */
export function planOwnerOf(plans: PlansState, board: BoardState, workspaceId: string): PlanOwner | undefined {
  for (const plan of plans.plans) {
    if (plan.status !== 'active') continue;
    for (const { task, milestone } of allTasks(plan.body)) {
      const issue = task.issueId ? board.issues.find((i) => i.id === task.issueId) : undefined;
      if (issue && issue.status !== 'canceled' && issue.worktrees.includes(workspaceId)) return { plan, task, milestone, issue };
    }
  }
  return undefined;
}

/**
 * The plan a place is part of: a plan's own page, its home conversation, or one of its task
 * worktrees (so the sidebar marks the plan's row while you're in any of them).
 */
export function planOfPlace(plans: PlansState, board: BoardState, view: { readonly kind: string; readonly id?: string }): string | undefined {
  if (view.kind === 'plan') return view.id;
  if (view.kind !== 'workspace' || !view.id) return undefined;
  const home = [...plans.plans].reverse().find((p) => p.home === `ws:${view.id}`);
  return home?.id ?? planOwnerOf(plans, board, view.id)?.plan.id;
}
