import { useMemo, useSyncExternalStore } from 'react';
import type { BoardState, Issue } from '@klaud/core/board/model.js';
import { toast, useApi, useApp, useKlaud } from '../lib/klaud.js';
import { useActions } from '../lib/actions.js';
import { type Person, type TasksPrefs, readTasksPrefs } from './tasks-model.js';

/** What the Tasks screens share: the board, you, the people a task can be for, the view's prefs, and acting on tasks. */

export const useBoard = (): BoardState => useApp((s) => s.board);
export const useSelfId = (): string => useApp((s) => s.selfId);

export function useSelf(): Person {
  const id = useApp((s) => s.selfId);
  const name = useApp((s) => s.self?.name ?? s.network.self?.name ?? 'You');
  return useMemo(() => ({ id, name }), [id, name]);
}

/** People you know: in this room, and friends on the network. */
export function usePeople(): readonly Person[] {
  const peers = useApp((s) => s.peers);
  const friends = useApp((s) => s.network.friends);
  return useMemo(() => {
    const all = new Map<string, Person>();
    for (const p of peers) if (!p.guest) all.set(p.peerId, { id: p.peerId, name: p.name });
    for (const f of friends) all.set(f.peerId, { id: f.peerId, name: f.name });
    return [...all.values()];
  }, [peers, friends]);
}

// ---- the view's prefs, per window

const KEY = 'klaud.tasks.v1';
let prefs = readTasksPrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY));
const listeners = new Set<() => void>();

export function setTasksPrefs(patch: Partial<TasksPrefs>): void {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // No storage: kept for this window.
  }
  for (const l of [...listeners]) l();
}

export function useTasksPrefs(): TasksPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => prefs,
  );
}

// ---- acting

const message = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error: /, '') : String(err));

/** The board's API with errors shown (a toast) instead of thrown, and opening tasks. */
export function useTaskActions() {
  const api = useApi();
  const { client } = useKlaud();
  const actions = useActions();
  return useMemo(() => {
    const act = async <T,>(run: () => Promise<T>, done?: string): Promise<T | undefined> => {
      try {
        const result = await run();
        if (done) toast(client, done, 'success');
        return result;
      } catch (err) {
        toast(client, message(err), 'error');
        return undefined;
      }
    };
    return {
      api: api.board,
      act,
      open: (issue: Pick<Issue, 'id'>): void => actions.run({ type: 'view', view: { kind: 'task', id: issue.id } }),
      openList: (): void => actions.run({ type: 'view', view: { kind: 'tasks' } }),
      openWorktree: (workspaceId: string): void => actions.run({ type: 'open_ws', id: workspaceId, tab: 'chat' }),
    };
  }, [api, client, actions]);
}
