import { Platform } from 'react-native';

/**
 * The phone's design tokens: the Mac app's neutral greys, light or dark (the phone's choice by
 * default), and color only where it means something. Icons are one ink (`color.text2`), never a
 * hue each; a fill is a quiet neutral, never a pastel chip. What keeps a color of its own: needs-you
 * and warnings (amber), problems (red), links and the one accent (blue), and online / done dots
 * (green), each muted enough to sit on grey without shouting. Nothing glows.
 *
 * The six pastel names stay as the API (`tint.sky`, `ink.lavender`, a `Tone`): the decorative
 * ones (sky, mint, peach, lavender) now draw neutral, butter and rose keep their meaning.
 *
 * `color`, `tint` and `ink` are live objects: `setScheme` swaps their values and the root remounts
 * (app/_layout.tsx), so components read them at render time and never cache them in a StyleSheet.
 */

export type Scheme = 'light' | 'dark';

/** Each tone: the fill behind it and its ink. Decorative tones are neutral; butter and rose mean something. */
const PASTELS = {
  light: {
    sky: ['rgba(0,0,0,0.045)', '#55555B'],
    mint: ['rgba(0,0,0,0.045)', '#55555B'],
    peach: ['rgba(0,0,0,0.045)', '#55555B'],
    lavender: ['rgba(0,0,0,0.045)', '#55555B'],
    butter: ['rgba(176,116,20,0.10)', '#94600F'],
    rose: ['rgba(196,55,48,0.085)', '#B3352E'],
  },
  dark: {
    sky: ['rgba(255,255,255,0.06)', '#B4B4BA'],
    mint: ['rgba(255,255,255,0.06)', '#B4B4BA'],
    peach: ['rgba(255,255,255,0.06)', '#B4B4BA'],
    lavender: ['rgba(255,255,255,0.06)', '#B4B4BA'],
    butter: ['rgba(224,176,80,0.13)', '#E2B45C'],
    rose: ['rgba(240,131,122,0.13)', '#F08A80'],
  },
} as const;

/** The colors that carry meaning by themselves (text, dots, links), as inks. */
const MEANINGS = {
  light: { claude: '#1D1D1F', subagent: '#55555B', ok: '#2E8550', warn: '#94600F', error: '#B3352E', info: '#2F64D0' },
  dark: { claude: '#ECECEE', subagent: '#B4B4BA', ok: '#6CC48F', warn: '#E2B45C', error: '#F08A80', info: '#86AAF2' },
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
    // A file's page in the viewer: solid, one step up from the stage, with a hairline.
    onStageCard: '#1C1C1F',
    onStageLine: 'rgba(255,255,255,0.08)',
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
    // A file's page in the viewer: solid, one step up from the stage, with a hairline.
    onStageCard: '#1C1C1F',
    onStageLine: 'rgba(255,255,255,0.08)',
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
  Object.assign(elevation, ELEVATION[s]);
  for (const [name, [bg, fg]] of Object.entries(PASTELS[s])) {
    tint[name as Pastel] = bg;
    ink[name as Pastel] = fg;
  }
  for (const [meaning, pastel] of Object.entries(MEANING)) {
    (color as Record<string, string>)[meaning] = MEANINGS[s][meaning as keyof (typeof MEANINGS)['light']];
    tint[meaning as keyof Tints] = PASTELS[s][pastel][0];
  }
}

export const alpha = (hex: string, a: number): string => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export const space = { 1: 2, 2: 4, 3: 8, 4: 12, 5: 16, 6: 24, 7: 32, 8: 48 } as const;
export const radius = { s: 8, m: 12, l: 14, xl: 20, pill: 999 } as const;

/** Icons: one line weight everywhere (the root's LucideProvider), fine enough to read as drawn, not stamped. */
export const stroke = 1.75;

// Android: no family name, so Roboto's real weights apply (a named family drops to regular).
const sans = Platform.select({ ios: 'System', android: undefined, default: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Roboto", "Helvetica Neue", sans-serif' });
const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, "SF Mono", Menlo, monospace' });

/** The system font for text drawn in SVG (charts, graphs): SVG's own default is a serif on the web. */
export const svgFont = Platform.select({ ios: 'System', android: 'sans-serif', default: sans }) as string;

/** Type: the system font, calm weights (600 at most below titles); colors come from `color` at render time. */
export const type = {
  hero: { fontFamily: sans, fontSize: 28, lineHeight: 34, fontWeight: '600' as const, letterSpacing: -0.6 },
  title: { fontFamily: sans, fontSize: 24, lineHeight: 30, fontWeight: '700' as const, letterSpacing: -0.4 },
  heading: { fontFamily: sans, fontSize: 16, lineHeight: 21, fontWeight: '600' as const, letterSpacing: -0.15 },
  body: { fontFamily: sans, fontSize: 15.5, lineHeight: 22, fontWeight: '400' as const },
  callout: { fontFamily: sans, fontSize: 14, lineHeight: 19, fontWeight: '400' as const },
  caption: { fontFamily: sans, fontSize: 12.5, lineHeight: 16, fontWeight: '400' as const },
  // Section labels: small, tracked, quiet; they organise, they don't decorate.
  eyebrow: { fontFamily: sans, fontSize: 12, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.4, textTransform: 'uppercase' as const },
  mono: { fontFamily: mono, fontSize: 12.5, lineHeight: 18 },
} as const;
/** The default color of each text style. */
export const typeColor = (v: keyof typeof type): string => (v === 'callout' || v === 'mono' ? color.text2 : v === 'caption' || v === 'eyebrow' ? color.text3 : color.text);

/**
 * Springs: critically damped, so things arrive and stop; nothing overshoots or bounces. `bouncy`
 * is kept as a name for its callers and settles like the others.
 */
export const spring = {
  snappy: { stiffness: 420, damping: 42, mass: 0.9 },
  soft: { stiffness: 200, damping: 30, mass: 1 },
  bouncy: { stiffness: 320, damping: 36, mass: 0.9 },
} as const;

export const TAB_BAR_H = 64;

/**
 * Elevation, by tone and a hairline (never shadow alone: shadows don't show on dark grey).
 * `card` is a card on the page; `raised` a card on a card (an output on a sheet); `behind1` and
 * `behind2` the cards stacked behind the front one, each a step further back (darker in dark,
 * dimmer in light), always above the page's own tone so their edges read.
 */
const ELEVATION = {
  light: {
    card: { surface: '#FFFFFF', border: 'rgba(0,0,0,0.06)' },
    raised: { surface: '#FFFFFF', border: 'rgba(0,0,0,0.08)' },
    behind1: { surface: '#FBFBFC', border: 'rgba(0,0,0,0.06)' },
    behind2: { surface: '#F7F7F8', border: 'rgba(0,0,0,0.05)' },
  },
  dark: {
    card: { surface: '#2A2A2E', border: 'rgba(255,255,255,0.08)' },
    raised: { surface: '#333338', border: 'rgba(255,255,255,0.10)' },
    behind1: { surface: '#252529', border: 'rgba(255,255,255,0.06)' },
    behind2: { surface: '#222225', border: 'rgba(255,255,255,0.045)' },
  },
} as const;
type Level = keyof (typeof ELEVATION)['light'];
export const elevation = {} as Record<Level, { surface: string; border: string }>;

/** The Beluga mark's own colors (assets/logo.svg): the brand, the same in both themes. */
export const brand = { tileTop: '#2A2C31', tileBottom: '#0F1013', whale: '#F5F5F7' } as const;

setScheme('light');
