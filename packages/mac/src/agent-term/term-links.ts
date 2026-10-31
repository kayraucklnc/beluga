import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import type { TermVisual } from '@beluga/shared/term-visuals.js';
import { chipCells, taskHits, visualHits } from '../lib/term-links.js';
import s from './agent-term.module.css';

/**
 * Links in the agent's terminal (BLG-535), on xterm.js: each `[[visual:N]]` token Claude wrote is
 * drawn over by a chip (what it is, Open) that opens the real visual beside the terminal; each
 * task key the board has is underlined and opens the task. The text under them stays the program's:
 * a chip follows its line as the terminal scrolls, and goes when that line no longer has the token
 * (the program redrew it). Clicks also work through xterm's link provider (hover, pointer).
 */

export interface TermLinkOptions {
  /** What a link to visual `n` says (from the shared state), when known yet. */
  readonly visual: (n: number) => TermVisual | undefined;
  readonly openVisual: (n: number) => void;
  readonly hasTask: (key: string) => boolean;
  readonly openTask: (key: string) => void;
}

/** One line's text, and the cell each character sits in (wide characters take two). */
function lineText(term: Terminal, y: number): { text: string; cells: number[] } | undefined {
  const line = term.buffer.active.getLine(y);
  if (!line) return undefined;
  let text = '';
  const cells: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // the second half of a wide character
    const chars = cell.getChars() || ' ';
    for (let i = 0; i < chars.length; i++) cells.push(x);
    text += chars;
  }
  cells.push(line.length);
  return { text: text.replace(/\s+$/, ''), cells };
}

const ICON: Record<string, string> = {
  graph: 'M4 4.5a1.5 1.5 0 1 0 0-.01 M12 8a1.5 1.5 0 1 0 0-.01 M4 11.5a1.5 1.5 0 1 0 0-.01 M5.4 5.2l5.2 2.3 M5.4 10.8l5.2-2.3',
  table: 'M2.5 3.5h11v9h-11z M2.5 6.5h11 M2.5 9.5h11 M6.5 3.5v9',
  chart: 'M2.5 2.5v11h11 M4.5 10.5l2.5-3 2 1.5 3.5-4.5',
  stats: 'M2.5 11a5.5 5.5 0 1 1 11 0 M8 11l2.5-3.5',
  gantt: 'M2.5 2.5v11 M4.5 4.5h4.5 M6.5 8h6.5 M5.5 11.5h3.5',
  heatmap: 'M2.5 2.5h11v11h-11z M2.5 8h11 M8 2.5v11',
  calendar: 'M2.5 4h11v9.5h-11z M2.5 6.5h11 M5.5 2.5v3 M10.5 2.5v3',
};

const svg = (kind: string): string => `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON[kind] ?? ICON.table}"/></svg>`;

const escape = (t: string): string => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** A chip's words: what it is, a few words more, and Open. */
function chipHtml(n: number, v: TermVisual | undefined): string {
  const title = v?.title ?? `Visual ${n}`;
  const meta = v?.meta ? `<span class="${s.chipMeta}">${escape(v.meta)}</span>` : '';
  return `<span class="${s.chipIcon}">${svg(v?.kind ?? 'table')}</span><span class="${s.chipTitle}">${escape(title)}</span>${meta}<span class="${s.chipOpen}">Open →</span>`;
}

/** How many cells a chip would like (its words), so it isn't cut when there's room. */
const wantCells = (n: number, v: TermVisual | undefined): number => 4 + (v?.title ?? `Visual ${n}`).length + (v?.meta ? v.meta.length + 2 : 0) + 8;

interface Placed {
  readonly marker: IMarker;
  readonly deco: IDecoration;
  readonly col: number;
  /** 'v7' for a visual, 't:BLG-12' for a task. */
  readonly id: string;
  /** The words it was drawn with (redrawn when what's known about it changes). */
  drawn?: string;
}

/** Lines looked at after each write (the rest of the scrollback was looked at before). */
const TAIL = 300;

