import { Icon } from '../components/Icon.js';
import { Badge } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { Row } from '../layout/sidebar-parts.js';
import { waitingForYou } from './RequestsView.js';

/** The sidebar's Requests row (tasks between Claudes), with how many wait for you. Only while the gateway runs. */
/** `whenAny`: only while a request is unanswered (or you're looking at them): answered ones leave the sidebar. */
export function RequestsNav({ whenAny }: { whenAny?: boolean } = {}) {
  const actions = useActions();
  const enabled = useApp((st) => st.gateway.enabled);
  const selected = useApp((st) => st.view.kind === 'requests');
  const waiting = useApp((st) => waitingForYou(st.gateway.tasks));
  const live = useApp((st) => st.gateway.tasks.filter((t) => t.state === 'sent' || t.state === 'queued' || t.state === 'working' || t.state === 'awaiting_approval').length);
  // Calm: no row until there's a request at all; then it stays, so what you sent (and your rules) is a click away.
  const any = useApp((st) => st.gateway.tasks.length > 0);
  if (!enabled || (whenAny && !waiting && !live && !any && !selected)) return null;
  return (
    <Row
      icon={<Icon name="hand" size={14} />}
      label="Requests"
      detail={waiting ? `${waiting} waiting for you` : live ? `${live} in progress` : 'Tasks between agents'}
      selected={selected}
      onClick={() => actions.run({ type: 'view', view: { kind: 'requests' } })}
      trailing={waiting ? <Badge count={waiting} urgent /> : null}
    />
  );
}
