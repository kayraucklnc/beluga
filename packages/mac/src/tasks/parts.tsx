import { activityOf } from '@klaud/ui/workspace-models.js';
import { liveFrom } from '@klaud/core/plans/progress.js';
import { pulseOf, pulseWords } from '@klaud/core/plans/watchdog.js';
import { type Issue, ISSUE_STATUSES, PRIORITIES, PRIORITY_INFO, STATUS_INFO, isFinished, isOpen, openBlockers, progressOf } from '@klaud/core/board/model.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { Icon } from '../components/Icon.js';
import { Dot, Tip, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useApp, useKlaud, toast } from '../lib/klaud.js';
import { openSheet } from '../lib/sheets.js';
import { useClock } from '../plans/use-plans.js';
import { WaitingLine } from '../plans/WaitingLine.js';
import { LabelChip, PrChip } from './marks.js';
import { dueText } from './tasks-model.js';
import type { LogItem } from '@klaud/core/store.js';
import { useTaskActions } from './use-tasks.js';
import t from './tasks.module.css';

const NONE: readonly never[] = [];

/** Who's working where, worked out once per log (every card on the board reads the same one). */
const lives = new WeakMap<readonly LogItem[], ReturnType<typeof liveFrom>>();
function liveOf(log: readonly LogItem[]): ReturnType<typeof liveFrom> {
  let live = lives.get(log);
  if (!live) lives.set(log, (live = liveFrom({ log, questions: [], approvals: [] })));
  return live;
}

/** What a row and a card show besides the title: sub-tasks done, what blocks it, its worktree, labels, due date, pull request. */
export function IssueMeta({ issue, compact, labels = true }: { issue: Issue; compact?: boolean; labels?: boolean }) {
  // Only what this issue shows, as plain values: a change elsewhere on the board doesn't render every card again.
  const done = useApp((s) => progressOf(s.board, issue).done);
  const total = useApp((s) => progressOf(s.board, issue).total);
  const progress = { done, total };
  const blocked = useApp((s) => openBlockers(s.board, issue).length);
  const waitsOn = useApp((s) => openBlockers(s.board, issue).map((b) => `${b.key} ${b.title}`).join(', '));
  const blockedBy = useApp((s) => openBlockers(s.board, issue).map((b) => b.key).join(', '));
  const last = issue.worktrees.at(-1);
  const worktree = useApp((s) => (last && s.projects.some((p) => p.workspaces.some((w) => w.id === last && !w.archived)) ? last : undefined));
  const running = useApp((s) => (worktree ? activityOf(s.log, `ws:${worktree}`).running : false));
  // What its Claude is doing right now, and the messages waiting for it (the head Claude's, yours).
  const run = useApp((s) => (worktree && running ? liveOf(s.log).run?.(`ws:${worktree}`) : undefined));
  const waiting = useApp((s) => (worktree && STATUS_INFO[issue.status].open ? liveOf(s.log).waiting?.(`ws:${worktree}`) : undefined)) ?? NONE;
  const pulse = running ? pulseOf(run, false, undefined) : undefined;
  const now = useClock(pulse?.kind === 'working' || pulse?.kind === 'command');
  const doing = pulse && !compact ? pulseWords(pulse, now).sub : undefined;
  const due = issue.due ? dueText(issue.due) : undefined;
  // The plan (and milestone) it's part of.
  const plan = useApp((s) => (issue.plan ? s.plans.plans.find((x) => x.id === issue.plan!.id) : undefined));
  const milestone = plan && issue.plan ? (plan.body ?? plan.draft)?.milestones.find((m) => m.id === issue.plan!.milestone)?.title : undefined;
  return (
    <span className={cx(t.meta, compact && t.metaCompact)}>
      {issue.drafting ? (
        <span className={t.writing} aria-live="polite">
          <Dot tone="claude" live />
          Claude is writing…
        </span>
      ) : null}
      {issue.needsChecks && STATUS_INFO[issue.status].open ? (
        <Tip label="Kept out of review: an acceptance criterion is neither ticked nor explained">
          <span className={t.needsChecks}>Needs its checks</span>
        </Tip>
      ) : null}
      {plan && milestone ? (
        <Tip label={`Part of the plan “${(plan.body ?? plan.draft)?.title ?? ''}”, milestone “${milestone}”`}>
          <span className={t.planMark}>
            <Icon name="flag" size={11} />
            {compact ? null : milestone}
          </span>
        </Tip>
      ) : null}
      {blocked && STATUS_INFO[issue.status].open ? (
        <Tip label={`Waits on ${waitsOn}`}>
          <span className={t.blocked}>
            <Icon name="stopSign" size={11} />
            {compact ? blocked : `Blocked by ${blockedBy}`}
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
        <Tip label={doing ? `Claude: ${doing}` : 'Claude is working on it'}>
          <span className={t.working}>
            <Dot tone="claude" live />
            {doing ? <span className={t.nowStep}>{doing}</span> : null}
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
      {waiting.length ? <WaitingLine waiting={waiting} /> : null}
    </span>
  );
}

/** Right-click (and ⋯) on a task: open it, its worktree, start one (or reopen a finished one), change it, copy, delete. */
export function useIssueMenu(): (issue: Issue) => ActionItem[] {
  const { api, act, open, openWorktree } = useTaskActions();
  const { client } = useKlaud();
  const projects = useApp((s) => s.projects);
  return (issue) => {
    // Only a worktree that's still here (an archived one can be restored from its page).
    const last = issue.worktrees.at(-1);
    const worktree = last && projects.some((p) => p.workspaces.some((w) => w.id === last && !w.archived)) ? last : undefined;
    const startable = isOpen(issue.status) && !isFinished(issue.status);
    return [
      { label: 'Open', icon: 'task', onSelect: () => open(issue) },
      ...(worktree
        ? [{ label: 'Open Worktree', icon: 'branch' as const, onSelect: () => openWorktree(worktree) }]
        : startable
          ? [
              { label: 'Start with Claude', icon: 'claude' as const, hint: 'A new worktree, Claude working on it', onSelect: () => void act(() => api.start(issue.id, { claude: true })) },
              { label: 'Start Worktree', icon: 'branch' as const, onSelect: () => void act(() => api.start(issue.id, {})) },
            ]
          : []),
      // Finished (or canceled) work starts again only deliberately: back to Todo, then Start.
      ...(startable ? [] : [{ label: 'Reopen the Task', icon: 'refresh' as const, onSelect: () => void act(() => api.update(issue.id, { status: 'todo' }), `Reopened ${issue.key}`) }]),
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
