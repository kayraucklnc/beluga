import { inApp } from '../lib/boot.js';
import type { PopupRequest } from './popup-model.js';
import { REQUEST_NOTIFICATION, type RequestAction } from './request-actions.js';

/**
 * Between Beluga's window and the request pop-up. In the app the shell carries it (a floating
 * window of its own, see src-tauri/src/popup.rs); in a browser (development, tests, the README's
 * recordings) popup.html in another tab hears the window over a BroadcastChannel.
 */

const CHANNEL = 'beluga-request-popup';

type Message =
  | { readonly t: 'requests'; readonly requests: readonly PopupRequest[] }
  | { readonly t: 'hello' }
  | { readonly t: 'action'; readonly action: RequestAction; readonly approval: string; readonly task: string };

const channel = (): BroadcastChannel | undefined => (typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(CHANNEL));

// ------------------------------------------------------------------ Beluga's window

/** Keep the pop-up showing these (none hides it). Returns a function that stops listening. */
export function popupPublisher(): { publish: (requests: readonly PopupRequest[]) => void; close: () => void } {
  if (inApp()) {
    return {
      publish: (requests) => void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_request_popup', { requests })).catch(() => undefined),
      close: () => undefined,
    };
  }
  const bc = channel();
  let last: readonly PopupRequest[] = [];
  if (bc) {
    bc.onmessage = (e: MessageEvent<Message>) => {
      const m = e.data;
      if (m.t === 'hello') bc.postMessage({ t: 'requests', requests: last } satisfies Message);
      // The same path as a notification's buttons (request-native.ts answers it).
      if (m.t === 'action') document.dispatchEvent(new CustomEvent(REQUEST_NOTIFICATION, { detail: { action: m.action, approval: m.approval, task: m.task } }));
    };
  }
  return {
    publish: (requests) => {
      last = requests;
      bc?.postMessage({ t: 'requests', requests } satisfies Message);
    },
    close: () => bc?.close(),
  };
}

// ------------------------------------------------------------------ the pop-up

export interface PopupPort {
  /** Hear the requests to show (now, and whenever they change). */
  readonly subscribe: (on: (requests: readonly PopupRequest[]) => void) => () => void;
  readonly act: (action: RequestAction, r: Pick<PopupRequest, 'approval' | 'task'>) => void;
  readonly resize: (height: number) => void;
  /** × : hide these until something new comes (they still wait in Beluga). */
  readonly dismiss: (approvals: readonly string[]) => void;
}

export function popupPort(): PopupPort {
  if (inApp()) {
    const core = import('@tauri-apps/api/core');
    return {
      subscribe: (on) => {
        let alive = true;
        let heard = false;
        let off: (() => void) | undefined;
        // Listen first, then ask what's showing; an event that came meanwhile is newer than the answer.
        void import('@tauri-apps/api/event')
          .then(({ listen }) =>
            listen<PopupRequest[]>('request-popup', (e) => {
              heard = true;
              on(e.payload);
            }),
          )
          .then((un) => {
            if (!alive) return un();
            off = un;
            return core.then(({ invoke }) => invoke<PopupRequest[]>('request_popup_state')).then((r) => alive && !heard && on(r));
          })
          .catch(() => undefined);
        return () => {
          alive = false;
          off?.();
        };
      },
      act: (action, r) => void core.then(({ invoke }) => invoke('request_popup_action', { action, approval: r.approval, task: r.task })).catch(() => undefined),
      resize: (height) => void core.then(({ invoke }) => invoke('request_popup_resize', { height })).catch(() => undefined),
      dismiss: (approvals) => void core.then(({ invoke }) => invoke('request_popup_dismiss', { approvals })).catch(() => undefined),
    };
  }
  // One channel to send on; each subscription listens on its own (React may subscribe twice).
  const out = channel();
  const hidden = new Set<string>();
  let listener: ((requests: readonly PopupRequest[]) => void) | undefined;
  let last: readonly PopupRequest[] = [];
  const show = (): void => listener?.(last.filter((r) => !hidden.has(r.approval)));
  return {
    subscribe: (on) => {
      listener = on;
      const bc = channel();
      if (bc) {
        bc.onmessage = (e: MessageEvent<Message>) => {
          if (e.data.t !== 'requests') return;
          last = e.data.requests;
          show();
        };
        bc.postMessage({ t: 'hello' } satisfies Message);
      }
      return () => {
        if (listener === on) listener = undefined;
        bc?.close();
      };
    },
    act: (action, r) => out?.postMessage({ t: 'action', action, approval: r.approval, task: r.task } satisfies Message),
    resize: () => undefined,
    dismiss: (approvals) => {
      for (const a of approvals) hidden.add(a);
      show();
    },
  };
}
