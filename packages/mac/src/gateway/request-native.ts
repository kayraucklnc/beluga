import { useEffect, useSyncExternalStore } from 'react';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { inApp } from '../lib/boot.js';
import { dndActive } from '@beluga/shared/quiet.js';
import { popupPublisher } from './popup-bridge.js';
import { popupRequests } from './popup-model.js';
import { REQUEST_NOTIFICATION, type RequestAction, outsideStep, parseRequestMenuId, trayRequests } from './request-actions.js';

/**
 * Friends' requests outside the window: the floating pop-up (Allow / Allow Always / Decline,
 * with See more), the same in the menu-bar menu, and the request sheet they open (one at a
 * time). The app shell (src-tauri) shows the pop-up and menu items; this side answers them.
 */

export { REQUEST_NOTIFICATION, type RequestAction, notificationActions } from './request-actions.js';

// ------------------------------------------------------------------ the request sheet

let open: string | undefined;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of [...listeners]) l();
};

/** Open the request sheet on this received task. */
export function openRequest(taskId: string): void {
  open = taskId;
  emit();
}

export function closeRequest(): void {
  if (open === undefined) return;
  open = undefined;
  emit();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const useRequestSheet = (): string | undefined => useSyncExternalStore(subscribe, () => open);

// ------------------------------------------------------------------ answering

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Answer an approval from outside the window (a notification, the menu bar), or open its sheet. */
export async function runRequestAction(client: SocketClient, action: RequestAction, approval: string | undefined, task: string | undefined): Promise<void> {
  const approvals = client.store.getState().approvals;
  const known = approvals.find((a) => a.id === approval) ?? (task ? approvals.find((a) => a.task === task) : undefined);
  const say = (text: string, level: 'info' | 'success' | 'error' = 'info'): void => void client.store.dispatch({ type: 'toast', text, level });
  const step = outsideStep(action, known, task);
  if (step.kind === 'gone') return say('That request was already answered');
  if (step.kind === 'review') {
    if (step.task) openRequest(step.task);
    else client.store.dispatch({ type: 'view', view: { kind: 'requests' } });
    return;
  }
  try {
    if (step.kind === 'decide') await client.api.gateway.decide(step.task, step.decision);
    else await client.api.host.answerApproval(step.answer, step.id);
    const answer = step.kind === 'decide' ? step.decision.answer : step.answer;
    const always = step.kind === 'decide' && step.decision.expiry === 'never' ? 'Allowed; requests like it run without asking (Settings › People & access)' : 'Approved; requests like it run without asking for a week';
    say(answer === 'no' ? 'Declined' : answer === 'always' ? always : 'Approved', answer === 'no' ? 'info' : 'success');
  } catch (err) {
    say(`Couldn't answer it: ${message(err)}`, 'error');
  }
}

/** A menu-bar item for a request ("req-yes:<approval id>"…); false if it's someone else's. */
export function runRequestMenuItem(id: string, client: SocketClient): boolean {
  const item = parseRequestMenuId(id);
  if (!item) return false;
  void runRequestAction(client, item.action, item.approval, undefined);
  return true;
}

/** Do Not Disturb (Beluga's or your status), or appearing offline: friends' requests wait quietly. */
const quietNow = (st: ReturnType<SocketClient['store']['getState']>): boolean =>
  dndActive(st.prefs.notify) || Boolean(st.network.self && (st.network.self.appearOffline || st.network.self.presence.state === 'dnd'));

/** Keep the pop-up showing the friends' requests waiting for you (and hide it once they're answered). */
export function useRequestPopup(client: SocketClient): void {
  useEffect(() => {
    const popup = popupPublisher();
    let last = '';
    const update = (): void => {
      const st = client.store.getState();
      const requests = popupRequests(st.approvals, st.gateway.tasks, quietNow(st));
      const key = JSON.stringify(requests);
      if (key === last) return;
      last = key;
      popup.publish(requests);
    };
    update();
    const unsubscribe = client.store.subscribe(update);
    return () => {
      unsubscribe();
      popup.publish([]);
      popup.close();
    };
  }, [client]);
}

/** Keep the menu bar's requests in step, and answer the notifications' (and the pop-up's) buttons. */
export function useRequestNative(client: SocketClient): void {
  useRequestPopup(client);
  useEffect(() => {
    const onEvent = (e: Event): void => {
      const d = (e as CustomEvent<{ action?: RequestAction; approval?: string; task?: string }>).detail;
      if (d?.action) void runRequestAction(client, d.action, d.approval, d.task);
    };
    document.addEventListener(REQUEST_NOTIFICATION, onEvent);
    if (!inApp()) return () => document.removeEventListener(REQUEST_NOTIFICATION, onEvent);
    let alive = true;
    let off: (() => void) | undefined;
    void import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const un = await listen<{ action: RequestAction; approval?: string; task?: string }>('notification-request', (e) => void runRequestAction(client, e.payload.action, e.payload.approval, e.payload.task));
        if (alive) off = un;
        else un();
      })
      .catch(() => undefined);
    let last = '';
    const update = (): void => {
      const requests = trayRequests(client.store.getState().approvals);
      const key = JSON.stringify(requests);
      if (key === last) return;
      last = key;
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_tray_requests', { requests })).catch(() => undefined);
    };
    update();
    const unsubscribe = client.store.subscribe(update);
    return () => {
      alive = false;
      off?.();
      unsubscribe();
      document.removeEventListener(REQUEST_NOTIFICATION, onEvent);
    };
  }, [client]);
}
