import { useEffect } from 'react';
import { inApp } from './boot.js';
import type { Actions } from './actions.js';
import type { UiStore } from './klaud.js';
import type { SocketClient } from '@klaud/ipc/socket-client.js';
import { setPrefs, getPrefs, zoom } from './prefs.js';
import { byMenu, showPanelTab, togglePanel, toggleTerminal } from './panel.js';
import { PANEL_LABELS, PANEL_TABS, type PanelTab } from './panel-model.js';
import { dockCount, workingCount } from '../layout/attention-model.js';
import { NOTIFICATION_TAP, macNoticeTarget, openNoticeTarget } from './notices.js';
import { COMMAND_IDS, type CommandId, commandState, runCommand } from './commands.js';
import { openNetworkLink, runNetworkMenuItem } from '../network/net-native.js';
import { runRequestMenuItem } from '../gateway/request-native.js';
import { SHOW_WELCOME } from '../onboarding/onboarding-model.js';
import { pastePlain } from '../chat/paste-paths.js';
import type { PlaceKind } from './go.js';
import { throttle } from './throttle.js';
import { windowActive } from './window-active.js';

const isCommand = (id: string): id is CommandId => (COMMAND_IDS as readonly string[]).includes(id);

const GO: Record<string, PlaceKind> = {
  'go-tasks': 'tasks',
  'go-room': 'room',
  'go-files': 'files',
  'go-overview': 'overview',
  'go-search': 'search',
  'go-usage': 'usage',
  'go-terminal': 'terminal',
  find: 'search',
};

/** What a menu bar item does (the same as its button or command in the window). */
export function runMenuItem(id: string, client: SocketClient, ui: UiStore, actions: Actions): void {
  const state = client.store.getState();
  const project = state.view.kind === 'workspace' ? state.projects.find((p) => p.workspaces.some((w) => w.id === (state.view as { id: string }).id)) : state.projects.find((p) => p.root);
  if (GO[id]) return actions.run({ type: 'view', view: { kind: GO[id]! } });
  // Friends, groups and your status (Add a Friend…, the menu bar's status items).
  if (runNetworkMenuItem(id, client)) return;
  // A friend's request in the menu-bar menu: Approve / Always / Decline / Review….
  if (runRequestMenuItem(id, client)) return;
  if (isCommand(id)) return runCommand({ client, ui, actions }, id);
  switch (id) {
    case 'settings':
      return ui.patch({ settings: 'general' });
    case 'palette':
      return ui.patch({ palette: true });
    case 'paste-plain':
      return void pastePlain();
    case 'help-keys':
      return ui.patch({ palette: true });
    case 'help-welcome':
    case 'onboarding':
      return void document.dispatchEvent(new CustomEvent(SHOW_WELCOME));
    case 'new-chat':
      return actions.run({ type: 'new_chat', projectId: 'chats' });
    case 'new-worktree':
      if (project?.root) actions.run({ type: 'new_worktree', projectId: project.id });
      else client.store.dispatch({ type: 'toast', text: 'Add a project first (File › Add Project…)', level: 'warn' });
      return;
    case 'add-project':
      return actions.run({ type: 'add_project' });
    case 'share-folder':
      return ui.openMenu({ kind: 'share_folder', launchDir: state.home, mine: state.myShares });
    case 'invite':
      return void document.dispatchEvent(new CustomEvent('klaud:invite'));
    case 'inbox':
      return ui.patch({ notices: true });
    case 'toggle-sidebar':
      return setPrefs({ sidebar: !getPrefs().sidebar });
    case 'toggle-dock':
      // ⌘J: the terminal, where you keep it (the drawer under the chat or the right panel).
      return byMenu('terminal', () => {
        const why = toggleTerminal(state);
        if (why) client.store.dispatch({ type: 'toast', text: why, level: 'info' });
      });
    case 'toggle-inspector':
      return byMenu('panel', () => togglePanel(state.view));
    case 'panel-changes':
    case 'panel-files':
    case 'panel-terminal':
    case 'panel-info':
    case 'panel-history':
    case 'panel-scratch':
    case 'panel-background': {
      const tab = id.slice('panel-'.length) as PanelTab;
      if (!PANEL_TABS.includes(tab)) return;
      return byMenu(`panel-${tab}`, () => {
        if (!showPanelTab(state, tab)) client.store.dispatch({ type: 'toast', text: `No ${PANEL_LABELS[tab]} here`, level: 'info' });
      });
    }
    case 'appearance-system':
    case 'appearance-light':
    case 'appearance-dark':
      return setPrefs({ appearance: id.slice('appearance-'.length) as 'system' | 'light' | 'dark' });
    case 'zoom-in':
    case 'zoom-out':
    case 'zoom-reset':
      zoom(id.slice('zoom-'.length) as 'in' | 'out' | 'reset');
      return;
    case 'help-log':
      return void client.api.local.openFolder(`${state.home}/.klaud/logs`);
  }
}

