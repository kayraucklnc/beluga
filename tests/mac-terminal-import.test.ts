import { describe, expect, it } from 'vitest';
import { colorsFor, foundLabel, hasLook, importPatch, importSummary, nearestScrollback, themeOf, xtermColors } from '../packages/mac/src/lib/terminal-import-model.js';
import type { TermColors, TerminalLook } from '../src/terminal/import/look.js';

const ansi = (fill: string | null = null): Array<string | null> => Array.from({ length: 16 }, (_, i) => (i === 1 ? '#ff0000' : fill));
const dark: TermColors = { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selection: '#585b70', ansi: ansi() };
const light: TermColors = { background: '#eff1f5', foreground: '#4c4f69', ansi: ansi() };

describe('bringing a terminal’s look into Beluga’s', () => {
  it('turns a look into your terminal settings, kept within what Settings offers', () => {
    const look: TerminalLook = { theme: { name: 'Mocha', colors: dark }, font: 'JetBrains Mono', fontSize: 13.3, lineHeight: 2, cursor: 'bar', cursorBlink: false, scrollback: 12_000, optionMeta: false };
    const { patch, skippedFont } = importPatch(look, 'Ghostty');
    expect(patch).toEqual({ termTheme: { name: 'Mocha', colors: dark, from: 'Ghostty' }, termFont: 'JetBrains Mono', termFontSize: 13.5, termLineHeight: 1.6, termCursor: 'bar', termCursorBlink: false, termScrollback: 10_000, termOptionMeta: false });
    expect(skippedFont).toBeUndefined();
    expect(importPatch({ fontSize: 40 }, 'x').patch).toEqual({ termFontSize: 22 });
  });

  it('leaves out a font that isn’t installed here, and keeps SF Mono as the system’s', () => {
    expect(importPatch({ font: 'Nope Mono', fontSize: 12 }, 'iTerm2', () => false)).toEqual({ patch: { termFontSize: 12 }, skippedFont: 'Nope Mono' });
    expect(importPatch({ font: '' }, 'Terminal', () => false).patch).toEqual({ termFont: '' });
  });

  it('snaps scrollback to the nearest choice', () => {
    expect(nearestScrollback(1000)).toBe(1000);
    expect(nearestScrollback(3000)).toBe(5000);
    expect(nearestScrollback(25_000)).toBe(50_000);
    expect(nearestScrollback(1_000_000)).toBe(100_000);
    expect(nearestScrollback(0)).toBe(1000);
  });

  it('says what it brings in a few words', () => {
    expect(importSummary({ theme: { name: 'Mocha', colors: dark, light }, font: 'Hack', fontSize: 13, cursor: 'bar', cursorBlink: true, scrollback: 10_000, optionMeta: true }, (f) => f !== 'Hack')).toEqual(['Mocha colours, light and dark', 'Hack (not installed here) 13 pt', 'Bar cursor, blinking', '10,000 lines back', 'Option as Meta']);
    expect(importSummary({ font: '', cursorBlink: false, lineHeight: 1.3 })).toEqual(['SF Mono', 'Cursor, steady', '1.30× lines']);
  });

  it('names a terminal with its profile, and knows when there’s nothing to bring', () => {
    expect(foundLabel({ app: 'iterm2', name: 'iTerm2', installed: true, look: { profile: 'Default', fontSize: 12 }, notes: [] })).toBe('iTerm2 · Default');
    expect(hasLook({ app: 'terminal', name: 'Terminal', installed: true, look: { profile: 'Basic' }, notes: [] })).toBe(false);
    expect(hasLook({ app: 'warp', name: 'Warp', installed: true, notes: [] })).toBe(false);
  });
});

describe('the colours xterm draws with', () => {
  it('uses the light colours while Beluga looks light, when the theme has them', () => {
    const theme = { name: 'Mocha', colors: dark, light };
    expect(colorsFor(theme, true)).toBe(dark);
    expect(colorsFor(theme, false)).toBe(light);
    expect(colorsFor({ name: 'x', colors: dark }, false)).toBe(dark);
    expect(colorsFor(null, true)).toBeUndefined();
  });

  it('gives xterm only the colours there are', () => {
    expect(xtermColors({ ...dark, cursorText: '#000000', selectionText: '#ffffff' })).toEqual({ background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#000000', selectionBackground: '#585b70', selectionForeground: '#ffffff', red: '#ff0000' });
    expect(xtermColors({ ansi: ansi('#111111') })).toMatchObject({ black: '#111111', red: '#ff0000', brightWhite: '#111111' });
    expect(xtermColors(undefined)).toBeUndefined();
  });

  it('reads a saved theme back, and drops one that isn’t', () => {
    expect(themeOf({ name: 'Mocha', from: 'Ghostty', colors: { ...dark, background: 'red', ansi: ['#000000'] } })).toEqual({ name: 'Mocha', from: 'Ghostty', colors: { foreground: '#cdd6f4', cursor: '#f5e0dc', selection: '#585b70', ansi: ['#000000', ...Array(15).fill(null)] } });
    expect(themeOf(null)).toBeNull();
    expect(themeOf({ colors: { background: '#000000' } })).toBeNull();
    expect(themeOf({ colors: dark, light })?.light?.background).toBe('#eff1f5');
  });
});
