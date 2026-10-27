import type { Cell, Stat, View } from '@beluga/shared/view-spec.js';
import { Icon } from '../Icon.js';
import type { ViewData } from './use-view-data.js';
import { formatCell, formatNumber, isNumeric } from './format.js';
import v from './views.module.css';

/**
 * Stat tiles: a few numbers that matter, each big, with its change (green when it's good, which
 * `invert` turns around: latency going down is good) and a sparkline of how it got here. From
 * `items`, or from rows (a source's): a `label` and a `value` column, or each numeric column's
 * latest value with its history as the trend.
 */

export function StatTiles({ view, data }: { view: View; data: ViewData }) {
  const items = view.items.length && !data.switched ? view.items : statsFromRows(data);
  if (!items.length) return <div className={v.empty}>{data.loading ? 'Loading…' : 'Nothing to show'}</div>;
  return (
    <div className={v.stats} data-count={Math.min(items.length, 4)}>
      {items.map((s, i) => (
        <Tile key={`${s.label}-${i}`} stat={s} />
      ))}
    </div>
  );
}

function statsFromRows(data: ViewData): Stat[] {
  const cols = data.columns;
  const labelCol = cols.find((c) => /^(label|name|metric|title|key)$/i.test(c.key)) ?? cols.find((c) => !isNumeric(c));
  const valueCol = cols.find((c) => /^(value|count|total|amount)$/i.test(c.key)) ?? cols.find((c) => isNumeric(c) && c !== labelCol);
  if (labelCol && valueCol && data.rows.length <= 12 && new Set(data.rows.map((r) => r[labelCol.key])).size === data.rows.length) {
    return data.rows.map((r) => ({ label: String(r[labelCol.key] ?? ''), value: (r[valueCol.key] as number | string | null) ?? '—', type: valueCol.type, ...(valueCol.unit ? { unit: valueCol.unit } : {}) }));
  }
  // A series of rows: each numeric column's last value, its change, and its history.
  return cols
    .filter(isNumeric)
    .slice(0, 6)
    .map((c) => {
      const values = data.rows.map((r) => r[c.key]).filter((x): x is number => typeof x === 'number');
      const last = values.at(-1) ?? 0;
      const before = values.at(-2);
      return { label: c.label ?? c.key, value: last, type: c.type, ...(c.unit ? { unit: c.unit } : {}), ...(before !== undefined && before !== 0 ? { delta: `${last >= before ? '+' : ''}${formatNumber(((last - before) / Math.abs(before)) * 100, { decimals: 1 })}%` } : {}), ...(values.length > 2 ? { trend: values.slice(-60) } : {}) };
    });
}

function Tile({ stat }: { stat: Stat }) {
  const value = typeof stat.value === 'number' ? formatCell(stat.value as Cell, { type: stat.type ?? 'number', ...(stat.currency ? { currency: stat.currency } : {}) }) : stat.value;
  const dir = deltaDir(stat.delta);
  const good = dir === 0 ? undefined : (dir > 0) !== Boolean(stat.invert);
  return (
    <div className={v.tile} data-status={stat.status}>
      <div className={v.tileLabel}>
        {stat.status ? <span className={v.statusMark} data-status={stat.status} aria-label={stat.status} /> : null}
        {stat.label}
      </div>
      <div className={v.tileMain}>
        <div className={v.tileValue}>
          {value}
          {stat.unit ? <span className={v.tileUnit}>{stat.unit}</span> : null}
        </div>
        {stat.trend && stat.trend.length > 1 ? <Spark values={stat.trend} good={good} /> : null}
      </div>
      {stat.delta !== undefined || stat.hint ? (
        <div className={v.tileFoot}>
          {stat.delta !== undefined ? (
            <span className={v.delta} data-good={good === undefined ? undefined : String(good)}>
              <Icon name={dir > 0 ? 'up' : dir < 0 ? 'up' : 'minus'} size={10} className={dir < 0 ? v.down : undefined} />
              {typeof stat.delta === 'number' ? `${stat.delta > 0 ? '+' : ''}${formatNumber(stat.delta)}` : stat.delta.replace(/^\+?/, dir > 0 ? '+' : '')}
            </span>
          ) : null}
          {stat.deltaLabel || stat.hint ? <span className={v.tileHint}>{stat.deltaLabel ?? stat.hint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function deltaDir(d: Stat['delta']): number {
  if (d === undefined) return 0;
  const n = typeof d === 'number' ? d : parseFloat(d.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? Math.sign(n) : 0;
}

/** A sparkline: the trend's shape, its last point marked (Sentinel's number tiles draw it too). */
export function Spark({ values, good }: { values: readonly number[]; good: boolean | undefined }) {
  const w = 120;
  const h = 32;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((y, i) => [(i / (values.length - 1)) * w, h - 3 - ((y - min) / span) * (h - 6)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts.at(-1)!;
  return (
    <svg className={v.spark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" data-good={good === undefined ? undefined : String(good)}>
      <path d={`${d} L${w},${h} L0,${h} Z`} className={v.sparkFill} />
      <path d={d} className={v.sparkLine} vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={2.2} className={v.sparkDot} />
    </svg>
  );
}
