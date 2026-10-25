import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What a view's source brought last time, kept on this Mac so opening a conversation (or a
 * report) again shows it at once instead of running the source again. Refresh, or a source's
 * `refresh` seconds, fetch it anew. It's only a cache: anything here can go at any time.
 */

/** Where views keep data on this Mac (the show tool's big `data` too). BELUGA_CACHE_DIR moves it (tests). */
export const viewDataDir = (): string => process.env.BELUGA_CACHE_DIR ?? path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/Beluga/views' : '.cache/beluga/views');
const dir = (): string => path.join(viewDataDir(), 'fetched');

/** Bigger than this isn't kept (sources.ts still holds a whole source for a minute). */
const MAX_BYTES = 4 * 1024 * 1024;
/** How many are kept on disk, newest first. */
const MAX_FILES = 400;
const MEMORY = 60;

const memory = new Map<string, { at: number; value: unknown }>();
let writes = 0;

const fileOf = (key: string): string => path.join(dir(), `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`);

/** What was kept under this key, and when it was fetched. */
export function recall<T>(key: string): { at: number; value: T } | undefined {
  const near = memory.get(key);
  if (near) return near as { at: number; value: T };
  try {
    const got = JSON.parse(readFileSync(fileOf(key), 'utf8')) as { key?: unknown; at?: unknown; value?: unknown };
    // Two keys with one name (never, in practice) don't mix.
    if (got.key !== key || typeof got.at !== 'number') return undefined;
    remember(key, got.at, got.value, false);
    return { at: got.at, value: got.value as T };
  } catch {
    return undefined;
  }
}

/** Keep what a source brought (in memory, and on disk when it's not too big). */
export function keep(key: string, at: number, value: unknown): void {
  remember(key, at, value, true);
}

function remember(key: string, at: number, value: unknown, write: boolean): void {
  const body = write ? JSON.stringify({ key, at, value }) : '';
  // Too big to keep around (a whole source of 50,000 rows): fetched again next time.
  if (body.length > MAX_BYTES) return;
  memory.delete(key);
  memory.set(key, { at, value });
  if (memory.size > MEMORY) memory.delete(memory.keys().next().value!);
  if (!write) return;
  try {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    writeFileSync(fileOf(key), body, { mode: 0o600 });
    if (++writes % 25 === 1) prune();
  } catch {
    // Kept in memory only.
  }
}

/** Only the newest MAX_FILES stay. */
function prune(): void {
  const files = readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(dir(), f);
      try {
        return { full, t: statSync(full).mtimeMs };
      } catch {
        return { full, t: 0 };
      }
    })
    .sort((a, b) => b.t - a.t);
  for (const f of files.slice(MAX_FILES)) rmSync(f.full, { force: true });
}

/** Forget everything kept in memory (tests). */
export function forgetKept(): void {
  memory.clear();
}
