import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Project } from '@klaud/workspaces/types.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { Badge, cx } from '../components/ui.js';
import { PROJECT_DRAG, editGroups, newGroupFor, useGroupEdit } from '../lib/group-edit.js';
import { useApi, useApp } from '../lib/klaud.js';
import side from './Sidebar.module.css';
import s from './project-groups.module.css';

/** The project menu's group options, done the Mac way: these spec options become "Move to Group ▸". */
export const isGroupOption = (id: string): boolean => id.startsWith('p-group:') || id === 'p-newgroup' || id === 'p-ungroup';

/** "Move to Group ▸": the groups (a check on this project's), New Group…, Remove from Group. */
export function useGroupItems(p: Project): readonly ActionItem[] {
  const api = useApi();
  const groups = useApp((st) => st.projectGroups);
  const current = groups.find((g) => g.projects.includes(p.root))?.name;
  if (!p.root) return [];
  return [
    {
      label: 'Move to Group',
      submenu: [
        ...groups.map((g) => ({ label: g.name, checked: g.name === current, onSelect: () => void (g.name === current ? undefined : api.workspaces.setGroup(p.id, g.name)) })),
        { label: 'New Group…', separate: groups.length > 0, onSelect: () => newGroupFor(p.id) },
        ...(current ? [{ label: `Remove from “${current}”`, onSelect: () => void api.workspaces.setGroup(p.id, undefined) }] : []),
      ],
      onSelect: () => undefined,
    },
  ];
}

/** Drag a project row onto a group (or out of one). */
export function projectDrag(p: Project) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(PROJECT_DRAG, p.id);
      e.dataTransfer.effectAllowed = 'move';
      editGroups({ dragging: p.id });
    },
    onDragEnd: () => editGroups({ dragging: undefined }),
  };
}

/** Where a dragged project can land: it lights up while one is over it. */
function useDrop(onDrop: (projectId: string) => void, accepts: (projectId: string) => boolean = () => true) {
  const { dragging } = useGroupEdit();
  const [over, setOver] = useState(false);
  const ok = dragging !== undefined && accepts(dragging);
  return {
    over: over && ok,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!ok || !e.dataTransfer.types.includes(PROJECT_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false);
        const id = e.dataTransfer.getData(PROJECT_DRAG);
        if (!id || !ok) return;
        e.preventDefault();
        editGroups({ dragging: undefined });
        onDrop(id);
      },
    },
  };
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

/** The row of a group being made: a folder and its name field (like Finder's New Folder). */
export function NewGroupRow() {
  const api = useApi();
  const { creating } = useGroupEdit();
  const project = useApp((st) => st.projects.find((p) => p.id === creating?.projectId));
  if (!creating || !project) return null;
  return (
    <div className={cx(side.row, side.groupRow, s.editing)} style={{ paddingLeft: 8 }}>
      <span className={side.rowIcon}>
        <Icon name="folder" size={13} />
      </span>
      <NameField
        key={creating.projectId}
        initial="New Group"
        label={`Name of the new group for ${project.name}`}
        onDone={(name) => {
          editGroups({ creating: undefined });
          if (name) void api.workspaces.setGroup(project.id, name);
        }}
      />
    </div>
  );
}

/** A group in the sidebar: click to fold, right-click to rename or ungroup, drop a project on it. */
export function GroupHeader({ name, count, open, onToggle, children }: { name: string; count: number; open: boolean; onToggle: () => void; children?: ReactNode }) {
  const api = useApi();
  const roots = useApp((st) => st.projectGroups.find((g) => g.name === name)?.projects);
  const projects = useApp((st) => st.projects);
  const { renaming } = useGroupEdit();
  const drop = useDrop(
    (projectId) => void api.workspaces.setGroup(projectId, name),
    (projectId) => !roots?.includes(projects.find((p) => p.id === projectId)?.root ?? ''),
  );
  const items: ActionItem[] = [
    { label: 'Rename…', icon: 'pencil', onSelect: () => editGroups({ renaming: name, creating: undefined }) },
    { label: 'Ungroup', hint: 'Its projects stay, back in the list', icon: 'x', onSelect: () => void api.workspaces.ungroup(name) },
  ];
  if (renaming === name) {
    return (
      <div className={cx(side.row, side.groupRow, s.editing)} style={{ paddingLeft: 8 }}>
        <span className={side.rowIcon}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
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
        className={cx(side.row, side.groupRow, drop.over && s.dropOn)}
        style={{ paddingLeft: 8 }}
        onClick={onToggle}
        onDoubleClick={() => editGroups({ renaming: name })}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            editGroups({ renaming: name });
          } else if (e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        {...drop.props}
      >
        <span className={side.rowIcon}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
        </span>
        <span className={side.rowLabel}>{name}</span>
        <span className={side.trailing}>{children ?? <Badge count={count} />}</span>
      </div>
    </ActionsContext>
  );
}

/** The projects not in a group: drop a grouped project here to take it out of its group. */
export function LooseProjects({ children }: { children: ReactNode }) {
  const api = useApi();
  const groups = useApp((st) => st.projectGroups);
  const projects = useApp((st) => st.projects);
  const { dragging } = useGroupEdit();
  const grouped = (id: string): boolean => {
    const root = projects.find((p) => p.id === id)?.root;
    return Boolean(root && groups.some((g) => g.projects.includes(root)));
  };
  const drop = useDrop((projectId) => void api.workspaces.setGroup(projectId, undefined), grouped);
  const offering = dragging !== undefined && grouped(dragging);
  return (
    <div className={cx(s.loose, offering && s.looseOffer, drop.over && s.dropOn)} {...drop.props}>
      {children}
      {offering ? <div className={s.dropHint}>Drop here to take it out of its group</div> : null}
    </div>
  );
}
