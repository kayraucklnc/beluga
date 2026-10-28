import { type Row, parseText, toCell, toRows } from '../../shared/view-spec.js';
import { type Better, type MetricPoint, type MetricSeries, type MetricSpec, type MetricUnit, OUTPUT_METRIC_MAX, type OutputFormat, ROWS_KEPT, SERIES_KEPT, type SeriesPoint } from './model.js';

/**
 * Numbers (docs/sentinel.md §10), the pure part: reading what a step said (a bare number, JSON,
 * CSV, "name: value" lines), picking named values out of it (a number, a whole array as a series,
 * rows, or the output itself), comparing a number with the past
 * (the previous run, yesterday, last week, last month), the change in words with its tone, and
 * keeping the files to two years or 20 000 points. Browser-safe: the screens use it too.
 */

/** One value a measure step kept: a number, a series, rows, or an output. */
export interface Measured {
  readonly name: string;
  readonly label?: string;
  readonly unit?: MetricUnit;
  readonly better?: Better;
  readonly value?: number;
  readonly rows?: readonly Row[];
  readonly columns?: readonly string[];
  readonly series?: readonly SeriesPoint[];
  readonly output?: { readonly text: string; readonly format: OutputFormat };
}

/** A line of a metric's file (~/.beluga/sentinel/metrics/<sentinel>/<name>.jsonl). */
export interface MetricLine {
  readonly at: number;
  readonly runId: string;
  readonly value?: number;
  readonly rows?: readonly Row[];
  readonly columns?: readonly string[];
  readonly series?: readonly SeriesPoint[];
  readonly output?: { readonly text: string; readonly format: OutputFormat };
}

export const KEEP_POINTS = 20_000;
export const KEEP_MS = 2 * 365 * 24 * 60 * 60_000;

/** A number from what a step said: 1204, "1,204", "$3,400.50", "12.5%", "340 ms"; anything else isn't one. */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v !== 'string') return undefined;
  const t = v.trim().replace(/^[$€£¥]\s*/, '').replace(/\s*(%|ms|s|kb|mb|gb|bytes?|[a-z]{3})$/i, '').replace(/[,_\s](?=\d{3}\b)/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const LINE = /^\s*([^:=\n]{1,80}?)\s*[:=]\s*(\S.*?)\s*$/;

/**
 * What a step said, as data: a bare number, JSON (kept as is), "name: value" lines (an object), CSV
 * or TSV (rows), or the text itself.
 */
export function readOutput(text: string): unknown {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return undefined;
  const n = toNumber(t);
  if (n !== undefined) return n;
  if (/^[[{]/.test(t)) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      // Not JSON after all: read on.
    }
  }
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines.length <= 200 && lines.every((l) => LINE.test(l) && !/^https?:/i.test(l))) {
    const out: Record<string, string | number> = {};
    for (const l of lines) {
      const [, k, v] = LINE.exec(l)!;
      out[k!] = toNumber(v) ?? v!;
    }
    return out;
  }
  if (lines.length > 1 && /[,\t]/.test(lines[0]!)) return parseText(t, 'auto').rows;
  return t;
}

/**
 * A path into what a step said: "$.items[0].statistics.subscriberCount", "rows[0].count", or a
 * column ("customers": the first row's, when it's rows). A leading `rows` on rows is the rows.
 */
export function pickPath(data: unknown, path: string | undefined): unknown {
  const p = (path ?? '').trim().replace(/^\$\.?/, '');
  if (!p) return data;
  let now: unknown = data;
  const parts = p.replace(/\[(\d+)\]/g, '.$1').replace(/\[["']([^"']+)["']\]/g, '.$1').split('.').filter(Boolean);
  for (const [i, part] of parts.entries()) {
    if (Array.isArray(now) && !/^\d+$/.test(part)) {
      if (i === 0 && part === 'rows') continue;
      // A column of rows: the first row's.
      now = now[0];
    }
    if (now === null || typeof now !== 'object') return undefined;
    const rec = now as Record<string, unknown>;
    if (Object.hasOwn(rec, part)) now = rec[part];
    else {
      // Columns read kindly: "Customers" finds "customers".
      const key = Object.keys(rec).find((k) => k.toLowerCase() === part.toLowerCase());
      now = key === undefined ? undefined : rec[key];
    }
  }
  return now;
}

