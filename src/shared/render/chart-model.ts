import type { Cell, Column, Row, Series, View } from '../view-spec.js';
import { MAX_SERIES, headingOf, isNumeric, toDate } from './format.js';

/**
 * What a chart draws from a view's rows: which column runs along the bottom, which are the
 * lines (or bars), long rows turned wide (one series per `group` value), and series past the
 * eighth folded into "Other". Pure (tested in tests/mac-views.test.ts).
 */

export interface ChartPlan {
  readonly x: string;
  readonly xColumn?: Column;
  /** The x values are dates (drawn as dates, in order). */
  readonly time: boolean;
  readonly series: readonly (Series & { readonly label: string })[];
  readonly rows: readonly Record<string, Cell>[];
  readonly yColumn?: Column;
}

export function planChart(view: Pick<View, 'x' | 'series' | 'group'>, columns: readonly Column[], rows: readonly Row[]): ChartPlan {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const x =
    view.x ??
    columns.find((c) => c.type === 'date' || c.type === 'datetime')?.key ??
    columns.find((c) => !isNumeric(c) && c.key !== view.group)?.key ??
    columns[0]?.key ??
    'x';
  const xColumn = byKey.get(x);
  const time = xColumn?.type === 'date' || xColumn?.type === 'datetime';
  if (view.group) {
    const y = view.series[0]?.key ?? columns.find((c) => isNumeric(c) && c.key !== x)?.key ?? 'value';
    const totals = new Map<string, number>();
    for (const r of rows) {
      const g = String(r[view.group] ?? '—');
      totals.set(g, (totals.get(g) ?? 0) + Math.abs(num(r[y])));
    }
    // The biggest groups get their own series; the rest are "Other".
    const ranked = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)!);
    const own = new Set(ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked);
    const wide = new Map<string, Record<string, Cell>>();
    for (const r of rows) {
      const xv = r[x] ?? null;
      const k = String(xv);
      const g: string = String(r[view.group] ?? '—');
      const key = own.has(g) ? g : 'Other';
      const row = wide.get(k) ?? { [x]: xv };
      row[key] = num(row[key]) + num(r[y]);
      wide.set(k, row);
    }
    // Keep each group's order as it first appeared (its color follows it, not its rank).
    const order = [...new Set(rows.map((r) => String(r[view.group!] ?? '—')))].filter((g) => own.has(g));
    const series = [...order, ...(ranked.length > own.size ? ['Other'] : [])].map((key) => ({ key, label: key }));
    return { x, ...(xColumn ? { xColumn } : {}), time, series, rows: sortX([...wide.values()], x, time), ...(byKey.get(y) ? { yColumn: byKey.get(y)! } : {}) };
  }
  // Guessed series share one measure (never two scales on one axis): the first numeric column's kind.
  const numeric = columns.filter((c) => isNumeric(c) && c.key !== x && !c.hidden);
  const asked: readonly Series[] = view.series.length ? view.series : numeric.filter((c) => c.type === numeric[0]?.type).map((c) => ({ key: c.key }));
  const series = asked.slice(0, MAX_SERIES).map((s) => ({ ...s, label: s.label ?? headingOf(byKey.get(s.key) ?? { key: s.key }) }));
  const yColumn = series.length ? byKey.get(series[0]!.key) : undefined;
  const plain = rows.map((r) => {
    const out: Record<string, Cell> = { [x]: r[x] ?? null };
    for (const s of series) out[s.key] = r[s.key] === null || r[s.key] === undefined ? null : num(r[s.key]);
    return out;
  });
  return { x, ...(xColumn ? { xColumn } : {}), time, series, rows: time ? sortX(plain, x, true) : plain, ...(yColumn ? { yColumn } : {}) };
}

function num(c: Cell | undefined): number {
  if (typeof c === 'number') return c;
  if (typeof c === 'string') {
    const n = Number(c.replace(/[,_\s%$€£]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return c === true ? 1 : 0;
}

function sortX(rows: Record<string, Cell>[], x: string, time: boolean): Record<string, Cell>[] {
  if (!time) return rows;
  return [...rows].sort((a, b) => (toDate(a[x] ?? null)?.getTime() ?? 0) - (toDate(b[x] ?? null)?.getTime() ?? 0));
}
