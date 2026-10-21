import { Fragment, useEffect, useMemo, useRef } from 'react';
import type { Project } from '@klaud/workspaces/types.js';
import { worktreeOrigin } from '@klaud/workspaces/origin.js';
import type { UiAction } from '@klaud/ui/workspace-models.js';
import { setOverviewView } from '../views/overview/use-overview-prefs.js';
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
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { pickImage, reloadProjectIcon } from '../lib/projects.js';
import { showUndo } from '../lib/undo-toast.js';
import { useArrangeDrag } from './arrange-drag.js';
import { GroupHeader, NewGroupRow, groupItems, isGroupOption, moveItems, moveKey } from './ProjectGroups.js';
import { type Entry, type Place, type Target, keyOfEntry, stepOf, useArrange, useLayout } from './project-layout.js';
import { OutsideWorktrees } from './OtherWorktrees.js';
import { ProjectAgents, SubAgentRows, useAgentOrigins, useCcSessions } from './SubAgents.js';
import { hasRowsInside } from './project-rows.js';
import { groupTally, groupWorking, projectTally, projectWorking, tallyTip } from './attention-model.js';
import { TallyMark } from './signal-marks.js';
import { Row } from './sidebar-parts.js';
import { WorkspaceRow } from './workspace-row.js';
import { useGitHubMenuItems } from '../views/project/GitHubRow.js';
import side from './Sidebar.module.css';
import s from './project-groups.module.css';

/**
 * The sidebar's Projects, arranged the way you like: drag projects and groups to reorder them,
 * drop a project on a group (or between its projects) to put it there, or out to the top level.
 * Projects and the groups you make fold; a folded project still shows the item you are in.
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

/** The Overview, narrowed to a project's archived work. */
function showArchivedOf(run: (a: UiAction) => void, projectId: string): void {
  setOverviewView({ filter: 'archived', project: projectId });
  run({ type: 'view', view: { kind: 'overview' } });
}

/**
 * Fold or unfold a project; with Option, every project (as Finder's Option-click does).
 * Projects start folded; the ones you unfold stay unfolded (kept on this Mac). Folding keeps
 * the item you're in visible under it until you go somewhere else.
 */
function useProjectFold(projectId: string): { folded: boolean; toggle: (all: boolean) => void; peek: () => void } {
  const { ui } = useKlaud();
  const open = usePrefs().openProjects.includes(projectId);
  const peeked = useUi((u) => u.peek === projectId);
  const folded = !open && !peeked;
  const projects = useApp((st) => st.projects);
  const view = useApp((st) => st.view);
  const project = projects.find((x) => x.id === projectId);
  const setOpen = (on: boolean, ids = [projectId]): void => {
    const rest = getPrefs().openProjects.filter((k) => !ids.includes(k));
    setPrefs({ openProjects: on ? [...rest, ...ids] : rest });
  };
  const toggle = (all: boolean): void => {
    // Folding or unfolding by hand: it stays the way you put it.
    if (ui.get().peek === projectId) ui.patch({ peek: undefined });
    setOpen(folded, all ? projects.filter((x) => x.root).map((x) => x.id) : undefined);
  };
  // Clicking the project's row: it unfolds (only until you go somewhere else, unless you open what's in it).
  const peek = (): void => {
    if (folded) ui.patch({ peek: projectId });
  };
  const at = view.kind === 'workspace' ? `ws:${view.id}` : view.kind === 'project' ? `project:${view.id}` : view.kind;
  useEffect(() => {
    if (!peeked) return;
    if (at === `project:${projectId}`) return;
    ui.patch({ peek: undefined });
    // You opened one of its worktrees or chats: it stays open. Anywhere else: it folds again.
    const inside = at.startsWith('ws:') && project?.workspaces.some((w) => `ws:${w.id}` === at);
    if (inside) setOpen(true);
  }, [at, peeked]);
  return { folded, toggle, peek };
}

