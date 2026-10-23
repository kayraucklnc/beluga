import type { AppState } from '@beluga/core/store.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { formatBytes } from '@beluga/shared/format.js';
import { Icon } from '../../components/Icon.js';
import { useActions } from '../../lib/actions.js';
import { useApp } from '../../lib/beluga.js';
import { Row } from '../../layout/sidebar-parts.js';
import s from '../../layout/Sidebar.module.css';

const worktrees = (st: AppState): Workspace[] => st.projects.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree');

/**
 * The Worktrees row, quietly at the end of Projects (it's housekeeping for them, not a place you
 * work in): every worktree in your projects, archived ones too, and the space they take.
 */
export function WorktreesNav() {
  const actions = useActions();
  const selected = useApp((st) => st.view.kind === 'worktrees');
  const count = useApp((st) => worktrees(st).filter((w) => !w.archived).length);
  const archived = useApp((st) => worktrees(st).filter((w) => w.archived).length);
  const bytes = useApp((st) => worktrees(st).reduce((n, w) => n + (w.archived ? 0 : (st.disk[w.id] ?? 0)), 0));
  if (!count && !archived) return null;
  return (
    <Row
      className={s.fold}
      icon={<Icon name="branch" size={13} />}
      label="Worktrees"
      detail={`${count} worktree${count === 1 ? '' : 's'}${bytes ? `, ${formatBytes(bytes)} on disk` : ''}${archived ? `, ${archived} archived` : ''}: who made them, what's left in them, and what to archive, restore or delete`}
      selected={selected}
      onClick={() => actions.run({ type: 'view', view: { kind: 'worktrees' } })}
      trailing={bytes ? <span className={s.archiving}>{formatBytes(bytes)}</span> : null}
    />
  );
}
