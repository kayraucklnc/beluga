import { type Loose, type LooseTable, type Plist, archivedColor, archivedFont, asDict, asTable, parseToml, parseYaml } from './formats.js';
import { ANSI_NAMES, type ImportedTheme, NATURAL_LINE_HEIGHT, type TermColors, type TerminalLook, cleanLook, floatsToHex, hexColor, isEmptyColors, makeColors } from './look.js';
import { ghosttyKeys, itermKeys } from './keys.js';

/**
 * Each terminal's settings → a TerminalLook (look.ts). Pure: the files come in as text (or a
 * plist's value), and anything they point at (a theme by name, an included file) through `read`.
 * Fonts given by PostScript name (iTerm2's, Terminal's) come back in `postscript` for the caller
 * to turn into a family (core/detect.ts asks macOS); `look.font` has a best guess meanwhile.
 */

export interface Parsed {
  readonly look?: TerminalLook;
  readonly notes: readonly string[];
  /** The font's PostScript name, when that's how the terminal keeps it. */
  readonly postscript?: string;
}

/** Reads another file a config points at: a theme by name, an include (relative to the config). */
export type ReadFile = (name: string) => string | undefined;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : typeof v === 'string' ? (/^(true|yes|on|1)$/i.test(v.trim()) ? true : /^(false|no|off|0)$/i.test(v.trim()) ? false : undefined) : typeof v === 'number' ? v !== 0 : undefined);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const unquote = (v: string): string => v.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

/** A line height `scale` times another terminal's natural one. */
const lineScale = (scale: number | undefined): number | undefined => (scale && scale > 0.5 && scale < 3 ? round2(NATURAL_LINE_HEIGHT * scale) : undefined);

const theme = (name: string, colors: TermColors, light?: TermColors): ImportedTheme | undefined => {
  if (isEmptyColors(colors) && (!light || isEmptyColors(light))) return undefined;
  return light && !isEmptyColors(light) ? { name, colors, light } : { name, colors };
};

// ---- fonts by PostScript name

const KNOWN_FAMILIES: Readonly<Record<string, string>> = {
  JetBrainsMono: 'JetBrains Mono',
  FiraCode: 'Fira Code',
  FiraMono: 'Fira Mono',
  SourceCodePro: 'Source Code Pro',
  CascadiaCode: 'Cascadia Code',
  CascadiaMono: 'Cascadia Mono',
  IBMPlexMono: 'IBM Plex Mono',
  GeistMono: 'Geist Mono',
  BerkeleyMono: 'Berkeley Mono',
  CourierNewPSMT: 'Courier New',
  UbuntuMono: 'Ubuntu Mono',
  RobotoMono: 'Roboto Mono',
  MesloLGS: 'MesloLGS NF',
  'MesloLGS-NF': 'MesloLGS NF',
  MonaspaceNeon: 'Monaspace Neon',
  CommitMono: 'Commit Mono',
};

/**
 * A PostScript font name's family, as a guess ("FiraCode-Retina" → "Fira Code"). SF Mono (and
 * Terminal's private copy of it) is the system's monospace: ''.
 */
export function familyFromPostScript(name: string): string {
  const base = name.trim().replace(/-(Regular|Retina|Medium|Light|Book|Roman|Text|Normal|Bold|Italic|Thin|SemiBold|ExtraLight|Variable|VF)$/i, '');
  if (/^(SFMono|SFMonoTerminal|\.SFNSMono|SFMono-Regular)/i.test(base)) return '';
  if (KNOWN_FAMILIES[base]) return KNOWN_FAMILIES[base];
  const nerd = /^(.*?)(NF|NerdFont|NerdFontMono|NFM)$/.exec(base);
  if (nerd && nerd[1]) return `${KNOWN_FAMILIES[nerd[1]] ?? nerd[1]} Nerd Font`;
  if (/\s/.test(base)) return base;
  return base.replace(/([a-z])([A-Z])/g, '$1 $2');
}

// ---- Ghostty

/** Ghostty's `key = value` lines, in order (repeats kept: font-family, palette). */
export function ghosttyLines(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out.push([line.slice(0, eq).trim(), unquote(line.slice(eq + 1))]);
  }
  return out;
}

