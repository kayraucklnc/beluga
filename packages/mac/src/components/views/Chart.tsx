import { useId, useMemo, useState } from 'react';
import { Area, Bar, CartesianGrid, Cell as PieCell, ComposedChart, Line, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { Cell, ChartKind, Column, View } from '@beluga/shared/view-spec.js';
import { useDocTheme } from '../markdown/use-doc-theme.js';
import { reducedMotion } from '../../lib/reduced-motion.js';
import type { ViewData } from './use-view-data.js';
import { type ChartPlan, planChart } from './chart-model.js';
import { SERIES_DARK, SERIES_LIGHT, formatCell, formatNumber, toDate } from './format.js';
import v from './views.module.css';

/**
 * A view's rows as a chart (recharts, loaded the first time one shows): lines (smooth, straight
 * or stepped), areas, bars (side by side, stacked or across), pie and donut, scatter. Colors come
 * in a fixed, color-blind-safe order (Claude can choose its own); thin marks, a quiet grid, a
 * crosshair with every series' value, and a legend that turns series off and on.
 */

const dayF = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeF = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const monthF = new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' });

/**
 * `onPoint`: a click on the plot hears the row under the crosshair, as the view has it (Sentinel's
 * numbers open its run). `fit`: a line's axis fits its values instead of starting at zero (a
 * number over time, like subscribers, that moves a little on a big base).
 */
export default function Chart({ view, data, kind, full, onPoint, fit }: { view: View; data: ViewData; kind: ChartKind; full: boolean; onPoint?: (row: Readonly<Record<string, unknown>>) => void; fit?: boolean }) {
  const theme = useDocTheme();
  const plan = useMemo(() => planChart(view, data.columns, data.rows), [view, data.columns, data.rows]);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const palette = view.colors?.length ? view.colors : theme === 'dark' ? SERIES_DARK : SERIES_LIGHT;
  const colorOf = (i: number, s?: { color?: string | undefined }): string => s?.color ?? palette[i % palette.length]!;
  const height = full ? Math.max(view.height ?? 0, 460) : (view.height ?? (kind === 'pie' || kind === 'donut' ? 240 : 260));
  if (!plan.rows.length) return <div className={v.empty} style={{ height }}>{data.loading ? 'Loading…' : 'No data to chart'}</div>;
  if (!plan.series.length) return <div className={v.empty} style={{ height }}>Nothing numeric to chart</div>;
  const legend = view.legend ?? (plan.series.length > 1 || kind === 'pie' || kind === 'donut');
  const toggle = (key: string): void => setOff((now) => {
    const next = new Set(now);
    if (next.has(key)) next.delete(key);
    else if (next.size < plan.series.length - 1) next.add(key);
    return next;
  });
  return (
    <div className={v.chart}>
      {legend && kind !== 'pie' && kind !== 'donut' ? (
        <div className={v.legend}>
          {plan.series.map((s, i) => (
            <button key={s.key} type="button" className={v.legendItem} aria-pressed={!off.has(s.key)} onClick={() => toggle(s.key)}>
              <span className={v.legendMark} data-kind={kind} style={{ background: colorOf(i, s) }} />
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
      <div style={{ height }}>
        {kind === 'pie' || kind === 'donut' ? (
          <Donut plan={plan} kind={kind} colorOf={colorOf} legend={legend} />
        ) : kind === 'scatter' ? (
          <Dots plan={plan} colorOf={colorOf} view={view} off={off} />
        ) : (
          <Cartesian plan={plan} kind={kind} view={view} colorOf={colorOf} off={off} fit={Boolean(fit) && kind === 'line'} {...(onPoint ? { onPoint: (r: Readonly<Record<string, unknown>>) => onPoint(data.rows.find((d) => d[plan.x] === r[plan.x]) ?? r) } : {})} />
        )}
      </div>
    </div>
  );
}

function tickX(plan: ChartPlan, value: unknown, span: number, max = 14): string {
  if (plan.time) {
    const d = toDate(value as Cell);
    if (!d) return String(value);
    return span < 2 * 86_400_000 ? timeF.format(d) : span > 300 * 86_400_000 ? monthF.format(d) : dayF.format(d);
  }
  if (typeof value === 'number') return formatNumber(value, { compact: true });
  const t = String(value ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const tickY = (col: Column | undefined) => (value: number): string => (col && col.type !== 'number' ? formatCell(value, col) : formatNumber(value, { compact: true }));

function timeSpan(plan: ChartPlan): number {
  if (!plan.time || plan.rows.length < 2) return 0;
  const first = toDate(plan.rows[0]![plan.x] ?? null)?.getTime() ?? 0;
  const last = toDate(plan.rows.at(-1)![plan.x] ?? null)?.getTime() ?? 0;
  return Math.abs(last - first);
}

function Cartesian({ plan, kind, view, colorOf, off, onPoint, fit }: { plan: ChartPlan; kind: 'line' | 'area' | 'bar'; view: View; colorOf: (i: number, s?: { color?: string | undefined }) => string; off: ReadonlySet<string>; onPoint?: (row: Readonly<Record<string, unknown>>) => void; fit?: boolean }) {
  const id = useId().replace(/:/g, '');
  const span = timeSpan(plan);
  const curve = view.curve === 'smooth' ? 'monotone' : view.curve === 'step' ? 'stepAfter' : 'linear';
  const dots = view.dots ?? plan.rows.length <= 16;
  // Bars with long names lie down, so the names can be read.
  const longNames = !plan.time && plan.rows.length > 0 && plan.rows.reduce((n, r) => n + String(r[plan.x] ?? '').length, 0) / plan.rows.length > 9;
  const horizontal = kind === 'bar' && (view.horizontal ?? longNames);
  const animate = !reducedMotion() && plan.rows.length < 400;
  const stack = view.stacked ? 'all' : undefined;
  const axis = { stroke: 'var(--hairline-strong)', tick: { fill: 'var(--text-3)', fontSize: 11 }, tickLine: false, axisLine: false } as const;
  const xAxis = (
    <XAxis
      dataKey={horizontal ? undefined : plan.x}
      {...(horizontal ? { type: 'number' as const, tickFormatter: tickY(plan.yColumn) } : { tickFormatter: (val: unknown) => tickX(plan, val, span) })}
      {...axis}
      axisLine={{ stroke: 'var(--hairline-strong)' }}
      minTickGap={24}
      tickMargin={8}
      {...(view.xLabel ? { label: { value: view.xLabel, position: 'insideBottom', offset: -2, fill: 'var(--text-3)', fontSize: 11 } } : {})}
    />
  );
  const yAxis = (
    <YAxis
      {...(horizontal ? { type: 'category' as const, dataKey: plan.x, width: 132, tickFormatter: (val: unknown) => tickX(plan, val, span, 21) } : { tickFormatter: tickY(plan.yColumn), width: 52, ...(fit ? { domain: ['auto', 'auto'] as [string, string] } : {}) })}
      {...axis}
      tickMargin={6}
      {...(view.yLabel ? { label: { value: view.yLabel, angle: -90, position: 'insideLeft', fill: 'var(--text-3)', fontSize: 11 } } : {})}
    />
  );
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart
        data={plan.rows as Record<string, unknown>[]}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 8, right: 14, bottom: view.xLabel ? 14 : 2, left: 2 }}
        barCategoryGap="22%"
        barGap={2}
        {...(onPoint
          ? {
              style: { cursor: 'pointer' },
              onClick: (state: { activeTooltipIndex?: number | string | null; activeIndex?: number | string | null; activeLabel?: unknown }) => {
                const at = Number(state?.activeTooltipIndex ?? state?.activeIndex);
                const row = Number.isInteger(at) ? plan.rows[at] : state?.activeLabel !== undefined ? plan.rows.find((r) => r[plan.x] === state.activeLabel) : undefined;
                if (row) onPoint(row);
              },
            }
          : {})}
      >
        <defs>
          {plan.series.map((s, i) => (
            <linearGradient key={s.key} id={`${id}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colorOf(i, s)} stopOpacity={view.stacked ? 0.5 : 0.28} />
              <stop offset="100%" stopColor={colorOf(i, s)} stopOpacity={view.stacked ? 0.18 : 0} />
            </linearGradient>
          ))}
        </defs>
        {view.grid ? <CartesianGrid stroke="var(--hairline)" strokeDasharray="3 4" vertical={false} horizontal={!horizontal} /> : null}
        {xAxis}
        {yAxis}
        <Tooltip content={<Tip plan={plan} span={span} />} cursor={kind === 'bar' ? { fill: 'var(--bg-hover)' } : { stroke: 'var(--hairline-strong)', strokeWidth: 1 }} isAnimationActive={false} />
        {plan.series.map((s, i) => {
          const type = s.type ?? kind;
          const color = colorOf(i, s);
          const hide = off.has(s.key);
          if (type === 'bar')
            return <Bar key={s.key} dataKey={s.key} name={s.label} fill={color} hide={hide} {...(stack ? { stackId: stack } : {})} radius={view.stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={44} isAnimationActive={animate} stroke="var(--view-surface)" strokeWidth={view.stacked ? 1 : 0} />;
          if (type === 'area')
            return <Area key={s.key} type={curve} dataKey={s.key} name={s.label} stroke={color} strokeWidth={2} fill={`url(#${id}-${i})`} hide={hide} {...(stack ? { stackId: stack } : {})} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--view-surface)' }} isAnimationActive={animate} connectNulls />;
          return <Line key={s.key} type={curve} dataKey={s.key} name={s.label} stroke={color} strokeWidth={2} hide={hide} dot={dots ? { r: 2.5, strokeWidth: 0, fill: color } : false} activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--view-surface)' }} isAnimationActive={animate} connectNulls />;
        })}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function Dots({ plan, colorOf, view, off }: { plan: ChartPlan; colorOf: (i: number, s?: { color?: string | undefined }) => string; view: View; off: ReadonlySet<string> }) {
  const axis = { tick: { fill: 'var(--text-3)', fontSize: 11 }, tickLine: false, axisLine: { stroke: 'var(--hairline-strong)' } } as const;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 8, right: 14, bottom: 2, left: 2 }}>
        {view.grid ? <CartesianGrid stroke="var(--hairline)" strokeDasharray="3 4" /> : null}
        <XAxis dataKey={plan.x} type="number" name={plan.xColumn?.label ?? plan.x} tickFormatter={(val: number) => formatNumber(val, { compact: true })} {...axis} />
        <YAxis type="number" dataKey={plan.series[0]?.key} tickFormatter={tickY(plan.yColumn)} width={52} {...axis} />
        <Tooltip content={<Tip plan={plan} span={0} />} cursor={{ stroke: 'var(--hairline-strong)' }} isAnimationActive={false} />
        {plan.series.map((s, i) =>
          off.has(s.key) ? null : <Scatter key={s.key} name={s.label} data={plan.rows.map((r) => ({ [plan.x]: r[plan.x], [plan.series[0]!.key]: r[s.key], ...r }))} fill={colorOf(i, s)} fillOpacity={0.78} stroke="var(--view-surface)" strokeWidth={1.5} isAnimationActive={false} />,
        )}
      </ScatterChart>
    </ResponsiveContainer>
  );
}

function Donut({ plan, kind, colorOf, legend }: { plan: ChartPlan; kind: 'pie' | 'donut'; colorOf: (i: number) => string; legend: boolean }) {
  const key = plan.series[0]!.key;
  // Slices past the eighth fold into "Other", largest first.
  const all = plan.rows.map((r) => ({ name: String(r[plan.x] ?? '—'), value: Math.max(0, Number(r[key]) || 0) })).sort((a, b) => b.value - a.value);
  const slices = all.length > 8 ? [...all.slice(0, 7), { name: 'Other', value: all.slice(7).reduce((n, s) => n + s.value, 0) }] : all;
  const sum = slices.reduce((n, s) => n + s.value, 0) || 1;
  return (
    <div className={v.donut}>
      <div className={v.donutPlot}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="name" innerRadius={kind === 'donut' ? '58%' : 0} outerRadius="92%" paddingAngle={slices.length > 1 ? 1.5 : 0} stroke="var(--view-surface)" strokeWidth={2} isAnimationActive={!reducedMotion()} cornerRadius={kind === 'donut' ? 4 : 2}>
              {slices.map((s, i) => (
                <PieCell key={s.name} fill={colorOf(i)} />
              ))}
            </Pie>
            <Tooltip content={<PieTip sum={sum} col={plan.yColumn} />} isAnimationActive={false} />
          </PieChart>
        </ResponsiveContainer>
        {kind === 'donut' ? (
          <div className={v.donutCenter}>
            <span className={v.donutValue}>{plan.yColumn ? formatCell(sum, plan.yColumn) : formatNumber(sum, { compact: true })}</span>
            <span className={v.donutLabel}>Total</span>
          </div>
        ) : null}
      </div>
      {legend ? (
        <ul className={v.donutLegend}>
          {slices.map((s, i) => (
            <li key={s.name}>
              <span className={v.legendMark} style={{ background: colorOf(i) }} />
              <span className={v.donutName}>{s.name}</span>
              <span className={v.donutPct}>{formatNumber((s.value / sum) * 100, { decimals: 1 })}%</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type TipProps = { active?: boolean; payload?: ReadonlyArray<{ dataKey?: unknown; name?: unknown; value?: unknown; color?: string; payload?: Record<string, unknown> }>; label?: unknown };

function Tip({ plan, span, active, payload, label }: TipProps & { plan: ChartPlan; span: number }) {
  if (!active || !payload?.length) return null;
  const x = label ?? payload[0]?.payload?.[plan.x];
  const heading = plan.time ? (() => {
    const d = toDate(x as Cell);
    return d ? (span < 2 * 86_400_000 ? d.toLocaleString() : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })) : String(x);
  })() : plan.xColumn ? formatCell(x as Cell, plan.xColumn) : String(x ?? '');
  return (
    <div className={v.tip}>
      <div className={v.tipHead}>{heading}</div>
      {payload.map((p) => {
        const s = plan.series.find((s) => s.key === p.dataKey);
        return (
          <div key={String(p.dataKey)} className={v.tipRow}>
            <span className={v.legendMark} style={{ background: p.color }} />
            <span className={v.tipName}>{String(s?.label ?? p.name ?? p.dataKey)}</span>
            <span className={v.tipValue}>{typeof p.value === 'number' ? (plan.yColumn && plan.yColumn.type !== 'number' ? formatCell(p.value, plan.yColumn) : formatNumber(p.value)) : String(p.value ?? '—')}</span>
          </div>
        );
      })}
    </div>
  );
}

function PieTip({ active, payload, sum, col }: TipProps & { sum: number; col: Column | undefined }) {
  const p = active ? payload?.[0] : undefined;
  if (!p) return null;
  const value = Number(p.value) || 0;
  return (
    <div className={v.tip}>
      <div className={v.tipRow}>
        <span className={v.legendMark} style={{ background: (p.payload as { fill?: string } | undefined)?.fill ?? p.color }} />
        <span className={v.tipName}>{String(p.name)}</span>
        <span className={v.tipValue}>
          {col ? formatCell(value, col) : formatNumber(value)} · {formatNumber((value / sum) * 100, { decimals: 1 })}%
        </span>
      </div>
    </div>
  );
}
