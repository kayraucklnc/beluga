import { Icon } from '../components/Icon.js';
import { Dot } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { Row } from '../layout/sidebar-parts.js';
import { sameDeep } from '../lib/stable.js';
import { anyRunning, isSentinelView, sidebarLine } from './sentinel-model.js';
import s from './sentinel-nav.module.css';

export { isSentinelView };

/**
 * The sidebar's Sentinel row, always there under Work: the one row for the whole section (its
 * Sentinels, Dashboard and Chat tabs are on its page). Its line (the row's hint): how many watch
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
      aria-current={selected ? 'page' : undefined}
      data-problem={line.problem || undefined}
    />
  );
}
