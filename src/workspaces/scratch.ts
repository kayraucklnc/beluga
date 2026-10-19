import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { SCRATCH_DIR } from '../shared/scratch-dir.js';

/**
 * A workspace's scratch folder: where Claude keeps the screenshots, logs and intermediate output it
 * makes while it works (not the work itself). It lives in the workspace as `.klaud/scratch/`, kept
 * out of git through the repo's own exclude file (never a change to .gitignore), and the Mac app
 * shows it live (the panel's Scratch tab).
 */

export { SCRATCH_DIR };
const EXCLUDE_LINE = `/${SCRATCH_DIR}/`;
/** How many files the list shows, and how deep it looks. */
const MAX_FILES = 300;
const MAX_DEPTH = 4;

const run = promisify(execFile);

export interface ScratchFile {
  /** From the workspace's folder, e.g. `.klaud/scratch/shots/home.png`. */
  readonly path: string;
  readonly size: number;
  /** Last written (ms). */
  readonly mtime: number;
}

/** The repo's exclude file (a worktree shares its main checkout's), or undefined outside git. */
async function excludeFile(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--git-common-dir'], { cwd: dir });
    return path.join(path.resolve(dir, stdout.trim()), 'info', 'exclude');
  } catch {
    return undefined;
  }
}

/** Make the folder and keep it out of git. Never throws: a run goes ahead without it. */
export async function ensureScratch(dir: string): Promise<string | undefined> {
  const scratch = path.join(dir, SCRATCH_DIR);
  try {
    await fs.mkdir(scratch, { recursive: true });
    const exclude = await excludeFile(dir);
    if (exclude) {
      const current = await fs.readFile(exclude, 'utf8').catch(() => '');
      if (!current.split('\n').some((l) => l.trim() === EXCLUDE_LINE)) {
        await fs.mkdir(path.dirname(exclude), { recursive: true });
        await fs.appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# klaud: Claude's scratch folder\n${EXCLUDE_LINE}\n`);
      }
    }
    return scratch;
  } catch {
    return undefined;
  }
}

/** What's in the folder, newest first (no links followed). */
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
  await walk(SCRATCH_DIR, 1);
  return files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, MAX_FILES);
}
