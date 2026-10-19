import type { AppState } from '../../../../src/core/store.js';
import { activityOf } from '../../../../src/ui/workspace-models.js';
import type { Project, Workspace } from '../../../../src/workspaces/types.js';

/**
 * Worktrees made outside Klaud, as the sidebar lists them: after Klaud's own, most recently
 * active first, each with where it is. Never grouped or labelled by the tool that made them.
 * Pure, so it's tested on its own (tests/mac-outside-worktrees.test.ts).
 */

/** More than this many and the list shows only the most recent few, then "Show N more". */
export const OUTSIDE_MANY = 6;
/** How many show while the rest are tucked away. */
export const OUTSIDE_SHOWN = 5;

/** A worktree made outside Klaud that Klaud hasn't talked in yet. */
export const isOutside = (w: Workspace): boolean => w.kind === 'worktree' && w.external && !w.archived;

export const outsideOf = (p: Project): Workspace[] => p.workspaces.filter(isOutside);

/** "~/code/klaude/madrid" for a path under your home folder. */
export const tildePath = (home: string, p: string): string => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

export interface OutsideLocation {
  /** The folder it's in (its parent), shortened to its tail: shown quietly after its name. */
  readonly folder: string;
  /** Its whole path, shortened: in the tooltip. */
  readonly path: string;
}

/** A long folder by its last two parts ("…/workspaces/klaude"): the part that tells worktrees apart. */
export function folderTail(folder: string): string {
  const parts = folder.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : folder;
}

/** Where a worktree made outside Klaud is (undefined for Klaud's own and for chats). */
export function outsideLocation(state: Pick<AppState, 'home'>, ws: Workspace): OutsideLocation | undefined {
  if (!isOutside(ws)) return undefined;
  const path = tildePath(state.home, ws.path);
  const cut = path.lastIndexOf('/');
  return { folder: folderTail(cut > 0 ? path.slice(0, cut) : path), path };
}

/** When something last happened in it: Klaud's conversation there, Claude's usage, or git (from `activity`). */
export function outsideActivity(state: Pick<AppState, 'log'>, ws: Workspace, activity: Readonly<Record<string, number>>): number {
  return Math.max(activityOf(state.log, `ws:${ws.id}`).lastTs ?? 0, ws.usage?.lastAt ?? 0, ws.createdAt ?? 0, activity[ws.id] ?? 0);
}

/** Most recently active first; ties (nothing known yet) by name. */
export function orderOutside(list: readonly Workspace[], activeAt: (w: Workspace) => number): Workspace[] {
  return [...list].sort((a, b) => activeAt(b) - activeAt(a) || a.name.localeCompare(b.name));
}

export interface OutsideRows {
  readonly shown: readonly Workspace[];
  /** Tucked away behind "Show N more" (empty when everything shows). */
  readonly hidden: readonly Workspace[];
}

/**
 * Which rows show: all of them when there are few or you expanded the list; otherwise the most
 * recent few, plus the one you're in if it's further down (so the selection never disappears).
 */
export function visibleOutside(ordered: readonly Workspace[], expanded: boolean, hereId?: string): OutsideRows {
  if (expanded || ordered.length <= OUTSIDE_MANY) return { shown: ordered, hidden: [] };
  const top = ordered.slice(0, OUTSIDE_SHOWN);
  const rest = ordered.slice(OUTSIDE_SHOWN);
  const here = rest.find((w) => w.id === hereId);
  return { shown: here ? [...top, here] : top, hidden: rest.filter((w) => w !== here) };
}