/** "subscriberCount" → "Subscriber count", "failed_payments" → "Failed payments". */
export function labelOf(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** A metric's name from anything: lowercase letters, digits and dashes, at most 60. */
export function metricName(text: string): string {
  return (
    text
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'value'
  );
}

/** Every top-level number (the first row's, for rows), when a step names none. */
function everyNumber(data: unknown): Measured[] {
  const n = toNumber(data);
  if (n !== undefined) return [{ name: 'value', label: 'Value', value: n }];
  const top = Array.isArray(data) ? data[0] : data;
  if (!top || typeof top !== 'object' || Array.isArray(top)) return [];
  return Object.entries(top as Record<string, unknown>).flatMap(([k, v]) => {
    const value = typeof v === 'boolean' ? undefined : toNumber(v);
    return value === undefined ? [] : [{ name: metricName(k), label: labelOf(k), value }];
  }).slice(0, 40);
}

/**
 * A series from a picked value: an array of numbers (labelled 1, 2, 3…), of rows (the `x` column
 * labels each point, the `y` column is its value; the first text and the first number column when
 * unset), or an object of numbers ({ "Mon": 3, "Tue": 5 }).
 */
export function seriesOf(v: unknown, x?: string, y?: string, keep = SERIES_KEPT): SeriesPoint[] | undefined {
  const cap = (pts: SeriesPoint[]): SeriesPoint[] | undefined => (pts.length ? pts.slice(0, keep) : undefined);
  if (typeof v === 'string') {
    const data = readOutput(v);
    return typeof data === 'string' ? undefined : seriesOf(data, x, y, keep);
  }
  if (Array.isArray(v)) {
    if (v.every((n) => toNumber(n) !== undefined)) return cap(v.map((n, i) => ({ x: String(i + 1), y: toNumber(n)! })));
    const rows = v.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r));
    if (!rows.length) return undefined;
    const keys = Object.keys(rows[0]!);
    const yKey = y ?? keys.find((k) => typeof rows[0]![k] !== 'boolean' && toNumber(rows[0]![k]) !== undefined);
    const xKey = x ?? keys.find((k) => k !== yKey && typeof rows[0]![k] === 'string' && toNumber(rows[0]![k]) === undefined) ?? keys.find((k) => k !== yKey);
    if (!yKey) return undefined;
    return cap(rows.flatMap((r, i) => {
      const n = toNumber(r[yKey]);
      return n === undefined ? [] : [{ x: xKey !== undefined && r[xKey] !== undefined && r[xKey] !== null ? String(r[xKey]).slice(0, 80) : String(i + 1), y: n }];
    }));
  }
  if (v && typeof v === 'object') return cap(Object.entries(v as Record<string, unknown>).flatMap(([k, n]) => (toNumber(n) === undefined || typeof n === 'boolean' ? [] : [{ x: k.slice(0, 80), y: toNumber(n)! }])));
  return undefined;
}

/** An output kept as a metric: the picked part (JSON as JSON), or the whole text, cut at 16 KB. */
export function outputOf(v: unknown, raw: string | undefined): { readonly text: string; readonly format: OutputFormat } | undefined {
  if (v === undefined || v === null) return raw?.trim() ? { text: raw.slice(0, OUTPUT_METRIC_MAX), format: textFormat(raw) } : undefined;
  if (typeof v === 'string') return v.trim() ? { text: v.slice(0, OUTPUT_METRIC_MAX), format: textFormat(v) } : undefined;
  const json = JSON.stringify(v, null, 2) ?? '';
  return { text: json.length > OUTPUT_METRIC_MAX ? JSON.stringify(v).slice(0, OUTPUT_METRIC_MAX) : json, format: 'json' };
}

