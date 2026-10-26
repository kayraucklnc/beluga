import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { BoardState, Issue } from '@beluga/core/board/model.js';
import type { AppState, View } from '@beluga/core/store.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { useActions } from '../lib/actions.js';
import { type Person, type TasksPrefs, fromV1TasksPrefs, isSolo, readTasksPrefs } from './tasks-model.js';

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

/** How many other people you work with: in this room (not guests) and your friends. */
export function useOthers(): number {
  const selfId = useApp((s) => s.selfId);
  const peers = useApp((s) => s.peers.filter((p) => p.peerId !== selfId && !p.guest).length);
  const friends = useApp((s) => s.network.friends.length);
  return peers + friends;
}

/** Whether you're alone on this project (then who a task is for isn't shown: see isSolo). */
export function useSolo(projectId: string | undefined): boolean {
  const board = useBoard();
  const selfId = useSelfId();
  const others = useOthers();
  return isSolo(board, projectId, selfId, others);
}

/** The project a view is about, if it's about one (a worktree, a project's home, a task, its board, a plan). */
export function projectOfView(state: AppState): string | undefined {
  const view = state.view;
  const id =
    view.kind === 'workspace'
      ? findWorkspace(state.projects, view.id)?.projectId
      : view.kind === 'project' || view.kind === 'draft' || view.kind === 'draft_worktree'
        ? view.kind === 'project'
          ? view.id
          : view.projectId
        : view.kind === 'task'
          ? state.board.issues.find((i) => i.id === view.id)?.projectId
          : view.kind === 'tasks' || view.kind === 'plans' || view.kind === 'issues' || view.kind === 'gh_issue'
            ? view.projectId
            : view.kind === 'plan'
              ? state.plans.plans.find((p) => p.id === view.id)?.projectId
              : undefined;
  // Only real projects (chats not tied to one don't have tasks).
  return id && state.projects.some((p) => p.id === id && p.root) ? id : undefined;
}

/** Remember the project you're in, so Tasks opens on it, and where you came to a task from (call once, near the top of the window). */
export function useRememberProject(): void {
  const project = useApp(projectOfView);
  useEffect(() => {
    if (project && project !== prefs.project) setTasksPrefs({ project });
  }, [project]);
  useRememberWayBack();
}

// ---- the way back out of a task (BLG-5)

/** Where you were before the task you're on (a sub-task or a linked task opened from it doesn't count). */
let cameFrom: View | undefined;

/** Places a task's Back returns to; anything else (a dialog-like view, a draft) goes to the Tasks list. */
const RETURNABLE: ReadonlySet<View['kind']> = new Set(['tasks', 'plans', 'plan', 'workspace', 'overview', 'project', 'requests', 'issues', 'gh_issue']);

/** Where you were before the GitHub issue you're on (Issues, a project's home, a task, a conversation). */
let issueCameFrom: View | undefined;

function useRememberWayBack(): void {
  const view = useApp((s) => s.view);
  const last = useRef(view);
  useEffect(() => {
    const prev = last.current;
    last.current = view;
    // Between an issue and its task, back and forth, each keeps the way it came: Back never bounces between the two.
    if (view.kind === 'task' && prev.kind !== 'task' && !(prev.kind === 'gh_issue' && sameView(issueCameFrom, view))) cameFrom = RETURNABLE.has(prev.kind) ? prev : undefined;
    if (view.kind === 'gh_issue' && prev.kind !== 'gh_issue' && !(prev.kind === 'task' && sameView(cameFrom, view))) issueCameFrom = RETURNABLE.has(prev.kind) || prev.kind === 'task' ? prev : undefined;
  }, [view]);
}

/** The same place: a task by its id, an issue by its project and number. */
function sameView(a: View | undefined, b: View): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'task' && b.kind === 'task') return a.id === b.id;
  if (a.kind === 'gh_issue' && b.kind === 'gh_issue') return a.projectId === b.projectId && a.number === b.number;
  return false;
}

/** Where Back on a task goes: where you came from, else its project's Tasks. */
export const wayBack = (projectId: string): View => cameFrom ?? { kind: 'tasks', projectId };

/** Where Back on a GitHub issue goes: where you came from, else its project's Issues. */
export const issueWayBack = (projectId: string): View => issueCameFrom ?? { kind: 'issues', projectId };

// ---- the view's prefs, per window

const KEY = 'beluga.tasks.v2';
const saved = (): string | null => {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(KEY) ?? fromV1TasksPrefs(localStorage.getItem('beluga.tasks.v1'));
  } catch {
    return null;
  }
};
let prefs = readTasksPrefs(saved());
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
  const { client } = useBeluga();
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
      openList: (projectId?: string): void => actions.run({ type: 'view', view: { kind: 'tasks', ...(projectId ? { projectId } : {}) } }),
      /** The board with only the tasks a worktree does or carries (none: every task). */
      openWorktreeTasks: (projectId: string, worktree?: string): void => actions.run({ type: 'view', view: { kind: 'tasks', projectId, ...(worktree ? { worktree } : {}) } }),
      openWorktree: (workspaceId: string): void => actions.run({ type: 'open_ws', id: workspaceId, tab: 'chat' }),
      /** Out of a task: back where you came from (its project's Tasks when that's unknown). */
      back: (projectId: string): void => actions.run({ type: 'view', view: wayBack(projectId) }),
    };
  }, [api, client, actions]);
}
