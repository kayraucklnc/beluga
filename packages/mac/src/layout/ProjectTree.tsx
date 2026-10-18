import { Fragment, useEffect, useRef } from 'react';
import type { Project } from '@klaud/workspaces/types.js';
import { worktreeOrigin } from '@klaud/workspaces/origin.js';
import { activityOf } from '@klaud/ui/workspace-models.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext, ActionsDropdown, SpecContext, SpecDropdown, type ActionItem } from '../components/SpecMenu.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { EarningsPill } from '../components/EarningsPill.js';
import { stripeMenuItem } from '../lib/earnings.js';
import { Badge, Dot, IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { inApp } from '../lib/boot.js';
import { newEmptyGroup, useGroupEdit } from '../lib/group-edit.js';
import { useApi, useApp, useKlaud, useUi } from '../lib/klaud.js';
import { openProjectHome } from '../lib/project-home.js';
import { pickImage, reloadProjectIcon } from '../lib/projects.js';
import { showUndo } from '../lib/undo-toast.js';
import { useArrangeDrag } from './arrange-drag.js';
import { GroupHeader, NewGroupRow, groupItems, isGroupOption, moveItems, moveKey } from './ProjectGroups.js';
import { type Entry, type Place, type Target, keyOfEntry, stepOf, useArrange, useLayout } from './project-layout.js';
import { OtherWorktreeFolds } from './OtherWorktrees.js';
import { Row } from './sidebar-parts.js';
import { WorkspaceRow } from './workspace-row.js';
import side from './Sidebar.module.css';
import s from './project-groups.module.css';

/**
 * The sidebar's Projects, arranged the way you like: drag projects and groups to reorder them,
 * drop a project on a group (or between its projects) to put it there, or out to the top level.
 * Projects always show their worktrees and chats; the groups you make fold.
 */

type Arrange = (item: Target, place: Place) => void;

/**
 * Spec options the sidebar does its own way (groups as a submenu; Hide with Undo, not an alert),
 * or not at all here: work happens in worktrees, never in the main checkout.
 */
const ownWay = (id: string): boolean => isGroupOption(id) || id === 'p-hide' || id === 'p-main';

/** A folder hovered while you drag a project into it opens after a moment (spring-loaded, as in Finder). */
const SPRING_MS = 700;

/** Hide a project, with Undo (it comes back where it was). */
function useHide(): (p: Project) => void {
  const api = useApi();
  const { client } = useKlaud();
  return (p) => {
    void api.workspaces.hideProject(p.id).then(() => {
      // The core's note says how to bring it back from the terminal; here Undo does.
      const note = client.store.getState().toast;
      if (note?.text.startsWith('Project hidden')) client.store.dispatch({ type: 'toast_clear', id: note.id });
      showUndo(`Hidden ${p.name}`, () => void api.workspaces.showProject(p.root));
    });
  };
}

/** "Change Icon…" for a project, and going back to the one it ships. */
function useIconItems(p: Project): readonly ActionItem[] {
  const api = useApi();
  const { client } = useKlaud();
  const change = async (image: string | undefined): Promise<void> => {
    try {
      await api.projects.setIcon(p.id, image);
      reloadProjectIcon(p.id);
    } catch (err) {
      client.store.dispatch({ type: 'toast', text: err instanceof Error ? err.message : String(err), level: 'error' });
    }
  };
  return [
    {
      label: 'Change Icon…',
      separate: true,
      onSelect: () => {
        void pickImage(`An icon for ${p.name}`).then((image) => (image ? change(image) : undefined));
      },
      disabled: !inApp(),
    },
    { label: 'Use the Project’s Own Icon', onSelect: () => void change(undefined) },
  ];
}

/** A project and, always under it, its worktrees and chats. `depth` 1: inside a group. */
function ProjectBlock({ p, depth, entries, arrange }: { p: Project; depth: 0 | 1; entries: readonly Entry[]; arrange: Arrange }) {
  const actions = useActions();
  const state = useApp((st) => st);
  const collapsed = useUi((u) => u.collapsed);
  const hide = useHide();
  const iconItems = useIconItems(p);
  const busy = p.workspaces.some((w) => activityOf(state.log, `ws:${w.id}`).running);
  const live = p.workspaces.filter((w) => !w.archived);
  // Not the main checkout (work happens in worktrees); questions asked in its folder stay, as chats.
  const mine = live.filter((w) => w.kind !== 'main' && worktreeOrigin(w) === 'klaud');
  const archived = p.workspaces.filter((w) => w.archived);
  const showArchived = collapsed.includes(`archive:${p.id}`);
  const item: Target = { project: p.id };
  const extra: ActionItem[] = [...moveItems(entries, item, arrange), ...groupItems(p, entries, arrange), stripeMenuItem(p, Boolean(state.earnings[p.root])), ...iconItems, { label: 'Hide Project', danger: true, onSelect: () => hide(p) }];
  const kids = depth + 2;
  return (
    <>
      <SpecContext menu={{ kind: 'project', id: p.id }} extra={extra} hide={ownWay}>
        <Row
          data-drag={`project:${p.id}`}
          indent={depth}
          className={side.projectRow}
          icon={
            <span className={s.projectIcon}>
              <ProjectIcon id={p.id} name={p.name} size={16} />
            </span>
          }
          label={p.name}
          detail={p.root}
          onClick={() => openProjectHome(actions.run, state, p.id)}
          onKeyDown={(e) => {
            const dir = moveKey(e);
            if (!dir || e.target !== e.currentTarget) return;
            e.preventDefault();
            const place = stepOf(entries, item, dir);
            if (place) arrange(item, place);
          }}
          trailing={
            <>
              <EarningsPill root={p.root} projectId={p.id} />
              <span className={side.hoverTools}>
                <IconButton icon="branch" label={`New worktree in ${p.name}`} onClick={(e) => (e.stopPropagation(), actions.run({ type: 'new_worktree', projectId: p.id }))} />
                <IconButton icon="plus" label={`New chat in ${p.name}`} onClick={(e) => (e.stopPropagation(), actions.run({ type: 'new_chat', projectId: p.id }))} />
                <SpecDropdown menu={{ kind: 'project', id: p.id }} align="end" extra={extra} hide={ownWay}>
                  <IconButton icon="more" label={`More for ${p.name}`} onClick={(e) => e.stopPropagation()} />
                </SpecDropdown>
                {busy ? (
                  <span className={side.status}>
                    <Dot tone="claude" live />
                  </span>
                ) : null}
              </span>
            </>
          }
        />
      </SpecContext>
      {mine.map((w) => (
        <WorkspaceRow key={w.id} ws={w} indent={kids} />
      ))}
      {/* Worktrees made outside Klaud, folded by what made them (Conductor, Claude Code, other). */}
      <OtherWorktreeFolds p={p} indent={kids} row={(w) => <WorkspaceRow key={w.id} ws={w} indent={kids + 1} />} />
      {archived.length ? (
        <Row indent={kids} className={side.fold} label="Archived" trailing={<Badge count={archived.length} />} icon={<Icon name={showArchived ? 'chevronDown' : 'chevronRight'} size={10} />} onClick={() => actions.run({ type: 'toggle_archive', projectId: p.id })} />
      ) : null}
      {showArchived
        ? archived.map((w) => (
            <SpecContext key={w.id} menu={{ kind: 'archived', id: w.id }}>
              <Row indent={kids + 1} className={side.fold} icon={<Icon name="archive" size={13} />} label={w.name} onClick={() => actions.run({ type: 'archived_menu', id: w.id })} />
            </SpecContext>
          ))
        : null}
    </>
  );
}

/** Projects you hid, folded at the bottom: each with Show. */
function HiddenProjects() {
  const actions = useActions();
  const api = useApi();
  const hidden = useApp((st) => st.hiddenProjects);
  const open = useUi((u) => u.collapsed.includes('hidden-projects'));
  if (!hidden.length) return null;
  return (
    <div className={s.hidden}>
      <Row
        className={side.fold}
        aria-expanded={open}
        icon={
          <span className={s.groupIcon}>
            <Icon name="chevronRight" size={9} className={cx(s.disclosure, open && s.disclosureOpen)} />
            <Icon name="eyeOff" size={14} className={s.folder} />
          </span>
        }
        label="Hidden Projects"
        trailing={<span className={s.count}>{hidden.length}</span>}
        onClick={() => actions.run({ type: 'toggle_fold', key: 'hidden-projects' })}
      />
      {open
        ? hidden.map((root) => {
            const name = root.split('/').filter(Boolean).pop() ?? root;
            return (
              <Row
                key={root}
                indent={1}
                className={s.hiddenRow}
                icon={
                  <span className={s.projectIcon}>
                    <ProjectIcon id={`path:${root}`} name={name} size={16} />
                  </span>
                }
                label={name}
                detail={root}
                trailing={
                  <button type="button" className={s.show} aria-label={`Show ${name}`} onClick={() => void api.workspaces.showProject(root)}>
                    Show
                  </button>
                }
              />
            );
          })
        : null}
    </div>
  );
}

/** The + on the Projects heading: add projects, or make a group. */
export function ProjectsAddMenu() {
  const actions = useActions();
  const items: ActionItem[] = [
    { label: 'Add Projects…', keys: '⌘O', onSelect: () => actions.run({ type: 'add_project' }) },
    { label: 'New Group', onSelect: () => newEmptyGroup() },
  ];
  return (
    <ActionsDropdown items={items}>
      <IconButton icon="plus" label="Add a project, or make a group" />
    </ActionsDropdown>
  );
}

/** Opens a folded group you hold a project over for a moment. */
function useSpringLoad(group: string | undefined, folded: boolean): void {
  const actions = useActions();
  useEffect(() => {
    if (!group || !folded) return;
    const t = setTimeout(() => actions.run({ type: 'toggle_group', name: group }), SPRING_MS);
    return () => clearTimeout(t);
  }, [group, folded]);
}

export function Projects() {
  const actions = useActions();
  const { entries } = useLayout();
  const arrange = useArrange();
  const tree = useRef<HTMLDivElement>(null);
  const collapsed = useUi((u) => u.collapsed);
  const log = useApp((st) => st.log);
  const { creating } = useGroupEdit();
  const { dragging, onPointerDown } = useArrangeDrag(tree, entries, arrange, s.ghost ?? '');
  const hover = dragging?.hover;
  const lifted = dragging ? ('project' in dragging.item ? `project:${dragging.item.project}` : `group:${dragging.item.group}`) : undefined;
  const intoGroup = hover?.kind === 'into' ? (hover.place.into ?? undefined) : undefined;
  useSpringLoad(intoGroup, intoGroup !== undefined && collapsed.includes(`group:${intoGroup}`));
  // A new group's row shows where the group will be: where its project is (after that project's group), else last.
  const newAt = !creating
    ? -1
    : creating.projectId
      ? (() => {
          const top = entries.findIndex((e) => e.kind === 'project' && e.project.id === creating.projectId);
          if (top >= 0) return top;
          const home = entries.findIndex((e) => e.kind === 'group' && e.projects.some((p) => p.id === creating.projectId));
          return home >= 0 ? home + 1 : entries.length;
        })()
      : entries.length;
  const treeItems: ActionItem[] = [
    { label: 'New Group', onSelect: () => newEmptyGroup() },
    { label: 'Add Projects…', onSelect: () => actions.run({ type: 'add_project' }) },
  ];
  return (
    <>
      <ActionsContext items={treeItems}>
        <div ref={tree} className={cx(s.tree, dragging && s.dragging)} onPointerDown={onPointerDown} data-arrange-tree>
          {entries.map((e, i) => {
            const key = keyOfEntry(e);
            return (
              <Fragment key={key}>
                {newAt === i ? <NewGroupRow /> : null}
                {e.kind === 'project' ? (
                  <div data-slot={key} className={cx(s.block, lifted === key && s.lifted)}>
                    <ProjectBlock p={e.project} depth={0} entries={entries} arrange={arrange} />
                  </div>
                ) : (
                  <div data-slot={key} className={cx(s.block, lifted === key && s.lifted)} role="group" aria-label={e.name}>
                    <GroupHeader
                      name={e.name}
                      count={e.projects.length}
                      open={!collapsed.includes(`group:${e.name}`)}
                      busy={e.projects.some((p) => p.workspaces.some((w) => activityOf(log, `ws:${w.id}`).running))}
                      dropOn={intoGroup === e.name}
                      menu={moveItems(entries, { group: e.name }, arrange)}
                      onToggle={() => actions.run({ type: 'toggle_group', name: e.name })}
                      onMove={(dir) => {
                        const place = stepOf(entries, { group: e.name }, dir);
                        if (place) arrange({ group: e.name }, place);
                      }}
                    />
                    {collapsed.includes(`group:${e.name}`)
                      ? null
                      : e.projects.map((p) => (
                          <div key={p.id} data-slot={`project:${p.id}`} className={cx(s.block, lifted === `project:${p.id}` && s.lifted)}>
                            <ProjectBlock p={p} depth={1} entries={entries} arrange={arrange} />
                          </div>
                        ))}
                  </div>
                )}
              </Fragment>
            );
          })}
          {newAt === entries.length ? <NewGroupRow /> : null}
          {hover?.kind === 'line' ? <div className={s.insertion} style={{ top: hover.y, left: hover.depth ? 32 : 18 }} aria-hidden="true" /> : null}
          {entries.length || creating ? null : <Row className={side.hintRow} icon={<Icon name="plus" size={13} />} label="Add a project…" onClick={() => actions.run({ type: 'add_project' })} />}
        </div>
      </ActionsContext>
      <HiddenProjects />
    </>
  );
}
