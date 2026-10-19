import { useEffect, useSyncExternalStore } from 'react';
import type { AppState, View } from '@klaud/core/store.js';

/** What the panel needs to know about the window: what's on screen and the projects. */
export type PanelState = Pick<AppState, 'view' | 'projects'>;
import { findWorkspace } from '@klaud/ui/workspace-models.js';
import type { Workspace } from '@klaud/workspaces/types.js';
import type { SocketClient } from '@klaud/ipc/socket-client.js';
import { type PanelTab, drawerFits, panelKey, panelTabsFor, pickPanelTab, rememberTab } from './panel-model.js';
import { type UiPrefs, getPrefs, setPrefs } from './prefs.js';

/**
 * The right panel and the terminal drawer, as the window uses them: which tab shows, showing a
 * tab from anywhere (Run shows the terminal, a file link shows Files), ⌘J, and the focus view
 * (a diff or a file across the whole center for a while, Esc goes back to the chat).
 */

export type FocusKind = 'diff' | 'file' | 'terminal';

interface Runtime {
  /** The center shows this instead of the chat (for this workspace only). */
  readonly focus?: { readonly kind: FocusKind; readonly wsId: string };
  /** When the keyboard was last asked to go to the terminal (⌘J): the terminal that shows takes it. */
  readonly termFocus: number;
  /** The tab the panel showed before ⌘J switched it to Terminal (⌘J again goes back), and where. */
  readonly before?: { readonly key: string; readonly tab: PanelTab; readonly closed: boolean };
  /**
   * The panel was open when a file or a diff took the center: it steps aside for the focus view
   * and comes back with Esc. Showing or hiding it yourself meanwhile forgets this (your choice stays).
   */
  readonly panelBack?: boolean;
}

let runtime: Runtime = { termFocus: 0 };
const listeners = new Set<() => void>();
const patch = (next: Partial<Runtime>): void => {
  runtime = { ...runtime, ...next };
  for (const l of [...listeners]) l();
};

export function usePanelRuntime<T>(pick: (r: Runtime) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => pick(runtime),
  );
}

const workspaceOf = (state: PanelState): Workspace | undefined => (state.view.kind === 'workspace' ? findWorkspace(state.projects, state.view.id) : undefined);

/** Uncommitted files or commits ahead of its base. */
export const hasChanges = (ws: Workspace | undefined): boolean => (ws?.status?.changed ?? 0) + (ws?.status?.ahead ?? 0) > 0;

export const tabsOf = (state: PanelState): PanelTab[] => panelTabsFor(state.view, workspaceOf(state)?.kind);

/** The tab showing (or that would show, when the panel is hidden) for what's on screen. */
export function currentTab(state: PanelState, prefs: UiPrefs = getPrefs()): PanelTab {
  return pickPanelTab(tabsOf(state), prefs.panelTabs[panelKey(state.view)], hasChanges(workspaceOf(state)));
}

/** Pick a tab (remembered for this workspace). */
export function setPanelTab(view: View, tab: PanelTab): void {
  patch({ before: undefined });
  setPrefs({ panelTabs: rememberTab(getPrefs().panelTabs, panelKey(view), tab) });
}

/** You showed or hid the panel yourself: during a focus view, that's what stays after it. */
const panelChosen = (): void => {
  if (runtime.focus && runtime.panelBack !== undefined) patch({ panelBack: undefined });
};

/** Show the panel on this tab. False when the view has no such tab. */
export function showPanelTab(state: PanelState, tab: PanelTab): boolean {
  if (!tabsOf(state).includes(tab)) return false;
  panelChosen();
  patch({ before: undefined });
  setPrefs({ inspector: true, panelTabs: rememberTab(getPrefs().panelTabs, panelKey(state.view), tab) });
  return true;
}

export const togglePanel = (): void => {
  panelChosen();
  setPrefs({ inspector: !getPrefs().inspector });
};

/** The terminal is on screen: in the drawer, or as the panel's tab. */
export function terminalShowing(state: PanelState, prefs: UiPrefs = getPrefs()): boolean {
  return (prefs.drawer && drawerFits(state.view)) || (prefs.inspector && currentTab(state, prefs) === 'terminal');
}

/** Put the keyboard in the terminal that's showing. */
export const focusTerminal = (): void => patch({ termFocus: Date.now() });

/**
 * Show the terminal where you keep it (Settings › Terminal: the drawer or the panel). Run uses
 * it too, without taking the keyboard from the message box.
 */
export function revealTerminal(state: PanelState, focus: boolean): boolean {
  const prefs = getPrefs();
  const inDrawer = (prefs.termIn === 'drawer' || !tabsOf(state).includes('terminal')) && drawerFits(state.view);
  if (inDrawer) {
    if (!prefs.drawer) setPrefs({ drawer: true });
  } else if (tabsOf(state).includes('terminal')) {
    const tab = currentTab(state, prefs);
    if (!(prefs.inspector && tab === 'terminal')) {
      const before = { key: panelKey(state.view), tab, closed: !prefs.inspector };
      panelChosen();
      setPrefs({ inspector: true, panelTabs: rememberTab(prefs.panelTabs, panelKey(state.view), 'terminal') });
      patch({ before });
    }
  } else return false;
  if (focus) focusTerminal();
  return true;
}

