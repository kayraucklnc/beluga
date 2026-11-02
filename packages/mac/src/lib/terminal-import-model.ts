import type { ImportedTheme, TermColors, TerminalFound, TerminalLook } from '../../../../src/terminal/import/look.js';
import type { ImportedKey } from '../../../../src/terminal/import/keys.js';

/**
 * Bringing another terminal's look into Beluga's (BLG-212), the window's side: what an import
 * changes in your terminal settings, the words for it, and the colours xterm.js draws with.
 * Pure (the reading is the daemon's, `terminalImport.detect`).
 */

/** An imported colour theme as kept in your settings: the theme, and the terminal it came from. */
export interface TermThemePref extends ImportedTheme {
  readonly from: string;
}

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function colorsOf(raw: unknown): TermColors | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r['ansi'])) return undefined;
  const out: Record<string, unknown> = { ansi: Array.from({ length: 16 }, (_, i) => (isHex((r['ansi'] as unknown[])[i]) ? (r['ansi'] as string[])[i] : null)) };
  for (const k of ['background', 'foreground', 'cursor', 'cursorText', 'selection', 'selectionText']) if (isHex(r[k])) out[k] = r[k];
  return out as unknown as TermColors;
}

/** A saved theme as it was saved, or null when it isn't one (an older or damaged setting). */
export function themeOf(raw: unknown): TermThemePref | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const colors = colorsOf(r['colors']);
  if (!colors) return null;
  const light = colorsOf(r['light']);
  return { name: typeof r['name'] === 'string' ? r['name'] : 'Imported', from: typeof r['from'] === 'string' ? r['from'] : '', colors, ...(light ? { light } : {}) };
}

/** The terminal settings an import can change (a part of UiPrefs). */
export interface TermLookPrefs {
  readonly termTheme: TermThemePref | null;
  readonly termFont: string;
  readonly termFontSize: number;
  readonly termLineHeight: number;
  readonly termCursor: 'block' | 'bar' | 'underline';
  readonly termCursorBlink: boolean;
  readonly termScrollback: number;
  readonly termOptionMeta: boolean;
  /** Keys brought from another terminal (BLG-537), over Beluga's terminal keys. */
  readonly termKeys: TermKeysPref | null;
}

/** Imported keys as kept in your settings: the keys, and the terminal they came from. */
export interface TermKeysPref {
  readonly from: string;
  readonly keys: readonly ImportedKey[];
}

/** Saved keys as they were saved, or null (an older or damaged setting). */
export function termKeysOf(raw: unknown): TermKeysPref | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r['keys'])) return null;
  const keys = (r['keys'] as unknown[]).filter((k): k is ImportedKey => !!k && typeof (k as ImportedKey).chord === 'string' && typeof (k as ImportedKey).action === 'string').slice(0, 300);
  return { from: typeof r['from'] === 'string' ? r['from'] : '', keys };
}

export const SCROLLBACK_CHOICES: readonly number[] = [1000, 5000, 10_000, 50_000, 100_000];

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** The scrollback choice nearest to `lines` (Settings offers a few, not any number). */
export const nearestScrollback = (lines: number): number => SCROLLBACK_CHOICES.reduce((best, c) => (Math.abs(Math.log(c / Math.max(1, lines))) < Math.abs(Math.log(best / Math.max(1, lines))) ? c : best));

/** Whether a terminal has anything to bring. */
export const hasLook = (f: TerminalFound): boolean => !!f.look && Object.keys(f.look).some((k) => k !== 'profile');

/**
 * What applying `look` changes. A font that isn't installed here is left out (`skipped`), and
 * sizes are kept within what Settings › Terminal offers.
 */
