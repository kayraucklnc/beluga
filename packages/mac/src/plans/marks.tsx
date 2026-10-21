import type { TaskState } from '@klaud/core/plans/progress.js';
import { cx } from '../components/ui.js';
import { type Tone, TASK_STATE } from './plans-model.js';
import p from './plans.module.css';

/** Small marks shared by the plan's graph, outline and lists: a task's state, a tone pill, progress. */

export function TaskStateIcon({ state, size = 14 }: { state: TaskState; size?: number }) {
  const tone = TASK_STATE[state].tone;
  const c = 8;
  const r = 5.6;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={cx(p.stateIcon, p[`tone_${tone}`], state === 'running' && p.spinning)} aria-hidden="true">
      {state === 'done' ? (
        <>
          <circle cx={c} cy={c} r={6.5} className={p.iconFill} />
          <path d="M5.2 8.2l1.9 1.9 3.8-4.1" className={p.iconMark} />
        </>
      ) : state === 'canceled' || state === 'missing' ? (
        <>
          <circle cx={c} cy={c} r={6.5} className={p.iconFill} />
          <path d="M5.8 5.8l4.4 4.4 M10.2 5.8l-4.4 4.4" className={p.iconMark} />
        </>
      ) : state === 'blocked' ? (
        <>
          <rect x={4.5} y={7.2} width={7} height={5.3} rx={1.2} className={p.iconFill} />
          <path d="M6 7.2V5.6a2 2 0 0 1 4 0v1.6" className={p.iconRing} />
        </>
      ) : state === 'asking' ? (
        <>
          <circle cx={c} cy={c} r={6.5} className={p.iconFill} />
          <path d="M8 4.8v4 M8 11.1v.01" className={p.iconMark} />
        </>
      ) : state === 'running' ? (
        <>
          <circle cx={c} cy={c} r={r} className={p.iconTrack} />
          <path d={`M${c} ${c - r}a${r} ${r} 0 0 1 ${r} ${r}`} className={p.iconRing} />
          <circle cx={c} cy={c} r={2} className={p.iconFill} />
        </>
      ) : state === 'review' || state === 'idle' ? (
        <>
          <circle cx={c} cy={c} r={r} className={p.iconRing} />
          <path d={state === 'review' ? `M${c} ${c}V${c - 3.6}A3.6 3.6 0 1 1 ${c - 3.6} ${c}z` : `M${c} ${c}V${c - 3.6}A3.6 3.6 0 0 1 ${c} ${c + 3.6}z`} className={p.iconFill} />
        </>
      ) : state === 'ready' ? (
        <>
          <circle cx={c} cy={c} r={r} className={p.iconRing} />
          <circle cx={c} cy={c} r={2.2} className={p.iconFill} />
        </>
      ) : (
        <circle cx={c} cy={c} r={r} className={cx(p.iconRing, p.dashed)} />
      )}
    </svg>
  );
}

export function TonePill({ tone, children, live }: { tone: Tone; children: React.ReactNode; live?: boolean }) {
  return (
    <span className={cx(p.pill, p[`tone_${tone}`])}>
      <span className={cx(p.pillDot, live && p.pillLive)} aria-hidden="true" />
      {children}
    </span>
  );
}

/** A plan's milestones as a row of segments, each filled as far as it got. */
export function MilestoneBar({ items }: { items: ReadonlyArray<{ readonly id: string; readonly title: string; readonly state: string; readonly share: number }> }) {
  return (
    <span className={p.bar} role="img" aria-label={items.map((m) => `${m.title}: ${Math.round(m.share * 100)}%`).join(', ')}>
      {items.map((m) => (
        <span key={m.id} className={cx(p.barSegment, p[`seg_${m.state}`])} title={m.title}>
          <span className={p.barFill} style={{ width: `${Math.round(m.share * 100)}%` }} />
        </span>
      ))}
    </span>
  );
}
