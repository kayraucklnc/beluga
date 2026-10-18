import type { View } from '../../../../src/core/store.js';

/**
 * The right panel, as plain data: which tabs a view has, which one it opens on, how wide it may
 * get, and how older window preferences carry over. No DOM here, so it's tested on its own.
 */

export type PanelTab = 'changes' | 'files' | 'terminal' | 'info';

/** Every tab in its fixed place: ⌥⌘1 is always Changes, ⌥⌘4 always Info. */
export const PANEL_TABS: readonly PanelTab[] = ['changes', 'files', 'terminal', 'info'];

export const PANEL_LABELS: Record<PanelTab, string> = { changes: 'Changes', files: 'Files', terminal: 'Terminal', info: 'Info' };

export const PANEL_MIN = 320;
export const PANEL_DEFAULT = 384;
/** The panel never takes more than this share of the window. */
export const PANEL_MAX_SHARE = 0.6;

export const SPLIT_MIN = 0.18;
export const SPLIT_MAX = 0.75;
export const SPLIT_DEFAULT = 0.4;

export const DRAWER_MIN = 0.18;
export const DRAWER_MAX = 0.75;
export const DRAWER_DEFAULT = 0.36;

/** How many workspaces' last tabs are remembered (the oldest are forgotten). */
export const REMEMBERED_TABS = 100;

export type TerminalPlace = 'drawer' | 'panel';

/** What kind of workspace (a chat has no git, so no Changes). */
type WsKind = 'chat' | 'main' | 'worktree' | string;

/** The panel's tabs for what's on screen, in their fixed order. */
export function panelTabsFor(view: View, wsKind?: WsKind): PanelTab[] {
  if (view.kind === 'workspace') return wsKind === 'chat' ? ['files', 'terminal', 'info'] : [...PANEL_TABS];
  // A shared workspace's shell is its owner's; the Terminal view is already all shells.
  if (view.kind === 'shared' || view.kind === 'terminal') return ['info'];
  return ['terminal', 'info'];
}

/** Where a view's last tab is remembered: per workspace, one for everything else. */
export const panelKey = (view: View): string => (view.kind === 'workspace' ? `ws:${view.id}` : 'app');

/** The tab to show: the one you last picked here, else Changes when there are changes, else Info. */
export function pickPanelTab(tabs: readonly PanelTab[], remembered: PanelTab | undefined, hasChanges: boolean): PanelTab {
  if (remembered && tabs.includes(remembered)) return remembered;
  if (hasChanges && tabs.includes('changes')) return 'changes';
  return tabs.includes('info') ? 'info' : (tabs[0] ?? 'info');
}

/** Remember a tab for a place, forgetting the oldest beyond REMEMBERED_TABS. */
export function rememberTab(map: Readonly<Record<string, PanelTab>>, key: string, tab: PanelTab): Record<string, PanelTab> {
  const rest = Object.entries(map).filter(([k]) => k !== key);
  return Object.fromEntries([...rest.slice(Math.max(0, rest.length - REMEMBERED_TABS + 1)), [key, tab]]);
}

/** The panel's width for a window this wide: at least PANEL_MIN, at most PANEL_MAX_SHARE of it. */
export function clampPanelWidth(width: number, windowWidth: number): number {
  const max = Math.max(PANEL_MIN, Math.floor(windowWidth * PANEL_MAX_SHARE));
  return Math.round(Math.min(max, Math.max(PANEL_MIN, width)));
}

export const clampShare = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

/** The bottom drawer works under any conversation or page, but not over the Terminal view or a friend's workspace. */
export const drawerFits = (view: View): boolean => view.kind !== 'terminal' && view.kind !== 'shared';

/** The ⌥⌘ digit for a tab (1–4). */
export const panelDigit = (tab: PanelTab): number => PANEL_TABS.indexOf(tab) + 1;

/**
 * Preferences saved by earlier versions, brought up to date. The terminal used to dock beside
 * the chat (`dock: 'right'`) or under it (`'bottom'`): beside becomes the right panel's Terminal
 * tab, under becomes the bottom drawer (kept open, at the same height).
 */
export function migratePrefs(raw: Record<string, unknown>): Record<string, unknown> {
  if (!('dock' in raw) && !('dockSize' in raw)) return raw;
  const { dock, dockSize, ...rest } = raw;
  const next: Record<string, unknown> = { ...rest };
  if (dock === 'right') next.termIn ??= 'panel';
  if (dock === 'bottom') {
    next.termIn ??= 'drawer';
    next.drawer ??= true;
  }
  if (typeof dockSize === 'number' && next.drawerSize === undefined) next.drawerSize = clampShare(dockSize, DRAWER_MIN, DRAWER_MAX);
  return next;
}