export function importPatch(look: TerminalLook, from: string, fontInstalled: (family: string) => boolean = () => true): { patch: Partial<TermLookPrefs>; skippedFont?: string } {
  const patch: { -readonly [K in keyof TermLookPrefs]?: TermLookPrefs[K] } = {};
  let skippedFont: string | undefined;
  if (look.theme) patch.termTheme = { ...look.theme, from };
  if (look.font !== undefined) {
    if (look.font === '' || fontInstalled(look.font)) patch.termFont = look.font;
    else skippedFont = look.font;
  }
  if (look.fontSize !== undefined) patch.termFontSize = clamp(Math.round(look.fontSize * 2) / 2, 9, 22);
  if (look.lineHeight !== undefined) patch.termLineHeight = Math.round(clamp(look.lineHeight, 1, 1.6) * 50) / 50;
  if (look.cursor) patch.termCursor = look.cursor;
  if (look.cursorBlink !== undefined) patch.termCursorBlink = look.cursorBlink;
  if (look.scrollback !== undefined) patch.termScrollback = nearestScrollback(look.scrollback);
  if (look.optionMeta !== undefined) patch.termOptionMeta = look.optionMeta;
  if (look.keys?.length) patch.termKeys = { from, keys: look.keys };
  return { patch, ...(skippedFont ? { skippedFont } : {}) };
}

const CURSORS = { block: 'Block', bar: 'Bar', underline: 'Underline' } as const;

/** What an import brings, a few words each ("Catppuccin Mocha colours", "JetBrains Mono 13 pt"…). */
export function importSummary(look: TerminalLook, fontInstalled: (family: string) => boolean = () => true): string[] {
  const out: string[] = [];
  if (look.theme) out.push(`${look.theme.name} colours${look.theme.light ? ', light and dark' : ''}`);
  if (look.font !== undefined || look.fontSize) {
    const font = look.font === undefined ? '' : look.font === '' ? 'SF Mono' : fontInstalled(look.font) ? look.font : `${look.font} (not installed here)`;
    out.push([font, look.fontSize ? `${look.fontSize} pt` : ''].filter(Boolean).join(' '));
  }
  if (look.cursor || look.cursorBlink !== undefined) {
    const shape = look.cursor ? `${CURSORS[look.cursor]} cursor` : 'Cursor';
    out.push(look.cursorBlink === undefined ? shape : `${shape}, ${look.cursorBlink ? 'blinking' : 'steady'}`);
  }
  if (look.lineHeight !== undefined) out.push(`${look.lineHeight.toFixed(2)}× lines`);
  if (look.scrollback !== undefined) out.push(`${nearestScrollback(look.scrollback).toLocaleString('en-US')} lines back`);
  if (look.optionMeta !== undefined) out.push(look.optionMeta ? 'Option as Meta' : 'Option types symbols');
  if (look.keys?.length) out.push(`${look.keys.length} ${look.keys.length === 1 ? 'key' : 'keys'} (tabs, splits…)`);
  return out;
}

/** The menu's words for a terminal ("iTerm2 · Default profile"). */
export const foundLabel = (f: TerminalFound): string => (f.look?.profile ? `${f.name} · ${f.look.profile}` : f.name);

/** The colours to draw with right now: the light ones while Beluga looks light, when there are some. */
export const colorsFor = (theme: ImportedTheme | null | undefined, dark: boolean): TermColors | undefined => (theme ? (!dark && theme.light ? theme.light : theme.colors) : undefined);

const XTERM_ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;

/** xterm.js's theme for imported colours (only what they have: xterm keeps its own for the rest). */
export function xtermColors(c: TermColors | undefined): Record<string, string> | undefined {
  if (!c) return undefined;
  const out: Record<string, string> = {};
  if (c.background) out['background'] = c.background;
  if (c.foreground) out['foreground'] = c.foreground;
  if (c.cursor) out['cursor'] = c.cursor;
  if (c.cursorText) out['cursorAccent'] = c.cursorText;
  if (c.selection) out['selectionBackground'] = c.selection;
  if (c.selectionText) out['selectionForeground'] = c.selectionText;
  c.ansi.forEach((v, i) => {
    if (v && XTERM_ANSI[i]) out[XTERM_ANSI[i]] = v;
  });
  return out;
}
