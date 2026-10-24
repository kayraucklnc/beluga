/**
 * Terminal output Claude shows (a shell session, a command's output, a log): read as lines of
 * colored spans, the prompt's lines apart from what they printed, so the screens can draw it as a
 * terminal: ANSI colors drawn rather than shown as `\x1b[31m`, errors tinted, long output folded.
 * Pure: the Mac and the phone draw from the same reading.
 */

/** The 16 colors by name (each screen has its own soft palette for them); 256-color and RGB as hex. */
export const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
export type AnsiName = (typeof ANSI_NAMES)[number];

export interface Span {
  readonly text: string;
  readonly fg?: AnsiName | `#${string}`;
  readonly bg?: AnsiName | `#${string}`;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
}

export type LineKind = 'prompt' | 'output' | 'error' | 'warning' | 'ok';

export interface TermLine {
  readonly kind: LineKind;
  /** A prompt line's prompt ("$ ", "~/app ❯ "), apart from its command. */
  readonly prompt?: string;
  readonly spans: readonly Span[];
}

export interface Terminal {
  readonly lines: readonly TermLine[];
  /** The commands typed, for "Copy Commands". */
  readonly commands: readonly string[];
  /** The text without colors, for "Copy". */
  readonly plain: string;
}

/** Fences that are always a terminal. */
export const TERMINAL_FENCE = /^(console|terminal|term|shell-session|sh-session|shellsession|bash-session|zsh-session|ansi|output|stdout|stderr|log|logs)$/;
/** Fences that are one when they read as a session (a prompt, then what it printed). */
const MAYBE_FENCE = /^(|sh|bash|shell|zsh|fish|text|txt|plain|plaintext)$/;

// ESC itself, or written out: \x1b, \u001b, \033, \e, ^[
const ESC_TEXT = /(?:\\x1[bB]|\\u001[bB]|\\033|\\e|\^\[)(?=\[|\])/g;
const CSI = /\x1b\[([0-9;:?]*)([A-Za-z])/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const HAS_ANSI = /\x1b\[[0-9;]*m|(?:\\x1[bB]|\\u001[bB]|\\033|\\e|\^\[)\[[0-9;]*m/;

const PROMPT = /^(\s*(?:\([\w.@-]+\)\s+)?(?:[\w.-]+@[\w.-]+(?::\S*)?\s*)?(?:[~/.][^\s$%❯➜]*\s*)?(?:\$|%|❯|➜|λ|PS [^>\n]*>)\s)(?=\S)/;
const ERROR = /(^|[\s[(])(error|err!|errors?:|failed|failure|fail|fatal|exception|traceback|panic(?:ked)?|segmentation fault|denied|not found|cannot|can't|✗|✖|✘|×)(?=$|[\s:\]).,!])/i;
const WARNING = /(^|[\s[(])(warn(?:ing)?|deprecated|⚠)(?=$|[\s:\]).,!])/i;
const OK = /(^|[\s[(])(✓|✔|pass(?:ed|es)?|ok|success(?:ful(?:ly)?)?|done|ready|compiled successfully)(?=$|[\s:\]).,!])/i;
const MAX_LINES = 5000;

interface Style {
  fg?: Span['fg'];
  bg?: Span['bg'];
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const hex = (r: number, g: number, b: number): `#${string}` => `#${[r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('')}`;

/** A 256-color index as a name (0–15) or hex. */
function color256(n: number): Span['fg'] {
  if (n < 16) return ANSI_NAMES[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return hex(v, v, v);
  }
  const i = n - 16;
  const step = (x: number): number => (x ? 55 + x * 40 : 0);
  return hex(step(Math.floor(i / 36)), step(Math.floor(i / 6) % 6), step(i % 6));
}

function applySgr(style: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)));
  let s: Style = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) (delete s.bold, delete s.dim);
    else if (c === 23) delete s.italic;
    else if (c === 24) delete s.underline;
    else if (c >= 30 && c <= 37) s.fg = ANSI_NAMES[c - 30];
    else if (c >= 90 && c <= 97) s.fg = ANSI_NAMES[c - 90 + 8];
    else if (c === 39) delete s.fg;
    else if (c >= 40 && c <= 47) s.bg = ANSI_NAMES[c - 40];
    else if (c >= 100 && c <= 107) s.bg = ANSI_NAMES[c - 100 + 8];
    else if (c === 49) delete s.bg;
    else if (c === 38 || c === 48) {
      const key = c === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        s[key] = color256(codes[i + 2]!);
        i += 2;
      } else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
        s[key] = hex(codes[i + 2]!, codes[i + 3]!, codes[i + 4]!);
        i += 4;
      }
    }
  }
  return s;
}

const spanOf = (text: string, s: Style): Span => ({ text, ...s });

/** Text with ANSI escapes → lines of spans (other escapes dropped; a carriage return writes over its line). */
export function parseAnsi(input: string): Span[][] {
  const text = input.replace(ESC_TEXT, '\x1b').replace(OSC, '').replace(/\r\n/g, '\n');
  const out: Span[][] = [];
  let style: Style = {};
  for (const rawLine of text.split('\n').slice(0, MAX_LINES)) {
    // A progress bar redraws its line: only what was written last shows.
    const parts = rawLine.split('\r');
    const line = parts.filter((p, i) => i === parts.length - 1 || p).at(-1) ?? '';
    const spans: Span[] = [];
    let at = 0;
    CSI.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CSI.exec(line))) {
      if (m.index > at) spans.push(spanOf(line.slice(at, m.index), style));
      if (m[2] === 'm') style = applySgr(style, m[1]!);
      at = m.index + m[0].length;
    }
    if (at < line.length) spans.push(spanOf(line.slice(at).replace(/\x1b/g, ''), style));
    out.push(spans.filter((s) => s.text));
  }
  return out;
}