/** Put links on a terminal → `refresh` (what's known about visuals changed) and `dispose`. */
export function attachTermLinks(term: Terminal, options: () => TermLinkOptions): { refresh: () => void; dispose: () => void } {
  const placed = new Map<string, Placed>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let all = true;

  const drop = (key: string): void => {
    const p = placed.get(key);
    if (!p) return;
    p.deco.dispose();
    p.marker.dispose();
    placed.delete(key);
  };
  const dropAll = (): void => {
    for (const key of [...placed.keys()]) drop(key);
  };

  const place = (y: number, col: number, cells: number, id: string, render: (el: HTMLElement, p: Placed) => void): void => {
    const buf = term.buffer.active;
    const marker = term.registerMarker(y - (buf.baseY + buf.cursorY));
    if (!marker) return;
    const deco = term.registerDecoration({ marker, x: col, width: cells, height: 1, layer: 'top' });
    if (!deco) return void marker.dispose();
    const p: Placed = { marker, deco, col, id };
    deco.onRender((el) => render(el, p));
    placed.set(`${marker.id}`, p);
  };

  const renderChip = (n: number) => (el: HTMLElement, p: Placed): void => {
    const v = options().visual(n);
    const words = `${v?.title}|${v?.meta}`;
    if (p.drawn === words && el.firstChild) return;
    p.drawn = words;
    el.classList.remove(s.taskLine!);
    el.classList.add(s.chip!);
    el.innerHTML = chipHtml(n, v);
    el.title = `${v?.title ?? 'Visual'}: open it beside the terminal`;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Open ${v?.title ?? `visual ${n}`}`);
    el.dataset.visual = String(n);
    el.onmousedown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      options().openVisual(n);
    };
  };

  const renderTask = (el: HTMLElement): void => {
    el.classList.add(s.taskLine!);
  };

  const scan = (): void => {
    timer = undefined;
    const buf = term.buffer.active;
    const end = buf.length;
    const from = all ? 0 : Math.max(0, end - Math.max(TAIL, term.rows * 2));
    all = false;
    const opts = options();
    // What's on each line now, by line.
    const want = new Map<number, Array<{ id: string; col: number; cells: number; n?: number }>>();
    for (let y = from; y < end; y++) {
      const line = lineText(term, y);
      if (!line || !line.text.includes('[[visual:') && !/[A-Z]-\d/.test(line.text)) continue;
      const here: Array<{ id: string; col: number; cells: number; n?: number }> = [];
      for (const hit of visualHits(line.text)) {
        const col = line.cells[hit.start] ?? hit.start;
        const endCol = line.cells[hit.end] ?? hit.end;
        const cells = chipCells(line.text, hit, wantCells(hit.n, opts.visual(hit.n)), term.cols) + (endCol - col - (hit.end - hit.start));
        here.push({ id: `v${hit.n}`, col, cells, n: hit.n });
      }
      for (const hit of taskHits(line.text, opts.hasTask)) {
        const col = line.cells[hit.start] ?? hit.start;
        here.push({ id: `t:${hit.key}`, col, cells: (line.cells[hit.end] ?? hit.end) - col });
      }
      if (here.length) want.set(y, here);
    }
    // Links placed before on the lines just read: kept where the line still has them, else gone.
    for (const [key, p] of [...placed]) {
      const y = p.marker.line;
      if (y < 0 || p.marker.isDisposed) {
        drop(key);
        continue;
      }
      if (y < from) continue;
      const here = want.get(y);
      const same = here?.find((w) => w.id === p.id && w.col === p.col);
      if (!same) drop(key);
      else here!.splice(here!.indexOf(same), 1);
    }
    for (const [y, list] of want) {
      for (const w of list) {
        if (w.n !== undefined) place(y, w.col, w.cells, w.id, renderChip(w.n));
        else place(y, w.col, w.cells, w.id, renderTask);
      }
    }
  };
  const later = (full = false): void => {
    if (full) all = true;
    if (timer === undefined) timer = setTimeout(scan, 60);
  };

  const links = term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = lineText(term, y - 1);
      if (!line) return callback(undefined);
      const opts = options();
      const range = (start: number, end: number) => ({ start: { x: (line.cells[start] ?? start) + 1, y }, end: { x: line.cells[end] ?? end, y } });
      const found = [
        ...visualHits(line.text).map((h) => ({ range: range(h.start, h.end), text: line.text.slice(h.start, h.end), activate: () => opts.openVisual(h.n), decorations: { pointerCursor: true, underline: false } })),
        ...taskHits(line.text, opts.hasTask).map((h) => ({ range: range(h.start, h.end), text: line.text.slice(h.start, h.end), activate: () => opts.openTask(h.key), decorations: { pointerCursor: true, underline: true } })),
      ];
      callback(found.length ? found : undefined);
    },
  });
  const wrote = term.onWriteParsed(() => later());
  // Reflowed lines (a new width) and the other screen (a full-screen program) are read again from the top.
  const resized = term.onResize(() => {
    dropAll();
    later(true);
  });
  const switched = term.buffer.onBufferChange(() => {
    dropAll();
    later(true);
  });
  later(true);
  return {
    // A chip's words (and so its width) changed: drawn again.
    refresh: () => {
      dropAll();
      later(true);
    },
    dispose: () => {
      clearTimeout(timer);
      links.dispose();
      wrote.dispose();
      resized.dispose();
      switched.dispose();
      dropAll();
    },
  };
}
