import type { AppState } from '../../../../../src/core/store.js';
import { activityOf } from '../../../../../src/ui/workspace-models.js';
import { worktreeOrigin } from '../../../../../src/workspaces/origin.js';
import type { Project, Workspace } from '../../../../../src/workspaces/types.js';

/**
 * What a project's home shows (ProjectHome.tsx draws it): how its main folder compares with
 * origin, its worktrees, the questions asked in main, and what was put away. Pure, so it's
 * tested on its own (tests/mac-project-home.test.ts).
 */

export type Tone = 'ok' | 'warn' | 'info' | 'muted';

export interface MainLine {
  /** "Up to date with origin/main", "3 behind origin/main"… */
  readonly label: string;
  readonly tone: Tone;
  /** "4 uncommitted changes in main" (they were made outside klaud). */
  readonly dirty?: string;
}

export interface HomeModel {
  readonly project: Project;
  /** The main checkout (its branch and status). */
  readonly main?: Workspace;
  readonly mainLine: MainLine;
  /** Worktrees klaud made, still around: the most recently active first. */
  readonly worktrees: readonly Workspace[];
  /** Questions asked in the main folder (ask-only chats), the most recent first. */
  readonly asks: readonly Workspace[];
  /** Archived worktrees and chats, the newest first. */
  readonly archived: readonly Workspace[];
  readonly stats: { readonly active: number; readonly ready: number; readonly archived: number };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How the main checkout compares with the branch it tracks (as of the last fetch). */
export function mainLineOf(main: Workspace | undefined): MainLine {
  const st = main?.status;
  const dirty = st?.changed ? `${plural(st.changed, 'uncommitted change')} in main` : undefined;
  const extra = dirty ? { dirty } : {};
  const up = st?.upstream;
  if (!st) return { label: 'Main folder', tone: 'muted', ...extra };
  if (!up) return { label: 'Not tracking a remote branch', tone: 'muted', ...extra };
  if (!up.ahead && !up.behind) return { label: `Up to date with ${up.name}`, tone: 'ok', ...extra };
  const label = up.ahead && up.behind ? `${up.ahead} ahead, ${up.behind} behind ${up.name}` : up.ahead ? `${up.ahead} ahead of ${up.name}` : `${up.behind} behind ${up.name}`;
  // Commits on main that aren't on origin are unusual here (work happens in worktrees): worth a look.
  return { label, tone: up.ahead ? 'warn' : 'info', ...extra };
}

/** When something last happened in a workspace: its last message, else when it was made. */
export const lastActive = (state: Pick<AppState, 'log'>, ws: Workspace): number => activityOf(state.log, `ws:${ws.id}`).lastTs ?? ws.createdAt;

/** Committed work not in its base yet, nothing uncommitted, no conflict, Claude not working. */
export function isReady(state: Pick<AppState, 'log' | 'conflicts'>, ws: Workspace): boolean {
  return ws.kind === 'worktree' && !ws.archived && !state.conflicts[ws.id]?.length && !activityOf(state.log, `ws:${ws.id}`).running && !ws.status?.changed && (ws.status?.ahead ?? 0) > 0;
}

export function homeModel(state: Pick<AppState, 'log' | 'conflicts'>, project: Project): HomeModel {
  const recent = (a: Workspace, b: Workspace): number => lastActive(state, b) - lastActive(state, a);
  const live = project.workspaces.filter((w) => !w.archived);
  const main = project.workspaces.find((w) => w.kind === 'main');
  const worktrees = live.filter((w) => w.kind === 'worktree' && worktreeOrigin(w) === 'klaud').sort(recent);
  // The main checkout's own conversation (from before) counts as a question asked there.
  const asks = live.filter((w) => w.askOnly && (w.kind === 'chat' || (w.kind === 'main' && Boolean(w.sessionId)))).sort(recent);
  const archived = project.workspaces.filter((w) => w.archived).sort((a, b) => b.createdAt - a.createdAt);
  return {
    project,
    ...(main ? { main } : {}),
    mainLine: mainLineOf(main),
    worktrees,
    asks,
    archived,
    stats: { active: worktrees.length, ready: worktrees.filter((w) => isReady(state, w)).length, archived: archived.length },
  };
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function agoText(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
