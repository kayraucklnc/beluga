import type { AppState } from '@klaud/core/store.js';
import type { Workspace } from '@klaud/workspaces/types.js';
import { formatBytes } from '@klaud/shared/format.js';
import { Icon } from '../../components/Icon.js';
import { useActions } from '../../lib/actions.js';
import { useApp } from '../../lib/klaud.js';
import { Row } from '../../layout/sidebar-parts.js';
import s from '../../layout/Sidebar.module.css';

const liveWorktrees = (st: AppState): Workspace[] => st.projects.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && !w.archived);

/** The sidebar's Worktrees row: every worktree in your projects, and the space they take. */
export function WorktreesNav() {
  const actions = useActions();
  const selected = useApp((st) => st.view.kind === 'worktrees');
  const count = useApp((st) => liveWorktrees(st).length);
  const bytes = useApp((st) => liveWorktrees(st).reduce((n, w) => n + (st.disk[w.id] ?? 0), 0));
  if (!count) return null;
  return (
    <Row
      icon={<Icon name="branch" size={14} />}
      label="Worktrees"
      detail={`${count} worktree${count === 1 ? '' : 's'}${bytes ? `, ${formatBytes(bytes)} on disk` : ''}: who made them, which are done, and the space they take`}
      selected={selected}
      onClick={() => actions.run({ type: 'view', view: { kind: 'worktrees' } })}
      trailing={bytes ? <span className={s.archiving}>{formatBytes(bytes)}</span> : null}
    />
  );
}
