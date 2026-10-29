import { useEffect, useRef } from 'react';

/**
 * What a list looked like the last time it was read (a project's runs, its latest commits, its
 * issues), kept across visits and launches so a page shows it at once and only swaps in what's
 * new when the fresh answer comes. Bounded: the most recently used few dozen, in localStorage.
 */

const KEY = 'beluga.lastSeen.v1';
const MAX = 40;

const load = (): Map<string, unknown> => {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const rows = raw ? (JSON.parse(raw) as [string, unknown][]) : [];
    return new Map(Array.isArray(rows) ? rows : []);
  } catch {
    return new Map();
  }
};

let kept: Map<string, unknown> | undefined;
let writing: ReturnType<typeof setTimeout> | undefined;

const all = (): Map<string, unknown> => (kept ??= load());

/** The last answer kept under `key`, if any. */
export function lastSeen<T>(key: string): T | undefined {
  return key ? (all().get(key) as T | undefined) : undefined;
}

/** Keep `value` as the last answer for `key` (written out a moment later, once for a burst). */
export function keepSeen(key: string, value: unknown): void {
  if (!key) return;
  const map = all();
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX) map.delete(map.keys().next().value!);
  if (writing) return;
  writing = setTimeout(() => {
    writing = undefined;
    try {
      localStorage.setItem(KEY, JSON.stringify([...map]));
    } catch {
      // No storage (or full): kept for this window.
    }
  }, 500);
}

/**
 * Which rows came in after the list was first shown, to let only those rise in: the first rows
 * (from what was kept, or when the whole section arrives) don't, a run started since does.
 */
export function useArrivals(keys: readonly (string | number)[]): (key: string | number) => boolean {
  const seen = useRef<Set<string | number> | undefined>(undefined);
  useEffect(() => {
    if (!keys.length) return;
    const s = (seen.current ??= new Set());
    for (const k of keys) s.add(k);
  });
  return (key) => seen.current !== undefined && !seen.current.has(key);
}

/** Whether a section's content came after the page opened (nothing kept to show at first): it fades in then. */
export function useLateArrival(scope: string, has: boolean): boolean {
  const at = useRef<{ scope: string; had: boolean } | undefined>(undefined);
  if (at.current?.scope !== scope) at.current = { scope, had: has };
  return !at.current.had;
}
