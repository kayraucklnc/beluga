import { planOwnerOf } from '../../../../src/core/plans/owner.js';
import type { AppState } from '../../../../src/core/store.js';

/** Plan task worktrees whose local merge you just confirmed (Merge Anyway): that one merge goes through. */
const confirmed = new Set<string>();

/** You said Merge Anyway for this worktree: its next merge goes through. */
export function confirmMerge(wsId: string): void {
  confirmed.add(wsId);
}

/**
 * Whether a local merge of this worktree must ask first (see actions.ts): it's a plan's task and
 * you haven't just said Merge Anyway. Every way in (toolbar, ⇧⌘M, ⌘K, menus) goes through it.
 */
export function mergeNeedsWarning(state: Pick<AppState, 'plans' | 'board'>, wsId: string): boolean {
  if (confirmed.delete(wsId)) return false;
  return Boolean(planOwnerOf(state.plans, state.board, wsId));
}
