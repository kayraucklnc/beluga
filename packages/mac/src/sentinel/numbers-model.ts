import type { Cell, Row } from '../../../../src/shared/view-spec.js';
import { type Dashboard, type MetricRef, type Tile, type TileState, TILE_STATE_WORDS, metricOf, tileCompare, tileMetrics, tileStateIn, tileTitle } from '../../../../src/core/sentinel/dashboard-model.js';
import { COMPARE, COMPARE_LABEL, COMPARE_WORDS, type Compare, type Tone, changeText, deltaOf, formatMetric, unitLabel } from '../../../../src/core/sentinel/metrics.js';
import type { MetricSeries, SentinelState } from '../../../../src/core/sentinel/model.js';

/**
 * Numbers on the Mac (docs/sentinel.md §10), the pure part: a number tile's words, a chart's
 * rows, the compare choices, the Refresh line, what Add a Tile lists, and the sidebar's Dashboard
 * line. Tested from tests/mac-dashboard.test.ts.
 */

export const COMPARE_CHOICES: ReadonlyArray<{ readonly value: Compare; readonly label: string; readonly hint: string }> = COMPARE.map((c) => ({ value: c, label: COMPARE_LABEL[c], hint: `Each change ${COMPARE_WORDS[c]}` }));

/** A number tile as drawn: its label, value, change, tone, what it's compared with, and its sparkline. */
export interface NumberWords {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly change?: string;
  readonly tone: Tone;
  readonly vs: string;
  readonly trend: readonly number[];
  /** The last point's run (the tile opens it). */
  readonly runId?: string;
  readonly at?: number;
}

export function numberWords(m: MetricSeries, compare: Compare, label = m.label): NumberWords {
  const last = m.points.at(-1);
  const d = deltaOf(m.points, compare, m.better);
  const change = changeText(d, m.unit);
  const unit = unitLabel(m.unit);
  return {
    label,
    value: last ? formatMetric(last.value, m.unit) : '—',
    ...(unit && m.unit !== 'percent' && !m.unit.startsWith('currency:') && m.unit !== 'ms' && m.unit !== 'bytes' ? { unit } : {}),
    ...(change ? { change } : {}),
    tone: d?.tone ?? 'none',
    vs: d?.change !== undefined ? COMPARE_WORDS[compare] : m.points.length > 1 ? `nothing ${COMPARE_WORDS[compare].replace(/^vs /, 'from ')}` : 'its first number',
    trend: m.points.slice(-30).map((p) => p.value),
    ...(last ? { runId: last.runId, at: last.at } : {}),
  };
}

/** A sentinel's numbers, in the order they were made (rows metrics after). */
export function metricsOf(s: Pick<SentinelState, 'metrics'>, sentinelId: string): { readonly numbers: MetricSeries[]; readonly tables: MetricSeries[] } {
  const all = Object.values(s.metrics?.[sentinelId] ?? {});
  return { numbers: all.filter((m) => m.kind === 'number'), tables: all.filter((m) => m.kind === 'rows') };
}

/** A chart's rows: one per point in time, a column per metric (`m0`, `m1`…), with the run each came from. */
export function chartRows(series: readonly MetricSeries[]): { readonly rows: Row[]; readonly keys: ReadonlyArray<{ readonly key: string; readonly label: string }> } {
  const byAt = new Map<number, Record<string, Cell>>();
  series.forEach((m, i) => {
    for (const p of m.points) {
      const row = byAt.get(p.at) ?? { at: new Date(p.at).toISOString() };
      row[`m${i}`] = p.value;
      row[`run${i}`] = p.runId;
      if (row.runId === undefined) row.runId = p.runId;
      byAt.set(p.at, row);
    }
  });
  return { rows: [...byAt.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r), keys: series.map((m, i) => ({ key: `m${i}`, label: m.label })) };
}

/** A chart view's JSON for some metrics over time (the chat's `line` / `area` / `bar` view). */
export function chartViewOf(series: readonly MetricSeries[], kind: 'line' | 'area' | 'bar' = 'line', height?: number): Record<string, unknown> {
  const { rows, keys } = chartRows(series);
  const m = series[0];
  const type = m?.unit.startsWith('currency:') ? 'currency' : m?.unit === 'percent' ? 'percent' : m?.unit === 'bytes' ? 'bytes' : 'number';
  return {
    type: 'chart',
    chart: kind,
    x: 'at',
    columns: [{ key: 'at', type: 'datetime', label: 'When' }, ...keys.map((k) => ({ key: k.key, label: k.label, type, ...(type === 'currency' && m ? { currency: m.unit.slice('currency:'.length) } : {}) }))],
    series: keys.map((k) => ({ key: k.key, label: k.label })),
    data: rows,
    curve: 'smooth',
    legend: keys.length > 1,
    ...(height ? { height } : {}),
  };
}

