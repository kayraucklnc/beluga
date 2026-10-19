import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { WorktreeInfo } from '@klaud/core/other-worktrees.js';
import { useApi } from '../lib/klaud.js';

/**
 * This window's memory for worktrees made outside Klaud: which ones you chose to start a
 * conversation in (the chat shows instead of the info page) and which show their info page
 * over the conversation. Plus the lookups the info page and the sidebar make.
 */

type Kind = 'started' | 'about';
let flags: Readonly<Record<Kind, ReadonlySet<string>>> = { started: new Set(), about: new Set() };
const listeners = new Set<() => void>();
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function setWorktreeFlag(kind: Kind, id: string, on: boolean): void {
  const next = new Set(flags[kind]);
  if (on) next.add(id);
  else next.delete(id);
  flags = { ...flags, [kind]: next };
  for (const fn of listeners) fn();
}

export function useWorktreeFlag(kind: Kind, id: string): boolean {
  return useSyncExternalStore(subscribe, () => flags[kind].has(id));
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The info page's facts about one worktree; `key` changes (its git status moved) fetch again. */
export function useWorktreeInfo(id: string, key: string): { info?: WorktreeInfo; loading: boolean; error?: string; reload: () => void } {
  const api = useApi();
  const [state, setState] = useState<{ info?: WorktreeInfo; loading: boolean; error?: string; for?: string }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...(s.for === id ? { info: s.info } : {}), loading: true, for: id }));
    api.workspaces
      .worktreeInfo(id)
      .then((info) => live && setState({ ...(info ? { info } : {}), loading: false, for: id }))
      .catch((err: unknown) => live && setState({ loading: false, error: errorText(err), for: id }));
    return () => {
      live = false;
    };
  }, [api, id, key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...(state.for === id ? state : { loading: true }), reload };
}

/** How long the sidebar trusts what git said about when each outside worktree last changed. */
const ACTIVITY_FRESH_MS = 60_000;
const activityCache = new Map<string, { readonly at: number; readonly times: Record<string, number> }>();

/**
 * When git last saw something happen in each of a project's worktrees made outside Klaud (a
 * commit, a checkout, staging): how the sidebar orders them. Asked again when the set of
 * worktrees changes, or after a minute. Empty until it's known.
 */
export function useOtherActivity(projectId: string, ids: readonly string[]): Record<string, number> {
  const api = useApi();
  const key = `${projectId}:${[...ids].sort().join(',')}`;
  const [times, setTimes] = useState<Record<string, number>>(() => activityCache.get(key)?.times ?? {});
  useEffect(() => {
    if (!ids.length) return;
    const hit = activityCache.get(key);
    if (hit) setTimes(hit.times);
    if (hit && Date.now() - hit.at < ACTIVITY_FRESH_MS) return;
    let live = true;
    api.workspaces
      .otherActivity(projectId)
      .then((found) => {
        activityCache.set(key, { at: Date.now(), times: found ?? {} });
        if (live) setTimes(found ?? {});
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // `key` covers ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, projectId]);
  return times;
}
