import { useEffect } from 'react';
import { inApp } from './boot.js';
import type { Actions } from './actions.js';
import type { UiStore } from './klaud.js';
import type { SocketClient } from '@klaud/ipc/socket-client.js';
import { setPrefs, getPrefs, zoom } from './prefs.js';

const GO: Record<string, 'room' | 'files' | 'overview' | 'search' | 'usage' | 'terminal'> = {
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
  switch (id) {
    case 'settings':
      return ui.patch({ settings: 'general' });
    case 'palette':
      return ui.patch({ palette: true });
    case 'help-keys':
      return ui.patch({ palette: true });
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
      return ui.openMenu({ kind: 'inbox' });
    case 'toggle-sidebar':
      return setPrefs({ sidebar: !getPrefs().sidebar });
    case 'toggle-dock':
      return setPrefs({ dock: getPrefs().dock === 'off' ? 'right' : 'off' });
    case 'toggle-inspector':
      return setPrefs({ inspector: !getPrefs().inspector });
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

/** A klaud:// link: "klaud://join/<invite>" joins a friend's room. */
export function inviteOf(url: string): string | undefined {
  const m = /^klaud:\/\/join\/(.+)$/.exec(url);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

/** Listen to the menu bar and to klaud:// links (only in the app). */
export function useNative(client: SocketClient, ui: UiStore, actions: Actions, onInvite: (invite: string) => void): void {
  useEffect(() => {
    if (!inApp()) return;
    let off: Array<() => void> = [];
    let alive = true;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const a = await listen<string>('menu', (e) => runMenuItem(e.payload, client, ui, actions));
      const b = await listen<string>('deep-link', (e) => {
        const invite = inviteOf(e.payload);
        if (invite) onInvite(invite);
      });
      if (alive) off = [a, b];
      else [a, b].forEach((f) => f());
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

/** Keep the menu-bar icon's count of what waits for you (approvals, questions) up to date. */
export function useTrayStatus(client: SocketClient): void {
  useEffect(() => {
    if (!inApp()) return;
    let last = '';
    const update = (): void => {
      const st = client.store.getState();
      const waiting = st.approvals.length + st.questions.length + st.knocks.length;
      const working = new Set(st.log.filter((l) => l.type === 'agent' && l.owner === st.selfId && ['started', 'text', 'tool', 'sub'].includes(l.status)).map((l) => l.channel)).size;
      const key = `${waiting}:${working}`;
      if (key === last) return;
      last = key;
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_tray_status', { waiting, working })).catch(() => undefined);
    };
    update();
    return client.store.subscribe(update);
  }, [client]);
}