const plainOf = (spans: readonly Span[]): string => spans.map((s) => s.text).join('');

/** The prompt at the start of a line ("$ ", "user@box:~/app$ "), if it has one. */
export function promptOf(line: string): string | undefined {
  return PROMPT.exec(line)?.[1];
}

/** How a line of output reads: an error, a warning, a pass, or just output. */
export function toneOfLine(raw: string): LineKind {
  // "0 failed", "no errors" isn't a problem.
  const line = raw.replace(/\b(?:0|no) (?:failed|failures?|errors?|warnings?)\b/gi, '');
  if (ERROR.test(line)) return 'error';
  if (WARNING.test(line)) return 'warning';
  if (OK.test(line)) return 'ok';
  return 'output';
}

/** Whether a fence holds a terminal: one that says so, ANSI colors, or a session (a prompt with output after it). */
export function isTerminal(lang: string, body: string): boolean {
  const l = lang.toLowerCase();
  if (TERMINAL_FENCE.test(l)) return true;
  if (!MAYBE_FENCE.test(l)) return false;
  if (HAS_ANSI.test(body)) return true;
  const lines = body.split('\n').filter((x) => x.trim());
  if (lines.length < 2 || !promptOf(lines[0]!)) return false;
  // Only commands (each line a prompt) is a script to copy, not a session.
  return lines.some((x) => !promptOf(x));
}

/** A terminal's lines, prompts apart, each output line toned (unless it's colored already). */
export function readTerminal(body: string): Terminal {
  const rows = parseAnsi(body.replace(/\n+$/, ''));
  const commands: string[] = [];
  const lines: TermLine[] = rows.map((spans) => {
    const text = plainOf(spans);
    const prompt = promptOf(text);
    if (prompt) {
      commands.push(text.slice(prompt.length));
      // The prompt's characters come off the spans' front.
      let left = prompt.length;
      const rest: Span[] = [];
      for (const s of spans) {
        if (left >= s.text.length) {
          left -= s.text.length;
          continue;
        }
        rest.push(left ? { ...s, text: s.text.slice(left) } : s);
        left = 0;
      }
      return { kind: 'prompt', prompt, spans: rest };
    }
    const colored = spans.some((s) => s.fg || s.bg);
    return { kind: colored ? 'output' : toneOfLine(text), spans };
  });
  return { lines, commands, plain: rows.map(plainOf).join('\n') };
}

/** How many lines show before "Show all" (the last ones, where the result is). */
export const TERMINAL_FOLD = 24;