const GHOSTTY_COLOR_KEYS: Readonly<Record<string, keyof Omit<TermColors, 'ansi'>>> = {
  background: 'background',
  foreground: 'foreground',
  'cursor-color': 'cursor',
  'cursor-text': 'cursorText',
  'selection-background': 'selection',
  'selection-foreground': 'selectionText',
};

/** Ghostty's colour lines over `base` (a theme's, then the config's own on top, as Ghostty does). */
function ghosttyColors(lines: ReadonlyArray<[string, string]>, base?: TermColors): TermColors {
  const parts: Record<string, unknown> = { ...base, ansi: [...(base?.ansi ?? [])] };
  for (const [k, v] of lines) {
    if (GHOSTTY_COLOR_KEYS[k]) parts[GHOSTTY_COLOR_KEYS[k]] = hexColor(v) ?? parts[GHOSTTY_COLOR_KEYS[k]];
    else if (k === 'palette') {
      const m = /^(\d{1,3})\s*=\s*(.+)$/.exec(v);
      const n = m ? Number(m[1]) : -1;
      if (m && n >= 0 && n < 16) (parts['ansi'] as unknown[])[n] = hexColor(m[2]) ?? (parts['ansi'] as unknown[])[n];
    }
  }
  return makeColors(parts as Parameters<typeof makeColors>[0]);
}

/**
 * Ghostty's config. `read('theme:<name>')` gets a theme file by name; `read('<path>')` a
 * `config-file` it includes (an optional one starts with ?).
 */
export function parseGhostty(text: string, read: ReadFile = () => undefined): Parsed {
  const notes: string[] = [];
  // config-file includes go after the file itself, as Ghostty reads them.
  const lines = ghosttyLines(text);
  const included: Array<[string, string]> = [];
  for (const [k, v] of lines) {
    if (k !== 'config-file' || !v) continue;
    const inc = read(v.replace(/^\?/, ''));
    if (inc) included.push(...ghosttyLines(inc).filter(([ik]) => ik !== 'config-file'));
  }
  const all = [...lines, ...included];
  const last = (key: string): string | undefined => all.filter(([k]) => k === key).at(-1)?.[1];
  const look: Mutable<TerminalLook> = {};

  // theme = Name, or theme = light:Name,dark:Name
  const themeValue = last('theme');
  let themeName = '';
  let darkBase: TermColors | undefined;
  let lightBase: TermColors | undefined;
  if (themeValue) {
    const pairs = Object.fromEntries(themeValue.split(',').map((p) => p.split(':').map((x) => x.trim()) as [string, string?]).map(([a, b]) => (b === undefined ? ['both', a] : [a, b])));
    const load = (name: string | undefined): TermColors | undefined => {
      if (!name) return undefined;
      const body = read(`theme:${name}`);
      if (body === undefined) {
        notes.push(`The theme “${name}” wasn't found.`);
        return undefined;
      }
      return ghosttyColors(ghosttyLines(body));
    };
    const both = pairs['both'] as string | undefined;
    darkBase = load(both ?? pairs['dark']);
    lightBase = both ? undefined : load(pairs['light']);
    themeName = (both ?? pairs['dark'] ?? pairs['light'] ?? '') as string;
  }
  const own = all.filter(([k]) => k === 'palette' || GHOSTTY_COLOR_KEYS[k]);
  const colors = ghosttyColors(own, darkBase ?? lightBase);
  const light = darkBase && lightBase ? ghosttyColors(own, lightBase) : undefined;
  look.theme = theme(themeName || 'Ghostty', colors, light);

  const families = all.filter(([k]) => k === 'font-family');
  // An empty font-family clears the list before it.
  const lastReset = families.map(([, v]) => v).lastIndexOf('');
  const family = families.slice(lastReset + 1)[0]?.[1];
  if (family) look.font = family;
  look.fontSize = num(last('font-size'));
  const cursor = last('cursor-style');
  if (cursor) look.cursor = cursor === 'bar' ? 'bar' : cursor === 'underline' ? 'underline' : 'block';
  look.cursorBlink = bool(last('cursor-style-blink'));
  const cell = last('adjust-cell-height');
  if (cell) {
    const pct = /^(-?[\d.]+)%$/.exec(cell);
    const px = num(cell);
    const size = look.fontSize ?? 13;
    look.lineHeight = lineScale(pct ? 1 + Number(pct[1]) / 100 : px !== undefined ? 1 + px / (size * NATURAL_LINE_HEIGHT) : undefined);
  }
  const alt = last('macos-option-as-alt');
  if (alt) look.optionMeta = alt !== 'false';
  const opacity = num(last('background-opacity'));
  if (opacity !== undefined && opacity < 1) notes.push('A see-through background stays solid in Beluga.');
  const keys = ghosttyKeys(all);
  if (keys.keys.length) look.keys = keys.keys;
  if (keys.skipped) notes.push(`${keys.skipped === 1 ? 'One of your keys has' : `${keys.skipped} of your keys have`} nothing to do in Beluga's terminal (a new window, a quick terminal…), so ${keys.skipped === 1 ? 'it stays' : 'they stay'} behind.`);
  return { look: cleanLook(look), notes };
}

