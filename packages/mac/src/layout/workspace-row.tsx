import type { AppState } from '@klaud/core/store.js';
import type { Workspace } from '@klaud/workspaces/types.js';
import { activityOf, stateOf, workspaceButtons } from '@klaud/ui/workspace-models.js';
import { Icon, type IconName } from '../components/Icon.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { Badge, Dot } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/klaud.js';
import { toolbarActions } from './toolbar-actions.js';
import { Row } from './sidebar-parts.js';
import s from './Sidebar.module.css';

/**
 * What a workspace's right-click menu offers: its toolbar's actions, named and drawn the same
 * (the shortcuts show for the workspace you're in, where they work).
 */
export function workspaceItems(state: AppState, ws: Workspace, run: ReturnType<typeof useActions>['run']): ActionItem[] {
  const { primary, icons, more } = toolbarActions(state, ws);
  const here = state.view.kind === 'workspace' && state.view.id === ws.id;
  const list = [...(primary && primary.action !== 'fix_checks' ? [primary] : []), ...icons, ...more];
  const order = workspaceButtons(state, ws).map((b) => b.action as string);
  return [
    { label: 'Open', icon: 'chevronRight', onSelect: () => run({ type: 'open_ws', id: ws.id }) },
    ...[...list]
      .sort((a, b) => order.indexOf(a.action === 'stop_run' ? 'run' : a.action) - order.indexOf(b.action === 'stop_run' ? 'run' : b.action))
      .map((a, i) => ({
        label: a.label,
        icon: a.icon,
        ...(a.disabled ? { hint: a.hint, disabled: true } : {}),
        ...(here && a.keys ? { keys: a.keys } : {}),
        ...(a.danger ? { danger: true } : {}),
        ...(i === 0 ? { separate: true } : {}),
        onSelect: () => (a.action === 'fix_checks' ? undefined : run({ type: 'ws', id: ws.id, action: a.action })),
      })),
  ];
}

/** A chat or worktree in the sidebar: its unread count and status dot sit at the row's right edge. */
export function WorkspaceRow({ ws, indent }: { ws: Workspace; indent: number }) {
  const actions = useActions();
  const state = useApp((st) => st);
  const selected = state.view.kind === 'workspace' && state.view.id === ws.id;
  const st = stateOf(state, ws, 0);
  const act = activityOf(state.log, `ws:${ws.id}`);
  const unread = state.unread[`ws:${ws.id}`] ?? 0;
  const icon: IconName = ws.kind === 'chat' ? 'chat' : ws.kind === 'main' ? 'folder' : 'branch';
  return (
    <ActionsContext items={workspaceItems(state, ws, actions.run)}>
      <Row
        indent={indent}
        selected={selected}
        icon={<Icon name={icon} size={14} />}
        label={<span className={ws.external ? s.external : undefined}>{ws.name}</span>}
        detail={`${ws.name}: ${st.label}`}
        onClick={() => actions.run({ type: 'open_ws', id: ws.id })}
        trailing={
          <>
            {unread ? <Badge count={unread} urgent /> : null}
            {act.running || act.awaiting || st.tone === 'error' || st.tone === 'warn' || st.tone === 'info' ? <Dot tone={st.tone === 'claude' ? 'claude' : st.tone === 'muted' ? 'muted' : st.tone} live={act.running} /> : null}
          </>
        }
      />
    </ActionsContext>
  );
}
