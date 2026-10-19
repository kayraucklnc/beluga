import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as g from './git.js';

/**
 * Facts about a worktree klaud didn't make (from Conductor, Claude Code, a script): when it
 * was made, its last commit, whether everything on it is already merged, and whether it's
 * safe to tidy away. Removing one keeps its branch, so nothing committed is ever lost.
 */

export interface WorktreeFacts {
  /** The folder is gone but git still lists it. */
  readonly missing: boolean;
  readonly branch?: string;
  readonly detached: boolean;
  /** When the worktree was added (its folder in .git/worktrees was born). */
  readonly createdAt?: number;
  readonly lastCommit?: { readonly at: number; readonly subject: string };
  readonly changed: number;
  readonly ahead: number;
  readonly behind: number;
  /** Everything on it is already in its base branch. */
  readonly merged: boolean;
  /** Its branch tracked a remote branch that's been deleted (usually: the pull request merged). */
  readonly upstreamGone: boolean;
}

export type StaleReason = 'missing' | 'gone' | 'merged';

/** Why a worktree can go without losing anything, or undefined when it has work of its own. */
export function staleReason(f: Pick<WorktreeFacts, 'missing' | 'changed' | 'merged' | 'upstreamGone'>): StaleReason | undefined {
  if (f.missing) return 'missing';
  if (f.changed > 0) return undefined;
  if (f.upstreamGone) return 'gone';
  if (f.merged) return 'merged';
  return undefined;
}

export function staleText(reason: StaleReason, base: string): string {
  switch (reason) {
    case 'missing':
      return 'Its folder is already gone; git still lists it';
    case 'gone':
      return 'Its remote branch was deleted (the pull request was likely merged)';
    case 'merged':
      return `Everything on it is already in ${base}`;
  }
}

const tryGit = (cwd: string, args: readonly string[]): Promise<string | undefined> => g.git(cwd, args, 15_000).then((s) => s, () => undefined);

/** When a worktree was added (its admin folder in .git/worktrees, else its own folder, was born). */
export async function bornAt(dir: string): Promise<number | undefined> {
  // The worktree's own folder inside the repo's .git/worktrees is made by `git worktree add`.
  const admin = (await tryGit(dir, ['rev-parse', '--absolute-git-dir']))?.trim();
  for (const p of [admin, dir]) {
    if (!p) continue;
    const st = await stat(p).catch(() => undefined);
    const t = st ? (st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs) : undefined;
    if (t) return Math.round(t);
  }
  return undefined;
}

/** The worktree's admin folder in the repo's .git/worktrees, from its `.git` file (no git process). */
async function adminDir(dir: string): Promise<string | undefined> {
  const text = await readFile(path.join(dir, '.git'), 'utf8').catch(() => undefined);
  const at = text ? /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim() : undefined;
  return at ? path.resolve(dir, at) : undefined;
}

/**
 * When something last happened in a worktree, as git sees it: a commit or checkout (its HEAD
 * log), staging (its index), or switching branches (HEAD). Cheap: a few `stat`s, no git process.
 */
export async function touchedAt(dir: string): Promise<number | undefined> {
  const admin = await adminDir(dir);
  const files = admin ? [path.join(admin, 'logs', 'HEAD'), path.join(admin, 'index'), path.join(admin, 'HEAD')] : [path.join(dir, '.git')];
  const times = await Promise.all(files.map((f) => stat(f).then((st) => st.mtimeMs, () => 0)));
  const latest = Math.max(0, ...times);
  return latest > 0 ? Math.round(latest) : undefined;
}

/** Look at one worktree (read-only git calls, without taking the index lock). */
export async function worktreeFacts(ws: { readonly path: string; readonly branch?: string }, base: string): Promise<WorktreeFacts> {
  if (!existsSync(ws.path)) return { missing: true, ...(ws.branch ? { branch: ws.branch } : {}), detached: !ws.branch, changed: 0, ahead: 0, behind: 0, merged: false, upstreamGone: false };
  const [status, last, merged, branch, createdAt] = await Promise.all([
    g.status(ws.path, base).catch(() => ({ changed: 0, ahead: 0, behind: 0 })),
    tryGit(ws.path, ['log', '-1', '--format=%ct%x09%s']),
    g.git(ws.path, ['merge-base', '--is-ancestor', 'HEAD', base], 15_000).then(() => true, () => false),
    tryGit(ws.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then((s) => s?.trim() || undefined),
    bornAt(ws.path),
  ]);
  const track = branch ? (await tryGit(ws.path, ['for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`]))?.trim() : undefined;
  const [at, ...subject] = (last ?? '').trim().split('\t');
  return {
    missing: false,
    ...(branch ? { branch } : {}),
    detached: !branch,
    ...(createdAt ? { createdAt } : {}),
    ...(at && Number(at) ? { lastCommit: { at: Number(at) * 1000, subject: subject.join('\t') } } : {}),
    changed: status.changed,
    ahead: status.ahead,
    behind: status.behind,
    merged,
    upstreamGone: track === '[gone]',
  };
}

/**
 * Remove a worktree's folder and git's record of it; its branch stays. Refuses when it has
 * uncommitted changes unless `force` (you confirmed losing them).
 */
export async function removeWorktreeKeepingBranch(repo: string, dir: string, force: boolean): Promise<void> {
  if (existsSync(dir)) return g.removeWorktree(repo, dir, force);
  // Folder already gone: newer git removes the record directly; older git only prunes.
  await g.removeWorktree(repo, dir).catch(() => g.git(repo, ['worktree', 'prune']));
}
