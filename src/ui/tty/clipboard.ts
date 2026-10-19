import { copyNative } from '../../core/clipboard.js';

/** OSC 52 asks the terminal itself to set the clipboard; works over SSH in most modern terminals. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/**
 * Copy text for an explicit user action. Falls back to OSC 52 (terminal clipboard,
 * works over SSH) when no OS tool exists. Returns how it was copied.
 */
export async function copyText(text: string, write: (s: string) => void = (s) => process.stdout.write(s)): Promise<'native' | 'osc52'> {
  if (await copyNative(text)) return 'native';
  write(osc52(text));
  return 'osc52';
}
