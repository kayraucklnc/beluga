import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { Project } from '@klaud/workspaces/types.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { Dot, cx } from '../components/ui.js';
import { editGroups, newGroupFor, useGroupEdit } from '../lib/group-edit.js';
import { useApi, useApp } from '../lib/klaud.js';
import { type Entry, type Place, type Target, outOfGroup, stepOf } from './project-layout.js';
import side from './Sidebar.module.css';
import s from './project-groups.module.css';

/** The project menu's group options, done the Mac way: these spec options become "Move to Group ▸". */
export const isGroupOption = (id: string): boolean => id.startsWith('p-group:') || id === 'p-newgroup' || id === 'p-ungroup';

/** Moving rows with the keyboard (⌥⌘↑/↓ are Previous/Next Workspace in the menu bar). */
export const MOVE_UP_KEYS = '⌃⌘↑';
export const MOVE_DOWN_KEYS = '⌃⌘↓';
export const moveKey = (e: KeyboardEvent): -1 | 1 | undefined => (e.ctrlKey && e.metaKey && !e.altKey && !e.shiftKey ? (e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : undefined) : undefined);

/** "Move Up" and "Move Down" for a row's menu (greyed at the ends). */
export function moveItems(entries: readonly Entry[], item: Target, arrange: (item: Target, place: Place) => void): ActionItem[] {
  const up = stepOf(entries, item, -1);
  const down = stepOf(entries, item, 1);
  return [
    { label: 'Move Up', keys: MOVE_UP_KEYS, disabled: !up, onSelect: () => up && arrange(item, up) },
    { label: 'Move Down', keys: MOVE_DOWN_KEYS, disabled: !down, onSelect: () => down && arrange(item, down) },
  ];
}

/** "Move to Group ▸": the groups (a check on this project's), New Group…, Remove from Group. */
export function groupItems(p: Project, entries: readonly Entry[], arrange: (item: Target, place: Place) => void): readonly ActionItem[] {
  const groups = entries.flatMap((e) => (e.kind === 'group' ? [e] : []));
  const current = groups.find((g) => g.projects.some((x) => x.id === p.id))?.name;
  if (!p.root) return [];
  return [
    {
      label: 'Move to Group',
      separate: true,
      submenu: [
        ...groups.map((g) => ({ label: g.name, checked: g.name === current, onSelect: () => (g.name === current ? undefined : arrange({ project: p.id }, { into: g.name, before: null })) })),
        { label: 'New Group…', separate: groups.length > 0, onSelect: () => newGroupFor(p.id) },
        ...(current ? [{ label: `Remove from “${current}”`, onSelect: () => arrange({ project: p.id }, outOfGroup(entries, current)) }] : []),
      ],
      onSelect: () => undefined,
    },
  ];
}

/** A group's name, typed in place: Return keeps it, Esc (or an empty name) gives up. */
function NameField({ initial, onDone, label }: { initial: string; onDone: (name: string | undefined) => void; label: string }) {
  const [name, setName] = useState(initial);
  const box = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (value: string | undefined): void => {
    if (done.current) return;
    done.current = true;
    onDone(value?.trim() ? value.trim() : undefined);
  };
  useEffect(() => {
    // After the menu that asked for it has closed and given the focus back.
    const t = setTimeout(() => {
      box.current?.focus();
      box.current?.select();
      box.current?.scrollIntoView({ block: 'nearest' });
    }, 30);
    return () => clearTimeout(t);
  }, []);
  return (
    <input
      ref={box}
      className={s.field}
      value={name}
      aria-label={label}
      maxLength={30}
      spellCheck={false}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(name);
        else if (e.key === 'Escape') finish(undefined);
      }}
      onBlur={() => finish(name)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** A group's disclosure triangle and folder (like a folder in Finder's sidebar). */
function GroupIcon({ open }: { open: boolean }) {
  return (
    <span className={s.groupIcon}>
      <Icon name="chevronRight" size={9} className={cx(s.disclosure, open && s.disclosureOpen)} />
      <Icon name="folder" size={15} className={s.folder} />
    </span>
  );
}

/** The row of a group being made: a folder and its name field (like Finder's New Folder). */
export function NewGroupRow() {
  const api = useApi();
  const { creating } = useGroupEdit();
  const project = useApp((st) => st.projects.find((p) => p.id === creating?.projectId));
  if (!creating) return null;
  return (
    <div className={cx(side.row, side.groupRow, s.editing)} style={{ paddingLeft: 8 }}>
      <span className={side.rowIcon} style={{ width: 'auto' }}>
        <GroupIcon open />
      </span>
      <NameField
        key={creating.projectId ?? ''}
        initial="New Group"
        label={project ? `Name of the new group for ${project.name}` : 'Name of the new group'}
        onDone={(name) => {
          editGroups({ creating: undefined });
          if (name) void api.workspaces.newGroup(name, project ? { project: project.id } : {});
        }}
      />
    </div>
  );
}

export interface GroupHeaderProps {
  readonly name: string;
  readonly count: number;
  readonly open: boolean;
  readonly busy: boolean;
  /** A project being dragged would go inside: the folder lights up. */
  readonly dropOn: boolean;
  readonly menu: readonly ActionItem[];
  readonly onToggle: () => void;
  readonly onMove: (dir: -1 | 1) => void;
}

/** A group in the sidebar: click to fold, drag to move, right-click to rename or ungroup. */
export function GroupHeader({ name, count, open, busy, dropOn, menu, onToggle, onMove }: GroupHeaderProps) {
  const api = useApi();
  const { renaming } = useGroupEdit();
  const items: ActionItem[] = [
    { label: 'Rename…', icon: 'pencil', onSelect: () => editGroups({ renaming: name, creating: undefined }) },
    ...menu,
    count
      ? { label: 'Ungroup', hint: 'Its projects stay, where the group was', icon: 'x', danger: true, separate: true, onSelect: () => void api.workspaces.ungroup(name) }
      : { label: 'Delete Group', icon: 'x', danger: true, separate: true, onSelect: () => void api.workspaces.ungroup(name) },
  ];
  if (renaming === name) {
    return (
      <div className={cx(side.row, side.groupRow, s.editing)} style={{ paddingLeft: 8 }} data-head>
        <span className={side.rowIcon} style={{ width: 'auto' }}>
          <GroupIcon open={open} />
        </span>
        <NameField
          initial={name}
          label={`New name for the group ${name}`}
          onDone={(to) => {
            editGroups({ renaming: undefined });
            if (to && to !== name) void api.workspaces.renameGroup(name, to);
          }}
        />
      </div>
    );
  }
  return (
    <ActionsContext items={items}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`Group ${name}`}
        className={cx(side.row, side.groupRow, s.groupHead, dropOn && s.dropOn)}
        style={{ paddingLeft: 8 }}
        data-head
        data-drag={`group:${name}`}
        onClick={onToggle}
        onDoubleClick={() => editGroups({ renaming: name })}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const dir = moveKey(e);
          if (dir) {
            e.preventDefault();
            onMove(dir);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            editGroups({ renaming: name });
          } else if (e.key === ' ' || (e.key === 'ArrowLeft' && open) || (e.key === 'ArrowRight' && !open)) {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className={side.rowIcon} style={{ width: 'auto' }}>
          <GroupIcon open={open} />
        </span>
        <span className={side.rowLabel}>{name}</span>
        <span className={side.trailing}>
          {open ? null : <span className={s.count}>{count}</span>}
          {busy && !open ? <Dot tone="claude" live /> : null}
          {open && !count ? <span className={s.empty}>Empty</span> : null}
        </span>
      </div>
    </ActionsContext>
  );
}

