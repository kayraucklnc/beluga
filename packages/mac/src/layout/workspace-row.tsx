import type { AppState } from '@klaud/core/store.js';
import type { Workspace } from '@klaud/workspaces/types.js';
import { stateOf } from '@klaud/ui/workspace-models.js';
import { Icon, type IconName } from '../components/Icon.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/klaud.js';
import { workspaceSignal } from './attention-model.js';
import { DotMark, SignalMark, nameClass, signalClass } from './signal-marks.js';
import { inSections, toolbarActions } from './toolbar-actions.js';
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
        onSelect: () => (a.action === 'fix_checks' ? undefined : run({ type: 'ws', id: ws.id, action: a.action })),
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
export function WorkspaceRow({ ws, indent }: { ws: Workspace; indent: number }) {
  const actions = useActions();
  const state = useApp((st) => st);
  const selected = state.view.kind === 'workspace' && state.view.id === ws.id;
  const st = stateOf(state, ws, 0);
  const signal = workspaceSignal(state, ws);
  const icon: IconName = ws.kind === 'chat' ? 'chat' : ws.kind === 'main' ? 'folder' : 'branch';
  // Idle: its git state (uncommitted changes, ready to merge) as before.
  const quiet = st.tone === 'warn' || st.tone === 'info' || st.tone === 'error' ? <DotMark tone={st.tone} /> : null;
  // Made outside Klaud: where it is, quietly after its name (the full path in the tooltip).
  const where = outsideLocation(state, ws);
  // Being archived: how far along (it leaves the sidebar when done).
  const archiving = state.archiving[ws.id];
  return (
    <ActionsContext items={workspaceItems(state, ws, actions.run)}>
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
}
