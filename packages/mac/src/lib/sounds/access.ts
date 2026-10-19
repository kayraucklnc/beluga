import { useEffect, useState } from 'react';
import { inApp } from '../boot.js';
import { type NotificationAccess, UNKNOWN_ACCESS } from './access-model.js';

export type { NotificationAccess } from './access-model.js';

/** What macOS says now (`unknown` outside the app: a browser's permission isn't macOS's). */
export async function notificationAccess(): Promise<NotificationAccess> {
  if (!inApp()) return UNKNOWN_ACCESS;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<NotificationAccess>('notification_access').catch(() => UNKNOWN_ACCESS);
}

/** Open System Settings › Notifications, at Klaud. */
export async function openNotificationSettings(): Promise<void> {
  if (!inApp()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_notification_settings');
}

/** The current access, checked again whenever the window comes back (you may have just changed it). */
export function useNotificationAccess(): NotificationAccess | undefined {
  const [access, setAccess] = useState<NotificationAccess>();
  useEffect(() => {
    let live = true;
    const check = (): void => void notificationAccess().then((a) => live && setAccess(a));
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') check();
    };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return access;
}
