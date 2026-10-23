import { Platform } from 'react-native';

/**
 * The phone's design tokens: soft pastels on the Mac app's neutral greys, light or dark (the
 * phone's choice by default). Color only means something, as on the Mac (packages/mac/src/styles/tokens.css): Claude is
 * peach, sub-agents lavender, done mint, needs-you butter, problems rose, links and info sky. Each
 * pastel is a tinted background (chips, icon circles, cards); its `ink` is the text and icon color
 * on it, dark enough for AA contrast. Nothing glows.
 *
 * `color`, `tint` and `ink` are live objects: `setScheme` swaps their values and the root remounts
 * (app/_layout.tsx), so components read them at render time and never cache them in a StyleSheet.
 */

export type Scheme = 'light' | 'dark';

/** The six pastels: a tinted surface and the ink that reads on it. */
const PASTELS = {
  light: {
    sky: ['#CFE3FA', '#2F5E8E'],
    mint: ['#CDEFE0', '#2C6E52'],
    peach: ['#FBDCCB', '#8A4B2A'],
    lavender: ['#E3DCF7', '#5A4A8C'],
    butter: ['#FBEFC4', '#7A6420'],
    rose: ['#F7D6DC', '#8C3A4A'],
  },
  // On the Mac's neutral dark grey: the pastel as a quiet low-opacity tint, its light tone as the ink.
  dark: {
    sky: ['rgba(169,200,236,0.14)', '#A9C8EC'],
    mint: ['rgba(159,214,189,0.14)', '#9FD6BD'],
    peach: ['rgba(240,191,163,0.15)', '#F0BFA3'],
    lavender: ['rgba(198,185,240,0.15)', '#C6B9F0'],
    butter: ['rgba(233,213,143,0.13)', '#E9D58F'],
    rose: ['rgba(239,176,188,0.14)', '#EFB0BC'],
  },
} as const;

type Pastel = keyof (typeof PASTELS)['light'];

// The Mac app's own greys (packages/mac/src/styles/tokens.css), neutral, no tint. Tertiary text is a
// shade stronger than the Mac's so captions keep AA contrast on the phone's cards.
const BASE = {
  light: {
    bg: '#F6F6F7',
    card: '#FFFFFF',
    bar: '#FFFFFF',
    selected: '#FFFFFF',
    sunken: 'rgba(0,0,0,0.045)',
    text: '#1D1D1F',
    text2: '#5D5D63',
    text3: '#737379',
    hairline: 'rgba(0,0,0,0.09)',
    hairlineStrong: 'rgba(0,0,0,0.16)',
    press: 'rgba(0,0,0,0.045)',
    primary: '#1D1D1F',
    onPrimary: '#FFFFFF',
    code: 'rgba(0,0,0,0.045)',
    scrim: 'rgba(0,0,0,0.25)',
    white: '#FFFFFF',
    shadowInk: '#000000',
    shadowCss: '0 1px 2px rgba(0,0,0,0.04), 0 6px 18px rgba(0,0,0,0.05)',
    shadowCssBar: '0 8px 28px rgba(0,0,0,0.10)',
    // The image viewer's stage: dark in both themes, so pictures read true.
    stage: '#0E0F11',
    onStage: '#ECECEE',
    onStageDim: 'rgba(236,236,238,0.4)',
    onStageChip: 'rgba(42,42,46,0.8)',
  },
  dark: {
    bg: '#1E1E21',
    card: '#2A2A2E',
    bar: '#19191B',
    selected: '#3A3A3F',
    sunken: 'rgba(255,255,255,0.06)',
    text: '#ECECEE',
    text2: '#A8A8AE',
    text3: '#8B8B92',
    hairline: 'rgba(255,255,255,0.075)',
    hairlineStrong: 'rgba(255,255,255,0.14)',
    press: 'rgba(255,255,255,0.1)',
    primary: '#ECECEE',
    onPrimary: '#1E1E21',
    code: 'rgba(255,255,255,0.06)',
    scrim: 'rgba(0,0,0,0.5)',
    white: '#FFFFFF',
    shadowInk: '#000000',
    shadowCss: 'none',
    shadowCssBar: '0 8px 28px rgba(0,0,0,0.4)',
    stage: '#0E0F11',
    onStage: '#ECECEE',
    onStageDim: 'rgba(236,236,238,0.4)',
    onStageChip: 'rgba(42,42,46,0.8)',
  },
} as const;

