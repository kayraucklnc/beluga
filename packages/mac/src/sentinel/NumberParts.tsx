import { Suspense, lazy, useMemo } from 'react';
import { type View, readView } from '@beluga/shared/view-spec.js';
import type { MetricSeries } from '@beluga/core/sentinel/model.js';
import { Icon } from '../components/Icon.js';
import { Spark } from '../components/views/Stats.js';
import { DataTable } from '../components/views/Table.js';
import { useViewData } from '../components/views/use-view-data.js';
import { Segmented, cx } from '../components/ui.js';
import type { Compare } from '@beluga/core/sentinel/metrics.js';
import { COMPARE_CHOICES, type NumberWords, chartViewOf, seriesViewOf, tableViewOf } from './numbers-model.js';
import v from '../components/views/views.module.css';
import n from './numbers.module.css';

/**
 * The pieces numbers are drawn with, on a sentinel's page and on the Dashboard: a number as the
 * chat's stat tile (its value, its change in the good or bad tone, a sparkline), a chart over time
 * (the chat's line view; a point opens its run), rows as the chat's table, and the compare switch.
 */

const Chart = lazy(() => import('../components/views/Chart.js'));

export function CompareSwitch({ value, onChange, label = 'Compare with' }: { value: Compare; onChange: (c: Compare) => void; label?: string }) {
  return <Segmented<Compare> label={label} value={value} onChange={onChange} options={COMPARE_CHOICES} />;
}

/** A number as a stat tile. `note`: a quiet word in its corner ("paused", "vs last week" when pinned). */
export function NumberTile({ w, note, selected, onClick, className, children }: { w: NumberWords; note?: string; selected?: boolean; onClick?: () => void; className?: string; children?: React.ReactNode }) {
  const good = w.tone === 'good' ? true : w.tone === 'bad' ? false : undefined;
  const up = w.change?.startsWith('+');
  const body = (
    <>
      <div className={v.tileLabel}>
        <span className={n.tileLabelText}>{w.label}</span>
        {note ? <span className={n.note}>{note}</span> : null}
        {children}
      </div>
      <div className={v.tileMain}>
        <div className={v.tileValue}>
          {w.value}
          {w.unit ? <span className={v.tileUnit}>{w.unit}</span> : null}
        </div>
        {w.trend.length > 1 ? <Spark values={w.trend} good={good} /> : null}
      </div>
      <div className={cx(v.tileFoot, n.foot)}>
        {w.change ? (
          <span className={cx(v.delta, n.delta)} data-good={good === undefined ? undefined : String(good)} data-tone={w.tone}>
            <Icon name={w.change === 'no change' ? 'minus' : 'up'} size={10} className={up || w.change === 'no change' ? undefined : v.down} />
            {w.change}
          </span>
        ) : null}
        <span className={cx(v.tileHint, n.vs)}>{w.vs}</span>
      </div>
    </>
  );
  if (!onClick) return <div className={cx(v.tile, n.tile, className)}>{body}</div>;
  return (
    <button type="button" className={cx(v.tile, n.tile, n.tileButton, className)} aria-pressed={selected} onClick={onClick} data-selected={selected || undefined}>
      {body}
    </button>
  );
}

/** Some metrics over time, as the chat's chart; a click on a point hears its run. */
export function MetricChart({ series, kind = 'line', height = 220, onRun }: { series: readonly MetricSeries[]; kind?: 'line' | 'area' | 'bar'; height?: number; onRun?: (runId: string) => void }) {
  const view = useMemo(() => {
    const r = readView(chartViewOf(series, kind, height));
    return r.ok ? r.view : undefined;
  }, [series, kind, height]);
  if (!view) return null;
  return <ChartBody view={view} kind={kind} {...(onRun ? { onRun } : {})} />;
}

function ChartBody({ view, kind, onRun }: { view: View; kind: 'line' | 'area' | 'bar'; onRun?: (runId: string) => void }) {
  const data = useViewData(view, { local: true, visible: true, limit: 500 });
  return (
    <div className={n.chart}>
      <Suspense fallback={<div className={v.chartWait} style={{ height: view.height ?? 220 }} />}>
        <Chart view={view} data={data} kind={kind} full={false} fit {...(onRun ? { onPoint: (row: Readonly<Record<string, unknown>>) => typeof row.runId === 'string' && onRun(row.runId) } : {})} />
      </Suspense>
    </div>
  );
}

/** A series metric's latest array, as the chat's chart (each point's label along the bottom). */
export function SeriesChart({ metric, kind = 'bar', height = 220 }: { metric: MetricSeries; kind?: 'line' | 'area' | 'bar'; height?: number }) {
  const view = useMemo(() => {
    const r = readView(seriesViewOf(metric, kind, height));
    return r.ok ? r.view : undefined;
  }, [metric, kind, height]);
  if (!view) return null;
  return <ChartBody view={view} kind={kind} />;
}

/** A rows metric (or a list from a step's output) as the chat's table, a page at a time. */
export function RowsTable({ metric, pageSize = 8 }: { metric: Pick<MetricSeries, 'rows' | 'columns'>; pageSize?: number }) {
  const view = useMemo(() => {
    const r = readView(tableViewOf(metric, pageSize));
    return r.ok ? r.view : undefined;
  }, [metric, pageSize]);
  if (!view) return null;
  return <TableBody view={view} />;
}

function TableBody({ view }: { view: View }) {
  const data = useViewData(view, { local: true, visible: true });
  return (
    <div className={n.table}>
      <DataTable view={view} data={data} full={false} />
    </div>
  );
}
