/**
 * Bringing your terminal's look into Beluga (BLG-212): what another terminal's settings come to,
 * in the terms Beluga's own terminal has. Pure (the Mac app imports these types too).
 */

export const TERMINAL_APPS = ['ghostty', 'iterm2', 'terminal', 'alacritty', 'kitty', 'wezterm', 'warp'] as const;
export type TerminalAppId = (typeof TERMINAL_APPS)[number];

export const TERMINAL_APP_NAMES: Readonly<Record<TerminalAppId, string>> = {
  ghostty: 'Ghostty',
  iterm2: 'iTerm2',
  terminal: 'Terminal',
  alacritty: 'Alacritty',
  kitty: 'kitty',
  wezterm: 'WezTerm',
  warp: 'Warp',
};

/** A terminal's colours, each `#rrggbb`. `ansi` has 16 slots (0–7, then the bright 8–15); a gap keeps Beluga's. */
export interface TermColors {
  readonly background?: string;
  readonly foreground?: string;
  readonly cursor?: string;
  readonly cursorText?: string;
  readonly selection?: string;
  readonly selectionText?: string;
  readonly ansi: ReadonlyArray<string | null>;
}

/** A colour theme: one set of colours, or one for a dark appearance (`colors`) and one for light. */
export interface ImportedTheme {
  /** Its name, when it has one ("Catppuccin Mocha"); otherwise the profile's or the app's. */
  readonly name: string;
  readonly colors: TermColors;
  /** Used while Beluga looks light, when the terminal had its own light colours. */
  readonly light?: TermColors;
}

/** What another terminal's settings come to, in Beluga's terms. Anything missing stays as it is. */
export interface TerminalLook {
  /** The profile it came from (iTerm2's and Terminal's profiles; Ghostty and the rest have one). */
  readonly profile?: string;
  readonly theme?: ImportedTheme;
  /** A font family ('' : the system's monospace, SF Mono). */
  readonly font?: string;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly cursor?: 'block' | 'bar' | 'underline';
  readonly cursorBlink?: boolean;
  readonly scrollback?: number;
  /** Option (Alt) sends Meta (Esc+), instead of typing special characters. */
  readonly optionMeta?: boolean;
}

/** One terminal on this Mac: installed or not, the file its settings came from, and what they are. */
export interface TerminalFound {
  readonly app: TerminalAppId;
  readonly name: string;
  readonly installed: boolean;
  /** The settings file read, with ~ for your home folder. */
  readonly file?: string;
  readonly look?: TerminalLook;
  /** What couldn't come along, in words ("Warp's built-in theme “Dracula” isn't readable"). */
  readonly notes: readonly string[];
}

/** Beluga's natural line height (Settings › Terminal's default): another terminal's 1.0 spacing. */
export const NATURAL_LINE_HEIGHT = 1.18;

const hex2 = (n: number): string => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

/** `#rrggbb` from 0–1 floats. */
export const floatsToHex = (r: number, g: number, b: number): string => `#${hex2(r * 255)}${hex2(g * 255)}${hex2(b * 255)}`;

/** Any of `#rgb`, `#rrggbb`, `#rrggbbaa`, `rrggbb`, `0xrrggbb`, `rgb:rr/gg/bb` → `#rrggbb`, or undefined. */
export function hexColor(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  const xrgb = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/.exec(v);
  if (xrgb) return `#${xrgb.slice(1, 4).map((c) => hex2((parseInt(c, 16) / (16 ** c.length - 1)) * 255)).join('')}`;
  const m = /^(?:#|0x)?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (!m) return undefined;
  const h = m[1]!;
  if (h.length === 3) return `#${[...h].map((c) => c + c).join('')}`;
  return `#${h.slice(0, 6)}`;
}

/** The colours with nothing in them (no theme to bring). */
export const isEmptyColors = (c: TermColors): boolean => !c.background && !c.foreground && !c.cursor && !c.selection && !c.ansi.some(Boolean);

/** A colour set from loose parts, keeping only real colours. */
export function makeColors(parts: { background?: unknown; foreground?: unknown; cursor?: unknown; cursorText?: unknown; selection?: unknown; selectionText?: unknown; ansi?: ReadonlyArray<unknown> }): TermColors {
  const ansi: Array<string | null> = [];
  for (let i = 0; i < 16; i++) ansi.push(hexColor(parts.ansi?.[i]) ?? null);
  const out: { -readonly [K in keyof TermColors]: TermColors[K] } = { ansi };
  for (const k of ['background', 'foreground', 'cursor', 'cursorText', 'selection', 'selectionText'] as const) {
    const c = hexColor(parts[k]);
    if (c) out[k] = c;
  }
  return out;
}

/** The ANSI names, in order (Alacritty's, WezTerm's and Warp's colour tables use them). */
export const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

/** Whether a colour is dark (for which appearance a theme suits). */
export function isDark(hex: string | undefined): boolean {
  const c = hexColor(hex);
  if (!c) return true;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/** The look without its empty parts (and a theme only when it has colours). */
export function cleanLook(look: TerminalLook): TerminalLook | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(look)) if (v !== undefined && v !== null && !(typeof v === 'number' && !Number.isFinite(v))) out[k] = v;
  const theme = out['theme'] as ImportedTheme | undefined;
  if (theme && isEmptyColors(theme.colors) && (!theme.light || isEmptyColors(theme.light))) delete out['theme'];
  const keys = Object.keys(out).filter((k) => k !== 'profile');
  return keys.length ? (out as TerminalLook) : undefined;
}
