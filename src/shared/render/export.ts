import type { Cell, Column, Row } from '../view-spec.js';
import { alignOf, formatCell, headingOf } from './format.js';

/**
 * A table's rows in the format you take them in (Copy as ▸, Save as ▸): aligned Markdown, CSV,
 * TSV, JSON, SQL inserts. Each either keeps the values as they are (48210, true) or takes them as
 * the table shows them ("$48,210", "Yes"). Pure (tested in tests/table-export.test.ts).
 */

export type ExportFormat = 'markdown' | 'csv' | 'tsv' | 'json' | 'sql';

export interface ExportOptions {
  /** Values as the table shows them, under its headings (else raw values under the keys). */
  readonly shown?: boolean;
  /** The SQL table's name (from the view's title). */
  readonly name?: string;
}

export interface ExportKind {
  readonly format: ExportFormat;
  readonly label: string;
  readonly ext: string;
  /** Whether "Values as Shown" changes it (Markdown always reads as shown). */
  readonly raw: boolean;
}

export const EXPORT_KINDS: readonly ExportKind[] = [
  { format: 'markdown', label: 'Markdown', ext: 'md', raw: false },
  { format: 'csv', label: 'CSV', ext: 'csv', raw: true },
  { format: 'tsv', label: 'TSV', ext: 'tsv', raw: true },
  { format: 'json', label: 'JSON', ext: 'json', raw: true },
  { format: 'sql', label: 'SQL Inserts', ext: 'sql', raw: true },
];

export function exportRows(format: ExportFormat, rows: readonly Row[], columns: readonly Column[], opts: ExportOptions = {}): string {
  switch (format) {
    case 'markdown':
      return toAlignedMarkdown(rows, columns);
    case 'csv':
      return toDelimited(rows, columns, ',', opts.shown ?? false);
    case 'tsv':
      return toDelimited(rows, columns, '\t', opts.shown ?? false);
    case 'json':
      return toJsonRows(rows, columns, opts.shown ?? false);
    case 'sql':
      return toSqlInserts(rows, columns, opts.name ?? 'rows', opts.shown ?? false);
  }
}

/** A file name from a view's title: "Customers by revenue" → "customers-by-revenue.csv". */
export function exportFileName(title: string | undefined, ext: string): string {
  const base = (title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${base || 'table'}.${ext}`;
}

const heading = (c: Column, shown: boolean): string => (shown ? headingOf(c) : c.key);
const shownText = (v: Cell | undefined, c: Column): string => (v === null || v === undefined ? '' : formatCell(v, c));
const rawText = (v: Cell | undefined): string => (v === null || v === undefined ? '' : String(v));

/** Markdown with every column padded to its widest cell, so it reads lined up in plain text too. */
export function toAlignedMarkdown(rows: readonly Row[], columns: readonly Column[]): string {
  const esc = (t: string): string => t.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const head = columns.map((c) => esc(headingOf(c)));
  const body = rows.map((r) => columns.map((c) => esc(shownText(r[c.key], c))));
  const widths = columns.map((_, i) => Math.max(3, head[i]!.length, ...body.map((cells) => cells[i]!.length)));
  const pad = (t: string, i: number): string => (alignOf(columns[i]!) === 'right' ? t.padStart(widths[i]!) : alignOf(columns[i]!) === 'center' ? t.padStart(Math.floor((widths[i]! + t.length) / 2)).padEnd(widths[i]!) : t.padEnd(widths[i]!));
  const rule = columns.map((c, i) => {
    const w = widths[i]!;
    const a = alignOf(c);
    return a === 'right' ? `${'-'.repeat(w - 1)}:` : a === 'center' ? `:${'-'.repeat(w - 2)}:` : '-'.repeat(w);
  });
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(head.map(pad)), line(rule), ...body.map((cells) => line(cells.map(pad)))].join('\n');
}

/** CSV (RFC 4180) or TSV. TSV has no quoting: a tab or line break in a cell becomes a space. */
export function toDelimited(rows: readonly Row[], columns: readonly Column[], sep: ',' | '\t', shown: boolean): string {
  const esc = sep === ',' ? (t: string): string => (/[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t) : (t: string): string => t.replace(/[\t\r\n]+/g, ' ');
  const text = (r: Row, c: Column): string => (shown ? shownText(r[c.key], c) : rawText(r[c.key]));
  return [columns.map((c) => esc(heading(c, shown))).join(sep), ...rows.map((r) => columns.map((c) => esc(text(r, c))).join(sep))].join('\n');
}

/** An array of objects, one per row, in the columns' order. A missing cell is null. */
export function toJsonRows(rows: readonly Row[], columns: readonly Column[], shown: boolean): string {
  const out = rows.map((r) => Object.fromEntries(columns.map((c) => [heading(c, shown), shown ? shownText(r[c.key], c) : (r[c.key] ?? null)])));
  return JSON.stringify(out, null, 2);
}

/** One INSERT with a line per row, names quoted for any SQL that follows the standard. */
export function toSqlInserts(rows: readonly Row[], columns: readonly Column[], name: string, shown: boolean): string {
  const ident = (t: string): string => `"${t.replace(/"/g, '""')}"`;
  const str = (t: string): string => `'${t.replace(/'/g, "''")}'`;
  const literal = (v: Cell | undefined, c: Column): string => {
    if (v === null || v === undefined) return 'NULL';
    if (shown) return str(shownText(v, c));
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return str(v);
  };
  const table = name.trim().toLowerCase().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'rows';
  const head = `INSERT INTO ${ident(table)} (${columns.map((c) => ident(heading(c, shown))).join(', ')}) VALUES`;
  if (!rows.length) return `-- ${ident(table)}: no rows`;
  return [head, rows.map((r) => `  (${columns.map((c) => literal(r[c.key], c)).join(', ')})`).join(',\n') + ';'].join('\n');
}