/** A rows metric as a table view's JSON (pages of 8). */
export function tableViewOf(m: MetricSeries, pageSize = 8): Record<string, unknown> {
  const columns = m.columns?.length ? m.columns : Object.keys(m.rows?.[0] ?? {});
  return { type: 'table', columns: columns.map((key) => ({ key })), data: m.rows ?? [], pageSize, search: false };
}

/** "Fetching… 2 of 3" (the one going is the next: 0 done means the first is running). */
export const refreshLine = (r: { readonly done: number; readonly total: number } | undefined): string | undefined => (r ? `Fetching… ${Math.min(r.total, r.done + 1)} of ${r.total}` : undefined);

/** What a tile can't draw from, in its quiet words (none: it draws). */
export const tileNote = (state: TileState): string | undefined => (state === 'ok' ? undefined : TILE_STATE_WORDS[state]);

/** What a tile is, for its menu and the sheet: "Revenue · Stripe revenue". */
export function tileCaption(s: Pick<SentinelState, 'metrics' | 'items'>, t: Tile): { readonly title: string; readonly from?: string; readonly state: TileState } {
  const ref = t.metric ?? t.metrics?.[0];
  const sid = ref?.sentinelId ?? t.sentinelId;
  const from = sid ? s.items.find((i) => i.id === sid)?.name : undefined;
  return { title: tileTitle(s, t), ...(from ? { from } : {}), state: tileStateIn(s, t) };
}

/** One choice in Add a Tile: a sentinel's metric, under its project. */
export interface MetricChoice {
  readonly ref: MetricRef;
  readonly label: string;
  readonly sentinel: string;
  readonly project: string;
  readonly kind: 'number' | 'rows';
  readonly value?: string;
  readonly onIt: boolean;
}

/** Every metric to pick from, by project then sentinel, with whether this dashboard has it already. */
export function metricChoices(s: Pick<SentinelState, 'metrics' | 'items'>, projectName: (id: string | undefined) => string, d?: Dashboard): MetricChoice[] {
  const on = new Set((d?.tiles ?? []).flatMap((t) => [...(t.metric ? [t.metric] : []), ...(t.metrics ?? [])]).map((r) => `${r.sentinelId}/${r.metric}`));
  return s.items
    .flatMap((i) =>
      Object.values(s.metrics?.[i.id] ?? {}).map((m): MetricChoice => {
        const last = m.points.at(-1);
        return {
          ref: { sentinelId: i.id, metric: m.name },
          label: m.label,
          sentinel: i.name,
          project: projectName(i.projectId),
          kind: m.kind,
          ...(m.kind === 'rows' ? { value: `${m.rows?.length ?? 0} rows` } : last ? { value: formatMetric(last.value, m.unit) } : {}),
          onIt: on.has(`${i.id}/${m.name}`),
        };
      }),
    )
    .sort((a, b) => a.project.localeCompare(b.project) || a.sentinel.localeCompare(b.sentinel));
}

/** The sidebar's Dashboard line: how many numbers, or how to get the first. */
export function dashboardLine(s: Pick<SentinelState, 'metrics' | 'dashboards' | 'refreshing'>): string {
  const refreshing = Object.values(s.refreshing ?? {})[0];
  if (refreshing) return refreshLine(refreshing)!;
  const n = Object.values(s.metrics ?? {}).reduce((sum, m) => sum + Object.keys(m).length, 0);
  const boards = s.dashboards?.length ?? 0;
  if (!n) return boards ? 'Waiting for the first number' : 'No numbers yet';
  return `${n} ${n === 1 ? 'number' : 'numbers'}${boards > 1 ? ` · ${boards} dashboards` : ''}`;
}

/** The number tiles a dashboard draws, worked out (Copy as Markdown, the phone's Home row). */
export function tileWords(s: Pick<SentinelState, 'metrics' | 'items' | 'runs'>, d: Dashboard, t: Tile): { readonly title: string; readonly value?: string; readonly change?: string; readonly text?: string } {
  const title = tileTitle(s, t);
  if (t.kind === 'number') {
    const m = metricOf(s, t.metric);
    if (!m) return { title };
    const w = numberWords(m, tileCompare(d, t));
    return { title, value: w.value, ...(w.change ? { change: `${w.change} ${w.vs}` } : {}) };
  }
  if (t.kind === 'text') {
    const last = [...s.runs].reverse().find((r) => r.sentinelId === t.sentinelId);
    return { title, ...(last?.headline ? { text: last.headline } : {}) };
  }
  if (t.kind === 'table') {
    const m = metricOf(s, t.metric);
    return { title, ...(m?.rows ? { value: `${m.rows.length} rows` } : {}) };
  }
  if (t.kind === 'chart') {
    const ms = tileMetrics(s, t);
    return { title, ...(ms.length ? { value: ms.map((m) => `${m.label} ${m.points.at(-1) ? formatMetric(m.points.at(-1)!.value, m.unit) : '—'}`).join(', ') } : {}) };
  }
  return { title };
}