/** What each meaning is drawn with. */
const MEANING: Record<string, Pastel> = { claude: 'peach', subagent: 'lavender', ok: 'mint', warn: 'butter', error: 'rose', info: 'sky' };

type Palette = { -readonly [K in keyof (typeof BASE)['light']]: string } & Record<'claude' | 'subagent' | 'ok' | 'warn' | 'error' | 'info', string>;
type Tints = Record<Pastel | 'claude' | 'subagent' | 'ok' | 'warn' | 'error' | 'info', string>;

/** Surfaces and text, plus each meaning's ink (`color.claude` reads on `tint.claude`). */
export const color = {} as Palette;
/** Each pastel (and meaning) as a tinted background. */
export const tint = {} as Tints;
/** Each pastel's ink, by pastel name. */
export const ink = {} as Record<Pastel, string>;

export let scheme: Scheme = 'light';

export function setScheme(s: Scheme): void {
  scheme = s;
  Object.assign(color, BASE[s]);
  for (const [name, [bg, fg]] of Object.entries(PASTELS[s])) {
    tint[name as Pastel] = bg;
    ink[name as Pastel] = fg;
  }
  for (const [meaning, pastel] of Object.entries(MEANING)) {
    (color as Record<string, string>)[meaning] = PASTELS[s][pastel][1];
    tint[meaning as keyof Tints] = PASTELS[s][pastel][0];
  }
}
setScheme('light');

export const alpha = (hex: string, a: number): string => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export const space = { 1: 2, 2: 4, 3: 8, 4: 12, 5: 16, 6: 24, 7: 32, 8: 48 } as const;
export const radius = { s: 10, m: 16, l: 22, xl: 28, pill: 999 } as const;

// Android: no family name, so Roboto's real weights apply (a named family drops to regular).
const sans = Platform.select({ ios: 'System', android: undefined, default: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Roboto", "Helvetica Neue", sans-serif' });
const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, "SF Mono", Menlo, monospace' });

/** Type: friendly weights, the system font; colors come from `color` at render time. */
export const type = {
  hero: { fontFamily: sans, fontSize: 30, lineHeight: 36, fontWeight: '700' as const, letterSpacing: -0.6 },
  title: { fontFamily: sans, fontSize: 24, lineHeight: 30, fontWeight: '700' as const, letterSpacing: -0.4 },
  heading: { fontFamily: sans, fontSize: 16.5, lineHeight: 22, fontWeight: '600' as const, letterSpacing: -0.1 },
  body: { fontFamily: sans, fontSize: 15.5, lineHeight: 22, fontWeight: '400' as const },
  callout: { fontFamily: sans, fontSize: 14, lineHeight: 19, fontWeight: '400' as const },
  caption: { fontFamily: sans, fontSize: 12.5, lineHeight: 16, fontWeight: '500' as const },
  eyebrow: { fontFamily: sans, fontSize: 13, lineHeight: 17, fontWeight: '600' as const },
  mono: { fontFamily: mono, fontSize: 12.5, lineHeight: 18 },
} as const;
/** The default color of each text style. */
export const typeColor = (v: keyof typeof type): string => (v === 'callout' || v === 'mono' ? color.text2 : v === 'caption' || v === 'eyebrow' ? color.text3 : color.text);

/** Springs: snappy for presses, soft for things settling. Subtle, never bouncy for its own sake. */
export const spring = {
  snappy: { stiffness: 380, damping: 34, mass: 0.9 },
  soft: { stiffness: 180, damping: 26, mass: 1 },
  bouncy: { stiffness: 300, damping: 24, mass: 0.9 },
} as const;

export const TAB_BAR_H = 64;

/** The Beluga mark's own colors (assets/logo.svg): the brand, the same in both themes. */
export const brand = { tileTop: '#2A2C31', tileBottom: '#0F1013', whale: '#F5F5F7' } as const;