// ---- iTerm2

const itermColor = (v: unknown): string | undefined => {
  const d = asDict(v);
  const r = num(d?.['Red Component']);
  const g = num(d?.['Green Component']);
  const b = num(d?.['Blue Component']);
  return r !== undefined && g !== undefined && b !== undefined ? floatsToHex(r, g, b) : undefined;
};

function itermColors(p: Record<string, Plist>, suffix: string): TermColors {
  const c = (key: string): string | undefined => itermColor(p[`${key}${suffix}`]) ?? itermColor(p[key]);
  return makeColors({
    background: c('Background Color'),
    foreground: c('Foreground Color'),
    cursor: c('Cursor Color'),
    cursorText: c('Cursor Text Color'),
    selection: c('Selection Color'),
    selectionText: c('Selected Text Color'),
    ansi: Array.from({ length: 16 }, (_, i) => c(`Ansi ${i} Color`)),
  });
}

/** iTerm2's preferences (com.googlecode.iterm2.plist): its default profile, or the first. */
export function parseIterm(prefs: Plist | undefined): Parsed {
  const root = asDict(prefs);
  const profiles = Array.isArray(root?.['New Bookmarks']) ? (root['New Bookmarks'] as readonly Plist[]).map(asDict).filter((p): p is Record<string, Plist> => !!p) : [];
  if (!profiles.length) return { notes: ['No profiles in iTerm2’s settings yet.'] };
  const guid = root?.['Default Bookmark Guid'];
  const p = profiles.find((x) => x['Guid'] === guid) ?? profiles[0]!;
  const name = typeof p['Name'] === 'string' ? p['Name'] : 'Default';
  const look: Mutable<TerminalLook> = { profile: name };
  const notes: string[] = [];
  const separate = p['Use Separate Colors for Light and Dark Mode'] === true;
  // iTerm2 doesn't keep the name of a colour preset: the profile's name it is.
  const themeName = `“${name}” profile`;
  look.theme = separate ? theme(themeName, itermColors(p, ' (Dark)'), itermColors(p, ' (Light)')) : theme(themeName, itermColors(p, ''));
  let postscript: string | undefined;
  const font = typeof p['Normal Font'] === 'string' ? /^(.*\S)\s+([\d.]+)$/.exec(p['Normal Font']) : null;
  if (font) {
    postscript = font[1]!;
    look.font = familyFromPostScript(postscript);
    look.fontSize = num(font[2]);
  }
  look.lineHeight = lineScale(num(p['Vertical Spacing']));
  const cursor = num(p['Cursor Type']);
  if (cursor !== undefined) look.cursor = cursor === 0 ? 'underline' : cursor === 1 ? 'bar' : 'block';
  look.cursorBlink = bool(p['Blinking Cursor']);
  look.scrollback = p['Unlimited Scrollback'] === true ? 100_000 : num(p['Scrollback Lines']);
  const option = num(p['Option Key Sends']);
  if (option !== undefined) look.optionMeta = option !== 0;
  if ((num(p['Transparency']) ?? 0) > 0.01) notes.push('A see-through background stays solid in Beluga.');
  const keys = itermKeys(root, p);
  if (keys.keys.length) look.keys = keys.keys;
  if (keys.skipped) notes.push(`${keys.skipped === 1 ? 'One of your key mappings does' : `${keys.skipped} of your key mappings do`} something Beluga's terminal hasn't got, so ${keys.skipped === 1 ? 'it stays' : 'they stay'} behind.`);
  return { look: cleanLook(look), notes, ...(postscript ? { postscript } : {}) };
}

// ---- Terminal (Terminal.app)

const TERMINAL_ANSI = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];

