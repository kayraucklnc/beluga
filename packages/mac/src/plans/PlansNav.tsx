import { Icon } from '../components/Icon.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/klaud.js';
import { Row } from '../layout/sidebar-parts.js';

/** The sidebar's Plans row (only while plans run): a dot while one waits for you. */
export function PlansNav() {
  const actions = useActions();
  const enabled = useApp((s) => s.plans.enabled);
  const selected = useApp((s) => s.view.kind === 'plans' || s.view.kind === 'plan');
  const running = useApp((s) => s.plans.plans.filter((x) => x.status === 'active' && !x.paused).length);
  if (!enabled) return null;
  return <Row icon={<Icon name="flag" size={14} />} label="Plans" detail={running ? `${running} running` : 'Big work, planned with Claude'} selected={selected} onClick={() => actions.run({ type: 'view', view: { kind: 'plans' } })} />;
}
