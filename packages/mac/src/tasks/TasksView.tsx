import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { isOpen } from '@beluga/core/board/model.js';
import { Icon } from '../components/Icon.js';
import { Select } from '../components/Select.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, EmptyActions, IconButton, Segmented, cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { currentSheet, openSheet } from '../lib/sheets.js';
import { TaskBoard } from './TaskBoard.js';
import { TaskList } from './TaskList.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { PickMenu } from './PickMenu.js';
import { type Display, SCOPES, type Scope, assigneesIn, connected, doneCount, projectToShow, scopeCounts, scoped, statusesFor, taskGraph } from './tasks-model.js';
import { setTasksPrefs, useBoard, useSelfId, useSolo, useTaskActions, useTasksPrefs } from './use-tasks.js';
import t from './tasks.module.css';

const FlowGraph = lazy(() => import('../components/graph/FlowGraph.js'));

/**
 * Tasks: one project's board at a time (the one you're in; the switcher at the top changes it),
 * Active, Backlog or All, for everyone or one person when you work with others, as a list grouped
 * by status, a board to drag cards across, or a graph of what waits on what. A task opens into
 * its page. ⌘N (or C) makes a new one, ⌘F finds. The Archive (finished tasks put away) is a list,
 * emptied for good from here.
 */