/** Terminal's preferences (com.apple.Terminal.plist): the default profile ("Default Window Settings"). */
export function parseTerminalApp(prefs: Plist | undefined): Parsed {
  const root = asDict(prefs);
  const all = asDict(root?.['Window Settings']);
  const want = typeof root?.['Default Window Settings'] === 'string' ? root['Default Window Settings'] : 'Basic';
  const p = asDict(all?.[want]);
  if (!p) return { look: { profile: want }, notes: [`Terminal's “${want}” profile is one of its own, unchanged: nothing to bring.`] };
  const look: Mutable<TerminalLook> = { profile: want };
  const notes: string[] = [];
  const c = (key: string): string | undefined => archivedColor(p[key]);
  const colors = makeColors({
    background: c('BackgroundColor'),
    foreground: c('TextColor'),
    cursor: c('CursorColor'),
    selection: c('SelectionColor'),
    ansi: [...TERMINAL_ANSI.map((n) => c(`ANSI${n}Color`)), ...TERMINAL_ANSI.map((n) => c(`ANSIBright${n}Color`))],
  });
  look.theme = theme(want, colors);
  if (!look.theme) notes.push(`The “${want}” profile uses Terminal’s standard colours, so Beluga keeps its own.`);
  const font = archivedFont(p['Font']);
  let postscript: string | undefined;
  if (font) {
    postscript = font.name;
    look.font = familyFromPostScript(font.name);
    look.fontSize = font.size;
  }
  look.lineHeight = lineScale(num(p['FontHeightSpacing']));
  const cursor = num(p['CursorType']);
  if (cursor !== undefined) look.cursor = cursor === 1 ? 'underline' : cursor === 2 ? 'bar' : 'block';
  look.cursorBlink = bool(p['CursorBlink']);
  look.optionMeta = bool(p['useOptionAsMetaKey']);
  if (p['ShouldLimitScrollback'] === true) look.scrollback = num(p['ScrollbackLines']);
  else if (p['ShouldLimitScrollback'] === false) look.scrollback = 100_000;
  return { look: cleanLook(look) ?? { profile: want }, notes, ...(postscript ? { postscript } : {}) };
}

// ---- Alacritty

function deepMerge(a: LooseTable, b: LooseTable): LooseTable {
  const out: LooseTable = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const x = asTable(out[k]);
    const y = asTable(v);
    out[k] = x && y ? deepMerge(x, y) : v;
  }
  return out;
}

const at = (t: Loose | undefined, ...keys: string[]): Loose | undefined => {
  let v: Loose | undefined = t;
  for (const k of keys) v = asTable(v)?.[k];
  return v;
};

/** Alacritty's colours table ([colors]) → colours. */
function alacrittyColors(c: Loose | undefined): TermColors {
  const normal = asTable(at(c, 'normal'));
  const bright = asTable(at(c, 'bright'));
  return makeColors({
    background: at(c, 'primary', 'background'),
    foreground: at(c, 'primary', 'foreground'),
    cursor: at(c, 'cursor', 'cursor'),
    cursorText: at(c, 'cursor', 'text'),
    selection: at(c, 'selection', 'background'),
    selectionText: at(c, 'selection', 'text'),
    ansi: [...ANSI_NAMES.map((n) => normal?.[n]), ...ANSI_NAMES.map((n) => bright?.[n])],
  });
}

