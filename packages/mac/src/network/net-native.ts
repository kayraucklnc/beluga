import { useEffect } from 'react';
import type { PresenceState } from '@klaud/net/mesh/views.js';
import type { SocketClient } from '@klaud/ipc/socket-client.js';
import { inApp } from '../lib/boot.js';
import { IDLE_AWAY_MS, findInvitation, idleStep, presenceFor, selfLine } from './net-model.js';
import { openNet } from './net-sheets.js';

/**
 * Friends and groups in the app shell: the File menu's Add a Friend… / New Group…, your status
 * in the menu-bar menu, klaud://add and klaud://join links, and Away when you're idle.
 */

const STATUS: Record<string, PresenceState> = { 'status-online': 'online', 'status-away': 'away', 'status-dnd': 'dnd', 'status-offline': 'offline' };

/** A menu item about friends or your status; false if it's someone else's. */
export function runNetworkMenuItem(id: string, client: SocketClient): boolean {
  const net = client.store.getState().network;
  const off = (): true => {
    client.store.dispatch({ type: 'toast', text: 'Turn on talking with friends first (Settings › People & access)', level: 'info' });
    return true;
  };
  if (id === 'add-friend') return net.enabled ? (openNet({ kind: 'add_friend' }), true) : off();
  if (id === 'new-group') return net.enabled ? (openNet({ kind: 'new_group' }), true) : off();
  if (id === 'status-set') return net.enabled ? (openNet({ kind: 'status' }), true) : off();
  const note = net.self?.presence.note;
  const set = (state: PresenceState, duration?: 'hour' | 'tomorrow'): true => {
    void client.api.network['presence.set'](presenceFor(state, { ...(note ? { note } : {}), ...(duration ? { duration } : {}) }));
    return true;
  };
  if (STATUS[id]) return set(STATUS[id]!);
  if (id === 'status-dnd-hour') return set('dnd', 'hour');
  if (id === 'status-dnd-tomorrow') return set('dnd', 'tomorrow');
  return false;
}

/** A klaud:// link that adds a friend or joins a group: open the sheet ready to accept it. True if it was one. */
export function openNetworkLink(url: string): boolean {
  const found = findInvitation(url);
  if (!found || !/^(?:beluga|klaud):\/\/(add|join)\/?[#?]/.test(url)) return false;
  openNet(found.group ? { kind: 'join_group', accept: found.text } : { kind: 'add_friend', accept: found.text });
  return true;
}

/** Keep the menu-bar menu's status items in step (gone while the network is off). */
export function useTrayPresence(client: SocketClient): void {
  useEffect(() => {
    if (!inApp()) return;
    let last = '';
    const update = (): void => {
      const self = client.store.getState().network.self;
      const presence = self ? { state: self.presence.state, line: selfLine(self.presence) } : null;
      const key = JSON.stringify(presence);
      if (key === last) return;
      last = key;
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_tray_presence', { presence })).catch(() => undefined);
    };
    update();
    return client.store.subscribe(update);
  }, [client]);
}

const CHECK_MS = 30_000;
const ACTIVITY = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;

/** How long since you last used the Mac (the system's idle time in the app; this window's input in a browser). */
async function idleMs(lastInput: number): Promise<number> {
  if (inApp()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const secs = await invoke<number | null>('system_idle_seconds');
      if (typeof secs === 'number') return secs * 1000;
    } catch {
      // Fall back to this window's input.
    }
  }
  return Date.now() - lastInput;
}

/**
 * Away when you haven't used the Mac for a while (only if you chose Online), back to Online
 * when you return (only if it was this that made you Away).
 */
export function useIdleAway(client: SocketClient, threshold = IDLE_AWAY_MS): void {
  useEffect(() => {
    let lastInput = Date.now();
    let autoAway = false;
    let checking = false;
    const check = async (): Promise<void> => {
      const self = client.store.getState().network.self;
      if (!self || checking) return;
      // You changed it yourself since: it's yours again.
      if (autoAway && self.presence.state !== 'away') autoAway = false;
      checking = true;
      try {
        const step = idleStep({ presence: self.presence, idleMs: await idleMs(lastInput), autoAway, threshold });
        if (!step) return;
        autoAway = step === 'away';
        const note = self.presence.note;
        await client.api.network['presence.set']({ state: step, ...(note ? { note } : {}) });
      } catch {
        autoAway = false;
      } finally {
        checking = false;
      }
    };
    let pending: ReturnType<typeof setTimeout> | undefined;
    const active = (): void => {
      lastInput = Date.now();
      // Coming back: say so soon, not at the next check.
      if (autoAway && !pending) pending = setTimeout(() => ((pending = undefined), void check()), 300);
    };
    for (const e of ACTIVITY) window.addEventListener(e, active, { passive: true });
    const timer = setInterval(() => void check(), CHECK_MS);
    return () => {
      for (const e of ACTIVITY) window.removeEventListener(e, active);
      clearInterval(timer);
      if (pending) clearTimeout(pending);
    };
  }, [client, threshold]);
}
