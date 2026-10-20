import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { isOpen } from '@klaud/core/board/model.js';
import { Icon } from '../components/Icon.js';
import { Select } from '../components/Select.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, EmptyActions, IconButton, Segmented, cx } from '../components/ui.js';
import { useApp } from '../lib/klaud.js';
import { currentSheet, openSheet } from '../lib/sheets.js';
import { TaskBoard } from './TaskBoard.js';
import { TaskList } from './TaskList.js';
import { type Display, SCOPES, type Scope, connected, scopeCounts, scoped, statusesFor, taskGraph } from './tasks-model.js';
import { setTasksPrefs, useBoard, useSelfId, useTaskActions, useTasksPrefs } from './use-tasks.js';
import t from './tasks.module.css';

const FlowGraph = lazy(() => import('../components/graph/FlowGraph.js'));

/**
 * Tasks: every project's board in one place. My Tasks, Active, Backlog or All, narrowed to one
 * project or not, as a list grouped by status, a board to drag cards across, or a graph of what
 * waits on what. A task opens into its page. ⌘N (or C) makes a new one, ⌘F finds.
 */
export function TasksView() {
  const board = useBoard();
  const selfId = useSelfId();
  const prefs = useTasksPrefs();
  const allProjects = useApp((s) => s.projects);
  const projects = useMemo(() => allProjects.filter((p) => p.root && !p.error), [allProjects]);
  const [query, setQuery] = useState('');
  const find = useRef<HTMLInputElement>(null);
  const { api, act, open } = useTaskActions();
  const project = projects.some((p) => p.id === prefs.project) ? prefs.project : '';
  const issues = useMemo(() => scoped(board, { scope: prefs.scope, project }, selfId, query), [board, prefs.scope, project, selfId, query]);
  const counts = useMemo(() => scopeCounts(board, project, selfId), [board, project, selfId]);
  const statuses = statusesFor(prefs.scope);
  // Only tasks tied to others: the rest have nothing to show there.
  const graph = useMemo(() => {
    if (prefs.display !== 'graph') return undefined;
    const tied = connected(board, issues);
    return tied.length ? taskGraph(board, tied) : undefined;
  }, [prefs.display, board, issues]);

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
        openSheet({ kind: 'new_task', ...(project ? { projectId: project } : {}) });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [project]);

  if (!board.enabled) return <Empty icon="task" title="Tasks need the Klaud app" detail="Open Klaud for Mac to plan and track work here." />;
  if (!projects.length) return <Empty icon="task" title="No projects yet" detail="Tasks belong to a project. Add one from the sidebar, then plan its work here." />;

  const none = !board.issues.length;
  return (
    <div className={t.view}>
      <div className={t.bar}>
        <div className={t.barGroup}>
        <Segmented<Scope>
          label="Show"
          value={prefs.scope}
          onChange={(scope) => setTasksPrefs({ scope })}
          options={SCOPES.map((s) => ({ value: s.value, label: counts[s.value] ? `${s.label} ${counts[s.value]}` : s.label, hint: s.hint }))}
        />
        <Select
          label="Project"
          size="small"
          value={project}
          onChange={(p) => setTasksPrefs({ project: p })}
          options={[{ value: '', label: 'All Projects' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <label className={t.find}>
          <Icon name="search" size={12} />
          <input ref={find} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" aria-label="Filter tasks" onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), (e.target as HTMLInputElement).blur())} />
          {query ? (
            <button type="button" className={t.findClear} aria-label="Clear the filter" onClick={() => setQuery('')}>
              <Icon name="x" size={10} />
            </button>
          ) : null}
        </label>
        </div>
        <div className={cx(t.barGroup, t.barActions)}>
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
        <ActionsDropdown
          items={[
            { label: 'Open a Task for Every New Worktree', checked: board.autoTasks, onSelect: () => void act(() => api.setAutoTasks(!board.autoTasks)) },
            { label: 'Show Canceled Tasks', separate: true, checked: !prefs.folded.includes('canceled'), onSelect: () => setTasksPrefs({ folded: prefs.folded.includes('canceled') ? prefs.folded.filter((s) => s !== 'canceled') : [...prefs.folded, 'canceled'] }) },
          ]}
        >
          <IconButton icon="more" label="Tasks Options" />
        </ActionsDropdown>
        <Button variant="primary" size="small" icon="plus" onClick={() => openSheet({ kind: 'new_task', ...(project ? { projectId: project } : {}) })} title="New Task (⌘N)">
          New Task
        </Button>
        </div>
      </div>
      <div className={cx(t.body, prefs.display === 'board' && t.bodyBoard, prefs.display === 'graph' && t.bodyGraph)}>
        {none ? (
          <Empty
            icon="task"
            title="Plan the work"
            detail="Every new worktree opens a task here, and its pull request moves it along. Or write down what needs doing."
            action={
              <EmptyActions>
                <Button variant="primary" icon="plus" onClick={() => openSheet({ kind: 'new_task', ...(project ? { projectId: project } : {}) })}>
                  New Task
                </Button>
              </EmptyActions>
            }
          />
        ) : !issues.length ? (
          <Empty icon="task" title={query ? 'Nothing matches' : prefs.scope === 'mine' ? 'Nothing for you right now' : 'Nothing here'} detail={query ? 'Try fewer words.' : SCOPES.find((s) => s.value === prefs.scope)?.hint} />
        ) : prefs.display === 'board' ? (
          <TaskBoard issues={issues} statuses={statuses} {...(project ? { projectId: project } : {})} />
        ) : prefs.display === 'graph' && !graph ? (
          <Empty icon="graph" title="Nothing waits on anything here" detail="Mark what blocks what, or add sub-tasks, on a task’s page: they show up here as a graph." />
        ) : prefs.display === 'graph' && graph ? (
          <div className={t.graph}>
            <Suspense fallback={<div className={t.graphNote}>Laying out…</div>}>
              <FlowGraph graph={graph} mode="full" localImages={false} openLabel="Open Task" onOpen={(id) => open({ id })} />
            </Suspense>
          </div>
        ) : (
          <TaskList issues={issues} statuses={statuses} emptyGroups={prefs.scope === 'active' || prefs.scope === 'backlog'} {...(project ? { projectId: project } : {})} />
        )}
      </div>
      {issues.length && prefs.display !== 'graph' ? <div className={t.foot}>{issues.filter((i) => isOpen(i.status)).length} open · {issues.length} shown</div> : null}
    </div>
  );
}
