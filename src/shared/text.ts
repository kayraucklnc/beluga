import stringWidth from 'string-width';
import type { LinkTarget } from './link-target.js';

/** A styled run of text. A line is a list of segments rendered side by side. */
export interface Seg {
  readonly text: string;
  readonly color?: string;
  /** Background color (used by the image renderer). */
  readonly bg?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly inverse?: boolean;
  readonly underline?: boolean;
  /** Clickable: a file, folder, URL or image mentioned in the chat. */
  readonly link?: LinkTarget;
}
export type Line = readonly Seg[];

export const width = (s: string): number => stringWidth(s);
export const lineWidth = (line: Line): number => line.reduce((n, s) => n + width(s.text), 0);
export const plain = (text: string, style: Omit<Seg, 'text'> = {}): Line => [{ text, ...style }];

/** Word-aware hard wrap that never returns lines wider than `max` columns. */
export function wrapText(text: string, max: number): string[] {
  const w = Math.max(4, max);
  const out: string[] = [];
  for (const para of text.replace(/\t/g, '  ').split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (width(line + word) <= w) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      while (width(line) > w) {
        let cut = w;
        while (cut > 1 && width(line.slice(0, cut)) > w) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Truncate a line to `max` columns, adding an ellipsis when cut. */
export function truncate(line: Line, max: number): Line {
  if (lineWidth(line) <= max) return line;
  const out: Seg[] = [];
  let used = 0;
  for (const seg of line) {
    const room = max - 1 - used;
    if (room <= 0) break;
    let text = seg.text;
    while (width(text) > room) text = text.slice(0, -1);
    out.push({ ...seg, text });
    used += width(text);
    if (text.length < seg.text.length) break;
  }
  return [...out, { text: '…', dim: true }];
}

/** Pad a line with spaces to exactly `cols` columns (truncating if needed). */
export function pad(line: Line, cols: number): Line {
  const fitted = truncate(line, cols);
  const gap = cols - lineWidth(fitted);
  return gap > 0 ? [...fitted, { text: ' '.repeat(gap) }] : fitted;
}

/** Pick the visible window of lines given a scroll offset from the bottom. */
export function windowLines<T>(lines: readonly T[], height: number, scrollFromBottom: number): T[] {
  const maxScroll = Math.max(0, lines.length - height);
  const scroll = Math.min(scrollFromBottom, maxScroll);
  const end = lines.length - scroll;
  return lines.slice(Math.max(0, end - height), end);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** Restyle columns [x0, x1] of a line (used for hover and keyboard highlights). */
export function highlightRange(line: Line, x0: number, x1: number, style: Omit<Seg, 'text'>): Line {
  const out: Seg[] = [];
  let x = 0;
  for (const seg of line) {
    const chars = [...seg.text];
    let buf = '';
    let bufHot: boolean | undefined;
    const flush = (): void => {
      if (!buf) return;
      out.push(bufHot ? { ...seg, ...style, text: buf } : { ...seg, text: buf });
      buf = '';
    };
    for (const ch of chars) {
      const hot = x >= x0 && x <= x1;
      if (bufHot !== undefined && hot !== bufHot) flush();
      bufHot = hot;
      buf += ch;
      x += width(ch);
    }
    flush();
  }
  return out;
}
