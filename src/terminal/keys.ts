/**
 * Keyboard helpers for the embedded terminal.
 *
 * Preferred path: forward raw stdin sequences straight to the PTY. Fallback:
 * `encodeKey` turns Ink's parsed `useInput(input, key)` pair back into the
 * bytes an xterm-compatible terminal would have sent.
 */

/** The subset of Ink's `Key` we look at (all optional so tests stay terse). */
export interface InkKeyLike {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly pageDown?: boolean;
  readonly pageUp?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly tab?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly meta?: boolean;
}

export interface EncodeOptions {
  /** DECCKM: arrows/Home/End send SS3 (`ESC O x`) instead of CSI. */
  readonly applicationCursor?: boolean;
}

const ESC = '\x1b';

/** xterm modifier parameter: 1 + shift + 2*alt + 4*ctrl (1 = none). */
const modifierParam = (key: InkKeyLike): number => 1 + (key.shift ? 1 : 0) + (key.meta ? 2 : 0) + (key.ctrl ? 4 : 0);

/** Arrows, Home, End: `CSI x`, `SS3 x` in application mode, `CSI 1;m x` with modifiers. */
function cursorKey(final: string, key: InkKeyLike, opts: EncodeOptions): string {
  const mod = modifierParam(key);
  if (mod > 1) return `${ESC}[1;${mod}${final}`;
  return opts.applicationCursor ? `${ESC}O${final}` : `${ESC}[${final}`;
}

/** PageUp/PageDown/Delete: `CSI n ~`, `CSI n;m ~` with modifiers. */
function tildeKey(code: number, key: InkKeyLike): string {
  const mod = modifierParam(key);
  return mod > 1 ? `${ESC}[${code};${mod}~` : `${ESC}[${code}~`;
}

/** Ctrl+<char> as a C0 control byte, or undefined when there is none. */
function ctrlChar(ch: string): string | undefined {
  if (ch === ' ' || ch === '@' || ch === '2') return '\x00';
  if (ch === '?') return '\x7f';
  const code = ch.toLowerCase().charCodeAt(0);
  if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60);
  if ('[\\]^_'.includes(ch)) return String.fromCharCode(ch.charCodeAt(0) & 0x1f);
  return undefined;
}

function specialKey(key: InkKeyLike, opts: EncodeOptions): string | undefined {
  if (key.upArrow) return cursorKey('A', key, opts);
  if (key.downArrow) return cursorKey('B', key, opts);
  if (key.rightArrow) return cursorKey('C', key, opts);
  if (key.leftArrow) return cursorKey('D', key, opts);
  if (key.home) return cursorKey('H', key, opts);
  if (key.end) return cursorKey('F', key, opts);
  if (key.pageUp) return tildeKey(5, key);
  if (key.pageDown) return tildeKey(6, key);
  if (key.delete) return tildeKey(3, key);
  if (key.escape) return ESC;
  if (key.return) return key.meta ? `${ESC}\r` : '\r';
  if (key.tab) return key.shift ? `${ESC}[Z` : '\t';
  if (key.backspace) return key.ctrl ? '\b' : key.meta ? `${ESC}\x7f` : '\x7f';
  return undefined;
}

/** Map an Ink `useInput` (input, key) pair to terminal input bytes. */
export function encodeKey(input: string, key: InkKeyLike, opts: EncodeOptions = {}): string {
  const special = specialKey(key, opts);
  if (special !== undefined) return special;
  let out = input;
  if (key.ctrl && input.length === 1) out = ctrlChar(input) ?? input;
  return key.meta && out !== '' ? ESC + out : out;
}

/** Kitty keyboard protocol form of Ctrl+] (`CSI 93;5u`), in case it is enabled. */
const KITTY_CTRL_BRACKET = `${ESC}[93;5u`;

/** Raw-stdin check for the "leave the terminal" chord: Ctrl+] (`\x1d`). */
export function isLeaveChord(data: string): boolean {
  return data === '\x1d' || data === KITTY_CTRL_BRACKET;
}

/** Same check for the Ink `useInput` fallback path. */
export function isLeaveKey(input: string, key: InkKeyLike): boolean {
  return isLeaveChord(input) || (Boolean(key.ctrl) && input === ']');
}
