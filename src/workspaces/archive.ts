import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderSize } from './disk.js';
import { FILE_RULES, type RegenRule, regenRule, remakeSteps } from './regenerable.js';

/**
 * A smart archive of a worktree: nothing of yours is lost, and what can be made again doesn't
 * take space. What git sees (changes, staged files, untracked files) goes into a snapshot
 * commit kept in the repo under refs/klaud/archive/<id>: git keeps it compressed and shares what
 * it already has. Of what git ignores, dependencies, build output and caches (see
 * regenerable.ts) are thrown away, and everything else (.env, local databases…) is packed into
 * one xz-compressed file. Then the folder goes; its branch stays. Restoring brings the folder
 * back exactly as it was, staging included; the thrown-away parts come back from `remake`.
 */

export interface ArchiveManifest {
  readonly version: 1;
  readonly id: string;
  /** Where the worktree was, its branch and the commit it was on. */
  readonly dir: string;
  readonly branch?: string;
  readonly head?: string;
  /** The snapshot commit: its tree is the folder as it was; its second parent's tree, the staging. */
  readonly snapshot: string;
  /** The packed ignored files (in the archive's folder), when there were any. */
  readonly keptFile?: string;
  readonly keptBytes: number;
  /** What was thrown away, how big, and what makes it again. */
  readonly dropped: ReadonlyArray<{ readonly path: string; readonly what: string; readonly bytes: number }>;
  readonly freedBytes: number;
  readonly remake: readonly string[];
  readonly archivedAt: number;
}

export interface ArchivePlan {
  readonly drop: ReadonlyArray<{ readonly path: string; readonly rule: RegenRule; readonly bytes: number }>;
  /** Ignored files and folders that are kept (relative, folders ending in "/"). */
  readonly keep: readonly string[];
  readonly dropBytes: number;
  readonly remake: readonly string[];
}

export type ArchivePhase = 'saving' | 'compressing' | 'removing';

/** An archive's plan as words and sizes (for a screen to show before you archive or free space). */
export interface ArchivePreview {
  readonly drop: ReadonlyArray<{ readonly path: string; readonly what: string; readonly bytes: number }>;
  readonly dropBytes: number;
  /** Ignored files of yours that are kept (the first few), and how many in all. */
  readonly keep: readonly string[];
  readonly keepCount: number;
  readonly remake: readonly string[];
}

export const previewOf = (p: ArchivePlan): ArchivePreview => ({ drop: p.drop.map((d) => ({ path: d.path, what: d.rule.what, bytes: d.bytes })), dropBytes: p.dropBytes, keep: p.keep.slice(0, 20), keepCount: p.keep.length, remake: p.remake });

const REF = (id: string): string => `refs/klaud/archive/${id}`;
const SAFE_ID = /^[\w.-]{1,128}$/;
const KEPT = 'kept.tar.xz';
const MANIFEST = 'manifest.json';
/** Packing what's kept can take a while on a big folder. */
const TAR_TIMEOUT_MS = 30 * 60_000;
/** Commits need a name; yours when git has one. */
const IDENTITY = { GIT_AUTHOR_NAME: 'Klaud', GIT_AUTHOR_EMAIL: 'klaud@localhost', GIT_COMMITTER_NAME: 'Klaud', GIT_COMMITTER_EMAIL: 'klaud@localhost' };

function run(cmd: string, args: readonly string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } ): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

