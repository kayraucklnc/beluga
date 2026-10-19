import { execFile } from 'node:child_process';
import { git } from './git.js';

/**
 * What merging a worktree's branch would do, before you say yes: where it goes, the commits and
 * files it brings, and anything that would stop it (uncommitted work, the main folder on another
 * branch or with changes of its own, conflicts). Only reads: nothing changes.
 */

export interface MergeCommit {
  readonly hash: string;
  readonly subject: string;
  readonly author: string;
  /** Unix seconds. */
  readonly when: number;
}

export interface MergePreview {
  /** The branch that merges. */
  readonly from: string;
  /** The branch it merges into. */
  readonly into: string;
  /** The folder whose files change (the project's main folder). */
  readonly folder: string;
  /** The branch that folder is on now (merging needs it on `into`). */
  readonly folderOn?: string;
  /** Uncommitted changes to tracked files in the main folder (merging needs none; untracked files are fine). */
  readonly folderChanges: readonly string[];
  /** Uncommitted files in the worktree: they wouldn't come along. */
  readonly uncommitted: number;
  /** The newest commits that merge, newest first (at most MAX_COMMITS). */
  readonly commits: readonly MergeCommit[];
  readonly commitCount: number;
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
  /** Commits on `into` this branch doesn't have yet (the merge combines both). */
  readonly newOnTarget: number;
  /** Files that would conflict; undefined when git can't tell (older than 2.38). */
  readonly conflicts?: readonly string[];
}

const MAX_COMMITS = 20;
const SEP = '\x1f';

/** `git merge-tree` exits 1 when there are conflicts, with the files still on stdout. */
function mergeTree(dir: string, into: string, from: string): Promise<readonly string[] | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', into, from], { cwd: dir, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (err && code !== 1) return resolve(undefined);
      // The first line is the merged tree; the conflicted files follow.
      resolve(stdout.split('\n').slice(1).filter(Boolean));
    });
  });
}

const count = async (dir: string, range: string): Promise<number> => Number((await git(dir, ['rev-list', '--count', range]).catch(() => '0')).trim()) || 0;

export function parseShortstat(text: string): { files: number; insertions: number; deletions: number } {
  const num = (re: RegExp): number => Number(re.exec(text)?.[1] ?? 0);
  return { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?\(\+\)/), deletions: num(/(\d+) deletions?\(-\)/) };
}

export function parseCommits(text: string): MergeCommit[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = '', author = '', when = '0'] = line.split(SEP);
      return { hash, subject, author, when: Number(when) || 0 };
    });
}

export async function mergePreview(opts: { folder: string; from: string; into?: string; uncommitted: number }): Promise<MergePreview> {
  const { folder, from } = opts;
  const folderOn = (await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || undefined;
  const into = opts.into ?? folderOn ?? 'HEAD';
  const range = `${into}..${from}`;
  const [status, log, commitCount, stat, newOnTarget, conflicts] = await Promise.all([
    git(folder, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no']).catch(() => ''),
    git(folder, ['log', `-n${MAX_COMMITS}`, `--format=%H${SEP}%s${SEP}%an${SEP}%ct`, range]).catch(() => ''),
    count(folder, range),
    git(folder, ['diff', '--shortstat', `${into}...${from}`]).catch(() => ''),
    count(folder, `${from}..${into}`),
    mergeTree(folder, into, from),
  ]);
  return {
    from,
    into,
    folder,
    ...(folderOn ? { folderOn } : {}),
    folderChanges: status
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3)),
    uncommitted: opts.uncommitted,
    commits: parseCommits(log),
    commitCount,
    ...parseShortstat(stat),
    newOnTarget,
    ...(conflicts ? { conflicts } : {}),
  };
}