/** A project and its worktrees and chats (folded: only the one you're in). `depth` 1: inside a group. */
function ProjectBlock({ p, depth, entries, arrange }: { p: Project; depth: 0 | 1; entries: readonly Entry[]; arrange: Arrange }) {
  const actions = useActions();
  const state = useApp((st) => st);
  const collapsed = useUi((u) => u.collapsed);
  const fold = useProjectFold(p.id);
  const here = state.view.kind === 'workspace' ? state.view.id : undefined;
  // You're in this project: on its home page, or in one of its worktrees or chats.
  const onHome = state.view.kind === 'project' && state.view.id === p.id;
  const current = onHome || (here !== undefined && p.workspaces.some((w) => w.id === here));
  const hide = useHide();
  const iconItems = useIconItems(p);
  const busy = projectWorking(state, p);
  // What's inside: how many conversations have news, and whether one needs you (folded, it's how you notice).
  const inside = projectTally(state, p);
  const insideTip = tallyTip(inside);
  const live = p.workspaces.filter((w) => !w.archived);
  // Not the main checkout (work happens in worktrees); questions asked in its folder stay, as chats.
  // A plan's own conversation lives on the plan's page (Plans), not in the tree — unless you're in it.
  const planHomes = new Set(state.plans.plans.map((x) => x.home));
  const mine = live.filter((w) => w.kind !== 'main' && worktreeOrigin(w) === 'klaud' && (!planHomes.has(`ws:${w.id}`) || w.id === here));
  const main = live.find((w) => w.kind === 'main');
  const archived = p.workspaces.filter((w) => w.archived);
  const item: Target = { project: p.id };
  const githubItems = useGitHubMenuItems(p.id, Boolean(p.root));
  // Archived work stays out of the sidebar: the Overview's Archived list has it.
  const showArchivedItem: ActionItem[] = archived.length ? [{ label: `Show Archived (${archived.length})`, onSelect: () => showArchivedOf(actions.run, p.id) }] : [];
  // Everything about its worktrees (archiving, restoring, cleaning up those made outside Klaud) is on the Worktrees page.
  const cleanUpItem: ActionItem[] = p.workspaces.some((w) => w.kind === 'worktree') ? [{ label: 'Manage Worktrees…', onSelect: () => actions.run({ type: 'view', view: { kind: 'worktrees', projectId: p.id } }) }] : [];
  const extra: ActionItem[] = [...showArchivedItem, ...cleanUpItem, ...moveItems(entries, item, arrange), ...groupItems(p, entries, arrange), stripeMenuItem(p, Boolean(state.earnings[p.root])), ...githubItems, ...iconItems, { label: 'Hide Project', danger: true, onSelect: () => hide(p) }];
  const kids = depth + 2;
  // Nothing to unfold: no arrow (its place kept, so the icons stay in line).
  const sessions = useCcSessions();
  const origins = useAgentOrigins();
  const foldable = useMemo(() => hasRowsInside(p, sessions, origins), [p, sessions, origins]);
  return (
    <>
      <SpecContext menu={{ kind: 'project', id: p.id }} extra={extra} hide={ownWay}>
        <Row
          data-drag={`project:${p.id}`}
          indent={depth}
          selected={onHome}
          className={cx(side.projectRow, current && side.currentProject)}
          data-current={current || undefined}
          aria-expanded={foldable ? !fold.folded : undefined}
          aria-label={p.name}
          icon={
            <span className={s.projectIcon}>
              {foldable ? (
                <button
                  type="button"
                  className={s.foldButton}
                  aria-label={fold.folded ? `Show what's in ${p.name}` : `Fold ${p.name}`}
                  title={fold.folded ? 'Show (Option-click: every project)' : 'Fold (Option-click: every project)'}
                  onClick={(e) => (e.stopPropagation(), fold.toggle(e.altKey))}
                >
                  <Icon name="chevronRight" size={9} className={cx(s.disclosure, !fold.folded && s.disclosureOpen)} />
                </button>
              ) : (
                <span className={s.foldButton} aria-hidden="true" />
              )}
              <ProjectIcon id={p.id} name={p.name} size={16} />
            </span>
          }
          label={p.name}
          detail={insideTip ? `${p.name}: ${insideTip}` : p.root}
          onClick={() => {
            openProjectHome(actions.run, state, p.id);
            fold.peek();
          }}
          onKeyDown={(e) => {
            // ← folds, → unfolds (as in Finder's lists).
            if (foldable && e.target === e.currentTarget && !e.metaKey && !e.ctrlKey && ((e.key === 'ArrowLeft' && !fold.folded) || (e.key === 'ArrowRight' && fold.folded))) {
              e.preventDefault();
              fold.toggle(e.altKey);
              return;
            }
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
                {/* Claude at work inside, beside what needs you or what's new (never hidden by them). */}
                {busy ? (
                  <span className={side.status} data-busy>
                    <Dot tone="claude" live />
                  </span>
                ) : null}
                <TallyMark tally={inside} folded={fold.folded} />
              </span>
            </>
          }
        />
      </SpecContext>
      {fold.folded ? (
        // Folded: only the item you're in stays, until you go elsewhere.
        live.filter((w) => w.id === here && w.kind !== 'main').map((w) => <WorkspaceRow key={w.id} ws={w} indent={kids} />)
      ) : (
        <>
          {mine.map((w) => (
            <Fragment key={w.id}>
              <WorkspaceRow ws={w} indent={kids} />
              <SubAgentRows ws={w} indent={kids + 1} />
            </Fragment>
          ))}
          {/* Worktrees made outside Klaud: after Klaud's own, most recent first, each with where it is. */}
          <OutsideWorktrees p={p} indent={kids} />
          {/* Sub-agents the main folder's conversations started (Claude's helpers, none of your worktrees or chats): behind one row. */}
          {main ? <ProjectAgents p={p} ws={main} indent={kids} /> : null}
        </>
      )}
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
  const state = useApp((st) => st);
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
                      busy={groupWorking(state, e.projects)}
                      tally={groupTally(state, e.projects)}
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
