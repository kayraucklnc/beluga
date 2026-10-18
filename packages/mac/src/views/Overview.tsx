import { activityOf, stateOf } from '@klaud/ui/workspace-models.js';
import { worktreeOrigin } from '@klaud/workspaces/origin.js';
import type { Workspace } from '@klaud/workspaces/types.js';
import { describePr, formatBytes } from '@klaud/shared/format.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext } from '../components/SpecMenu.js';
import { Button, Dot, Empty, EmptyActions, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/klaud.js';
import { workspaceItems } from '../layout/Sidebar.js';
import s from './overview.module.css';

const ago = (ts: number, now: number): string => {
  const m = Math.round((now - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

/** Every worktree and chat at a glance, grouped by project; what needs you comes first. */
export function OverviewView() {
  const actions = useActions();
  const state = useApp((st) => st);
  const now = Date.now();
  const groups = state.projects
    .map((p) => ({ p, list: p.workspaces.filter((w) => !w.archived && worktreeOrigin(w) !== 'agent') }))
    .filter((g) => g.list.length);
  if (!groups.length) {
    const project = state.projects.find((p) => p.root);
    return (
      <Empty
        icon="grid"
        title="No workspaces yet"
        detail={project ? `Start a worktree in ${project.name}: its own branch, with Claude on your task.` : 'Add your projects, then give Claude a task in a worktree of its own.'}
        action={
          <EmptyActions>
            {project ? (
              <Button variant="primary" icon="branch" onClick={() => actions.run({ type: 'new_worktree', projectId: project.id })}>
                New Worktree
              </Button>
            ) : (
              <Button variant="primary" icon="plus" onClick={() => actions.run({ type: 'add_project' })}>
                Add Projects…
              </Button>
            )}
            <Button icon="chat" onClick={() => actions.run({ type: 'new_chat', projectId: 'chats' })}>
              New Chat
            </Button>
          </EmptyActions>
        }
      />
    );
  }
  const rank = (w: Workspace): number => {
    const st = stateOf(state, w, 0);
    return st.tone === 'error' ? 0 : st.tone === 'warn' && activityOf(state.log, `ws:${w.id}`).awaiting ? 1 : st.tone === 'claude' ? 2 : state.unread[`ws:${w.id}`] ? 3 : 4;
  };
  return (
    <div className={s.pane}>
      {groups.map(({ p, list }) => (
        <section key={p.id} className={s.group}>
          <h2 className={s.groupTitle}>
            {p.root ? p.name : 'Chats'}
            <span className={s.count}>{list.length}</span>
            <span className={s.groupActions}>
              <Button size="small" variant="quiet" icon={p.root ? 'branch' : 'plus'} onClick={() => actions.run(p.root ? { type: 'new_worktree', projectId: p.id } : { type: 'new_chat', projectId: 'chats' })}>
                {p.root ? 'New Worktree' : 'New Chat'}
              </Button>
            </span>
          </h2>
          <div className={s.table} role="list">
            {[...list].sort((a, b) => rank(a) - rank(b)).map((w) => {
              const st = stateOf(state, w, 0);
              const act = activityOf(state.log, `ws:${w.id}`);
              const unread = state.unread[`ws:${w.id}`] ?? 0;
              const pr = state.prs[w.id];
              const disk = state.disk[w.id];
              const ctx = state.context[`ws:${w.id}`];
              return (
                <ActionsContext key={w.id} items={workspaceItems(state, w, actions.run)}>
                  <div role="listitem" tabIndex={0} className={s.row} onClick={() => actions.run({ type: 'open_ws', id: w.id })} onKeyDown={(e) => e.key === 'Enter' && actions.run({ type: 'open_ws', id: w.id })}>
                    <span className={s.kind}>
                      <Icon name={w.kind === 'chat' ? 'chat' : w.kind === 'main' ? 'folder' : 'branch'} size={14} />
                    </span>
                    <span className={s.name}>
                      {w.name}
                      {unread ? <span className={s.unread}>{unread} new</span> : null}
                    </span>
                    <span className={s.branch}>{w.branch ?? (w.kind === 'chat' ? 'chat' : '')}</span>
                    <span className={cx(s.state, s[`tone_${st.tone}`])}>
                      <Dot tone={st.tone === 'claude' ? 'claude' : st.tone === 'muted' ? 'muted' : st.tone} live={act.running} />
                      {st.label}
                    </span>
                    <span className={s.extra}>
                      {pr ? describePr(pr) : ''}
                      {ctx ? `${pr ? ' · ' : ''}${Math.round((ctx.used / ctx.window) * 100)}% context` : ''}
                    </span>
                    <span className={s.when}>{act.lastTs ? ago(act.lastTs, now) : disk !== undefined ? formatBytes(disk) : ''}</span>
                  </div>
                </ActionsContext>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
