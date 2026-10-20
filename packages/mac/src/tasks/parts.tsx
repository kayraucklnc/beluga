import { activityOf } from '@klaud/ui/workspace-models.js';
import { type Issue, ISSUE_STATUSES, PRIORITIES, PRIORITY_INFO, STATUS_INFO, openBlockers, progressOf } from '@klaud/core/board/model.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { Icon } from '../components/Icon.js';
import { Dot, Tip, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useApp, useKlaud, toast } from '../lib/klaud.js';
import { openSheet } from '../lib/sheets.js';
import { LabelChip, PrChip } from './marks.js';
import { dueText } from './tasks-model.js';
import { useBoard, useTaskActions } from './use-tasks.js';
import t from './tasks.module.css';

/** What a row and a card show besides the title: sub-tasks done, what blocks it, its worktree, labels, due date, pull request. */
export function IssueMeta({ issue, compact, labels = true }: { issue: Issue; compact?: boolean; labels?: boolean }) {
  const board = useBoard();
  const progress = progressOf(board, issue);
  const blockers = openBlockers(board, issue);
  const last = issue.worktrees.at(-1);
  const worktree = useApp((s) => (last && s.projects.some((p) => p.workspaces.some((w) => w.id === last && !w.archived)) ? last : undefined));
  const running = useApp((s) => (worktree ? activityOf(s.log, `ws:${worktree}`).running : false));
  const due = issue.due ? dueText(issue.due) : undefined;
  return (
    <span className={cx(t.meta, compact && t.metaCompact)}>
      {blockers.length && STATUS_INFO[issue.status].open ? (
        <Tip label={`Waits on ${blockers.map((b) => `${b.key} ${b.title}`).join(', ')}`}>
          <span className={t.blocked}>
            <Icon name="stopSign" size={11} />
            {compact ? blockers.length : `Blocked by ${blockers.map((b) => b.key).join(', ')}`}
          </span>
        </Tip>
      ) : null}
      {progress.total ? (
        <Tip label={`${progress.done} of ${progress.total} sub-tasks done`}>
          <span className={t.progress}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="6" cy="6" r="4.6" className={t.progressTrack} />
              <circle cx="6" cy="6" r="4.6" className={t.progressDone} strokeDasharray={`${(progress.done / progress.total) * 28.9} 28.9`} transform="rotate(-90 6 6)" />
            </svg>
            {progress.done}/{progress.total}
          </span>
        </Tip>
      ) : null}
      {labels ? issue.labels.slice(0, compact ? 2 : 4).map((l) => <LabelChip key={l} label={l} />) : null}
      {due ? (
        <span className={cx(t.due, due.late && STATUS_INFO[issue.status].open && t.dueLate)}>
          <Icon name="calendar" size={11} />
          {due.text}
        </span>
      ) : null}
      {running ? (
        <Tip label="Claude is working on it">
          <span className={t.working}>
            <Dot tone="claude" live />
          </span>
        </Tip>
      ) : worktree && !issue.pr ? (
        <Tip label={issue.branch ? `In worktree on ${issue.branch}` : 'Has a worktree'}>
          <span className={t.worktreeMark}>
            <Icon name="branch" size={11} />
          </span>
        </Tip>
      ) : null}
      {issue.pr ? <PrChip pr={issue.pr} /> : null}
    </span>
  );
}

/** Right-click (and ⋯) on a task: open it, its worktree, start one, change it, copy, delete. */
export function useIssueMenu(): (issue: Issue) => ActionItem[] {
  const { api, act, open, openWorktree } = useTaskActions();
  const { client } = useKlaud();
  const projects = useApp((s) => s.projects);
  return (issue) => {
    // Only a worktree that's still here (an archived one can be restored from its page).
    const last = issue.worktrees.at(-1);
    const worktree = last && projects.some((p) => p.workspaces.some((w) => w.id === last && !w.archived)) ? last : undefined;
    return [
      { label: 'Open', icon: 'task', onSelect: () => open(issue) },
      worktree
        ? { label: 'Open Worktree', icon: 'branch', onSelect: () => openWorktree(worktree) }
        : { label: 'Start with Claude', icon: 'claude', hint: 'A new worktree, Claude working on it', onSelect: () => void act(() => api.start(issue.id, { claude: true })) },
      ...(worktree ? [] : [{ label: 'Start Worktree', icon: 'branch' as const, onSelect: () => void act(() => api.start(issue.id, {})) }]),
      {
        label: 'Status',
        separate: true,
        submenu: ISSUE_STATUSES.map((s) => ({ label: STATUS_INFO[s].label, checked: issue.status === s, onSelect: () => void act(() => api.update(issue.id, { status: s })) })),
        onSelect: () => undefined,
      },
      {
        label: 'Priority',
        submenu: PRIORITIES.map((p) => ({ label: PRIORITY_INFO[p].label, checked: issue.priority === p, onSelect: () => void act(() => api.update(issue.id, { priority: p })) })),
        onSelect: () => undefined,
      },
      { label: 'Add Sub-task…', icon: 'plus', onSelect: () => openSheet({ kind: 'new_task', projectId: issue.projectId, parent: issue.id }) },
      { label: 'Copy Key', icon: 'copy', separate: true, hint: issue.key, onSelect: () => void copyText(issue.key).then(() => toast(client, `Copied ${issue.key}`, 'success')) },
      { label: 'Copy Title and Key', onSelect: () => void copyText(`${issue.key} ${issue.title}`).then(() => toast(client, 'Copied', 'success')) },
      {
        label: 'Delete Task…',
        danger: true,
        onSelect: () =>
          openSheet({
            kind: 'confirm',
            title: `Delete ${issue.key}?`,
            message: `“${issue.title}”, its brief and its history go away. Its sub-tasks stay, as tasks of their own. Its worktree isn't touched.`,
            confirm: 'Delete Task',
            destructive: true,
            run: () => void act(() => api.remove(issue.id), `Deleted ${issue.key}`),
          }),
      },
    ];
  };
}
