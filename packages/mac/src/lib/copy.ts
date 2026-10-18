import { inApp } from './boot.js';

/** Put text on the clipboard (the app's own clipboard, or the browser's in development). */
export async function copyText(text: string): Promise<void> {
  if (inApp()) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
  } else await navigator.clipboard?.writeText(text);
}
