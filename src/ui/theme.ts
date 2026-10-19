import type { ThemeName } from '../shared/settings-schema.js';

export interface Palette {
  readonly accent: string;
  readonly claude: string;
  readonly info: string;
  readonly ok: string;
  readonly warn: string;
  readonly error: string;
  readonly muted: string;
  readonly text: string;
  readonly border: string;
  readonly focus: string;
  readonly people: readonly string[];
}

/**
 * Semantic palettes. Neutral greys carry the layout; color is reserved for
 * meaning: Claude, success, needs-you, error. Truecolor (downsampled on 256-color terminals).
 */
export const PALETTES: Readonly<Record<ThemeName, Palette>> = {
  calm: {
    accent: '#d9a38f',
    claude: '#d4876c',
    info: '#8fb3cf',
    ok: '#9cbf8f',
    warn: '#d8b878',
    error: '#d08585',
    muted: '#7d8590',
    text: '#d6d9de',
    border: '#3b4048',
    focus: '#8a919c',
    people: ['#8fb3cf', '#9cbf8f', '#c9a6d9', '#d8b878', '#7fbfb3', '#b8a8e0', '#c7b49b', '#a3c4e0'],
  },
  light: {
    accent: '#b5583a',
    claude: '#b5583a',
    info: '#2f6690',
    ok: '#3d7a3a',
    warn: '#9a6a00',
    error: '#b23b3b',
    muted: '#6b7280',
    text: '#1f2328',
    border: '#c8ccd2',
    focus: '#5b6470',
    people: ['#2f6690', '#3d7a3a', '#7a4a9a', '#9a6a00', '#1f7a6d', '#5a4ab0', '#7a5a3a', '#3a5fa0'],
  },
  contrast: {
    accent: '#ffb38a',
    claude: '#ff9d73',
    info: '#7cc4ff',
    ok: '#7fe08a',
    warn: '#ffd166',
    error: '#ff7b7b',
    muted: '#a8b0bb',
    text: '#ffffff',
    border: '#6b7380',
    focus: '#e0e4ea',
    people: ['#7cc4ff', '#7fe08a', '#e0a6ff', '#ffd166', '#6fe3d0', '#c3b4ff', '#ffc9a0', '#a0d0ff'],
  },
  mono: {
    accent: '#d4876c',
    claude: '#d4876c',
    info: '#c8ccd2',
    ok: '#c8ccd2',
    warn: '#d4876c',
    error: '#d4876c',
    muted: '#80868f',
    text: '#d6d9de',
    border: '#3b4048',
    focus: '#9aa0a8',
    people: ['#d6d9de', '#b9bec6', '#9ca2ab', '#d6d9de', '#b9bec6', '#9ca2ab', '#d6d9de', '#b9bec6'],
  },
};

export const THEME_LABELS: Readonly<Record<ThemeName, string>> = {
  calm: 'Calm (dark)',
  light: 'Light terminal',
  contrast: 'High contrast',
  mono: 'Monochrome',
};

/**
 * The active palette. Components read it at render time, so switching themes is
 * a single in-place update followed by a re-render (the one deliberate mutation here).
 */
export const theme: { -readonly [K in keyof Palette]: Palette[K] } = { ...PALETTES.calm };

export function applyTheme(name: ThemeName): void {
  Object.assign(theme, PALETTES[name]);
}

export const glyph = {
  logo: '❯',
  claude: '◆',
  dot: '●',
  ring: '○',
  wait: '◌',
  ok: '✓',
  fail: '✗',
  denied: '⊘',
  arrow: '↳',
  prompt: '›',
  eye: '◉',
  folder: '▸',
  file: '·',
  bar: '│',
} as const;

// Geometric shapes are in every common monospace font (braille spinners are not in Menlo or DejaVu).
export const SPINNER = ['◐', '◓', '◑', '◒'] as const;

export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return theme.people[h % theme.people.length] ?? theme.text;
}
