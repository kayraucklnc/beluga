import type { Line, Seg } from './text.js';

const BASIC = ['#1e2127', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#dcdfe4'];
const BRIGHT = ['#7f848e', '#ff7a85', '#b5e890', '#ffd68a', '#7cc4ff', '#de9bf0', '#7fd8e3', '#ffffff'];

interface Style {
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function xterm256(n: number): string {
  if (n < 8) return BASIC[n] ?? '#ffffff';
  if (n < 16) return BRIGHT[n - 8] ?? '#ffffff';
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `#${v.toString(16).padStart(2, '0').repeat(3)}`;
  }
  const i = n - 16;
  const level = (x: number): string => (x === 0 ? 0 : 55 + x * 40).toString(16).padStart(2, '0');
  return `#${level(Math.floor(i / 36))}${level(Math.floor(i / 6) % 6)}${level(i % 6)}`;
}

function applySgr(style: Style, params: number[]): Style {
  let s = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0;
    if (p === 0) s = {};
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 22) s = { ...s, bold: false, dim: false };
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p >= 30 && p <= 37) s.color = BASIC[p - 30];
    else if (p >= 90 && p <= 97) s.color = BRIGHT[p - 90];
    else if (p === 39) s.color = undefined;
    else if (p === 38 && params[i + 1] === 2) {
      const [r = 0, g = 0, b = 0] = params.slice(i + 2, i + 5);
      s.color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      i += 4;
    } else if (p === 38 && params[i + 1] === 5) {
      s.color = xterm256(params[i + 2] ?? 7);
      i += 2;
    } else if ((p === 48 && params[i + 1] === 2) || p === 58) i += 4;
    else if (p === 48 && params[i + 1] === 5) i += 2;
  }
  return s;
}

/**
 * Convert one line of ANSI-styled text into styled segments, so it can be measured,
 * padded and truncated exactly like the rest of the UI. Non-SGR escapes are dropped.
 */
export function ansiToLine(input: string): Line {
  const segs: Seg[] = [];
  let style: Style = {};
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
  let last = 0;
  const push = (text: string): void => {
    if (!text) return;
    const seg: Seg = { text, ...(style.color ? { color: style.color } : {}), ...(style.bold ? { bold: true } : {}), ...(style.dim ? { dim: true } : {}), ...(style.italic ? { italic: true } : {}), ...(style.underline ? { underline: true } : {}) };
    segs.push(seg);
  };
  for (const m of input.matchAll(re)) {
    push(input.slice(last, m.index));
    if (m[1] !== undefined) style = applySgr(style, m[1] === '' ? [0] : m[1].split(';').map(Number));
    last = (m.index ?? 0) + m[0].length;
  }
  push(input.slice(last));
  return segs;
}
