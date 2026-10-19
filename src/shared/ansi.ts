/**
 * Terminal colours in command output (ANSI SGR codes) as styled pieces, so a screen can draw
 * `npm test`'s green and red the way the terminal did. Other escape codes (cursor moves,
 * titles) are dropped. Browser-safe.
 */

export interface AnsiStyle {
  /** 0–15 (the terminal palette), or a #rrggbb colour. */
  readonly fg?: number | string;
  readonly bg?: number | string;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
}

export interface AnsiPiece {
  readonly text: string;
  readonly style: AnsiStyle;
}

// eslint-disable-next-line no-control-regex
const ESCAPE = /\u001b\[([0-9;?]*)([A-Za-z])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>78]/g;

const hex = (n: number): string => n.toString(16).padStart(2, '0');

/** 256-colour index → palette index (0–15) or #rrggbb. */
function color256(n: number): number | string {
  if (n < 16) return n;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `#${hex(v)}${hex(v)}${hex(v)}`;
  }
  const i = n - 16;
  const level = (x: number): number => (x === 0 ? 0 : 55 + x * 40);
  return `#${hex(level(Math.floor(i / 36)))}${hex(level(Math.floor(i / 6) % 6))}${hex(level(i % 6))}`;
}

function apply(style: AnsiStyle, codes: number[]): AnsiStyle {
  let s: { -readonly [K in keyof AnsiStyle]: AnsiStyle[K] } = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) s = { ...s, bold: undefined, dim: undefined };
    else if (c === 23) s.italic = undefined;
    else if (c === 24) s.underline = undefined;
    else if (c >= 30 && c <= 37) s.fg = c - 30;
    else if (c >= 90 && c <= 97) s.fg = c - 90 + 8;
    else if (c === 39) s.fg = undefined;
    else if (c >= 40 && c <= 47) s.bg = c - 40;
    else if (c >= 100 && c <= 107) s.bg = c - 100 + 8;
    else if (c === 49) s.bg = undefined;
    else if ((c === 38 || c === 48) && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
      s[c === 38 ? 'fg' : 'bg'] = color256(codes[i + 2]!);
      i += 2;
    } else if ((c === 38 || c === 48) && codes[i + 1] === 2 && codes[i + 4] !== undefined) {
      s[c === 38 ? 'fg' : 'bg'] = `#${hex(codes[i + 2]! & 255)}${hex(codes[i + 3]! & 255)}${hex(codes[i + 4]! & 255)}`;
      i += 4;
    }
  }
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as AnsiStyle;
}

/** Text with ANSI codes → pieces with their style (plain text comes back as one piece). */
export function parseAnsi(text: string): AnsiPiece[] {
  const out: AnsiPiece[] = [];
  let style: AnsiStyle = {};
  let at = 0;
  const push = (t: string): void => {
    // Carriage returns redraw a line (progress bars): keep what was drawn last.
    const cleaned = t.replace(/[^\n]*\r(?!\n)/g, '');
    if (!cleaned) return;
    const last = out[out.length - 1];
    if (last && last.style === style) out[out.length - 1] = { text: last.text + cleaned, style };
    else out.push({ text: cleaned, style });
  };
  for (const m of text.matchAll(ESCAPE)) {
    push(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[2] === 'm') style = apply(style, (m[1] || '0').split(';').map((n) => Number(n) || 0));
  }
  push(text.slice(at));
  return out;
}

/** The text without any escape codes. */
export const stripAnsi = (text: string): string => parseAnsi(text).map((p) => p.text).join('');