/**
 * A klaud:// link that joins a friend's room: "klaud://join/<invite>", or an invite itself
 * ("klaud://<host key>…#secret", what Invite copies), so clicking the link a friend sent works.
 */
export function inviteOf(url: string): string | undefined {
  const m = /^klaud:\/\/join\/(.+)$/.exec(url);
  if (m) return decodeURIComponent(m[1]!);
  return /^klaud:\/\/[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\/?(\?relay=[^\s#]+)?#[\w-]{16,256}$/.test(url) ? url : undefined;
}

/** Listen to the menu bar and to klaud:// links (only in the app). */
export function useNative(client: SocketClient, ui: UiStore, actions: Actions, onInvite: (invite: string) => void): void {
  useEffect(() => {
    if (!inApp()) return;
    let off: Array<() => void> = [];
    let alive = true;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const a = await listen<string>('menu', (e) => runMenuItem(e.payload, client, ui, actions));
      // The same link can come both ways (live and from the launch buffer): handle it once.
      const handled = new Set<string>();
      const open = (url: string): void => {
        if (handled.has(url)) return;
        // klaud://add… and klaud://join#…: a friend's or a group's invitation (the klaud network).
        if (openNetworkLink(url)) return void handled.add(url);
        const invite = inviteOf(url);
        if (!invite) return;
        handled.add(url);
        onInvite(invite);
      };
      const b = await listen<string>('deep-link', (e) => open(e.payload));
      if (alive) off = [a, b];
      else [a, b].forEach((f) => f());
      // A link that launched the app arrived before anyone was listening.
      const { invoke } = await import('@tauri-apps/api/core');
      if (alive) for (const url of await invoke<string[]>('take_pending_links')) open(url);
    });
    return () => {
      alive = false;
      off.forEach((f) => f());
    };
  }, [client]);
}

/** Leave this room and join a friend's (the daemon starts again in their room). */
export async function joinRoom(invite: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('restart_daemon', { args: ['join', invite] });
}

/**
 * Keep the Dock icon's badge and the menu-bar icon in step with what's new for you: the
 * sidebar's Unread conversations (one each), plus other unread notifications and anything
 * still waiting on you (see dockCount).
 *
 * The store changes many times a second while Claudes stream, and counting is a walk over every
 * conversation: at most once a second in front, once every 5 s behind other windows (KLD-48),
 * nothing counted when the state hasn't changed, and nothing sent when the counts haven't.
 */
export const TRAY_GAP_MS = 1000;
export const TRAY_GAP_AWAY_MS = 5000;

export function useTrayStatus(client: SocketClient): void {
  useEffect(() => {
    if (!inApp()) return;
    let last = '';
    let seen: unknown;
    const update = (): void => {
      const st = client.store.getState();
      if (st === seen) return;
      seen = st;
      const waiting = st.approvals.length + st.questions.length + st.knocks.length;
      const working = workingCount(st);
      const unread = dockCount(st);
      const key = `${waiting}:${working}:${unread}`;
      if (key === last) return;
      last = key;
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_tray_status', { waiting, working, unread })).catch(() => undefined);
    };
    const tick = throttle(update, () => (windowActive() ? TRAY_GAP_MS : TRAY_GAP_AWAY_MS));
    tick.request();
    const off = client.store.subscribe(tick.request);
    return () => {
      off();
      tick.stop();
    };
  }, [client]);
}

/**
 * Tell klaud whether this window is in front: what it shows isn't announced while it is, and
 * "Only when klaud isn't in front" waits until it isn't. Coming to the front refreshes PRs.
 */
export function useWindowFocus(client: SocketClient): void {
  useEffect(() => {
    let wasFocused = false;
    const set = (focused: boolean): void => {
      client.store.dispatch({ type: 'away', away: !focused });
      // Coming back to the window: PRs merged or checks finished while you were away show at once.
      if (focused && !wasFocused) void client.api.workbench.refreshPrs({ reason: 'focus' }).catch(() => undefined);
      wasFocused = focused;
    };
    if (inApp()) {
      let alive = true;
      let off: (() => void) | undefined;
      void import('@tauri-apps/api/window')
        .then(async ({ getCurrentWindow }) => {
          const w = getCurrentWindow();
          const un = await w.onFocusChanged(({ payload }) => set(payload));
          if (!alive) return un();
          off = un;
          set(await w.isFocused());
        })
        .catch(() => undefined);
      return () => {
        alive = false;
        off?.();
      };
    }
    const update = (): void => set(document.visibilityState === 'visible' && document.hasFocus());
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [client]);
}

/**
 * Clicking a desktop notification brings the window forward (the app shell does that) and goes
 * where it's about; one about several places opens the notification centre instead.
 */
export function useNotificationTaps(client: SocketClient, ui: UiStore, actions: Actions): void {
  useEffect(() => {
    const go = (channel: string | undefined): void => {
      const target = macNoticeTarget(client.store.getState(), channel);
      if (!target || channel === undefined) return ui.patch({ notices: true });
      void client.api.inbox.read({ channel });
      openNoticeTarget(actions, target, (id) => client.store.dispatch({ type: 'view', view: { kind: 'conversation', id } }));
    };
    const onTap = (e: Event): void => go((e as CustomEvent<{ channel?: string } | undefined>).detail?.channel);
    document.addEventListener(NOTIFICATION_TAP, onTap);
    let alive = true;
    let off: (() => void) | undefined;
    if (inApp()) {
      void import('@tauri-apps/api/event')
        .then(async ({ listen }) => {
          const un = await listen<string | null>('notification-tap', (e) => go(e.payload ?? undefined));
          if (alive) off = un;
          else un();
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
      off?.();
      document.removeEventListener(NOTIFICATION_TAP, onTap);
    };
  }, [client]);
}

/**
 * Keep the menu bar's Workspace and Conversation menus in step with the window: items that
 * can't run right now are greyed out (Merge with nothing to merge, Stop while Claude is idle),
 * Plan First shows its check, and Run reads Stop Running while the run script runs.
 */
export function useMenuState(client: SocketClient): void {
  useEffect(() => {
    if (!inApp()) return;
    let last = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (): void => {
      timer = undefined;
      const state = client.store.getState();
      const enabled: Record<string, boolean> = {};
      const checked: Record<string, boolean> = {};
      const labels: Record<string, string> = {};
      for (const id of COMMAND_IDS) {
        const st = commandState(state, id);
        enabled[id] = st.enabled;
        if (st.checked !== undefined) checked[id] = st.checked;
        if (st.label) labels[id] = st.label;
      }
      const key = JSON.stringify([enabled, checked, labels]);
      if (key === last) return;
      last = key;
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_menu_state', { enabled, checked, labels })).catch(() => undefined);
    };
    // The store changes many times a second while Claude streams; the menu needn't.
    const update = (): void => {
      timer ??= setTimeout(send, 150);
    };
    send();
    const off = client.store.subscribe(update);
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [client]);
}
