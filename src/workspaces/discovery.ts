import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'dist', 'build', 'vendor']);
const MAX_PROJECTS = 300;

/** True when `dir` is the main checkout of a git repo (a `.git` folder, not a worktree's `.git` file). */
export function isMainCheckout(dir: string): boolean {
  try {
    return statSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

/** Find git projects inside parent folders (two levels deep, skipping heavy/hidden folders). */
export function findProjects(roots: readonly string[], depth = 2): string[] {
  const found = new Set<string>();
  const walk = (dir: string, level: number): void => {
    if (found.size >= MAX_PROJECTS) return;
    if (isMainCheckout(dir)) {
      found.add(dir);
      return;
    }
    if (level >= depth) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name))
        .map((d) => d.name);
    } catch {
      return;
    }
    for (const name of entries.sort()) walk(path.join(dir, name), level + 1);
  };
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // ~/Projects and ~/projects are the same folder on case-insensitive disks: scan it once.
    const canonical = realpathSync.native(root);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    walk(canonical, 0);
  }
  return [...found];
}
