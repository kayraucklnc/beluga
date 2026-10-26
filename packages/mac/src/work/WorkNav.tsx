import { Icon } from '../components/Icon.js';
import { Segmented } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import type { View } from '@beluga/core/store.js';
import { Row } from '../layout/sidebar-parts.js';
import { PlanSideRows } from '../plans/PlansNav.js';
import { projectOfView } from '../tasks/use-tasks.js';
import w from './work.module.css';

/**
 * Work: Tasks, Issues and Plans behind one sidebar row (BLG-197), so the sidebar stays short.
 * The row opens the one you used last; a switch over each list moves between them. Running plans
 * still show under the row.
 */

export type WorkPage = 'tasks' | 'issues' | 'plans';

const KEY = 'beluga.work.last';
const lastPage = (): WorkPage => {
  const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
  return v === 'issues' || v === 'plans' ? v : 'tasks';
};
const remember = (p: WorkPage): void => {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    // Private storage: it just opens Tasks next time.
  }
};

/** Which of Work's pages a view belongs to (a task, an issue or a plan counts as its list). */
export function workPageOf(view: View): WorkPage | undefined {
  if (view.kind === 'tasks' || view.kind === 'task') return 'tasks';
  if (view.kind === 'issues' || view.kind === 'gh_issue') return 'issues';
  if (view.kind === 'plans' || view.kind === 'plan') return 'plans';
  return undefined;
}

function useOpenWork(): (page: WorkPage) => void {
  const actions = useActions();
  const here = useApp(projectOfView);
  return (page) => {
    remember(page);
    const at = page !== 'tasks' && here ? { projectId: here } : {};
    actions.run({ type: 'view', view: { kind: page, ...at } as View });
  };
}

export function WorkNav() {
  const open = useOpenWork();
  const board = useApp((s) => s.board.enabled);
  const plans = useApp((s) => s.plans.enabled);
  const page = useApp((s) => workPageOf(s.view));
  const running = useApp((s) => s.plans.plans.filter((x) => x.status === 'active').length);
  if (!board && !plans) return null;
  const pick = (): WorkPage => {
    const last = lastPage();
    return (last === 'plans' ? plans : board) ? last : board ? 'tasks' : 'plans';
  };
  return (
    <>
      <Row
        icon={<Icon name="task" size={14} />}
        label="Work"
        detail={running ? `Tasks, issues and plans · ${running} plan${running === 1 ? '' : 's'} running` : 'Tasks, issues and plans'}
        selected={page !== undefined}
        onClick={() => open(pick())}
      />
      {plans ? <PlanSideRows /> : null}
    </>
  );
}

/** The switch over Tasks, Issues and Plans: the three lists of Work. */
export function WorkSwitch({ page }: { page: WorkPage }) {
  const open = useOpenWork();
  const board = useApp((s) => s.board.enabled);
  const plans = useApp((s) => s.plans.enabled);
  const options = [
    ...(board ? [{ value: 'tasks' as const, label: 'Tasks', icon: 'task' as const }, { value: 'issues' as const, label: 'Issues', icon: 'issue' as const }] : []),
    ...(plans ? [{ value: 'plans' as const, label: 'Plans', icon: 'flag' as const }] : []),
  ];
  if (options.length < 2) return null;
  return (
    <div className={w.switch}>
      <Segmented<WorkPage> label="Work" value={page} onChange={open} options={options} />
    </div>
  );
}

/** A Work list with its switch above it. */
export function WorkFrame({ page, children }: { page: WorkPage; children: React.ReactNode }) {
  return (
    <div className={w.frame}>
      <WorkSwitch page={page} />
      <div className={w.page}>{children}</div>
    </div>
  );
}
