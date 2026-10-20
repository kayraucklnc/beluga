import type { KeyboardEvent, MouseEvent } from 'react';
import type { ArchivePreview } from '@klaud/workspaces/archive.js';
import { formatBytes } from '@klaud/shared/format.js';
import { Icon } from '../../components/Icon.js';
import { type ActionItem, ActionsContext, ActionsDropdown } from '../../components/SpecMenu.js';
import { IconButton, cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { useApp } from '../../lib/klaud.js';
import { outsideLocation } from '../../layout/outside-model.js';
import type { WorktreeRow } from './worktrees-model.js';
import s from './worktrees.module.css';

const ARCHIVING = { saving: 'Saving…', compressing: 'Compressing…', removing: 'Removing…' } as const;
const stop = (e: MouseEvent): void => e.stopPropagation();

export interface ItemActions {
  readonly archive: (rows: readonly WorktreeRow[]) => void;
  readonly free: (rows: readonly WorktreeRow[]) => void;
}

/** One worktree: tick it, open it (click), or right-click for what can be done with it. */
export function WorktreeItem({ row, plan, ticked, onTick, act }: { row: WorktreeRow; plan: ArchivePreview | undefined; ticked: boolean; onTick: (on: boolean) => void; act: ItemActions }) {
  const actions = useActions();
  const home = useApp((st) => st.home);
  const w = row.ws;
  const where = outsideLocation({ home }, w);
  const open = (): void => actions.run({ type: 'open_ws', id: w.id });
  const parent = row.madeBy.kind === 'agent' ? row.madeBy.parentId : undefined;
  const items: ActionItem[] = [
    { label: 'Open', icon: 'forward', onSelect: open },
    ...(parent ? [{ label: 'Open the Conversation That Started It', icon: 'chat' as const, onSelect: () => actions.run({ type: 'open_ws', id: parent }) }] : []),
    { label: 'Show in Finder', icon: 'folder', onSelect: () => actions.run({ type: 'ws', id: w.id, action: 'finder' }) },
    { label: 'Free Up Space…', icon: 'archive', separate: true, disabled: !plan?.dropBytes, ...(plan && !plan.dropBytes ? { hint: 'Nothing to clear' } : {}), onSelect: () => act.free([row]) },
    { label: 'Archive…', icon: 'archive', onSelect: () => act.archive([row]) },
  ];
  const onKey = (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') open();
    if (e.key === ' ') {
      e.preventDefault();
      onTick(!ticked);
    }
  };
  const task = row.madeBy.kind === 'agent' ? row.madeBy.task : undefined;
  return (
    <ActionsContext items={items}>
      <div role="row" tabIndex={0} aria-label={w.name} aria-selected={ticked} className={cx(s.row, ticked && s.ticked, row.archiving && s.busy)} onClick={open} onKeyDown={onKey} data-worktree={w.id}>
        <span role="cell" className={s.tick} onClick={stop}>
          <input type="checkbox" aria-label={`Select ${w.name}`} checked={ticked} disabled={Boolean(row.archiving)} onChange={(e) => onTick(e.target.checked)} />
        </span>
        <span role="cell" className={s.nameCell}>
          <Icon name={row.madeBy.kind === 'agent' ? 'bot' : 'branch'} size={14} className={s.icon} />
          <span className={s.nameText}>
            <span className={s.name}>{task ?? w.name}</span>
            <span className={s.sub} title={where?.path ?? w.path}>
              {row.project.name}
              {w.branch ? ` · ${w.branch}` : ''}
              {where ? ` · ${where.folder}` : ''}
            </span>
          </span>
        </span>
        <span role="cell" className={cx(s.madeBy, row.madeBy.kind === 'agent' && row.madeBy.orphan && s.orphan)} title={row.madeBy.label}>
          {row.madeBy.label}
        </span>
        <span role="cell" className={cx(s.work, row.work.done && s.done)}>
          {row.work.label}
        </span>
        <span role="cell" className={s.size}>
          {row.size !== undefined ? formatBytes(row.size) : '–'}
        </span>
        <span role="cell" className={s.size} title={plan?.drop.map((d) => `${d.path} (${d.what}): ${formatBytes(d.bytes)}`).join('\n') || undefined}>
          {row.archiving ? <span className={s.phase}>{ARCHIVING[row.archiving]}</span> : plan ? (plan.dropBytes ? formatBytes(plan.dropBytes) : 'None') : <span className={s.pending}>…</span>}
        </span>
        <span role="cell" className={s.more} onClick={stop}>
          <ActionsDropdown items={items}>
            <IconButton icon="more" label={`More for ${w.name}`} />
          </ActionsDropdown>
        </span>
      </div>
    </ActionsContext>
  );
}