/** Alacritty's alacritty.toml (or the older alacritty.yml, `yaml`), with the files it imports through `read`. */
export function parseAlacritty(text: string, read: ReadFile = () => undefined, yaml = false): Parsed {
  const notes: string[] = [];
  const own = yaml ? parseYaml(text) : parseToml(text);
  const imports = at(own, 'general', 'import') ?? own['import'];
  let cfg: LooseTable = {};
  for (const file of Array.isArray(imports) ? imports : []) {
    if (typeof file !== 'string') continue;
    const body = read(file);
    if (body === undefined) notes.push(`The imported file ${file} wasn't found.`);
    else cfg = deepMerge(cfg, /\.ya?ml$/i.test(file) ? parseYaml(body) : parseToml(body));
  }
  cfg = deepMerge(cfg, own);
  const look: Mutable<TerminalLook> = {};
  look.theme = theme('Alacritty', alacrittyColors(cfg['colors']));
  const family = at(cfg, 'font', 'normal', 'family');
  if (typeof family === 'string') look.font = family;
  look.fontSize = num(at(cfg, 'font', 'size'));
  const y = num(at(cfg, 'font', 'offset', 'y'));
  if (y) look.lineHeight = lineScale(1 + y / ((look.fontSize ?? 11.25) * NATURAL_LINE_HEIGHT));
  const style = at(cfg, 'cursor', 'style');
  const shape = typeof style === 'string' ? style : at(style, 'shape');
  if (typeof shape === 'string') look.cursor = /beam/i.test(shape) ? 'bar' : /underline/i.test(shape) ? 'underline' : 'block';
  const blink = at(style, 'blinking');
  if (typeof blink === 'string') look.cursorBlink = /^(on|always)$/i.test(blink);
  look.scrollback = num(at(cfg, 'scrolling', 'history'));
  const alt = at(cfg, 'window', 'option_as_alt');
  if (typeof alt === 'string') look.optionMeta = !/^none$/i.test(alt);
  const opacity = num(at(cfg, 'window', 'opacity'));
  if (opacity !== undefined && opacity < 1) notes.push('A see-through background stays solid in Beluga.');
  return { look: cleanLook(look), notes };
}

// ---- kitty

/** kitty's kitty.conf (`key value` lines), with the files it includes (a theme, usually) through `read`. */
export function parseKitty(text: string, read: ReadFile = () => undefined): Parsed {
  const notes: string[] = [];
  const pairs: Array<[string, string]> = [];
  const walk = (body: string, depth: number): void => {
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const [, k, v] = m as unknown as [string, string, string];
      if (k === 'include' && depth < 4) {
        const inc = read(v.trim());
        if (inc === undefined) notes.push(`The included file ${v.trim()} wasn't found.`);
        else walk(inc, depth + 1);
      } else pairs.push([k, v.trim()]);
    }
  };
  walk(text, 0);
  const last = (key: string): string | undefined => pairs.filter(([k]) => k === key).at(-1)?.[1];
  const look: Mutable<TerminalLook> = {};
  look.theme = theme(
    'kitty',
    makeColors({
      background: last('background'),
      foreground: last('foreground'),
      cursor: last('cursor'),
      cursorText: last('cursor_text_color'),
      selection: last('selection_background'),
      selectionText: last('selection_foreground'),
      ansi: Array.from({ length: 16 }, (_, i) => last(`color${i}`)),
    }),
  );
  const family = last('font_family');
  if (family && family !== 'monospace' && family !== 'auto') {
    // kitty 0.36+: font_family family="JetBrains Mono" style=…
    const named = /family=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(family);
    look.font = named ? (named[1] ?? named[2] ?? named[3])! : unquote(family);
  }
  look.fontSize = num(last('font_size'));
  const shape = last('cursor_shape');
  if (shape) look.cursor = shape === 'beam' ? 'bar' : shape === 'underline' ? 'underline' : 'block';
  const blink = num(last('cursor_blink_interval')?.split(/\s+/)[0]);
  if (blink !== undefined) look.cursorBlink = blink !== 0;
  const lines = num(last('scrollback_lines'));
  if (lines !== undefined) look.scrollback = lines < 0 ? 100_000 : lines;
  const cell = /cell_height\s+(-?[\d.]+)(%|px)?/.exec(pairs.filter(([k]) => k === 'modify_font').map(([, v]) => v).find((v) => v.startsWith('cell_height')) ?? '') ?? (last('adjust_line_height') ? /^()(-?[\d.]+)(%)?$/.exec(last('adjust_line_height')!) : null);
  if (cell) {
    const n = Number(cell[1] || cell[2]);
    const pct = (cell[1] ? cell[2] : cell[3]) === '%';
    look.lineHeight = lineScale(pct ? n / 100 : 1 + n / ((look.fontSize ?? 11) * NATURAL_LINE_HEIGHT));
  }
  const alt = last('macos_option_as_alt');
  if (alt) look.optionMeta = alt !== 'no';
  const opacity = num(last('background_opacity'));
  if (opacity !== undefined && opacity < 1) notes.push('A see-through background stays solid in Beluga.');
  return { look: cleanLook(look), notes };
}

// ---- WezTerm

