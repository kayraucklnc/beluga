import { type Plist, asDict } from './formats.js';

/**
 * Bringing your terminal's keys into Beluga's terminal view (BLG-537): Ghostty's `keybind = …`
 * lines and iTerm2's key mappings and menu shortcuts, in Beluga's terms. A key is a chord as
 * Beluga writes one ("Shift+Cmd+D": Ctrl, Alt, Shift, Cmd, then the key) and what it does. What
 * Beluga's terminal has no action for is counted, never guessed. Pure: no files.
 */

/** What a key does in Beluga's terminal view (packages/mac/src/lib/term-keys.ts runs them). */
export const TERM_ACTIONS = [
  'new_tab',
  'close',
  'next_tab',
  'prev_tab',
  'split_right',
  'split_down',
  'focus_left',
  'focus_right',
  'focus_up',
  'focus_down',
  'focus_prev',
  'focus_next',
  'zoom',
  'find',
  'clear',
  'font_up',
  'font_down',
  'font_reset',
  'copy',
  'paste',
  'select_all',
  'newest_visual',
  'unbind',
] as const;
export type TermActionName = (typeof TERM_ACTIONS)[number];
/** An action, `tab:3` (that tab), or `text:…` (these characters typed into the program). */
export type TermAction = TermActionName | `tab:${number}` | `text:${string}`;

export interface ImportedKey {
  readonly chord: string;
  readonly action: TermAction;
}

export interface ImportedKeys {
  readonly keys: readonly ImportedKey[];
  /** How many of theirs Beluga has nothing for (a new window, a quick terminal…). */
  readonly skipped: number;
}

const MODS = ['Ctrl', 'Alt', 'Shift', 'Cmd'] as const;
type Mods = { ctrl: boolean; alt: boolean; shift: boolean; cmd: boolean };

/** A chord as Beluga writes one. */
export const chordFrom = (m: Mods, key: string): string => [...MODS.filter((x) => m[x.toLowerCase() as keyof Mods]), key].join('+');

const isAction = (a: string): a is TermAction => (TERM_ACTIONS as readonly string[]).includes(a) || /^tab:[1-9]$/.test(a) || a.startsWith('text:');

// ---- Ghostty

const GHOSTTY_KEYS: Readonly<Record<string, string>> = {
  left: 'Left', right: 'Right', up: 'Up', down: 'Down', arrow_left: 'Left', arrow_right: 'Right', arrow_up: 'Up', arrow_down: 'Down',
  enter: 'Enter', return: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', escape: 'Escape', space: 'Space',
  home: 'Home', end: 'End', page_up: 'PageUp', page_down: 'PageDown',
  bracket_left: '[', left_bracket: '[', bracket_right: ']', right_bracket: ']', equal: '=', plus: '=', minus: '-', comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';', apostrophe: "'", quote: "'", grave_accent: '`', backquote: '`',
};

