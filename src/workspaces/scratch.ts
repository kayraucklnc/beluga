import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { SCRATCH_DIR, SHOWN_SCRATCH_DIRS } from '../shared/scratch-dir.js';

/**
 * A workspace's scratch folder: where Claude keeps the screenshots, logs and intermediate output it
 * makes while it works (not the work itself). It lives in the workspace as `.beluga/scratch/`, kept
 * out of git through the repo's own exclude file (never a change to .gitignore), and the Mac app
 * shows it live (the panel's Scratch tab), together with the `.context/` folder Claude saves to
 * when another tool runs it in the same worktree (looked at, never written).
 */

export { SCRATCH_DIR, SHOWN_SCRATCH_DIRS };
const EXCLUDE_LINE = `/${SCRATCH_DIR}/`;
/** How many files the list shows, and how deep it looks. */
const MAX_FILES = 300;
const MAX_DEPTH = 4;

const run = promisify(execFile);

export interface ScratchFile {
  /** From the workspace's folder, e.g. `.beluga/scratch/shots/home.png`. */
  readonly path: string;
  readonly size: number;
  /** Last written (ms). */
  readonly mtime: number;
}

/** The repo's exclude file (a worktree shares its main checkout's), or undefined outside git. */
async function excludeFile(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--git-common-dir'], { cwd: dir, timeout: 5000 });
    return path.join(path.resolve(dir, stdout.trim()), 'info', 'exclude');
  } catch {
    return undefined;
  }
}

/** Each part of a folder's path inside the workspace is a real folder (or not there yet), never a link out. */
async function noLinks(dir: string, rel: string = SCRATCH_DIR): Promise<boolean> {
  let at = dir;
  for (const part of rel.split('/')) {
    at = path.join(at, part);
    const st = await fs.lstat(at).catch(() => undefined);
    if (st && !st.isDirectory()) return false; // a link (or a file) where the folder goes
  }
  return true;
}

/** Keeping each workspace's folder out of git, done once per process (two runs at once share it). */
const excluding = new Map<string, Promise<void>>();

async function excludeOnce(dir: string): Promise<void> {
  const exclude = await excludeFile(dir);
  if (!exclude) return;
  const current = await fs.readFile(exclude, 'utf8').catch(() => '');
  if (current.split('\n').some((l) => l.trim() === EXCLUDE_LINE)) return;
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  await fs.appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# beluga: Claude's scratch folder\n${EXCLUDE_LINE}\n`);
}

/** Make the folder and keep it out of git. Never throws: a run goes ahead without it. */
export async function ensureScratch(dir: string): Promise<string | undefined> {
  const scratch = path.join(dir, SCRATCH_DIR);
  try {
    if (!(await noLinks(dir))) return undefined;
    await fs.mkdir(scratch, { recursive: true });
    let job = excluding.get(dir);
    if (!job) {
      job = excludeOnce(dir);
      excluding.set(dir, job);
      job.catch(() => excluding.delete(dir));
    }
    await job;
    return scratch;
  } catch {
    return undefined;
  }
}

/** What's in the shown folders (Beluga's and `.context/`), newest first (no links followed). */
export async function listScratch(dir: string): Promise<ScratchFile[]> {
  const files: ScratchFile[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory() && depth < MAX_DEPTH) await walk(child, depth + 1);
      else if (e.isFile()) {
        const st = await fs.stat(path.join(dir, child)).catch(() => undefined);
        if (st) files.push({ path: child, size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    }
  };
  for (const rel of SHOWN_SCRATCH_DIRS) {
    if (await noLinks(dir, rel)) await walk(rel, 1);
  }
  return files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, MAX_FILES);
}