const textFormat = (t: string): OutputFormat => {
  const s = t.trim();
  if (/^[[{]/.test(s)) {
    try {
      JSON.parse(s);
      return 'json';
    } catch {
      // Text after all.
    }
  }
  return /(^|\n)(#{1,4} |[-*] )|\*\*/.test(s) ? 'markdown' : 'text';
};

/** Rows from a picked value: an array of rows, an object (one row), or text (CSV). */
function rowsOf(v: unknown, keep: number): { rows: Row[]; columns: string[] } | undefined {
  if (v === undefined || v === null) return undefined;
  const { rows, columns } = toRows(typeof v === 'string' ? v : Array.isArray(v) ? v : [v]);
  return { rows: rows.slice(0, keep), columns };
}

/**
 * What a measure step keeps from data: each named metric (its number, or its rows), or every
 * top-level number when it names none. → what it found, and the names it couldn't find.
 */
export function measureFrom(data: unknown, specs: readonly MetricSpec[], keep = ROWS_KEPT, raw?: string): { readonly found: Measured[]; readonly missing: string[] } {
  if (!specs.length) return { found: everyNumber(data), missing: [] };
  const found: Measured[] = [];
  const missing: string[] = [];
  const cap = Math.max(1, Math.min(ROWS_KEPT, keep));
  for (const spec of specs) {
    // A rows, series or output metric with no path takes the whole thing; a number its own name.
    const whole = spec.kind === 'rows' || spec.kind === 'series' || spec.kind === 'output';
    const v = pickPath(data, spec.pick ?? (whole ? '' : spec.name));
    const base = { name: spec.name, ...(spec.label ? { label: spec.label } : {}), ...(spec.unit ? { unit: spec.unit } : {}), ...(spec.better ? { better: spec.better } : {}) };
    if (spec.kind === 'output') {
      const o = outputOf(spec.pick?.trim() ? v : undefined, spec.pick?.trim() ? undefined : (raw ?? (typeof data === 'string' ? data : JSON.stringify(data, null, 2))));
      if (o) found.push({ ...base, output: o });
      else missing.push(spec.name);
      continue;
    }
    if (spec.kind === 'series') {
      const pts = seriesOf(v, spec.x, spec.y);
      if (pts?.length) found.push({ ...base, series: pts });
      else missing.push(spec.name);
      continue;
    }
    if (spec.kind === 'rows') {
      const r = rowsOf(v, cap);
      if (r?.rows.length) found.push({ ...base, rows: r.rows, columns: r.columns });
      else missing.push(spec.name);
      continue;
    }
    // A single number in rows (a count query's one row and column) is that number.
    const single = Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === 'object' ? Object.values(v[0] as Record<string, unknown>) : undefined;
    const value = toNumber(single?.length === 1 ? single[0] : v);
    if (value === undefined) missing.push(spec.name);
    else found.push({ ...base, value });
  }
  return { found, missing };
}

/** What a Keep the numbers step kept, in words: "Kept Revenue: $3,120 · Jobs: 6 rows". */
export function keptWords(found: readonly Measured[]): string {
  const said = found.map((m) => `${m.label ?? labelOf(m.name)}: ${m.value !== undefined ? formatMetric(m.value, m.unit) : m.series ? `${m.series.length} points` : m.output ? `its output (${m.output.format === 'json' ? 'JSON' : m.output.format === 'markdown' ? 'Markdown' : 'text'})` : `${m.rows?.length ?? 0} rows`}`);
  return `Kept ${said.join(' · ')}`;
}

/** Rows as cells only (what the files and the state keep). */
export const cellRows = (rows: readonly Record<string, unknown>[]): Row[] => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toCell(v)])));

// ---------------------------------------------------------------- compared to when

export const COMPARE = ['previous', 'day', 'week', 'month'] as const;
export type Compare = (typeof COMPARE)[number];
export const COMPARE_LABEL: Readonly<Record<Compare, string>> = { previous: 'Previous', day: 'Yesterday', week: 'Last week', month: 'Last month' };
export const COMPARE_WORDS: Readonly<Record<Compare, string>> = { previous: 'vs the run before', day: 'vs yesterday', week: 'vs last week', month: 'vs last month' };

const DAY = 24 * 60 * 60_000;

