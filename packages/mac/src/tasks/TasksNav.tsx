import { isMine, isOpen } from '@klaud/core/board/model.js';
import { Icon } from '../components/Icon.js';
import { Badge } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/klaud.js';
import { Row } from '../layout/sidebar-parts.js';

/** The sidebar's Tasks row: how many are yours (or your Claude's) and open. Only while the board runs. */
export function TasksNav() {
  const actions = useActions();
  const enabled = useApp((s) => s.board.enabled);
  const selected = useApp((s) => s.view.kind === 'tasks' || s.view.kind === 'task');
  const mine = useApp((s) => s.board.issues.filter((i) => isOpen(i.status) && i.status !== 'backlog' && isMine(i, s.selfId)).length);
  const review = useApp((s) => s.board.issues.filter((i) => i.status === 'in_review' && isMine(i, s.selfId)).length);
  if (!enabled) return null;
  return (
    <Row
      icon={<Icon name="task" size={14} />}
      label="Tasks"
      detail={review ? `${review} in review` : mine ? `${mine} for you` : 'Plan and track the work'}
      selected={selected}
      onClick={() => actions.run({ type: 'view', view: { kind: 'tasks' } })}
      trailing={mine ? <Badge count={mine} /> : null}
    />
  );
}
