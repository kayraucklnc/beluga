import { type CSSProperties, useMemo } from 'react';
import type { View } from '@beluga/shared/view-spec.js';
import { type GanttBar, along, barTone, planGantt } from '@beluga/shared/render/grid-model.js';
import { cx } from '../ui.js';
import type { ViewData } from './use-view-data.js';
import { formatNumber } from './format.js';
import { useHoverTip } from './HoverTip.js';
import v from './views.module.css';

/**
 * A gantt (a timeline): a row per bar from its start to its end, in lanes, on a time axis. Bars
 * are pastel pills by status (done mint, active sky, blocked rose…), their progress a deeper fill;
 * a milestone is a small diamond, today a thin dashed line. Hover a bar for its dates.
 */

const dayF = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const timeF = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function when(bar: GanttBar, hours: boolean): string {
  const f = hours ? timeF : dayF;
  if (bar.milestone) return f.format(bar.start);
  // A bar to the end of a day reads as ending on that day.
  const end = !hours && bar.end - bar.start >= 86_400_000 ? bar.end - 1 : bar.end;
  return `${f.format(bar.start)} – ${f.format(end)}`;
}

export function GanttView({ view, data, full }: { view: View; data: ViewData; full: boolean }) {
  const plan = useMemo(() => planGantt(view, data.rows, data.columns), [view, data.rows, data.columns]);
  const { show, hide, tip } = useHoverTip();
  if (!plan) return <div className={v.empty}>{data.loading ? 'Loading…' : 'Nothing to put on a timeline (it needs a start date)'}</div>;
  const pct = (t: number): string => `${(along(plan, t) * 100).toFixed(3)}%`;
  const bars = plan.lanes.reduce((n, l) => n + l.bars.length, 0);
  return (
    <div className={cx(v.gantt, !full && bars > 25 && v.ganttScroll)} onMouseLeave={hide}>
      <div className={v.ganttAxis}>
        <span className={v.ganttCorner} />
        <span className={v.ganttTrack}>
          {plan.ticks.map((t) => (
            <span key={t.t} className={v.ganttTick} style={{ left: pct(t.t) }}>
              {t.label}
            </span>
          ))}
        </span>
      </div>
      <div className={v.ganttRows}>
        <div className={v.ganttGrid} aria-hidden="true">
          {plan.ticks.map((t) => (
            <span key={t.t} className={v.ganttLine} style={{ left: pct(t.t) }} />
          ))}
          {plan.today !== undefined ? <span className={v.ganttToday} style={{ left: pct(plan.today) }} title="Today" /> : null}
        </div>
        {plan.lanes.map((lane, li) => (
          <div key={`${lane.name}-${li}`} className={v.ganttLane} role="group" aria-label={lane.name || undefined}>
            {lane.name ? <div className={v.ganttLaneName}>{lane.name}</div> : null}
            {lane.bars.map((bar, i) => {
              const tone = barTone(bar.status);
              const body = (
                <>
                  <div className={v.tipHead}>{bar.label || 'Untitled'}</div>
                  <div className={v.tipRow}>
                    <span className={v.tipName}>{when(bar, plan.hours)}</span>
                  </div>
                  {bar.progress !== undefined ? (
                    <div className={v.tipRow}>
                      <span className={v.tipName}>Progress</span>
                      <span className={v.tipValue}>{formatNumber(bar.progress * 100, { decimals: 0 })}%</span>
                    </div>
                  ) : null}
                  {bar.status ? (
                    <div className={v.tipRow}>
                      <span className={v.tipName}>Status</span>
                      <span className={v.tipValue}>{bar.status}</span>
                    </div>
                  ) : null}
                </>
              );
              const style = { left: pct(bar.start), width: `max(6px, ${((along(plan, bar.end) - along(plan, bar.start)) * 100).toFixed(3)}%)` } as CSSProperties;
              return (
                <div key={i} className={v.ganttRow}>
                  <span className={v.ganttLabel} title={bar.label}>
                    {bar.label || '—'}
                  </span>
                  <span className={v.ganttTrack}>
                    {bar.milestone ? (
                      <span className={v.ganttMilestone} data-tone={tone} style={{ left: pct(bar.start) }} onMouseEnter={(e) => show(e.currentTarget, body)} onMouseLeave={hide} aria-label={`${bar.label}: ${when(bar, plan.hours)}`} />
                    ) : (
                      <span className={v.ganttBar} data-tone={tone} style={style} onMouseEnter={(e) => show(e.currentTarget, body)} onMouseLeave={hide} aria-label={`${bar.label}: ${when(bar, plan.hours)}`}>
                        {bar.progress !== undefined ? <span className={v.ganttProgress} style={{ width: `${bar.progress * 100}%` }} /> : null}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {tip}
    </div>
  );
}
