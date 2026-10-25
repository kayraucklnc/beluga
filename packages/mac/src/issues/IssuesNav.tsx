import { Icon } from '../components/Icon.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { Row } from '../layout/sidebar-parts.js';
import { projectOfView, useTasksPrefs } from '../tasks/use-tasks.js';

/**
 * The sidebar's Issues row, under Tasks: the GitHub issues of the project you're in (Issues never
 * mixes projects). Only while the board runs: every way of working on an issue goes through it.
 */
export function IssuesNav() {
  const actions = useActions();
  const prefs = useTasksPrefs();
  const enabled = useApp((s) => s.board.enabled);
  const here = useApp(projectOfView);
  const selected = useApp((s) => s.view.kind === 'issues' || s.view.kind === 'gh_issue');
  const project = useApp((s) => s.projects.find((p) => p.id === (here ?? prefs.project) && p.root)?.name);
  if (!enabled) return null;
  return (
    <Row
      icon={<Icon name="issue" size={14} />}
      label="Issues"
      detail={project ? `${project}’s GitHub issues` : 'GitHub issues, for Claude to investigate or fix'}
      selected={selected}
      onClick={() => actions.run({ type: 'view', view: { kind: 'issues', ...(here ? { projectId: here } : {}) } })}
    />
  );
}
