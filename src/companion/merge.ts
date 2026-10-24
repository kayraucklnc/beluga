import path from 'node:path';
import type { Session } from '../core/session.js';
import { reviewMerge } from '../workspaces/merge-review.js';
import type { MergePreview } from '../workspaces/merge-preview.js';
import type { MergeCheckView, MergeView } from './protocol.js';
import { plainLine } from './strip.js';

/**
 * Merging a worktree from the phone (BLG-67), on the Mac's own path: the checks of its Merge sheet
 * (git.mergePreview + reviewMerge), the merge itself (the workspace controller's merge, as
 * workspaces.merge), and on conflicts Claude asked to resolve them in that worktree (as Solve merge
 * conflict does, workspaces.askClaudeToMerge). Where each merge stands is kept here (per worktree)
 * and shown in its conversation's view, so the phone follows every step live.
 *
 * Files go to the phone by name only, and the main folder's path never does.
 */

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** A file by its name (no folders, nothing of the Mac's paths). */
const named = (files: readonly string[]): string[] => files.slice(0, 100).map((f) => clip(path.basename(f), 300));

/** The worktree a `conv:ws:<id>` topic is, when it's one of yours that can merge. */
export function worktreeOf(s: Session, topic: string): string {
  const id = topic.startsWith('conv:ws:') ? topic.slice('conv:ws:'.length) : '';
  const ws = id ? s.workspaces?.manager.find(id) : undefined;
  if (!ws || ws.kind !== 'worktree' || !ws.branch || ws.archived) throw new Error('Only a worktree of yours can be merged');
  return id;
}

/** What merging would do, and what stands in the way, in the Mac's own words (folders left out). */
export function mergeCheckOf(p: MergePreview): MergeCheckView {
  const plain: MergePreview = { ...p, folderChanges: named(p.folderChanges), ...(p.conflicts ? { conflicts: named(p.conflicts) } : {}) };
  const review = reviewMerge(plain);
  return {
    from: clip(p.from, 200),
    into: clip(p.into, 200),
    commits: p.commitCount,
    files: p.files,
    subjects: p.commits.slice(0, 5).map((c) => clip(plainLine(c.subject, 300), 300)),
    checks: review.checks.slice(0, 12).map((c) => ({ id: c.id, tone: c.tone, text: clip(c.text, 500), ...(c.fix ? { fix: c.fix } : {}) })),
    canMerge: review.canMerge,
    confirm: clip(review.confirm, 60),
    ...(plain.conflicts?.length ? { conflicts: [...plain.conflicts] } : {}),
  };
}

export interface MergeBook {
  get(id: string): MergeView | undefined;
  set(id: string, merge: MergeView | undefined): void;
}

/** Look before merging (the Merge sheet's checks). */
export async function mergeCheck(s: Session, topic: string): Promise<MergeCheckView> {
  const id = worktreeOf(s, topic);
  return mergeCheckOf(await s.workspaces!.manager.mergePreview(id));
}

/** Merge it, as the Mac's Merge does; the conversation's view says how it went. */
export async function merge(s: Session, book: MergeBook, topic: string): Promise<MergeView> {
  const id = worktreeOf(s, topic);
  book.set(id, { phase: 'merging', at: Date.now() });
  const result = await s.workspaces!.merge(id).catch(() => undefined);
  const at = Date.now();
  const done: MergeView = !result
    ? { phase: 'blocked', at, why: 'It couldn’t merge: check it on your Mac' }
    : result.ok
      ? { phase: 'merged', at }
      : result.reason === 'conflict'
        ? { phase: 'conflicts', at, conflicts: named(result.files) }
        : result.reason === 'wrong_branch'
          ? { phase: 'blocked', at, why: `Your main folder is on ${result.current}, not ${result.expected}. Switch it back first.` }
          : { phase: 'blocked', at, why: `Your main folder has uncommitted changes (${named(result.files).slice(0, 3).join(', ')}). Commit or stash them there first.` };
  book.set(id, done);
  return done;
}

/** Claude merges it in that worktree's conversation and resolves the conflicts (Solve merge conflict). */
export function resolve(s: Session, book: MergeBook, topic: string): MergeView {
  const id = worktreeOf(s, topic);
  const files = s.store.getState().conflicts[id] ?? book.get(id)?.conflicts ?? [];
  s.workspaces!.askClaudeToMerge(id, files);
  const view: MergeView = { phase: 'resolving', at: Date.now(), ...(files.length ? { conflicts: named(files) } : {}) };
  book.set(id, view);
  return view;
}
