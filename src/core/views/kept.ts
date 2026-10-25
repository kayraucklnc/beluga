import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What a view's source brought last time, kept on this Mac so opening a conversation (or a
 * report) again shows it at once instead of running the source again. Refresh, or a source's
 * `refresh` seconds, fetch it anew. It's only a cache: anything here can go at any time, and
 * it goes when the conversation it was shown in is archived or deleted (forget.ts).
 *
 * Kept per source as the view names it (`group`: its pages, its control values), so one view's
 * rows can be forgotten: fetched/<group>/<key>.json.
 */

/** Where views keep data on this Mac (the show tool's big `data` too). BELUGA_CACHE_DIR moves it (tests). */
export const viewDataDir = (): string => process.env.BELUGA_CACHE_DIR ?? path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/Beluga/views' : '.cache/beluga/views');
const dir = (): string => path.join(viewDataDir(), 'fetched');

/** Bigger than this isn't kept (sources.ts still holds a whole source for a minute). */
const MAX_BYTES = 4 * 1024 * 1024;
/** How many are kept on disk, newest first. */
const MAX_FILES = 400;
const MEMORY = 60;

const memory = new Map<string, { group: string; at: number; value: unknown }>();
let writes = 0;

const hash = (s: string, n: number): string => createHash('sha256').update(s).digest('hex').slice(0, n);
const groupDir = (group: string): string => path.join(dir(), hash(group, 20));
const fileOf = (group: string, key: string): string => path.join(groupDir(group), `${hash(key, 24)}.json`);

/** What was kept under this key, and when it was fetched. */
export function recall<T>(group: string, key: string): { at: number; value: T } | undefined {
  const near = memory.get(key);
  if (near) return near as { at: number; value: T };
  try {
    const got = JSON.parse(readFileSync(fileOf(group, key), 'utf8')) as { key?: unknown; at?: unknown; value?: unknown };
    // Two keys with one name (never, in practice) don't mix.
    if (got.key !== key || typeof got.at !== 'number') return undefined;
    remember(group, key, got.at, got.value, false);
    return { at: got.at, value: got.value as T };
  } catch {
    return undefined;
  }
}

/** Keep what a source brought (in memory, and on disk when it's not too big). */
export function keep(group: string, key: string, at: number, value: unknown): void {
  remember(group, key, at, value, true);
}

/** Forget everything a source brought (its view's conversation was archived or deleted). → whether there was any. */
export function forgetSource(group: string): boolean {
  for (const [k, v] of memory) if (v.group === group) memory.delete(k);
  try {
    readdirSync(groupDir(group));
  } catch {
    return false;
  }
  rmSync(groupDir(group), { recursive: true, force: true });
  return true;
}

function remember(group: string, key: string, at: number, value: unknown, write: boolean): void {
  const body = write ? JSON.stringify({ key, at, value }) : '';
  // Too big to keep around (a whole source of 50,000 rows): fetched again next time.
  if (body.length > MAX_BYTES) return;
  memory.delete(key);
  memory.set(key, { group, at, value });
  if (memory.size > MEMORY) memory.delete(memory.keys().next().value!);
  if (!write) return;
  try {
    mkdirSync(groupDir(group), { recursive: true, mode: 0o700 });
    writeFileSync(fileOf(group, key), body, { mode: 0o600 });
    if (++writes % 25 === 1) prune();
  } catch {
    // Kept in memory only.
  }
}

/** Only the newest MAX_FILES stay (and folders left empty go). */
function prune(): void {
  const files: { full: string; t: number }[] = [];
  for (const g of readdirSync(dir())) {
    let names: string[];
    try {
      names = readdirSync(path.join(dir(), g));
    } catch {
      continue;
    }
    if (!names.length) rmSync(path.join(dir(), g), { recursive: true, force: true });
    for (const f of names) {
      const full = path.join(dir(), g, f);
      try {
        files.push({ full, t: statSync(full).mtimeMs });
      } catch {
        // Gone meanwhile.
      }
    }
  }
  files.sort((a, b) => b.t - a.t);
  for (const f of files.slice(MAX_FILES)) rmSync(f.full, { force: true });
}

/** Forget everything kept in memory (tests). */
export function forgetKept(): void {
  memory.clear();
}
