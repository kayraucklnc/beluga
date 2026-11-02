import { useEffect, useMemo, useState } from 'react';
import { MAX_INLINE_ROWS, type View, readView } from '@beluga/shared/view-spec.js';
import type { MetricLine } from '@beluga/core/sentinel/metrics.js';
import type { MetricSeries } from '@beluga/core/sentinel/model.js';
import { Markdown } from '../chat/Markdown.js';
import { FormSheet } from '../components/FormSheet.js';
import { Button } from '../components/ui.js';
import { DataTable } from '../components/views/Table.js';
import { useViewData } from '../components/views/use-view-data.js';
import { ago } from '../tasks/tasks-model.js';
import { useSentinelActions } from './use-sentinel.js';
import d from './data.module.css';
import n from './numbers.module.css';

/**
 * A metric's whole history (BLG-392), from its file: a number's value at every run, a table's rows
 * run by run (when each was kept first), a kept array's points, a kept output's last ones as they
 * read. The latest 500 rows show here; Export takes all of it to Downloads as CSV or JSON, and Show
 * in Finder opens where it's kept.
 */
export function DataSheet({ sentinelId, metric, close }: { sentinelId: string; metric: string; close: () => void }) {
  const a = useSentinelActions();
  const [got, setGot] = useState<{ readonly metric: MetricSeries; readonly lines: readonly MetricLine[] }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    a.api.metricRead(sentinelId, metric).then(
      (r) => alive && setGot(r),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [a, sentinelId, metric]);
  const m = got?.metric;
  const out = (format: 'csv' | 'json') => void a.act(() => a.api.dataExport(sentinelId, { metric, format }), 'Saved in Downloads › Beluga');
  return (
    <FormSheet
      title={m ? m.label : 'Kept data'}
      icon="table"
      intro={got ? summary(got.metric, got.lines) : undefined}
      submitLabel="Close"
      hideSubmit
      cancelLabel="Close"
      width={900}
      onSubmit={close}
      onCancel={close}
      footer={
        <span className={d.sheetBar}>
          <Button size="small" icon="download" onClick={() => out('csv')} disabled={!got?.lines.length}>
            Export CSV
          </Button>
          <Button size="small" icon="download" onClick={() => out('json')} disabled={!got?.lines.length}>
            Export JSON
          </Button>
          <Button size="small" icon="folder" onClick={() => void a.act(() => a.api.dataReveal(sentinelId))}>
            Show in Finder
          </Button>
        </span>
      }
    >
      {error ? <p className={d.note}>{error}</p> : !got ? <p className={d.note}>Reading it…</p> : got.metric.kind === 'output' ? <Outputs lines={got.lines} /> : <History metric={got.metric} lines={got.lines} />}
    </FormSheet>
  );
}

function summary(m: MetricSeries, lines: readonly MetricLine[]): string {
  if (!lines.length) return 'Nothing kept yet.';
  const runs = `${lines.length.toLocaleString()} ${lines.length === 1 ? 'run' : 'runs'}`;
  const rows = m.kind === 'rows' ? `${lines.reduce((t, l) => t + (l.rows?.length ?? 0), 0).toLocaleString()} rows over ` : '';
  return `${rows}${runs}, since ${ago(lines[0]!.at)}. Newest first.`;
}

/** A number, a table or a list of points: every line as rows, newest first (the latest MAX_INLINE_ROWS). */
function History({ metric, lines }: { metric: MetricSeries; lines: readonly MetricLine[] }) {
  const view = useMemo(() => {
    const newest = [...lines].reverse();
    const kept = (l: MetricLine) => new Date(l.at).toISOString();
    let columns: Array<{ key: string; label?: string; type?: string; currency?: string; unit?: string }>;
    let rows: Array<Record<string, unknown>>;
    if (metric.kind === 'rows') {
      const keys = [...new Set(newest.flatMap((l) => l.columns ?? Object.keys(l.rows?.[0] ?? {})))].slice(0, 30);
      columns = [{ key: '__kept', label: 'Kept', type: 'datetime' }, ...keys.map((key) => ({ key, label: metric.columnTypes?.find((c) => c.key === key)?.label ?? key }))];
      rows = newest.flatMap((l) => (l.rows ?? []).map((r) => ({ __kept: kept(l), ...r })));
    } else if (metric.kind === 'series') {
      columns = [{ key: '__kept', label: 'Kept', type: 'datetime' }, { key: 'x', label: 'Point' }, { key: 'y', label: 'Value', type: 'number' }];
      rows = newest.flatMap((l) => (l.series ?? []).map((p) => ({ __kept: kept(l), x: p.x, y: p.y })));
    } else {
      columns = [{ key: '__kept', label: 'Kept', type: 'datetime' }, { key: 'value', label: metric.label, ...unitColumn(metric.unit) }];
      rows = newest.filter((l) => l.value !== undefined).map((l) => ({ __kept: kept(l), value: l.value }));
    }
    const r = readView({ type: 'table', columns, data: rows.slice(0, MAX_INLINE_ROWS), pageSize: 25, search: true });
    return r.ok ? { view: r.view, cut: rows.length > MAX_INLINE_ROWS, total: rows.length } : undefined;
  }, [metric, lines]);
  if (!view) return <p className={d.note}>Its history doesn’t read as a table.</p>;
  return (
    <>
      <Rows view={view.view} />
      {view.cut ? <p className={d.note}>The latest {MAX_INLINE_ROWS.toLocaleString()} of {view.total.toLocaleString()} rows show here: Export has all of them.</p> : null}
    </>
  );
}

function Rows({ view }: { view: View }) {
  const data = useViewData(view, { local: true, visible: true });
  return (
    <div className={n.table}>
      <DataTable view={view} data={data} full={false} />
    </div>
  );
}

/** A number's column as its unit reads ("$3,412", "380 ms", "12%"). */
function unitColumn(unit: MetricSeries['unit']): { type: string; currency?: string; unit?: string } {
  if (unit.startsWith('currency:')) return { type: 'currency', currency: unit.slice('currency:'.length).toUpperCase() };
  if (unit === 'percent' || unit === 'bytes') return { type: unit };
  return unit === 'ms' ? { type: 'number', unit: 'ms' } : { type: 'number' };
}

/** A kept output's last ones, newest first, as they read. */
function Outputs({ lines }: { lines: readonly MetricLine[] }) {
  const newest = [...lines].reverse().filter((l) => l.output);
  if (!newest.length) return <p className={d.note}>Nothing kept yet.</p>;
  return (
    <div className={d.outputs}>
      {newest.map((l) => (
        <div key={`${l.runId}:${l.at}`} className={d.output}>
          <div className={d.outputHead}>
            <span>{ago(l.at)}</span>
            <span>{l.output!.format}</span>
          </div>
          {l.output!.format === 'markdown' ? <Markdown text={l.output!.text} /> : <pre className={d.outputText}>{l.output!.text}</pre>}
        </div>
      ))}
    </div>
  );
}
