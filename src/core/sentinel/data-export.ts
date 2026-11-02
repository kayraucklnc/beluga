import type { MetricLine } from './metrics.js';
import type { MetricKind } from './model.js';

/**
 * A metric's whole history as a file you can take away (BLG-392): every line its file keeps, oldest
 * first, as CSV (a number's value per run; a kept table's rows, run by run, with when each was kept;
 * a kept array's points; an output's text) or as JSON (the lines as they are, times in ISO). Pure:
 * Sentinels writes it to Downloads, or streams it to the phone.
 */

export type ExportFormat = 'csv' | 'json';

const iso = (at: number): string => new Date(at).toISOString();

/** One CSV field: quoted when it holds a comma, a quote or a line break; a formula's first character defused. */
function field(v: unknown): string {
  if (v === null || v === undefined) return '';
  let t = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
  // A spreadsheet runs a cell that starts with = + - @ as a formula: a value never does here.
  if (/^[=+\-@\t\r]/.test(t) && !(typeof v === 'number')) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

const csv = (header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string => [header, ...rows].map((r) => r.map(field).join(',')).join('\r\n') + '\r\n';

export function metricExport(kind: MetricKind, lines: readonly MetricLine[], format: ExportFormat): string {
  if (format === 'json') return `${JSON.stringify(lines.map(({ at, ...rest }) => ({ at: iso(at), ...rest })), null, 2)}\n`;
  if (kind === 'rows') {
    // Every column any run kept, in the order they first came.
    const columns = [...new Set(lines.flatMap((l) => l.columns ?? Object.keys(l.rows?.[0] ?? {})))];
    return csv(['kept_at', 'run', ...columns], lines.flatMap((l) => (l.rows ?? []).map((r) => [iso(l.at), l.runId, ...columns.map((c) => r[c])])));
  }
  if (kind === 'series') return csv(['kept_at', 'run', 'x', 'y'], lines.flatMap((l) => (l.series ?? []).map((p) => [iso(l.at), l.runId, p.x, p.y])));
  if (kind === 'output') return csv(['kept_at', 'run', 'format', 'text'], lines.filter((l) => l.output).map((l) => [iso(l.at), l.runId, l.output!.format, l.output!.text]));
  return csv(['kept_at', 'run', 'value'], lines.filter((l) => l.value !== undefined).map((l) => [iso(l.at), l.runId, l.value]));
}

/** A file name that's fine anywhere ("Stripe revenue · Revenue.csv"). */
export const exportName = (sentinel: string, metric: string, format: ExportFormat): string => `${`${sentinel} · ${metric}`.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 120)}.${format}`;
