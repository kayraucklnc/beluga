import type { WorkspaceAction } from '../../../../src/ui/workspace-models.js';

/**
 * Workspace actions that start Claude working or change git: one click never just does them,
 * a small confirmation says what will happen first (see work-confirm.ts). Pure, so it's tested
 * on its own (tests/mac-outside-worktrees.test.ts).
 */
export type AskedWork = Extract<WorkspaceAction, 'review_claude' | 'commit' | 'merge' | 'merge_claude' | 'compact'> | 'fix_checks' | 'resolve_pr' | 'continue_after_merge';

const ASKED: ReadonlySet<string> = new Set<AskedWork>(['review_claude', 'commit', 'merge', 'merge_claude', 'compact', 'fix_checks', 'resolve_pr', 'continue_after_merge']);

export const asksBeforeWork = (action: string): action is AskedWork => ASKED.has(action);