/** WezTerm's colour scheme file (~/.config/wezterm/colors/*.toml) → its name and colours. */
export function parseWeztermScheme(text: string): { name?: string; colors: TermColors } {
  const t = parseToml(text);
  const c = asTable(t['colors']) ?? {};
  const name = at(t, 'metadata', 'name');
  return { ...(typeof name === 'string' ? { name } : {}), colors: weztermColors(c) };
}

function weztermColors(c: LooseTable): TermColors {
  const list = (v: Loose | undefined): Loose[] => Array.from({ length: 8 }, (_, i) => (Array.isArray(v) ? (v[i] ?? null) : null));
  return makeColors({ background: c['background'], foreground: c['foreground'], cursor: c['cursor_bg'], cursorText: c['cursor_fg'], selection: c['selection_bg'], selectionText: c['selection_fg'], ansi: [...list(c['ansi']), ...list(c['brights'])] });
}

/** The `{ … }` that starts at `open` (Lua tables nest). */
function luaBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** A Lua table of colours (`colors = { foreground = '#…', ansi = { … } }`) → a loose table. */
function luaColors(block: string): LooseTable {
  const out: LooseTable = {};
  for (const m of block.matchAll(/\b(ansi|brights)\s*=\s*\{([^}]*)\}/g)) out[m[1]!] = [...m[2]!.matchAll(/(['"])(.*?)\1/g)].map((x) => x[2]!);
  // Only its own keys: not the ones of tables inside it (tab_bar = { background = … }).
  let flat = block.slice(1, -1);
  for (let prev = ''; prev !== flat; ) [prev, flat] = [flat, flat.replace(/\{[^{}]*\}/g, '')];
  for (const m of flat.matchAll(/(\w+)\s*=\s*(['"])(.*?)\2/g)) out[m[1]!] = m[3]!;
  return out;
}

/**
 * WezTerm's wezterm.lua, best effort: it's a program, so this reads the usual lines
 * (`config.color_scheme = '…'`, `font = wezterm.font('…')`, `font_size`, `colors = { … }`…).
 * `read('scheme:<name>')` gets a colour scheme's TOML by name.
 */
export function parseWezterm(text: string, read: ReadFile = () => undefined): Parsed {
  const notes: string[] = [];
  const src = text
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
  const look: Mutable<TerminalLook> = {};
  const str = (key: string): string | undefined => {
    const all = [...src.matchAll(new RegExp(`\\b${key}\\s*=\\s*(['"])(.*?)\\1`, 'g'))];
    return all.at(-1)?.[2];
  };
  const number = (key: string): number | undefined => num([...src.matchAll(new RegExp(`\\b${key}\\s*=\\s*(-?[\\d.]+)`, 'g'))].at(-1)?.[1]);
  const scheme = str('color_scheme');
  let colors: TermColors | undefined;
  let name = 'WezTerm';
  if (scheme) {
    const body = read(`scheme:${scheme}`);
    if (body !== undefined) {
      // Its own scheme files have a [colors] table; the rest come as Ghostty theme files of the same name.
      colors = body.includes('[colors]') ? parseWeztermScheme(body).colors : ghosttyColors(ghosttyLines(body));
      name = scheme;
    } else notes.push(`WezTerm's built-in scheme “${scheme}” isn't readable from outside WezTerm.`);
  }
  const block = /\bcolors\s*=\s*\{/.exec(src);
  if (block) colors = overlay(colors, weztermColors(luaColors(luaBlock(src, block.index + block[0].length - 1))));
  if (colors) look.theme = theme(name, colors);
  const font = /\bfont\s*=\s*wezterm\.font(?:_with_fallback)?\s*\(?\s*\{?\s*\{?\s*(?:family\s*=\s*)?(['"])(.+?)\1/.exec(src);
  if (font) look.font = font[2]!;
  look.fontSize = number('font_size');
  look.lineHeight = lineScale(number('line_height'));
  const cursor = str('default_cursor_style');
  if (cursor) {
    look.cursor = /bar/i.test(cursor) ? 'bar' : /underline/i.test(cursor) ? 'underline' : 'block';
    look.cursorBlink = /^blinking/i.test(cursor);
  }
  look.scrollback = number('scrollback_lines');
  const composed = /\bsend_composed_key_when_left_alt_is_pressed\s*=\s*(true|false)/.exec(src);
  if (composed) look.optionMeta = composed[1] === 'false';
  const opacity = number('window_background_opacity');
  if (opacity !== undefined && opacity < 1) notes.push('A see-through background stays solid in Beluga.');
  return { look: cleanLook(look), notes };
}

/** `top`'s colours over `base`'s (slot by slot for the ANSI ones). */
function overlay(base: TermColors | undefined, top: TermColors): TermColors {
  return makeColors({ ...base, ...Object.fromEntries(Object.entries(top).filter(([k, v]) => k !== 'ansi' && v)), ansi: top.ansi.map((c, i) => c ?? base?.ansi[i] ?? null) });
}

// ---- Warp

/** A Warp theme (~/.warp/themes/*.yaml) → its name and colours. */
export function parseWarpTheme(text: string): { name?: string; colors: TermColors } {
  const y = parseYaml(text);
  const normal = asTable(at(y, 'terminal_colors', 'normal'));
  const bright = asTable(at(y, 'terminal_colors', 'bright'));
  const name = y['name'];
  return {
    ...(typeof name === 'string' ? { name } : {}),
    colors: makeColors({ background: y['background'], foreground: y['foreground'], cursor: y['cursor'] ?? y['accent'], ansi: [...ANSI_NAMES.map((n) => normal?.[n]), ...ANSI_NAMES.map((n) => bright?.[n])] }),
  };
}

/** Every key under `t` (dotted), for finding Warp's settings wherever a version keeps them. */
function flatten(t: LooseTable, prefix = '', out: Array<[string, Loose]> = [], depth = 0): Array<[string, Loose]> {
  for (const [k, v] of Object.entries(t)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const sub = asTable(v);
    if (sub && depth < 6) flatten(sub, key, out, depth + 1);
    else out.push([key, v]);
  }
  return out;
}

/**
 * Warp's settings (~/.warp/settings.toml; older versions keep the same names in its defaults,
 * passed as `extra`). `read('theme:<name>')` gets a theme's YAML by name: Warp's own themes are
 * inside the app, and only come along when another terminal has one of the same name.
 */
export function parseWarp(settings: string | undefined, read: ReadFile = () => undefined, extra: Readonly<Record<string, unknown>> = {}): Parsed {
  const notes: string[] = [];
  const flat = [...flatten(settings ? parseToml(settings) : {}), ...Object.entries(extra).map(([k, v]) => [k, v as Loose] as [string, Loose])];
  const find = (re: RegExp): Loose | undefined => flat.find(([k, v]) => re.test(k.split('.').at(-1)!) && v !== null && v !== '')?.[1];
  const look: Mutable<TerminalLook> = {};
  const rawTheme = find(/^(theme|selected_theme|Theme)$/i);
  let themeName: string | undefined;
  if (typeof rawTheme === 'string') {
    // Older Warp: "\"Dracula\"" or {"Custom":{"name":"…","path":"…"}} as JSON text.
    try {
      const j = JSON.parse(rawTheme) as unknown;
      themeName = typeof j === 'string' ? j : (asTable(asTable(j as Loose)?.['Custom'])?.['name'] as string | undefined);
    } catch {
      themeName = rawTheme;
    }
  } else if (asTable(rawTheme)) themeName = (asTable(rawTheme)?.['name'] ?? asTable(at(rawTheme, 'Custom'))?.['name']) as string | undefined;
  if (themeName) {
    const body = read(`theme:${themeName}`);
    if (body !== undefined) look.theme = theme(themeName, /^\s*[\w-]+\s*=/m.test(body) ? ghosttyColors(ghosttyLines(body)) : parseWarpTheme(body).colors);
    else notes.push(`Warp's built-in theme “${themeName}” isn't readable from outside Warp.`);
  }
  const font = find(/^(font_name|font_family|FontName)$/i);
  if (typeof font === 'string') look.font = font;
  look.fontSize = num(find(/^(font_size|FontSize)$/i));
  look.lineHeight = lineScale(num(find(/^(line_height_ratio|line_height|LineHeightRatio)$/i)));
  const blink = find(/^(cursor_blink|CursorBlink)$/i);
  look.cursorBlink = bool(blink);
  const meta = find(/^(left_option_key_meta|option_as_meta|ExtraMetaKeys|LeftOptionKeyMeta)$/i);
  look.optionMeta = bool(meta);
  if (!themeName && !look.font && !look.fontSize) notes.push('Warp is on its standard look: nothing to bring.');
  return { look: cleanLook(look), notes };
}
