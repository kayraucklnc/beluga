/** Visual language shared by every component. Terminal color names keep it theme-friendly. */
export const theme = {
  accent: 'magentaBright',
  claude: 'magenta',
  info: 'cyan',
  ok: 'green',
  warn: 'yellow',
  error: 'red',
  muted: 'gray',
  text: 'white',
  border: 'gray',
  focus: 'cyan',
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
} as const;

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const PEOPLE_COLORS = ['cyan', 'green', 'yellow', 'blue', 'redBright', 'cyanBright', 'greenBright', 'blueBright'];

export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PEOPLE_COLORS[h % PEOPLE_COLORS.length] ?? 'cyan';
}
