import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Files and folders that hold local secrets/config and aren't in git, copied into new worktrees. */
const ENV_FILE = /^\.env(\..+)?$/;
const ENV_DIRS = new Set(['.ssh', '.aws']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.klaude', '.next', 'vendor']);
const MAX_DEPTH = 3;

/** Relative paths of env files (and files inside .ssh/.aws folders) in a checkout. */
export function findEnvFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && ENV_FILE.test(e.name) && !/\.(example|sample|template)$/.test(e.name)) found.push(relPath);
      else if (e.isDirectory() && ENV_DIRS.has(e.name)) {
        for (const f of readdirSync(path.join(dir, e.name), { withFileTypes: true })) if (f.isFile()) found.push(`${relPath}/${f.name}`);
      } else if (e.isDirectory() && depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), relPath, depth + 1);
    }
  };
  walk(root, '', 0);
  return found.sort();
}

/** Copy env files from the main folder into a new worktree (only ones the worktree doesn't have). */
export async function copyEnvFiles(from: string, to: string): Promise<string[]> {
  const copied: string[] = [];
  for (const rel of findEnvFiles(from)) {
    const target = path.join(to, rel);
    if (existsSync(target)) continue;
    cpSync(path.join(from, rel), target, { recursive: true, preserveTimestamps: true });
    copied.push(rel);
  }
  return copied;
}

const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Fingerprint of every env file in a folder, taken when the worktree is created. */
export async function envSnapshot(dir: string): Promise<Record<string, string>> {
  return Object.fromEntries(findEnvFiles(dir).map((rel) => [rel, hash(path.join(dir, rel))]));
}

export interface EnvChange {
  readonly file: string;
  /** For KEY=VALUE files: key names that were added, changed or removed (values are never shown). */
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  /** Not a KEY=VALUE file (e.g. a key in .ssh): the whole file differs. */
  readonly binary: boolean;
}

export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line);
    if (m?.[1]) out.set(m[1], m[2] ?? '');
  }
  return out;
}

/** What changed in a worktree's env files compared with the main folder. */
export function envChanges(worktree: string, main: string, snapshot: Readonly<Record<string, string>> = {}): EnvChange[] {
  const changes: EnvChange[] = [];
  for (const rel of findEnvFiles(worktree)) {
    const file = path.join(worktree, rel);
    if (snapshot[rel] && snapshot[rel] === hash(file)) continue; // untouched since creation
    const mainFile = path.join(main, rel);
    const isDotenv = ENV_FILE.test(path.basename(rel));
    if (!isDotenv) {
      if (!existsSync(mainFile) || hash(mainFile) !== hash(file)) changes.push({ file: rel, added: [], changed: [], removed: [], binary: true });
      continue;
    }
    const mine = parseDotenv(readFileSync(file, 'utf8'));
    const theirs = existsSync(mainFile) ? parseDotenv(readFileSync(mainFile, 'utf8')) : new Map<string, string>();
    const added = [...mine.keys()].filter((k) => !theirs.has(k));
    const changed = [...mine.keys()].filter((k) => theirs.has(k) && theirs.get(k) !== mine.get(k));
    const removed = [...theirs.keys()].filter((k) => !mine.has(k));
    if (added.length || changed.length || removed.length) changes.push({ file: rel, added, changed, removed, binary: false });
  }
  return changes;
}

/**
 * Bring a worktree's env changes back into the main folder: changed and added keys are
 * written into the main file (keeping its other keys and comments); other files are copied.
 * Removed keys are left alone, so nothing in the main folder is deleted by surprise.
 */
export function applyEnvChanges(worktree: string, main: string, changes: readonly EnvChange[]): void {
  for (const c of changes) {
    const src = path.join(worktree, c.file);
    const dst = path.join(main, c.file);
    if (c.binary || !existsSync(dst)) {
      cpSync(src, dst, { recursive: true });
      continue;
    }
    const mine = parseDotenv(readFileSync(src, 'utf8'));
    const lines = readFileSync(dst, 'utf8').split('\n');
    const keys = new Set([...c.added, ...c.changed]);
    const updated = lines.map((line) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/.exec(line);
      const key = m?.[1];
      if (key && keys.has(key)) {
        keys.delete(key);
        return `${key}=${mine.get(key) ?? ''}`;
      }
      return line;
    });
    const appended = [...keys].map((k) => `${k}=${mine.get(k) ?? ''}`);
    const body = [...updated.filter((l, i) => !(i === updated.length - 1 && l === '' && appended.length)), ...appended].join('\n');
    writeFileSync(dst, body.endsWith('\n') ? body : `${body}\n`, { mode: statSync(dst).mode });
  }
}