const git = (cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> => run('git', args, { cwd, ...(env ? { env } : {}) });
const tryGit = (cwd: string, args: readonly string[]): Promise<string | undefined> => git(cwd, args).then((s) => s.trim(), () => undefined);

/** Your name for the snapshot commit when git has one, else Klaud's. */
async function identity(dir: string): Promise<NodeJS.ProcessEnv> {
  const name = await tryGit(dir, ['config', 'user.name']);
  const email = await tryGit(dir, ['config', 'user.email']);
  return name && email ? {} : IDENTITY;
}

/** Ignored files and folders (a folder git ignores whole is one entry, ending in "/"). */
async function ignored(dir: string): Promise<string[]> {
  const out = await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  return out.split('\0').filter(Boolean);
}

/** What an archive would throw away and keep, without touching anything. */
export async function planArchive(dir: string): Promise<ArchivePlan> {
  const drop: Array<{ path: string; rule: RegenRule; bytes: number }> = [];
  const keep: string[] = [];
  const dropped = new Set<string>();
  for (const rel of await ignored(dir)) {
    const rule = regenRule(dir, rel);
    if (!rule) {
      keep.push(rel);
      continue;
    }
    // A file inside a thrown-away folder: the folder goes as one.
    const top = topOf(rel, rule);
    if (dropped.has(top)) continue;
    dropped.add(top);
    drop.push({ path: top, rule, bytes: 0 });
  }
  const sized = await Promise.all(drop.map(async (d) => ({ ...d, bytes: (await folderSize(path.join(dir, d.path))) ?? 0 })));
  return { drop: sized, keep: outermost(keep), dropBytes: sized.reduce((n, d) => n + d.bytes, 0), remake: remakeSteps(sized.map((d) => d.rule)) };
}

/** Without what's inside another entry (a kept folder takes everything in it). */
function outermost(rels: readonly string[]): string[] {
  const dirs = rels.filter((r) => r.endsWith('/'));
  return rels.filter((r) => !dirs.some((d) => d !== r && r.startsWith(d)));
}

/** The folder a rule matched in a path ("node_modules/a/b.js" → "node_modules/"). */
function topOf(rel: string, rule: RegenRule): string {
  const parts = rel.split('/').filter(Boolean);
  if (!rel.endsWith('/') && FILE_RULES.includes(rule)) return rel;
  const i = parts.findIndex((p, k) => (k < parts.length - 1 || rel.endsWith('/')) && rule.names.some((n) => (typeof n === 'string' ? n === p : n.test(p))));
  return i < 0 ? rel : `${parts.slice(0, i + 1).join('/')}/`;
}

/** The archive's folder (one per worktree id). */
const folderOf = (archivesDir: string, id: string): string => {
  if (!SAFE_ID.test(id)) throw new Error('Not an archive id');
  return path.join(archivesDir, id);
};

export function readManifest(archivesDir: string, id: string): ArchiveManifest | undefined {
  try {
    const m = JSON.parse(readFileSync(path.join(folderOf(archivesDir, id), MANIFEST), 'utf8')) as ArchiveManifest;
    return m.version === 1 && typeof m.snapshot === 'string' ? m : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The folder as it is, as a commit: its tree has every file git doesn't ignore (changed, new
 * or deleted), its second parent's tree is the staging. Nothing in the folder changes.
 */
async function snapshot(dir: string, message: string): Promise<{ snapshot: string; head?: string }> {
  const env = await identity(dir);
  const head = await tryGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const parents = head ? ['-p', head] : [];
  // Staging: unmerged files can't be written as a tree; then it's the same as the folder.
  const staged = await tryGit(dir, ['write-tree']);
  const index = path.join(os.tmpdir(), `klaud-archive-${process.pid}-${Date.now()}.index`);
  try {
    const temp = { ...env, GIT_INDEX_FILE: index };
    await git(dir, head ? ['read-tree', head] : ['read-tree', '--empty'], temp);
    await git(dir, ['add', '-A', '--', '.'], temp);
    const tree = (await git(dir, ['write-tree'], temp)).trim();
    const stagedCommit = (await git(dir, ['commit-tree', staged ?? tree, ...parents, '-m', `${message} (staged)`], env)).trim();
    const commit = (await git(dir, ['commit-tree', tree, ...parents, '-p', stagedCommit, '-m', message], env)).trim();
    return { snapshot: commit, ...(head ? { head } : {}) };
  } finally {
    rmSync(index, { force: true });
  }
}

/** Pack these (relative) paths of `dir` into an xz file, as small as xz makes it. */
async function pack(dir: string, rels: readonly string[], file: string): Promise<void> {
  const list = `${file}.list`;
  writeFileSync(list, rels.map((r) => r.replace(/\/$/, '')).join('\0'));
  try {
    await run('tar', ['-c', '-J', '--options', 'xz:compression-level=9', '-f', file, '-C', dir, '--null', '-T', list], { cwd: dir, timeoutMs: TAR_TIMEOUT_MS, env: { XZ_OPT: '-9e' } });
    // Can it be read back? (before anything is removed)
    await run('tar', ['-t', '-f', file], { cwd: dir, timeoutMs: TAR_TIMEOUT_MS });
  } finally {
    rmSync(list, { force: true });
  }
}

export interface ArchiveOptions {
  /** The repo's main checkout (where `git worktree` runs). */
  readonly repo: string;
  readonly dir: string;
  /** The worktree's id (names the archive and its ref). */
  readonly id: string;
  readonly archivesDir: string;
  readonly onPhase?: (phase: ArchivePhase) => void;
}

/** Archive a worktree: save what's yours, throw away what's made again, remove the folder (its branch stays). */
export async function archiveWorktree(o: ArchiveOptions): Promise<ArchiveManifest> {
  if (!existsSync(o.dir) || !lstatSync(o.dir).isDirectory()) throw new Error(`${o.dir} isn't there`);
  const folder = folderOf(o.archivesDir, o.id);
  const work = `${folder}.partial`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    o.onPhase?.('saving');
    const plan = await planArchive(o.dir);
    const branch = await tryGit(o.dir, ['symbolic-ref', '--short', '--quiet', 'HEAD']);
    const snap = await snapshot(o.dir, `Klaud archive of ${path.basename(o.dir)}`);
    await git(o.repo, ['update-ref', REF(o.id), snap.snapshot]);
    o.onPhase?.('compressing');
    let keptBytes = 0;
    if (plan.keep.length) {
      await pack(o.dir, plan.keep, path.join(work, KEPT));
      keptBytes = lstatSync(path.join(work, KEPT)).size;
    }
    const manifest: ArchiveManifest = {
      version: 1,
      id: o.id,
      dir: o.dir,
      ...(branch ? { branch } : {}),
      ...(snap.head ? { head: snap.head } : {}),
      snapshot: snap.snapshot,
      ...(plan.keep.length ? { keptFile: KEPT } : {}),
      keptBytes,
      dropped: plan.drop.map((d) => ({ path: d.path, what: d.rule.what, bytes: d.bytes })),
      freedBytes: plan.dropBytes,
      remake: plan.remake,
      archivedAt: Date.now(),
    };
    writeFileSync(path.join(work, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(folder, { recursive: true, force: true });
    renameSync(work, folder);
    o.onPhase?.('removing');
    await git(o.repo, ['worktree', 'remove', '--force', o.dir]);
    return manifest;
  } catch (err) {
    rmSync(work, { recursive: true, force: true });
    // Nothing was removed: forget the snapshot too, unless an earlier archive's manifest still needs it.
    if (!readManifest(o.archivesDir, o.id)) await tryGit(o.repo, ['update-ref', '-d', REF(o.id)]);
    throw err;
  }
}

/**
 * Bring an archived worktree back where it was: its branch checked out, every file as it was
 * (staging too), the kept ignored files unpacked. Then the archive goes.
 */
export async function restoreWorktree(o: Omit<ArchiveOptions, 'onPhase'>): Promise<ArchiveManifest> {
  const m = readManifest(o.archivesDir, o.id);
  if (!m) throw new Error('No archive for this worktree');
  const folder = folderOf(o.archivesDir, o.id);
  if (existsSync(o.dir)) throw new Error(`${o.dir} is already there`);
  mkdirSync(path.dirname(o.dir), { recursive: true });
  const tip = m.branch ? await tryGit(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${m.branch}`]) : undefined;
  // The branch is where it was: back on it. Moved on (or gone): at the commit it was on, so nothing of either is mixed up.
  if (m.branch && tip && tip === m.head) await git(o.repo, ['worktree', 'add', o.dir, m.branch]);
  else if (m.head) await git(o.repo, ['worktree', 'add', '--detach', o.dir, m.head]);
  else await git(o.repo, ['worktree', 'add', '--orphan', o.dir]);
  await git(o.dir, ['read-tree', '-u', '--reset', `${m.snapshot}^{tree}`]);
  await git(o.dir, ['read-tree', `${m.snapshot}^2^{tree}`]);
  if (m.keptFile) await run('tar', ['-x', '-p', '-f', path.join(folder, m.keptFile), '-C', o.dir], { cwd: o.dir, timeoutMs: TAR_TIMEOUT_MS });
  await tryGit(o.repo, ['update-ref', '-d', REF(o.id)]);
  rmSync(folder, { recursive: true, force: true });
  return m;
}

/** Forget an archive (the worktree is deleted for good). */
export async function dropArchive(repo: string, archivesDir: string, id: string): Promise<void> {
  if (repo) await tryGit(repo, ['update-ref', '-d', REF(id)]);
  rmSync(folderOf(archivesDir, id), { recursive: true, force: true });
}

/** Free space in a worktree you keep: throw away only what's made again. */
export async function freeSpace(dir: string): Promise<{ bytes: number; removed: readonly string[]; remake: readonly string[] }> {
  const plan = await planArchive(dir);
  for (const d of plan.drop) rmSync(path.join(dir, d.path), { recursive: true, force: true });
  return { bytes: plan.dropBytes, removed: plan.drop.map((d) => d.path), remake: plan.remake };
}
