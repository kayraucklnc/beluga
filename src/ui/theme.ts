/**
 * Calm, low-contrast palette (truecolor; chalk downsamples on 256-color terminals).
 * Neutral greys carry the layout; color is reserved for meaning:
 * Claude = soft coral, success = sage, attention = sand, errors = clay.
 */
export const theme = {
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
} as const;

export const glyph = {
  logo: '✦',
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

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Soft pastels so names are distinguishable without shouting. */
const PEOPLE_COLORS = ['#8fb3cf', '#9cbf8f', '#c9a6d9', '#d8b878', '#7fbfb3', '#b8a8e0', '#c7b49b', '#a3c4e0'];

export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PEOPLE_COLORS[h % PEOPLE_COLORS.length] ?? PEOPLE_COLORS[0]!;
}