/** When "then" is for a compare, from the last point's time (a month is a calendar month). */
export function thenOf(at: number, compare: Exclude<Compare, 'previous'>): number {
  if (compare === 'day') return at - DAY;
  if (compare === 'week') return at - 7 * DAY;
  const d = new Date(at);
  const target = new Date(d.getFullYear(), d.getMonth() - 1, 1, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  // The same day of last month, or its last day (31 March → 28 or 29 February).
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return target.getTime();
}

/** Runs drift (a schedule a few seconds late, a slow step): "then" takes a point up to an hour after it. */
const GRACE = 60 * 60_000;

/** The point to compare the last one with: the run before, or the nearest at or before then (an hour's grace). */
export function baselineOf(points: readonly MetricPoint[], compare: Compare): MetricPoint | undefined {
  const last = points.at(-1);
  if (!last) return undefined;
  if (compare === 'previous') return points.at(-2);
  const then = thenOf(last.at, compare) + GRACE;
  for (let i = points.length - 2; i >= 0; i--) if (points[i]!.at <= then) return points[i];
  return undefined;
}

export type Tone = 'good' | 'bad' | 'flat' | 'none';

export interface Delta {
  readonly value: number;
  readonly before?: number;
  /** value − before. */
  readonly change?: number;
  /** The change as a share of before (none when before is 0). */
  readonly pct?: number;
  /** Green when it moved the good way, rose when the bad, grey when it didn't move or neither is good. */
  readonly tone: Tone;
}

/** The last number and its change against then, with its tone by `better`. */
export function deltaOf(points: readonly MetricPoint[], compare: Compare, better: Better): Delta | undefined {
  const last = points.at(-1);
  if (!last) return undefined;
  const base = baselineOf(points, compare);
  if (!base) return { value: last.value, tone: 'none' };
  const change = last.value - base.value;
  const pct = base.value !== 0 ? (change / Math.abs(base.value)) * 100 : undefined;
  const tone: Tone = change === 0 ? 'flat' : better === 'none' ? 'none' : (change > 0) === (better === 'up') ? 'good' : 'bad';
  return { value: last.value, before: base.value, change, ...(pct !== undefined ? { pct } : {}), tone };
}

// ---------------------------------------------------------------- words

const currencyOf = (unit: MetricUnit): string | undefined => (unit.startsWith('currency:') ? unit.slice('currency:'.length).toUpperCase() : undefined);

/** A number with its unit: "1,204", "$3,400", "12.5%", "340 ms", "1.2 s", "4.1 MB". */
export function formatMetric(value: number, unit: MetricUnit = 'count'): string {
  const cur = currencyOf(unit);
  if (cur) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2, minimumFractionDigits: 0 }).format(value);
    } catch {
      return `${grouped(value)} ${cur}`;
    }
  }
  switch (unit) {
    case 'percent':
      return `${grouped(value, 1)}%`;
    case 'ms':
      return Math.abs(value) >= 10_000 ? `${grouped(value / 1000, 0)} s` : Math.abs(value) >= 1000 ? `${grouped(value / 1000, 1)} s` : `${grouped(value, 0)} ms`;
    case 'bytes': {
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let v = value;
      let i = 0;
      while (Math.abs(v) >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
      }
      return `${grouped(v, i ? 1 : 0)} ${units[i]}`;
    }
    default:
      return grouped(value, Number.isInteger(value) ? 0 : 2);
  }
}

const grouped = (n: number, max = 2): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: max }).format(n);

/** The change in words: "+12 (+4.1%)", "−$120", "no change"; none without a point to compare. */
export function changeText(d: Delta | undefined, unit: MetricUnit = 'count'): string | undefined {
  if (!d || d.change === undefined) return undefined;
  if (d.change === 0) return 'no change';
  const sign = d.change > 0 ? '+' : '−';
  const abs = formatMetric(Math.abs(d.change), unit === 'percent' ? 'plain' : unit);
  const amount = unit === 'percent' ? `${sign}${abs} pts` : `${sign}${abs}`;
  return d.pct !== undefined && unit !== 'percent' ? `${amount} (${sign}${grouped(Math.abs(d.pct), 1)}%)` : amount;
}

