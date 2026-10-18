import { inApp } from './boot.js';

/** Open a web page in the default browser. */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (inApp()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener');
}

export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes('Mac');
export const mod = (): string => (isMac() ? '⌘' : 'Ctrl+');
