import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The git side of a smart archive (archive.ts): running git and tar, the checks that keep it
 * from losing anything (a merge in progress, a submodule's local work), and the snapshot commit
 * of a folder as it is.
 */

/** git add and read-tree on a big folder can take a while; packing much longer. */
export const LONG_MS = 10 * 60_000;
export const TAR_TIMEOUT_MS = 30 * 60_000;
/** Commits need a name; yours when git has one. */
const IDENTITY = { GIT_AUTHOR_NAME: 'Klaud', GIT_AUTHOR_EMAIL: 'klaud@localhost', GIT_COMMITTER_NAME: 'Klaud', GIT_COMMITTER_EMAIL: 'klaud@localhost' };

export class ArchiveError extends Error {}

export function run(cmd: string, args: readonly string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export const git = (cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<string> => run('git', args, { cwd, ...(env ? { env } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
export const tryGit = (cwd: string, args: readonly string[]): Promise<string | undefined> => git(cwd, args).then((s) => s.trim(), () => undefined);

/** Ignored files and folders (a folder git ignores whole is one entry, ending in "/"). */
export async function ignoredIn(dir: string): Promise<string[]> {
  return (await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], undefined, LONG_MS)).split('\0').filter(Boolean);
}

/** `git check-ignore -v` over these paths (exit 1 is "none of them": not a failure). */
function checkIgnore(dir: string, rels: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['check-ignore', '-v', '-z', '--stdin'], { cwd: dir, timeout: LONG_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as { code?: unknown }).code !== 1) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
    child.stdin?.end(rels.join('\0'));
  });
}

/**
 * Of these ignored paths, the ones the project itself ignores (a .gitignore in the repo), not
 * only your own global ignore file or .git/info/exclude: only those can be throwaway.
 */
export async function ignoredByProject(dir: string, rels: readonly string[]): Promise<Set<string>> {
  if (!rels.length) return new Set();
  const out = await checkIgnore(dir, rels.map((r) => r.replace(/\/$/, '')));
  const fields = out.split('\0');
  const mine = new Set<string>();
  // source, line, pattern, path: four fields each.
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const source = fields[i]!;
    const pattern = fields[i + 2]!;
    const rel = fields[i + 3]!;
    // A negated pattern ("!keep") matched last: not ignored by it at all.
    if (pattern.startsWith('!') || path.isAbsolute(source) || source.includes('.git/') || !source.endsWith('.gitignore')) continue;
    mine.add(rel);
  }
  return new Set(rels.filter((r) => mine.has(r.replace(/\/$/, ''))));
}

/** Refuse when git is in the middle of something the folder's own git data holds (it goes with the folder). */
export async function assertSettled(dir: string): Promise<void> {
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
  const busy: Array<[string, string]> = [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['BISECT_LOG', 'a bisect'],
  ];
  const found = busy.find(([f]) => existsSync(path.join(gitDir, f)));
  if (found) throw new ArchiveError(`It’s in the middle of ${found[1]}. Finish or abort it first, then archive.`);
}

/** Folders that are git repos of their own, in a git index (mode 160000 entries). */
async function gitlinks(dir: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const out = await git(dir, ['ls-files', '--stage', '-z'], env, LONG_MS);
  return out
    .split('\0')
    .filter((l) => l.startsWith('160000 '))
    .map((l) => l.slice(l.indexOf('\t') + 1));
}

/**
 * Submodules keep their own git data in the worktree's git folder, which goes with it: refuse
 * when one has changes or commits that aren't pushed (a clean one comes back from its remote).
 */
export async function assertSubmodulesSafe(dir: string): Promise<boolean> {
  const subs = (await gitlinks(dir)).filter((p) => existsSync(path.join(dir, p, '.git')));
  for (const sub of subs) {
    const at = path.join(dir, sub);
    const dirty = await tryGit(at, ['status', '--porcelain']);
    const unpushed = await tryGit(at, ['rev-list', '-n', '1', 'HEAD', '--not', '--remotes']);
    if (dirty || unpushed) throw new ArchiveError(`The submodule ${sub} has ${dirty ? 'uncommitted changes' : 'commits that aren’t pushed'}. Commit and push them in it first, then archive.`);
  }
  return subs.length > 0;
}

/** Your name for the snapshot commit when git has one, else Klaud's. */
async function identity(dir: string): Promise<NodeJS.ProcessEnv> {
  const name = await tryGit(dir, ['config', 'user.name']);
  const email = await tryGit(dir, ['config', 'user.email']);
  return name && email ? {} : IDENTITY;
}

export interface Snapshot {
  readonly commit: string;
  readonly tree: string;
  readonly head?: string;
  /** Git repos of yours inside the folder that aren't submodules (their files and history go in the packed file). */
  readonly nested: readonly string[];
}

/**
 * The folder as it is, as a commit: its tree has every file git doesn't ignore (changed, new
 * or deleted), its second parent's tree is the staging. Nothing in the folder changes.
 */
export async function snapshot(dir: string, message: string): Promise<Snapshot> {
  const env = await identity(dir);
  const head = await tryGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const parents = head ? ['-p', head] : [];
  const submodules = new Set(await gitlinks(dir));
  // Staging: unmerged files can't be written as a tree; then it's the same as the folder.
  const staged = await tryGit(dir, ['write-tree']);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'klaud-archive-'));
  try {
    const temp = { ...env, GIT_INDEX_FILE: path.join(tmp, 'index') };
    await git(dir, head ? ['read-tree', head] : ['read-tree', '--empty'], temp, LONG_MS);
    await git(dir, ['-c', 'advice.addEmbeddedRepo=false', 'add', '-A', '--', '.'], temp, LONG_MS);
    const tree = (await git(dir, ['write-tree'], temp, LONG_MS)).trim();
    // A repo inside that isn't a submodule: git only notes it's there, so it's packed whole.
    const nested = (await gitlinks(dir, temp)).filter((p) => !submodules.has(p));
    const stagedCommit = (await git(dir, ['commit-tree', staged ?? tree, ...parents, '-m', `${message} (staged)`], env)).trim();
    const commit = (await git(dir, ['commit-tree', tree, ...parents, '-p', stagedCommit, '-m', message], env)).trim();
    return { commit, tree, nested, ...(head ? { head } : {}) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Pack these (relative) paths of `dir` into an xz file, as small as xz makes it, and check every one is in it. */
export async function pack(dir: string, rels: readonly string[], file: string): Promise<void> {
  const names = rels.map((r) => r.replace(/\/$/, ''));
  const list = `${file}.list`;
  writeFileSync(list, names.join('\0'));
  try {
    await run('tar', ['-c', '-J', '--options', 'xz:compression-level=9', '-f', file, '-C', dir, '--null', '-T', list], { cwd: dir, timeoutMs: TAR_TIMEOUT_MS });
    const listed = new Set((await run('tar', ['-t', '-f', file], { cwd: dir, timeoutMs: TAR_TIMEOUT_MS })).split('\n').map((l) => l.replace(/\/$/, '')));
    const missing = names.find((n) => !listed.has(n));
    if (missing) throw new ArchiveError(`Couldn’t pack ${missing}`);
  } finally {
    rmSync(list, { force: true });
  }
}
