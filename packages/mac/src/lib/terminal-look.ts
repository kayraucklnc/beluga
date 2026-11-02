import type { ITerminalOptions } from '@xterm/xterm';
import type { UiPrefs } from './prefs.js';
import { colorsFor, xtermColors } from './terminal-import-model.js';

export { SCROLLBACK_CHOICES } from './terminal-import-model.js';

/** How the terminal looks: fonts to offer, and the xterm options for your choices. */

/** Monospace fonts worth offering; only the installed ones are listed (SF Mono and Menlo always are on a Mac). */
export const TERMINAL_FONTS: readonly string[] = ['Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'IBM Plex Mono', 'Source Code Pro', 'Hack', 'Iosevka', 'Berkeley Mono', 'Geist Mono', 'Courier New'];

/** The system's monospace (SF Mono on a Mac; web views only reach it as ui-monospace). */
const SYSTEM = 'ui-monospace, "SF Mono", Menlo, monospace';

/** The CSS font stack for a family, falling back to the system's monospace if it's missing. */
export const fontStack = (family: string): string => (family ? `"${family.replace(/"/g, '')}", ${SYSTEM}` : SYSTEM);

const installed = new Map<string, boolean>();

/**
 * Whether a font is installed: text drawn in it measures differently from the fallbacks.
 * (document.fonts.check can't tell for local fonts: it says yes to anything.)
 */
export function hasFont(family: string): boolean {
  const known = installed.get(family);
  if (known !== undefined) return known;
  let found = false;
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      const sample = 'mmmmmmmmmlli10OO@#';
      found = ['monospace', 'serif', 'sans-serif'].some((fallback) => {
        ctx.font = `72px ${fallback}`;
        const plain = ctx.measureText(sample).width;
        ctx.font = `72px "${family}", ${fallback}`;
        return ctx.measureText(sample).width !== plain;
      });
    }
  } catch {
    found = false;
  }
  installed.set(family, found);
  return found;
}

/** The fonts to offer: installed ones, plus the one you picked even if it's gone (so the menu shows it). */
export function fontChoices(picked: string): Array<{ value: string; label: string }> {
  const fonts = TERMINAL_FONTS.filter((f) => f === 'Menlo' || hasFont(f));
  const extra = picked && !fonts.includes(picked) ? [{ value: picked, label: hasFont(picked) ? picked : `${picked} (not installed)` }] : [];
  return [{ value: '', label: 'SF Mono (system)' }, ...fonts.map((f) => ({ value: f, label: f })), ...extra];
}

/** xterm's options for your terminal look. */
export const terminalOptions = (p: UiPrefs): Pick<ITerminalOptions, 'fontFamily' | 'fontSize' | 'lineHeight' | 'cursorStyle' | 'cursorBlink' | 'scrollback' | 'cursorInactiveStyle' | 'macOptionIsMeta'> => ({
  fontFamily: fontStack(p.termFont),
  fontSize: p.termFontSize,
  lineHeight: p.termLineHeight,
  cursorStyle: p.termCursor,
  cursorInactiveStyle: 'outline',
  cursorBlink: p.termCursorBlink,
  scrollback: p.termScrollback,
  macOptionIsMeta: p.termOptionMeta,
});

/** Whether the window looks dark right now (prefs.ts puts it on the document). */
export const looksDark = (): boolean => document.documentElement.dataset.theme === 'dark';

/**
 * The colours you brought from another terminal (Settings › Terminal › Import from…), as xterm
 * wants them, or undefined for Beluga's own (which follow the window's appearance).
 */
export const importedTheme = (p: UiPrefs, dark: boolean = looksDark()): Record<string, string> | undefined => xtermColors(colorsFor(p.termTheme, dark));
