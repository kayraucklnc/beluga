import { type CSSProperties, useMemo } from 'react';
import type { View } from '@beluga/shared/view-spec.js';
import { planHeatmap, scaleColor, scaleOf } from '@beluga/shared/render/grid-model.js';
import { useDocTheme } from '../markdown/use-doc-theme.js';
import type { ViewData } from './use-view-data.js';
import { formatCell, formatNumber } from './format.js';
import { useHoverTip } from './HoverTip.js';
import v from './views.module.css';

/**
 * A heatmap: x across, y down, each cell colored by its value along a soft scale (Claude can give
 * its own colors). Cells stay square-ish and shrink to fit; past their smallest the grid scrolls
 * sideways. A legend from the least to the most; hover a cell for its value.
 */

export function HeatmapView({ view, data }: { view: View; data: ViewData }) {
  const dark = useDocTheme() === 'dark';
  const plan = useMemo(() => planHeatmap(view, data.rows, data.columns), [view, data.rows, data.columns]);
  const { show, hide, tip } = useHoverTip();
  if (!plan) return <div className={v.empty}>{data.loading ? 'Loading…' : 'Nothing to draw as a heatmap'}</div>;
  const scale = scaleOf(view, dark);
  const fmt = (n: number): string => (plan.valueColumn ? formatCell(n, plan.valueColumn) : formatNumber(n));
  const labelCh = Math.min(18, Math.max(3, ...plan.ys.map((y) => y.length)));
  const tall = plan.xs.length > 14 || plan.xs.some((x) => x.length > 6);
  const style = {
    '--heat-label': `calc(${labelCh}ch + 10px)`,
    gridTemplateColumns: `var(--heat-label) repeat(${plan.xs.length}, minmax(10px, 1fr))`,
    minWidth: `calc(${labelCh}ch + 10px + ${plan.xs.length * 12}px)`,
    maxWidth: `calc(${labelCh}ch + 10px + ${plan.xs.length * 44}px)`,
  } as CSSProperties;
  return (
    <div className={v.heat} onMouseLeave={hide}>
      <div className={v.heatScroll}>
        <div className={v.heatGrid} style={style} role="grid" aria-label={view.title ?? 'Heatmap'}>
          <span />
          {plan.xs.map((x, i) => (
            <span key={`x${i}`} className={tall ? v.heatXTall : v.heatX} title={x}>
              {x}
            </span>
          ))}
          {plan.ys.map((y, yi) => (
            <Row key={`y${yi}`} y={y} cells={plan.cells[yi] ?? []} xs={plan.xs} color={(n) => scaleColor(n, plan.min, plan.max, scale)} fmt={fmt} show={show} hide={hide} />
          ))}
        </div>
      </div>
      <div className={v.heatLegend}>
        <span>{fmt(plan.min)}</span>
        <span className={v.heatRamp} style={{ background: `linear-gradient(to right, ${scale.slice(1).join(', ')})` }} />
        <span>{fmt(plan.max)}</span>
      </div>
      {tip}
    </div>
  );
}

function Row({ y, cells, xs, color, fmt, show, hide }: { y: string; cells: readonly (number | null)[]; xs: readonly string[]; color: (n: number | null) => string; fmt: (n: number) => string; show: (el: Element, body: React.ReactNode) => void; hide: () => void }) {
  return (
    <>
      <span className={v.heatY} title={y}>
        {y}
      </span>
      {xs.map((x, xi) => {
        const n = cells[xi] ?? null;
        const body = (
          <>
            <div className={v.tipHead}>
              {x} · {y}
            </div>
            <div className={v.tipRow}>
              <span className={v.legendMark} style={{ background: color(n) }} />
              <span className={v.tipName}>Value</span>
              <span className={v.tipValue}>{n === null ? '—' : fmt(n)}</span>
            </div>
          </>
        );
        return <span key={xi} role="gridcell" className={v.heatCell} style={{ background: color(n) }} aria-label={`${x}, ${y}: ${n === null ? 'no value' : fmt(n)}`} onMouseEnter={(e) => show(e.currentTarget, body)} onMouseLeave={hide} />;
      })}
    </>
  );
}
