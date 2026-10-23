import { Icon } from '../components/Icon.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { Row } from '../layout/sidebar-parts.js';
import { useTasksPrefs } from './use-tasks.js';

/**
 * The sidebar's Tasks row: the board of the project you're in (Tasks never mixes projects, so
 * there's no count across them here). Only while the board runs.
 */
export function TasksNav() {
  const actions = useActions();
  const prefs = useTasksPrefs();
  const enabled = useApp((s) => s.board.enabled);
  const selected = useApp((s) => s.view.kind === 'tasks' || s.view.kind === 'task');
  const project = useApp((s) => s.projects.find((p) => p.id === prefs.project && p.root)?.name);
  if (!enabled) return null;
  return (
    <Row
      icon={<Icon name="task" size={14} />}
      label="Tasks"
      detail={project ? `${project}’s tasks` : 'Plan and track the work, project by project'}
      selected={selected}
      onClick={() => actions.run({ type: 'view', view: { kind: 'tasks' } })}
    />
  );
}