/** Put the terminal away: close the drawer, or give the panel back what it showed before. */
export function hideTerminal(state: PanelState): void {
  const prefs = getPrefs();
  const key = panelKey(state.view);
  const inPanel = prefs.inspector && currentTab(state, prefs) === 'terminal';
  const inDrawer = prefs.drawer && drawerFits(state.view);
  if (!inPanel && !inDrawer) return;
  // The panel goes back to what it showed before ⌘J (here, not in another workspace).
  const before = runtime.before?.key === key ? runtime.before : undefined;
  const back = before && before.tab !== 'terminal' ? before.tab : (tabsOf(state).find((t) => t !== 'terminal') ?? 'info');
  patch({ before: undefined });
  setPrefs({
    ...(inDrawer ? { drawer: false } : {}),
    // Closing the drawer mustn't leave the terminal showing in the panel instead.
    ...(inPanel ? { inspector: before ? !before.closed : true, panelTabs: rememberTab(prefs.panelTabs, key, back) } : {}),
  });
}

/** ⌘J: show the terminal (and type in it), or put it away. Returns why not, when it can't. */
export function toggleTerminal(state: PanelState): string | undefined {
  if (terminalShowing(state)) {
    hideTerminal(state);
    return undefined;
  }
  if (state.view.kind === 'shared') return 'A shared workspace’s terminal is its owner’s';
  if (state.view.kind === 'terminal') return undefined;
  return revealTerminal(state, true) ? undefined : 'No terminal here';
}

/** Move the terminal to the other place (and keep it there for ⌘J). */
export function moveTerminal(state: PanelState, to: 'drawer' | 'panel'): void {
  if (to === 'drawer') {
    const prefs = getPrefs();
    const panelHadIt = prefs.inspector && currentTab(state, prefs) === 'terminal';
    if (panelHadIt) hideTerminal(state);
    setPrefs({ termIn: 'drawer', drawer: true });
  } else {
    setPrefs({ termIn: 'panel', drawer: false });
    revealTerminal(state, false);
  }
}

/**
 * A diff, a file or the terminal across the center. The panel steps aside meanwhile (it would
 * only show a smaller copy of the same thing) and comes back when you go back to the chat.
 */
export function openFocus(kind: FocusKind, wsId: string): void {
  const open = getPrefs().inspector;
  // Already focused (another file, the diff after the file): keep what the panel was before all of it.
  const panelBack = runtime.focus && runtime.panelBack !== undefined ? runtime.panelBack : open;
  patch({ focus: { kind, wsId }, panelBack });
  if (open) setPrefs({ inspector: false });
}

export function closeFocus(): void {
  if (!runtime.focus) return;
  const back = runtime.panelBack;
  patch({ focus: undefined, panelBack: undefined });
  if (back && !getPrefs().inspector) setPrefs({ inspector: true });
}

export const focusFor = (wsId: string | undefined): FocusKind | undefined => (wsId && runtime.focus?.wsId === wsId ? runtime.focus.kind : undefined);

// A key press can reach both the window and the menu bar (its item has the same key), in either
// order: a toggle must run once. Whichever comes second within a moment is the echo.
const ran = new Map<string, { readonly by: 'key' | 'menu'; readonly at: number }>();
const ECHO_MS = 300;

function dedupe(by: 'key' | 'menu', id: string, run: () => void): void {
  const last = ran.get(id);
  const now = Date.now();
  if (last && last.by !== by && now - last.at < ECHO_MS) return;
  ran.set(id, { by, at: now });
  run();
}

export const byKey = (id: string, run: () => void): void => dedupe('key', id, run);
export const byMenu = (id: string, run: () => void): void => dedupe('menu', id, run);

/**
 * A workspace's Files, Diff and Terminal used to replace the chat. Whatever still asks for them
 * (Run, /review, a notification, "Open File" in a diff) now shows that tab in the panel (or the
 * terminal where you keep it), and the center stays on the conversation.
 */
export function useWorkspaceTabBridge(client: SocketClient): void {
  useEffect(() => {
    const check = (): void => {
      const state = client.store.getState();
      const view = state.view;
      if (view.kind !== 'workspace' || view.tab === 'chat') return;
      const chat: View = { ...view, tab: 'chat' };
      if (view.tab === 'review') showPanelTab({ ...state, view: chat }, 'changes');
      else if (view.tab === 'files') showPanelTab({ ...state, view: chat }, 'files');
      else revealTerminal({ ...state, view: chat }, false);
      client.store.dispatch({ type: 'view', view: chat });
    };
    check();
    return client.store.subscribe(check);
  }, [client]);
  // Somewhere else: the focus view was for the workspace you left.
  useEffect(
    () =>
      client.store.subscribe(() => {
        const view = client.store.getState().view;
        if (runtime.focus && (view.kind !== 'workspace' || view.id !== runtime.focus.wsId)) closeFocus();
      }),
    [client],
  );
}
