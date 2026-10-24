import type { AppState } from '../core/store.js';
import type { MergePreview } from './merge-preview.js';
import type { Workspace } from './types.js';

/**
 * Before you merge a worktree: what's fine, what to know, and what stands in the way, in plain
 * words. Pure, so it's tested on its own; the Mac's Merge sheet and the phone's (companion.mergeCheck) both use it (tests/mac-merge-review.test.ts).
 */

export type CheckTone = 'ok' | 'info' | 'block';

export interface MergeCheck {
  readonly id: string;
  readonly tone: CheckTone;
  readonly text: string;
  /** What fixes it from here: commit this worktree's changes, or let Claude merge and resolve. */
  readonly fix?: 'commit' | 'claude';
}

export interface MergeReview {
  readonly checks: readonly MergeCheck[];
  readonly canMerge: boolean;
  /** The button: "Merge 3 Commits". */
  readonly confirm: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const listed = (files: readonly string[], max = 3): string => (files.length > max ? `${files.slice(0, max).join(', ')} and ${files.length - max} more` : files.join(', '));

export function reviewMerge(p: MergePreview): MergeReview {
  const checks: MergeCheck[] = [];
  const onTarget = !p.folderOn || p.folderOn === p.into;
  if (p.uncommitted > 0) checks.push({ id: 'uncommitted', tone: 'block', text: `${plural(p.uncommitted, 'uncommitted file')} in this worktree wouldn’t come along. Commit first.`, fix: 'commit' });
  if (p.commitCount === 0) checks.push({ id: 'nothing', tone: 'block', text: `Nothing to merge: ${p.into} already has everything in ${p.from}.` });
  if (!onTarget) checks.push({ id: 'branch', tone: 'block', text: `Your main folder is on ${p.folderOn}, not ${p.into}. Switch it back to ${p.into} first.` });
  if (p.folderChanges.length) checks.push({ id: 'dirty', tone: 'block', text: `Your main folder has uncommitted changes (${listed(p.folderChanges)}). Commit or stash them there first.` });
  if (p.conflicts?.length) checks.push({ id: 'conflicts', tone: 'block', text: `${plural(p.conflicts.length, 'file')} would conflict: ${listed(p.conflicts)}. Claude can merge it and resolve them.`, fix: 'claude' });
  else if (p.conflicts && p.commitCount > 0) checks.push({ id: 'conflicts', tone: 'ok', text: 'No conflicts' });
  if (onTarget && !p.folderChanges.length) checks.push({ id: 'folder', tone: 'ok', text: `Your main folder is on ${p.into}, with no uncommitted changes` });
  if (p.newOnTarget > 0) checks.push({ id: 'newer', tone: 'info', text: `${p.into} has ${plural(p.newOnTarget, 'newer commit')} that ${p.from} doesn’t. The merge keeps both.` });
  const canMerge = !checks.some((c) => c.tone === 'block');
  return { checks, canMerge, confirm: canMerge ? `Merge ${plural(p.commitCount, 'Commit')}` : 'Merge' };
}

/** The branch a worktree merges into, as the toolbar names it before asking ("main"). */
export function mergeTargetOf(state: Pick<AppState, 'projects'>, ws: Workspace): string {
  const project = state.projects.find((p) => p.id === ws.projectId);
  const base = (ws.base ?? project?.base ?? 'HEAD').replace(/^origin\//, '');
  return base === 'HEAD' ? (project?.sync?.branch ?? 'main') : base;
}
