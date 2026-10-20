import { type KeyboardEvent, memo, useEffect, useRef, useState } from 'react';
import { type Issue, type IssueStatus, PRIORITY_INFO, STATUS_INFO, byRank } from '@klaud/core/board/model.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext } from '../components/SpecMenu.js';
import { IconButton, cx } from '../components/ui.js';
import { openSheet } from '../lib/sheets.js';
import { AssigneeMark, PriorityIcon, StatusIcon } from './marks.js';
import { IssueMeta, useIssueMenu } from './parts.js';
import { AssigneePicker, PriorityPicker, StatusPicker } from './pickers.js';
import { ago } from './tasks-model.js';
import { setTasksPrefs, useSelfId, useTaskActions, useTasksPrefs } from './use-tasks.js';
import t from './tasks.module.css';

/**
 * Tasks as a list, grouped by status (each group folds, and its + adds a task there). A row's
 * status, priority and assignee change from their own menus; the rest of the row opens the task.
 * ↑↓ move, Return opens, right-click for everything else.
 */
export function TaskList({ issues, statuses, projectId, emptyGroups }: { issues: readonly Issue[]; statuses: readonly IssueStatus[]; projectId?: string; emptyGroups: boolean }) {
  const prefs = useTasksPrefs();
  const { open } = useTaskActions();
  const [cursor, setCursor] = useState<string>();
  const groups = statuses
    .map((status) => ({ status, items: issues.filter((i) => i.status === status).sort((a, b) => PRIORITY_INFO[a.priority].rank - PRIORITY_INFO[b.priority].rank || byRank(a, b)) }))
    .filter((g) => g.items.length || emptyGroups);
  const visible = groups.flatMap((g) => (prefs.folded.includes(g.status) ? [] : g.items));
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cursor) return;
    list.current?.querySelector<HTMLElement>(`[data-issue="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.issue) return;
    const at = visible.findIndex((i) => i.id === cursor);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = visible[Math.min(visible.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))] ?? visible[0];
      if (next) setCursor(next.id);
    } else if (e.key === 'Enter' && at >= 0) {
      e.preventDefault();
      open(visible[at]!);
    }
  };

  const fold = (status: IssueStatus): void => setTasksPrefs({ folded: prefs.folded.includes(status) ? prefs.folded.filter((s) => s !== status) : [...prefs.folded, status] });

  return (
    <div ref={list} className={t.list} role="grid" aria-label="Tasks" tabIndex={0} onKeyDown={onKeyDown}>
      {groups.map((g) => {
        const folded = prefs.folded.includes(g.status);
        return (
          <section key={g.status} className={t.group} aria-label={STATUS_INFO[g.status].label}>
            <header className={t.groupHead}>
              <button type="button" className={t.groupToggle} onClick={() => fold(g.status)} aria-expanded={!folded}>
                <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={11} />
                <StatusIcon status={g.status} />
                <span className={t.groupName}>{STATUS_INFO[g.status].label}</span>
                <span className={t.groupCount}>{g.items.length}</span>
              </button>
              <IconButton icon="plus" label={`New Task in ${STATUS_INFO[g.status].label}`} onClick={() => openSheet({ kind: 'new_task', status: g.status, ...(projectId ? { projectId } : {}) })} />
            </header>
            {folded ? null : g.items.map((issue) => <Row key={issue.id} issue={issue} cursor={cursor === issue.id} onCursor={() => setCursor(issue.id)} />)}
            {!folded && !g.items.length ? <div className={t.groupEmpty}>Nothing here</div> : null}
          </section>
        );
      })}
    </div>
  );
}

const Row = memo(function Row({ issue, cursor, onCursor }: { issue: Issue; cursor: boolean; onCursor: () => void }) {
  const selfId = useSelfId();
  const { api, act, open } = useTaskActions();
  const menu = useIssueMenu();
  const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation();
  return (
    <ActionsContext items={() => menu(issue)}>
      <div
        role="row"
        tabIndex={-1}
        data-issue={issue.id}
        className={cx(t.row, cursor && t.rowCursor)}
        onClick={() => open(issue)}
        onMouseDown={onCursor}
        aria-label={`${issue.key} ${issue.title}, ${STATUS_INFO[issue.status].label}`}
      >
        <span className={t.rowCell} onClick={stop}>
          <PriorityPicker issue={issue}>
            <button type="button" className={t.iconHit} aria-label={`Priority: ${PRIORITY_INFO[issue.priority].label}`}>
              <PriorityIcon priority={issue.priority} />
            </button>
          </PriorityPicker>
        </span>
        <span className={t.key}>{issue.key}</span>
        <span className={t.rowCell} onClick={stop}>
          <StatusPicker issue={issue}>
            <button type="button" className={t.iconHit} aria-label={`Status: ${STATUS_INFO[issue.status].label}`}>
              <StatusIcon status={issue.status} />
            </button>
          </StatusPicker>
        </span>
        <span className={cx(t.title, !STATUS_INFO[issue.status].open && t.titleClosed)}>{issue.title}</span>
        <IssueMeta issue={issue} />
        <span className={t.rowCell} onClick={stop}>
          <AssigneePicker value={issue.assignee} onChange={(a) => void act(() => api.update(issue.id, { assignee: a }))} align="end">
            <button type="button" className={t.iconHit}>
              <AssigneeMark assignee={issue.assignee} selfId={selfId} />
            </button>
          </AssigneePicker>
        </span>
        <span className={t.when}>{ago(issue.updatedAt)}</span>
      </div>
    </ActionsContext>
  );
});
