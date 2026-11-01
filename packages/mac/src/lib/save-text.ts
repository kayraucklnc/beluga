import { inApp } from './boot.js';

/**
 * Save as…: text the window made (a table as CSV or JSON) written to a file you pick. In the app
 * the native shell shows the Save panel and writes the file (src-tauri/src/export.rs); in a
 * browser (development) it downloads. The path it went to, or undefined when you cancelled.
 */
export async function saveTextAs(name: string, contents: string): Promise<string | undefined> {
  if (inApp()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke<string | null>('save_export', { name, contents })) ?? undefined;
  }
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}