/** A metric's own words for the screens: its value, its change, and what it's compared to. */
export function metricWords(m: Pick<MetricSeries, 'points' | 'unit' | 'better'>, compare: Compare): { readonly value?: string; readonly change?: string; readonly tone: Tone; readonly vs: string } {
  const d = deltaOf(m.points, compare, m.better);
  const change = changeText(d, m.unit);
  return { ...(d ? { value: formatMetric(d.value, m.unit) } : {}), ...(change ? { change } : {}), tone: d?.tone ?? 'none', vs: COMPARE_WORDS[compare] };
}

/** "currency:USD" → "USD", "ms" → "ms": the unit's short name (none for counts and plain). */
export function unitLabel(unit: MetricUnit): string | undefined {
  const cur = currencyOf(unit);
  if (cur) return cur;
  return unit === 'percent' ? '%' : unit === 'ms' ? 'ms' : unit === 'bytes' ? 'bytes' : undefined;
}

// ---------------------------------------------------------------- the files

/** A metric's lines, kept to two years and 20 000 points (the newest), oldest first. */
export function prunePoints<L extends { readonly at: number }>(lines: readonly L[], now: number, keep = KEEP_POINTS, keepMs = KEEP_MS): L[] {
  const since = now - keepMs;
  const fresh = lines.filter((l) => l.at >= since);
  return fresh.length > keep ? fresh.slice(fresh.length - keep) : [...fresh];
}

/** A file's lines as points (a rows or series line counts its rows or points; an output's is 0). */
export const pointOf = (l: MetricLine): MetricPoint => ({ at: l.at, value: l.value ?? l.rows?.length ?? l.series?.length ?? 0, runId: l.runId });

/** A line of a metric's file, read back (one that doesn't read is skipped). */
export function readLine(text: string): MetricLine | undefined {
  try {
    const v = JSON.parse(text) as Partial<MetricLine>;
    if (typeof v.at !== 'number' || typeof v.runId !== 'string') return undefined;
    if (typeof v.value === 'number') return { at: v.at, runId: v.runId, value: v.value };
    if (Array.isArray(v.rows)) return { at: v.at, runId: v.runId, rows: v.rows, ...(Array.isArray(v.columns) ? { columns: v.columns } : {}) };
    if (Array.isArray(v.series)) return { at: v.at, runId: v.runId, series: v.series.filter((p) => p && typeof p.x === 'string' && typeof p.y === 'number') };
    if (v.output && typeof v.output.text === 'string') return { at: v.at, runId: v.runId, output: { text: v.output.text, format: v.output.format === 'json' || v.output.format === 'markdown' ? v.output.format : 'text' } };
  } catch {
    // A torn last line (Beluga closed while writing): skipped.
  }
  return undefined;
}

/** What metric_read says, one point per line: "2026-10-01 07:00  1,204". */
export function describePoints(m: Pick<MetricSeries, 'label' | 'unit'>, lines: readonly MetricLine[], max = 400): string {
  if (!lines.length) return `${m.label}: no points in that time.`;
  const shown = lines.slice(-max);
  const day = (at: number): string => {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return [
    `${m.label}: ${lines.length} ${lines.length === 1 ? 'point' : 'points'}${shown.length < lines.length ? ` (the last ${shown.length})` : ''}, oldest first.`,
    ...shown.map((l) => `${day(l.at)}  ${l.value !== undefined ? formatMetric(l.value, m.unit) : l.series ? `${l.series.length} points: ${l.series.slice(0, 12).map((p) => `${p.x} ${formatMetric(p.y, m.unit)}`).join(', ')}${l.series.length > 12 ? '…' : ''}` : l.output ? `output (${l.output.format}): ${l.output.text.replace(/\s+/g, ' ').slice(0, 200)}` : `${l.rows?.length ?? 0} rows${l.rows?.[0] ? `, first: ${JSON.stringify(l.rows[0]).slice(0, 200)}` : ''}`}`),
  ].join('\n');
}
