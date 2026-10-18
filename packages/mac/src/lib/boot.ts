import type { Capabilities } from '@klaud/ipc/socket-client.js';
import { SocketClient } from '@klaud/ipc/socket-client.js';
import { NOTIFICATION_TAP } from './notices.js';

/** Running inside the Tauri shell (otherwise: a browser, while developing). */
export const inApp = (): boolean => '__TAURI_INTERNALS__' in globalThis;

export interface Endpoint {
  readonly url: string;
  readonly token: string;
}

/** Where the daemon is: the app's own sidecar (asked through Tauri), or the dev server's bridge. */
export async function endpoint(): Promise<Endpoint> {
  if (inApp()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Endpoint>('daemon_endpoint');
  }
  const res = await fetch('/__klaud/endpoint');
  const body = (await res.json()) as Endpoint & { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? 'klaud is not running');
  return body;
}

/** What only this window can do for klaud: its clipboard, notifications, links and text size. */
export function capabilities(setZoom: (dir: 'in' | 'out' | 'reset') => { ok: boolean; message: string }): Capabilities {
  return {
    copyText: async (text: string) => {
      if (inApp()) {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
        await writeText(text);
      } else await navigator.clipboard.writeText(text);
    },
    // Clicking one comes back as a tap (the app shell's "notification-tap" event, or NOTIFICATION_TAP here).
    notify: async (n: { title: string; body: string; sound: boolean; channel?: string }) => {
      if (inApp()) {
        const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification');
        if (!(await isPermissionGranted()) && (await requestPermission()) !== 'granted') return;
        sendNotification({ title: n.title, body: n.body, ...(n.sound ? { sound: 'default' } : {}), extra: n.channel ? { channel: n.channel } : {} });
        return;
      }
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission !== 'granted') return;
      const shown = new Notification(n.title, { body: n.body, silent: !n.sound });
      shown.onclick = () => {
        window.focus();
        document.dispatchEvent(new CustomEvent(NOTIFICATION_TAP, { detail: { channel: n.channel } }));
      };
    },
    openExternal: async (target: string) => {
      if (inApp()) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(target);
      } else window.open(target, '_blank', 'noopener');
    },
    zoom: (dir: 'in' | 'out' | 'reset') => setZoom(dir),
  };
}

export const APP_VERSION = '0.4.0';

/** Attach to klaud. */
export async function connect(caps: Capabilities): Promise<SocketClient> {
  const { url, token } = await endpoint();
  return SocketClient.connect({ url, token, kind: 'mac', version: APP_VERSION, caps });
}
