import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { WorktreeInfo } from '@klaud/core/other-worktrees.js';
import type { OriginInfo } from '@klaud/workspaces/origin.js';
import { useApi } from '../lib/klaud.js';

/**
 * This window's memory for worktrees made outside Klaud: which ones you chose to start a
 * conversation in (the chat shows instead of the info page) and which show their info page
 * over the conversation. Plus the lookups the info page and the sidebar folds make.
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

const originCache = new Map<string, Record<string, OriginInfo>>();

/**
 * Who made each of a project's other worktrees (looked up once per set of worktrees: it reads
 * Conductor's data and Claude Code's transcripts). Empty until it's known.
 */
export function useOrigins(projectId: string, ids: readonly string[]): Record<string, OriginInfo> {
  const api = useApi();
  const key = `${projectId}:${[...ids].sort().join(',')}`;
  const [origins, setOrigins] = useState<Record<string, OriginInfo>>(() => originCache.get(key) ?? {});
  useEffect(() => {
    if (!ids.length) return;
    const hit = originCache.get(key);
    if (hit) {
      setOrigins(hit);
      return;
    }
    let live = true;
    api.workspaces
      .otherOrigins(projectId)
      .then((found) => {
        originCache.set(key, found ?? {});
        if (live) setOrigins(found ?? {});
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // `key` covers ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, projectId]);
  return origins;
}
