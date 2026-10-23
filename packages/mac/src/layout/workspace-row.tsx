import type { AppState } from '@beluga/core/store.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { stateOf } from '@beluga/ui/workspace-models.js';
import { Icon, type IconName } from '../components/Icon.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { memo } from 'react';
import { useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { workspaceSignal } from './attention-model.js';
import { DotMark, SignalMark, nameClass, signalClass } from './signal-marks.js';
import { inSections, toolbarActions } from './toolbar-actions.js';
import { isPlanAction, runPlanAction } from '../lib/plan-task.js';
import { Row } from './sidebar-parts.js';
import { outsideLocation } from './outside-model.js';
import s from './Sidebar.module.css';
import o from './other-worktrees.module.css';

/**
 * What a workspace's right-click menu offers: its toolbar's actions, named and drawn the same
 * (the shortcuts show for the workspace you're in, where they work).
 */
export function workspaceItems(state: AppState, ws: Workspace, run: ReturnType<typeof useActions>['run']): ActionItem[] {
  const { primary, icons, more } = toolbarActions(state, ws);
  const here = state.view.kind === 'workspace' && state.view.id === ws.id;
  const sections = inSections([...(primary && primary.action !== 'fix_checks' ? [primary] : []), ...icons, ...more.flat()]);
  return [
    { label: 'Open', icon: 'chevronRight', onSelect: () => run({ type: 'open_ws', id: ws.id }) },
    ...sections.flatMap((section) =>
      section.map((a, i) => ({
        label: a.label,
        icon: a.icon,
        ...(a.disabled ? { hint: a.hint, disabled: true } : {}),
        ...(here && a.keys ? { keys: a.keys } : {}),
        ...(a.danger ? { danger: true } : {}),
        ...(i === 0 ? { separate: true } : {}),
        onSelect: () => (a.action === 'fix_checks' ? undefined : isPlanAction(a.action) ? runPlanAction(state, ws.id, a.action, run) : run({ type: 'ws', id: ws.id, action: a.action })),
      })),
    ),
  ];
}

/** What archiving is doing now, in words. */
const ARCHIVING: Record<NonNullable<AppState['archiving'][string]>, string> = {
  saving: 'Archiving: saving everything of yours',
  compressing: 'Archiving: compressing your ignored files',
  removing: 'Archiving: removing the folder',
};

/**
 * A chat or worktree in the sidebar. What it waits on sits at the row's right edge: a hand
 * when it needs you (the row faintly tinted), a count and a bold name when Claude finished or
 * someone wrote while you were elsewhere, Claude's pulse while it works; otherwise its git state.
 */
export const WorkspaceRow = memo(function WorkspaceRow({ ws, indent }: { ws: Workspace; indent: number }) {
  const actions = useActions();
  const { client } = useBeluga();
  // Only what the row shows: another conversation streaming doesn't draw it again (KLD-48).
  const { selected, st, signal, where, archiving } = useApp(
    (state) => ({
      selected: state.view.kind === 'workspace' && state.view.id === ws.id,
      st: stateOf(state, ws, 0),
      signal: workspaceSignal(state, ws),
      // Made outside Beluga: where it is, quietly after its name (the full path in the tooltip).
      where: outsideLocation(state, ws),
      // Being archived: how far along (it leaves the sidebar when done).
      archiving: state.archiving[ws.id],
    }),
    sameDeep,
  );
  const icon: IconName = ws.kind === 'chat' ? 'chat' : ws.kind === 'main' ? 'folder' : 'branch';
  // Idle: its git state (uncommitted changes, ready to merge) as before.
  const quiet = st.tone === 'warn' || st.tone === 'info' || st.tone === 'error' ? <DotMark tone={st.tone} /> : null;
  return (
    <ActionsContext items={() => workspaceItems(client.store.getState(), ws, actions.run)}>
      <Row
        indent={indent}
        selected={selected}
        className={signalClass(signal, selected)}
        data-signal-row={signal.level}
        // Named for itself alone (so it's found by name whatever it waits on); the tooltip says the rest.
        aria-label={ws.name}
        icon={<Icon name={icon} size={14} />}
        label={
          <>
            <span className={cx(ws.external && s.external, nameClass(signal))}>{ws.name}</span>
            {where ? <span className={o.where}>{where.folder}</span> : null}
          </>
        }
        detail={archiving ? `${ws.name}: ${ARCHIVING[archiving]}` : `${ws.name}: ${signal.tip || st.label}${where ? `\n${where.path}` : ''}`}
        onClick={() => actions.run({ type: 'open_ws', id: ws.id })}
        trailing={archiving ? <span className={s.archiving} data-archiving={archiving}>Archiving…</span> : <SignalMark signal={signal} fallback={quiet} />}
      />
    </ActionsContext>
  );
});
