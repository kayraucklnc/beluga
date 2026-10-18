import { worktreeOrigin } from '@klaud/workspaces/origin.js';
import { Alert } from '../../components/Alert.js';
import { useApp } from '../../lib/klaud.js';
import type { NativeMenuProps } from './index.js';
import { count, usePick } from './pick.js';
import s from './menus.module.css';

/** Tidy up the worktrees Claude Code sub-agents left in a project: which ones, and what's kept. */
export function AgentsAlert({ menu, close }: NativeMenuProps<'agents'>) {
  const pick = usePick(menu);
  const project = useApp((st) => st.projects.find((p) => p.id === menu.projectId));
  if (!project) return null;
  const agents = project.workspaces.filter((w) => !w.archived && worktreeOrigin(w) === 'agent');
  const clean = agents.filter((w) => w.status?.changed === 0).length;
  const table = {
    columns: ['Worktree', 'Branch', 'Changes'],
    rows: agents.map((w) => [
      w.name,
      <code key="b">{w.branch ?? '–'}</code>,
      w.status?.changed ? <span className={s.warn}>{count(w.status.changed, 'file')}</span> : <span className={s.muted}>none</span>,
    ]),
  };
  if (!clean) {
    return (
      <Alert
        icon="branch"
        tone="info"
        title={`Claude Code left ${count(agents.length, 'worktree')} in ${project.name}`}
        message="Each one has uncommitted changes, so klaud leaves them alone. Open one to look at what’s in it."
        table={table}
        cancel={false}
        confirm={{ label: 'OK', onClick: close }}
        onCancel={close}
      />
    );
  }
  return (
    <Alert
      icon="branch"
      tone="caution"
      title={`Remove ${count(clean, 'finished worktree')}?`}
      message={`Claude Code sub-agents made these under .claude/worktrees in ${project.name}. Removing the ${clean === 1 ? 'one' : 'ones'} without uncommitted changes keeps ${clean === 1 ? 'its branch' : 'their branches'}, so no commits are lost.`}
      table={table}
      confirm={{ label: `Remove ${count(clean, 'Worktree')}`, onClick: () => pick('agents-clean') }}
      onCancel={close}
    />
  );
}
