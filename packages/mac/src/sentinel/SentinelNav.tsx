import { Icon } from '../components/Icon.js';
import { Dot } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { Row } from '../layout/sidebar-parts.js';
import { sameDeep } from '../lib/stable.js';
import { anyRunning, sidebarLine } from './sentinel-model.js';
import { dashboardLine } from './numbers-model.js';
import s from './sentinel-nav.module.css';

/** Views that are Sentinel's (the row is selected on each). */
export const isSentinelView = (kind: string): boolean => kind === 'sentinel' || kind === 'sentinel_page' || kind === 'sentinel_run';

/**
 * The sidebar's Sentinel row, always there under Work. Its line (the row's hint): how many watch
 * and when the next runs, or "Paused after 3 failures" with the problem mark; a live dot while a run goes.
 */
export function SentinelNav() {
  const actions = useActions();
  const { line, live, selected } = useApp((st) => ({ line: sidebarLine(st.sentinel), live: anyRunning(st.sentinel), selected: isSentinelView(st.view.kind) }), sameDeep);
  return (
    <Row
      icon={<Icon name="sentinel" size={14} />}
      label="Sentinel"
      detail={line.text}
      selected={selected}
      onClick={() => actions.run({ type: 'view', view: { kind: 'sentinel' } })}
      trailing={live ? <Dot tone="claude" live /> : line.problem ? <Icon name="alert" size={12} className={s.alert} /> : null}
      data-sentinel-row=""
      data-problem={line.problem || undefined}
    />
  );
}

/**
 * The sidebar's Dashboard row, under Sentinel (docs/sentinel.md §10): how many numbers sentinels
 * keep, or "Fetching… 2 of 3" while a Refresh goes. Shown once Sentinel runs here.
 */
export function DashboardNav() {
  const actions = useActions();
  const { line, selected, on } = useApp((st) => ({ line: dashboardLine(st.sentinel), selected: st.view.kind === 'dashboard', on: st.sentinel.enabled }), sameDeep);
  if (!on) return null;
  return <Row icon={<Icon name="gauge" size={14} />} label="Dashboard" detail={line} selected={selected} onClick={() => actions.run({ type: 'view', view: { kind: 'dashboard' } })} data-dashboard-row="" />;
}
