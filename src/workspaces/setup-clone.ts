import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A new worktree's npm installs, copied instead (BLG-366): when another checkout of the project
 * (the main folder or a sibling worktree) has the same package-lock.json and installed exactly
 * that, its node_modules is cloned (APFS copy-on-write: seconds, no extra disk) instead of
 * `npm ci` fetching and unpacking it all again, three times over in a repo with sub-packages. If the
 * copy fails the install runs as it would have. Only on macOS (`cp -c`); anything else runs as is.
 */

/** One `npm ci` / `npm install` step, optionally in a sub-package (`--prefix packages/mac`). */
const NPM_INSTALL = /^npm\s+(?:ci|install|i)(?:\s+--prefix(?:=|\s+)(\S+))?$/;
/** What a package runs when it's installed itself (a copy skips them, so they're run after it). */
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare'] as const;
/** Caches inside node_modules that may name the folder they were made in (vite's, vitest's, babel's…). */
const CACHES = ['.cache', '.vite', '.vitest'];

const read = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

type Packages = Record<string, { version?: string; optional?: boolean; devOptional?: boolean; link?: boolean }>;
const packagesOf = (text: string | undefined): Packages | undefined => {
  try {
    return text ? ((JSON.parse(text) as { packages?: Packages }).packages ?? undefined) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether `dir`'s node_modules holds what its lockfile says (npm's own record of what it installed,
 * node_modules/.package-lock.json, against package-lock.json): everything installed is as locked,
 * and nothing locked is missing but what's optional (another platform's builds).
 */
export function installedAsLocked(dir: string, lock = read(path.join(dir, 'package-lock.json'))): boolean {
  const want = packagesOf(lock);
  const have = packagesOf(read(path.join(dir, 'node_modules', '.package-lock.json')));
  if (!want || !have) return false;
  for (const [key, pkg] of Object.entries(have)) if (want[key]?.version !== pkg.version) return false;
  for (const [key, pkg] of Object.entries(want)) if (key && !pkg.optional && !pkg.devOptional && !(key in have)) return false;
  return true;
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The setup to run in the worktree at `dir` instead of `command`: each npm install in it whose
 * package another checkout (`sources`) has installed from the same lockfile becomes a clone of that
 * one's node_modules (then the package's own install scripts), falling back to the install itself.
 * Undefined when there's nothing to copy.
 */
export function clonedSetup(command: string, dir: string, sources: readonly string[], platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'darwin') return undefined;
  let copied = false;
  const steps = command.split('&&').map((raw) => {
    const step = raw.trim();
    const m = NPM_INSTALL.exec(step);
    if (!m) return step;
    const rel = m[1] ?? '.';
    const here = path.resolve(dir, rel);
    const lock = read(path.join(here, 'package-lock.json'));
    if (!lock || existsSync(path.join(here, 'node_modules'))) return step;
    const from = sources.map((s) => path.resolve(s, rel)).find((there) => there !== here && read(path.join(there, 'package-lock.json')) === lock && installedAsLocked(there, lock));
    if (!from) return step;
    copied = true;
    const target = path.join(here, 'node_modules');
    const scripts = (JSON.parse(read(path.join(here, 'package.json')) ?? '{}') as { scripts?: Record<string, string> }).scripts ?? {};
    const prefix = m[1] ? ` --prefix ${m[1]}` : '';
    const after = LIFECYCLE.filter((s) => scripts[s]).map((s) => ` && npm run ${s}${prefix}`).join('');
    const tidy = CACHES.map((c) => q(path.join(target, c))).join(' ');
    return `{ echo ${q(`Copying ${rel === '.' ? '' : `${rel}/`}node_modules from ${from} (same lockfile)`)} && cp -c -R ${q(path.join(from, 'node_modules'))} ${q(target)} && rm -rf ${tidy}${after}; } || { rm -rf ${q(target)}; ${step}; }`;
  });
  return copied ? steps.join(' && ') : undefined;
}