/** Ghostty's `super+shift+d` → a chord, or undefined (a sequence like `ctrl+a>n`, an unknown key). */
export function ghosttyChord(trigger: string): string | undefined {
  const t = trigger.trim().replace(/^((global|all|unconsumed|performable):)+/, '');
  if (!t || t.includes('>')) return undefined;
  const parts = t.split('+');
  // "super++" is the plus key.
  const rawKey = t.endsWith('++') ? '=' : parts.pop()!.toLowerCase();
  if (t.endsWith('++')) parts.splice(-2);
  const m: Mods = { ctrl: false, alt: false, shift: false, cmd: false };
  for (const p of parts.map((x) => x.toLowerCase())) {
    if (p === 'super' || p === 'cmd' || p === 'command') m.cmd = true;
    else if (p === 'ctrl' || p === 'control') m.ctrl = true;
    else if (p === 'alt' || p === 'opt' || p === 'option') m.alt = true;
    else if (p === 'shift') m.shift = true;
    else return undefined;
  }
  const bare = rawKey.replace(/^key_/, '').replace(/^physical:/, '');
  const key = GHOSTTY_KEYS[bare] ?? (/^[a-z0-9]$/.test(bare) ? bare.toUpperCase() : /^digit_\d$/.test(bare) ? bare.slice(6) : /^f\d{1,2}$/.test(bare) ? bare.toUpperCase() : bare.length === 1 && /[[\]=\-,./\\;'`]/.test(bare) ? bare : undefined);
  return key ? chordFrom(m, key) : undefined;
}

/** Ghostty's escapes in `text:` (Zig's: \x1b, \n, \r, \t, \\). */
const unescapeZig = (s: string): string => s.replace(/\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|[nrt\\"'])/g, (_m, e: string) => (e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : e[0] === 'u' ? String.fromCodePoint(parseInt(e.slice(2, -1), 16)) : e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e));

/** Ghostty's action → Beluga's, or undefined when it has none. */
export function ghosttyAction(raw: string): TermAction | undefined {
  const [name = '', arg = ''] = raw.trim().split(/:(.*)/s);
  switch (name) {
    case 'new_tab':
      return 'new_tab';
    case 'close_surface':
    case 'close_tab':
      return 'close';
    case 'next_tab':
      return 'next_tab';
    case 'previous_tab':
      return 'prev_tab';
    case 'goto_tab':
      return /^[1-9]$/.test(arg) ? (`tab:${Number(arg)}` as TermAction) : undefined;
    case 'last_tab':
      return 'tab:9';
    case 'new_split':
      return arg === 'down' || arg === 'up' ? 'split_down' : 'split_right';
    case 'goto_split':
      return ({ left: 'focus_left', right: 'focus_right', top: 'focus_up', up: 'focus_up', bottom: 'focus_down', down: 'focus_down', previous: 'focus_prev', next: 'focus_next' } as const)[arg as 'left'];
    case 'toggle_split_zoom':
      return 'zoom';
    case 'start_search':
    case 'search':
      return 'find';
    case 'clear_screen':
      return 'clear';
    case 'increase_font_size':
      return 'font_up';
    case 'decrease_font_size':
      return 'font_down';
    case 'reset_font_size':
      return 'font_reset';
    case 'copy_to_clipboard':
      return 'copy';
    case 'paste_from_clipboard':
      return 'paste';
    case 'select_all':
      return 'select_all';
    case 'unbind':
    case 'ignore':
      return 'unbind';
    case 'text':
      return arg ? (`text:${unescapeZig(arg)}` as TermAction) : undefined;
    case 'esc':
      return arg ? (`text:\x1b${unescapeZig(arg)}` as TermAction) : undefined;
    case 'csi':
      return arg ? (`text:\x1b[${unescapeZig(arg)}` as TermAction) : undefined;
    default:
      return undefined;
  }
}

/** Ghostty's `keybind = …` lines (in order: a later one for the same key wins). */
export function ghosttyKeys(lines: ReadonlyArray<readonly [string, string]>): ImportedKeys {
  const out = new Map<string, TermAction>();
  let skipped = 0;
  for (const [k, v] of lines) {
    if (k !== 'keybind' || !v) continue;
    if (v === 'clear') {
      out.clear();
      continue;
    }
    // trigger=action, the trigger possibly ending in "=" itself (super+==increase_font_size:1).
    const split = /^(.+?)=([a-z_]+(?::.*)?)$/s.exec(v);
    const chord = split ? ghosttyChord(split[1]!) : undefined;
    const action = split ? ghosttyAction(split[2]!) : undefined;
    if (!chord || !action) {
      skipped++;
      continue;
    }
    out.delete(chord);
    out.set(chord, action);
  }
  return { keys: [...out].map(([chord, action]) => ({ chord, action })), skipped };
}

// ---- iTerm2

/** iTerm2's modifier flags (NSEventModifierFlags). */
const SHIFT = 0x20000;
const CTRL = 0x40000;
const ALT = 0x80000;
const CMD = 0x100000;

const ITERM_SPECIAL: Readonly<Record<number, string>> = { 0xf700: 'Up', 0xf701: 'Down', 0xf702: 'Left', 0xf703: 'Right', 0xf728: 'Delete', 0x7f: 'Backspace', 0x0d: 'Enter', 0x03: 'Enter', 0x09: 'Tab', 0x1b: 'Escape', 0x20: 'Space', 0xf729: 'Home', 0xf72b: 'End', 0xf72c: 'PageUp', 0xf72d: 'PageDown' };

/** A key's character (a code) as Beluga names it, or undefined. */
function itermKeyName(code: number): string | undefined {
  if (ITERM_SPECIAL[code]) return ITERM_SPECIAL[code];
  if (code >= 0xf704 && code <= 0xf70f) return `F${code - 0xf704 + 1}`;
  const ch = String.fromCharCode(code);
  if (/^[a-zA-Z0-9]$/.test(ch)) return ch.toUpperCase();
  return /^[[\]=\-,./\\;'`]$/.test(ch) ? ch : undefined;
}

/** iTerm2's `0x62-0x80000` (character, modifier flags, maybe a key code) → a chord. */
export function itermChord(key: string): string | undefined {
  const m = /^0x([0-9a-f]+)-0x([0-9a-f]+)/i.exec(key);
  if (!m) return undefined;
  const name = itermKeyName(parseInt(m[1]!, 16));
  const flags = parseInt(m[2]!, 16);
  return name ? chordFrom({ ctrl: Boolean(flags & CTRL), alt: Boolean(flags & ALT), shift: Boolean(flags & SHIFT), cmd: Boolean(flags & CMD) }, name) : undefined;
}

/** iTerm2's key actions that type something (the ones a key mapping is mostly for). */
function itermAction(value: Plist | undefined): TermAction | undefined {
  const v = asDict(value);
  const action = typeof v?.['Action'] === 'number' ? v['Action'] : undefined;
  const text = typeof v?.['Text'] === 'string' ? v['Text'] : '';
  // 10: send an escape sequence (Esc + the text), 11: hex codes, 12: text, 13: ignore.
  if (action === 10 && text) return `text:\x1b${text}`;
  if (action === 11 && text) {
    const bytes = text.split(/[\s,]+/).filter(Boolean).map((h) => parseInt(h, 16));
    return bytes.length && bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 0x110000) ? `text:${String.fromCodePoint(...bytes)}` : undefined;
  }
  if (action === 12 && text) return `text:${text.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\e/g, '\x1b')}`;
  if (action === 13) return 'unbind';
  return undefined;
}

/** iTerm2's menu items → Beluga's actions (its menu shortcuts, changed in macOS's or iTerm2's settings). */
const ITERM_MENUS: Readonly<Record<string, TermAction>> = {
  'New Tab': 'new_tab',
  'New Tab with Current Profile': 'new_tab',
  Close: 'close',
  'Select Next Tab': 'next_tab',
  'Select Previous Tab': 'prev_tab',
  'Split Vertically with Current Profile': 'split_right',
  'Split Horizontally with Current Profile': 'split_down',
  'Select Pane Left': 'focus_left',
  'Select Pane Right': 'focus_right',
  'Select Pane Above': 'focus_up',
  'Select Pane Below': 'focus_down',
  'Select Next Pane': 'focus_next',
  'Select Previous Pane': 'focus_prev',
  'Maximize Active Pane': 'zoom',
  'Find…': 'find',
  'Find...': 'find',
  'Clear Buffer': 'clear',
  'Make Text Bigger': 'font_up',
  'Make Text Smaller': 'font_down',
  'Make Text Normal Size': 'font_reset',
};

/** A menu shortcut as macOS keeps it ("@$d": ⇧⌘D) → a chord. */
export function menuEquivalentChord(eq: string): string | undefined {
  const m: Mods = { ctrl: false, alt: false, shift: false, cmd: false };
  let i = 0;
  for (; i < eq.length - 1; i++) {
    const c = eq[i];
    if (c === '@') m.cmd = true;
    else if (c === '^') m.ctrl = true;
    else if (c === '~') m.alt = true;
    else if (c === '$') m.shift = true;
    else break;
  }
  const rest = eq.slice(i);
  if ([...rest].length !== 1) return undefined;
  const code = rest.codePointAt(0)!;
  if (/^[A-Z]$/.test(rest)) m.shift = true;
  const name = itermKeyName(code);
  return name ? chordFrom(m, name) : undefined;
}

/** iTerm2's keys: the profile's key mappings, the global ones, and its menu shortcuts. */
export function itermKeys(root: Readonly<Record<string, Plist>> | undefined, profile: Readonly<Record<string, Plist>> | undefined): ImportedKeys {
  const out = new Map<string, TermAction>();
  let skipped = 0;
  const maps = [asDict(root?.['GlobalKeyMap']), asDict(profile?.['Keyboard Map'])];
  for (const map of maps) {
    for (const [key, value] of Object.entries(map ?? {})) {
      const chord = itermChord(key);
      const action = itermAction(value);
      if (!chord || !action) {
        skipped++;
        continue;
      }
      out.set(chord, action);
    }
  }
  for (const [title, eq] of Object.entries(asDict(root?.['NSUserKeyEquivalents']) ?? {})) {
    const action = ITERM_MENUS[title];
    const chord = typeof eq === 'string' ? menuEquivalentChord(eq) : undefined;
    if (!action || !chord) {
      if (typeof eq === 'string' && eq) skipped++;
      continue;
    }
    out.set(chord, action);
  }
  return { keys: [...out].map(([chord, action]) => ({ chord, action })).filter((k) => isAction(k.action)), skipped };
}
