import type { AppState } from '@klaud/core/store.js';
import { planTitle } from '@klaud/core/plans/model.js';
import { planOwnerOf } from '@klaud/core/plans/owner.js';
import type { UiAction } from '@klaud/ui/workspace-models.js';
import { openSheet } from './sheets.js';

/** A plan's task worktree: open its task or its plan, or merge it by hand after a warning. */
export type PlanAction = 'open_task' | 'open_plan' | 'merge_anyway';

export const isPlanAction = (a: string): a is PlanAction => a === 'open_task' || a === 'open_plan' || a === 'merge_anyway';

/** Opening a plan task's task or plan; merging one by hand asks first (the plan merges it itself). */
export function runPlanAction(state: AppState, wsId: string, action: PlanAction, run: (a: UiAction) => void): void {
  const owner = planOwnerOf(state.plans, state.board, wsId);
  if (!owner) return;
  if (action === 'open_plan') return run({ type: 'view', view: { kind: 'plan', id: owner.plan.id } });
  if (action === 'open_task') return run({ type: 'view', view: { kind: 'task', id: owner.issue.id } });
  const name = planTitle(owner.plan);
  openSheet({
    kind: 'confirm',
    title: `Merge ${owner.issue.key} by hand?`,
    message: `It’s part of “${name}”: when “${owner.milestone.title}” passes, Klaud merges it into the plan’s branch, and the plan opens one PR at the end. Merging it yourself skips the plan’s checks.`,
    confirm: 'Merge Anyway',
    run: () => run({ type: 'ws', id: wsId, action: 'merge' }),
  });
}
