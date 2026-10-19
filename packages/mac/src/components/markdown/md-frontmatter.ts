/**
 * YAML front matter (`---` … `---` at the very top), split off before the Markdown is read so
 * the reader can show it as a small table of its own.
 */

const FRONT = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export interface FrontMatter {
  /** The YAML between the fences, or undefined when there's none. */
  readonly yaml?: string;
  /** The Markdown after it. */
  readonly body: string;
  /** How many lines the front matter took (to keep source line numbers honest). */
  readonly lines: number;
}

export function splitFrontMatter(text: string): FrontMatter {
  const m = FRONT.exec(text);
  if (!m) return { body: text, lines: 0 };
  return { yaml: m[1], body: text.slice(m[0].length), lines: m[0].split('\n').length - (m[0].endsWith('\n') ? 1 : 0) };
}

/** One row of the metadata table: a key and its value as text. */
export interface MetaRow {
  readonly key: string;
  readonly value: string;
}

const show = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(show).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** Parsed front matter as rows (a mapping's keys; anything else is one row). */
export function metaRows(data: unknown): MetaRow[] {
  if (data && typeof data === 'object' && !Array.isArray(data) && !(data instanceof Date)) {
    return Object.entries(data as Record<string, unknown>).map(([key, value]) => ({ key, value: show(value) }));
  }
  return data === undefined || data === null ? [] : [{ key: '', value: show(data) }];
}