export function TasksView() {
  const board = useBoard();
  const selfId = useSelfId();
  const prefs = useTasksPrefs();
  const view = useApp((s) => s.view);
  const allProjects = useApp((s) => s.projects);
  const projects = useMemo(() => allProjects.filter((p) => p.root && !p.error), [allProjects]);
  const [query, setQuery] = useState('');
  const find = useRef<HTMLInputElement>(null);
  const { api, act, open, openList } = useTaskActions();
  const project = projectToShow(board, projects, view.kind === 'tasks' ? view.projectId : undefined, prefs.project);
  const solo = useSolo(project);
  const people = useMemo(() => (solo ? [] : assigneesIn(board, project, selfId)), [solo, board, project, selfId]);
  // A filter for someone who has no tasks here any more shows everyone's.
  const who = !solo && (prefs.who === 'nobody' || people.some((p) => p.key === prefs.who)) ? prefs.who : '';
  const issues = useMemo(() => (project ? scoped(board, { scope: prefs.scope, project, who }, selfId, query) : []), [board, prefs.scope, project, who, selfId, query]);
  const counts = useMemo(() => (project ? scopeCounts(board, project, who, selfId) : { active: 0, backlog: 0, all: 0, archived: 0 }), [board, project, who, selfId]);
  const statuses = statusesFor(prefs.scope);
  const archive = prefs.scope === 'archived';
  // The Archive is a list: nothing in it moves or waits on anything.
  const display = archive ? 'list' : prefs.display;
  // Only tasks tied to others: the rest have nothing to show there.
  const graph = useMemo(() => {
    if (display !== 'graph') return undefined;
    const tied = connected(board, issues);
    return tied.length ? taskGraph(board, tied) : undefined;
  }, [display, board, issues]);
  const here = projects.find((p) => p.id === project);

  // ⌘F finds, ⌘N or C (outside a field) makes a task.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Not while typing, in a menu, a pop-up or a sheet (a sheet's own keys stay its own).
      if (e.defaultPrevented || currentSheet()) return;
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"], [role="combobox"], [role="dialog"]');
      if (e.metaKey && e.key.toLowerCase() === 'f' && !typing) {
        e.preventDefault();
        find.current?.focus();
        find.current?.select();
      } else if ((e.metaKey && e.key.toLowerCase() === 'n' && !e.shiftKey) || (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'c')) {
        e.preventDefault();
        e.stopPropagation();
        openSheet({ kind: 'new_task', projectId: project });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [project]);

  if (!board.enabled) return <Empty icon="task" title="Tasks need the Beluga app" detail="Open Beluga for Mac to plan and track work here." />;
  if (!projects.length || !here) return <Empty icon="task" title="No projects yet" detail="Tasks belong to a project. Add one from the sidebar, then plan its work here." />;

  const none = !board.issues.some((i) => i.projectId === project);
  return (
    <div className={t.view}>
      <div className={t.bar}>
        <div className={t.barGroup}>
        <PickMenu<string>
          label="Project"
          choices={projects.map((p) => ({ value: p.id, label: p.name, mark: <ProjectIcon id={p.id} name={p.name} size={16} />, hint: openCount(board, p.id) }))}
          chosen={[here.id]}
          onPick={(id) => openList(id)}
        >
          <button type="button" className={t.projectSwitch} aria-label={`Project: ${here.name}`}>
            <ProjectIcon id={here.id} name={here.name} size={18} />
            <span className={t.projectName}>{here.name}</span>
            <Icon name="chevronDown" size={11} />
          </button>
        </PickMenu>
        <Segmented<Scope>
          label="Show"
          value={prefs.scope}
          onChange={(scope) => setTasksPrefs({ scope })}
          options={SCOPES.map((s) => ({ value: s.value, label: counts[s.value] ? `${s.label} ${counts[s.value]}` : s.label, hint: s.hint }))}
        />
        {/* Whose tasks: only when you work with others (alone, every task is yours and your Claude's). */}
        {people.length > 1 || (people.length === 1 && people[0]!.key !== `person:${selfId}` && people[0]!.key !== `claude:${selfId}`) ? (
          <Select
            label="Whose tasks"
            size="small"
            value={who}
            onChange={(w) => setTasksPrefs({ who: w })}
            options={[{ value: '', label: 'Everyone' }, ...people.map((p) => ({ value: p.key, label: p.label })), { value: 'nobody', label: 'No one yet' }]}
          />
        ) : null}
        </div>
        <div className={cx(t.barGroup, t.barActions)}>
        <label className={t.find}>
          <Icon name="search" size={12} />
          <input ref={find} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" aria-label="Filter tasks" onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), (e.target as HTMLInputElement).blur())} />
          {query ? (
            <button type="button" className={t.findClear} aria-label="Clear the filter" onClick={() => setQuery('')}>
              <Icon name="x" size={10} />
            </button>
          ) : null}
        </label>
        {archive ? (
          counts.archived ? (
            <Button
              size="small"
              variant="quiet"
              onClick={() =>
                openSheet({
                  kind: 'confirm',
                  title: `Delete ${counts.archived} archived ${counts.archived === 1 ? 'task' : 'tasks'} for good?`,
                  message: 'Their briefs, history and what’s left of their proof go away. This can’t be undone.',
                  confirm: 'Empty Archive',
                  destructive: true,
                  run: () => void act(() => api.emptyArchive(project), 'The Archive is empty'),
                })
              }
            >
              Empty Archive
            </Button>
          ) : null
        ) : (
          <Segmented<Display>
            label="Display"
            iconOnly
            value={prefs.display}
            onChange={(display) => setTasksPrefs({ display })}
            options={[
              { value: 'list', label: 'List', icon: 'rows' },
              { value: 'board', label: 'Board', icon: 'columns' },
              { value: 'graph', label: 'What Waits on What', icon: 'graph' },
            ]}
          />
        )}
        <ActionsDropdown
          items={[
            { label: 'Open a Task for Every New Worktree', checked: board.autoTasks, onSelect: () => void act(() => api.setAutoTasks(!board.autoTasks)) },
            { label: 'Archive Done Tasks', icon: 'archive', separate: true, disabled: !doneCount(board, project), onSelect: () => void act(() => api.archiveDone(project), 'Done tasks are in the Archive') },
            { label: 'Show Canceled Tasks', separate: true, checked: !prefs.folded.includes('canceled'), onSelect: () => setTasksPrefs({ folded: prefs.folded.includes('canceled') ? prefs.folded.filter((s) => s !== 'canceled') : [...prefs.folded, 'canceled'] }) },
          ]}
        >
          <IconButton icon="more" label="Tasks Options" />
        </ActionsDropdown>
        <Button variant="primary" size="small" icon="plus" onClick={() => openSheet({ kind: 'new_task', projectId: project })} title="New Task (⌘N)">
          New Task
        </Button>
        </div>
      </div>
      <div className={cx(t.body, display === 'board' && t.bodyBoard, display === 'graph' && t.bodyGraph)}>
        {none ? (
          <Empty
            icon="task"
            title="Plan the work"
            detail="Every new worktree opens a task here, and its pull request moves it along. Or write down what needs doing."
            action={
              <EmptyActions>
                <Button variant="primary" icon="plus" onClick={() => openSheet({ kind: 'new_task', projectId: project })}>
                  New Task
                </Button>
              </EmptyActions>
            }
          />
        ) : !issues.length ? (
          archive && !query ? (
            <Empty icon="archive" title="The Archive is empty" detail="Archive Done tasks from the Done group: they come here, their words kept and their screenshots kept small." />
          ) : (
            <Empty icon="task" title={query ? 'Nothing matches' : who ? 'Nothing for them here' : 'Nothing here'} detail={query ? 'Try fewer words.' : SCOPES.find((s) => s.value === prefs.scope)?.hint} />
          )
        ) : display === 'board' ? (
          <TaskBoard issues={issues} statuses={statuses} projectId={project} />
        ) : display === 'graph' && !graph ? (
          <Empty icon="graph" title="Nothing waits on anything here" detail="Mark what blocks what, or add sub-tasks, on a task’s page: they show up here as a graph." />
        ) : display === 'graph' && graph ? (
          <div className={t.graph}>
            <Suspense fallback={<div className={t.graphNote}>Laying out…</div>}>
              <FlowGraph graph={graph} mode="full" localImages={false} openLabel="Open Task" onOpen={(id) => open({ id })} />
            </Suspense>
          </div>
        ) : (
          <TaskList issues={issues} statuses={statuses} emptyGroups={prefs.scope === 'active' || prefs.scope === 'backlog'} projectId={project} archived={archive} />
        )}
      </div>
      {issues.length && display !== 'graph' ? <div className={t.foot}>{archive ? `${issues.length} archived` : `${issues.filter((i) => isOpen(i.status)).length} open · ${issues.length} shown`}</div> : null}
    </div>
  );
}

/** "3 open" (or nothing), beside each project in the switcher. */
function openCount(board: ReturnType<typeof useBoard>, projectId: string): string | undefined {
  const n = board.issues.filter((i) => i.projectId === projectId && isOpen(i.status)).length;
  return n ? `${n} open` : undefined;
}
