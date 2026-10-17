import { execFile } from 'node:child_process';

export class GitError extends Error {}

/** Run git in a directory; resolves stdout, rejects with git's own message. */
export function git(cwd: string, args: readonly string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new GitError((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const tryGit = (cwd: string, args: readonly string[]): Promise<string | undefined> => git(cwd, args).then((s) => s, () => undefined);

export interface WorktreeEntry {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  return porcelain
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const fields = new Map(block.split('\n').map((l) => [l.split(' ')[0] ?? '', l.slice(l.indexOf(' ') + 1)] as const));
      const branch = fields.get('branch')?.replace(/^refs\/heads\//, '');
      return { path: fields.get('worktree') ?? '', head: fields.get('HEAD'), branch, detached: fields.has('detached'), bare: fields.has('bare') };
    })
    .filter((w) => w.path);
}

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  return parseWorktreeList(await git(repo, ['worktree', 'list', '--porcelain']));
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return (await tryGit(dir, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
}

/** The main checkout of the repo `dir` belongs to (works from inside a worktree too). */
export async function mainCheckout(dir: string): Promise<string | undefined> {
  const common = (await tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
  return common?.endsWith('/.git') ? common.slice(0, -5) : undefined;
}

/** origin's default branch, e.g. "origin/main"; falls back to a local main/master. */
export async function defaultBase(repo: string): Promise<string> {
  const head = (await tryGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  if (head) return head;
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await tryGit(repo, ['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }
  return 'HEAD';
}

export async function hasRemote(repo: string): Promise<boolean> {
  return Boolean((await tryGit(repo, ['remote']))?.trim());
}

/** Create a worktree on a new branch from `base` (fetching origin first so it's the latest). */
export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  if (base.startsWith('origin/') && (await hasRemote(repo))) await tryGit(repo, ['fetch', 'origin', '--prune']);
  await git(repo, ['worktree', 'add', '-b', branch, path, base]);
}

export async function removeWorktree(repo: string, path: string, force = false): Promise<void> {
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['branch', '-D', branch]);
}

export interface Status {
  readonly branch?: string;
  readonly changed: number;
  readonly ahead: number;
  readonly behind: number;
}

/** Uncommitted file count plus commits ahead/behind `base`. */
export async function status(dir: string, base?: string): Promise<Status> {
  const out = await git(dir, ['status', '--porcelain=v1', '-b']);
  const [head = '', ...files] = out.split('\n').filter(Boolean);
  const branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(head)?.[1];
  let ahead = 0;
  let behind = 0;
  if (base) {
    const counts = (await tryGit(dir, ['rev-list', '--left-right', '--count', `${base}...HEAD`]))?.trim().split(/\s+/);
    behind = Number(counts?.[0] ?? 0) || 0;
    ahead = Number(counts?.[1] ?? 0) || 0;
  }
  return { branch, changed: files.length, ahead, behind };
}

export interface ChangedFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly state: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
}

export interface Review {
  readonly base: string;
  readonly commits: readonly { readonly hash: string; readonly subject: string }[];
  readonly files: readonly ChangedFile[];
}

/** Everything that differs from `base`: commits plus committed, staged, unstaged and new files. */
export async function review(dir: string, base: string): Promise<Review> {
  const mergeBase = (await tryGit(dir, ['merge-base', base, 'HEAD']))?.trim() || base;
  const log = (await tryGit(dir, ['log', '--format=%h%x09%s', `${mergeBase}..HEAD`])) ?? '';
  const commits = log.split('\n').filter(Boolean).map((l) => ({ hash: l.split('\t')[0] ?? '', subject: l.split('\t').slice(1).join('\t') }));
  const numstat = (await tryGit(dir, ['diff', '--numstat', mergeBase])) ?? '';
  const names = (await tryGit(dir, ['diff', '--name-status', mergeBase])) ?? '';
  const states = new Map(
    names.split('\n').filter(Boolean).map((l) => {
      const [code = 'M', ...rest] = l.split('\t');
      const state: ChangedFile['state'] = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : code.startsWith('R') ? 'renamed' : 'modified';
      return [rest.at(-1) ?? '', state] as const;
    }),
  );
  const files: ChangedFile[] = numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a = '0', r = '0', ...p] = l.split('\t');
      const path = p.join('\t').replace(/^.*\{.* => (.*)\}.*$/, '$1');
      return { path, added: Number(a) || 0, removed: Number(r) || 0, state: states.get(path) ?? 'modified' };
    });
  const untracked = ((await tryGit(dir, ['ls-files', '--others', '--exclude-standard'])) ?? '').split('\n').filter(Boolean);
  for (const path of untracked) files.push({ path, added: 0, removed: 0, state: 'untracked' });
  return { base: mergeBase, commits, files };
}

/** Unified diff for one file against the merge base (new files shown in full). */
export async function fileDiff(dir: string, base: string, path: string): Promise<string> {
  const mergeBase = (await tryGit(dir, ['merge-base', base, 'HEAD']))?.trim() || base;
  const diff = await git(dir, ['diff', mergeBase, '--', path]);
  if (diff.trim()) return diff;
  return (await tryGit(dir, ['diff', '--no-index', '--', '/dev/null', path])) ?? '';
}

export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, ['add', '-A']);
  const staged = (await tryGit(dir, ['diff', '--cached', '--name-only']))?.trim();
  if (!staged) return false;
  await git(dir, ['commit', '-m', message]);
  return true;
}

export type MergeResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'dirty' | 'conflict'; readonly files: readonly string[] };

/** Merge `branch` into the main checkout. Aborts cleanly on conflicts. */
export async function mergeInto(mainDir: string, branch: string): Promise<MergeResult> {
  const dirty = (await git(mainDir, ['status', '--porcelain'])).split('\n').filter(Boolean);
  if (dirty.length) return { ok: false, reason: 'dirty', files: dirty.map((l) => l.slice(3)) };
  try {
    await git(mainDir, ['merge', '--no-ff', '--no-edit', branch]);
    return { ok: true };
  } catch {
    const conflicts = ((await tryGit(mainDir, ['diff', '--name-only', '--diff-filter=U'])) ?? '').split('\n').filter(Boolean);
    await tryGit(mainDir, ['merge', '--abort']);
    return { ok: false, reason: 'conflict', files: conflicts };
  }
}

export async function currentBranch(dir: string): Promise<string | undefined> {
  return (await tryGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
}

/** Keep klaude's per-workspace folder out of git without touching the repo's .gitignore. */
export async function excludeKlaudeDir(dir: string): Promise<void> {
  const gitDir = (await tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
  if (!gitDir) return;
  const { appendFile, readFile, mkdir } = await import('node:fs/promises');
  const file = `${gitDir}/info/exclude`;
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.split('\n').includes('.klaude/')) return;
  await mkdir(`${gitDir}/info`, { recursive: true });
  await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}.klaude/\n`);
}
