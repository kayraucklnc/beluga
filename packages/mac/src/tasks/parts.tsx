import { activityOf } from '@beluga/ui/workspace-models.js';
import { liveFrom } from '@beluga/core/plans/progress.js';
import { pulseOf, pulseWords } from '@beluga/core/plans/watchdog.js';
import { type Issue, ISSUE_STATUSES, PRIORITIES, PRIORITY_INFO, STATUS_INFO, childrenOf, isArchived, isOpen, isStartable, issueById, openBlockers, progressOf, worktreeDoing, worktreeOf } from '@beluga/core/board/model.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Dot, IconButton, Tip, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useApp, useBeluga, toast } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { useClock } from '../plans/use-plans.js';
import { WaitingLine } from '../plans/WaitingLine.js';
import { LabelChip, PrChip } from './marks.js';
import { doneCount, dueText, onIt, onItTip, onItWords, toggleOpened } from './tasks-model.js';
import type { LogItem } from '@beluga/core/store.js';
import { revealSubTasks, setTasksPrefs, useTaskActions, useTasksPrefs } from './use-tasks.js';
import { teammatesOf, workingOn } from '@beluga/core/team/model.js';
import { sameDeep } from '../lib/stable.js';
import { askAboutTask } from '../network/chat-model.js';
import { draftIn } from '../network/NetComposer.js';
import { IssueMark } from '../issues/task-bits.js';
import t from './tasks.module.css';

const NONE: readonly never[] = [];

/** Who's working where, worked out once per log (every card on the board reads the same one). */
const lives = new WeakMap<readonly LogItem[], ReturnType<typeof liveFrom>>();
function liveOf(log: readonly LogItem[]): ReturnType<typeof liveFrom> {
  let live = lives.get(log);
  if (!live) lives.set(log, (live = liveFrom({ log, questions: [], approvals: [] })));
  return live;
}

/** What a row and a card show besides the title: sub-tasks done, what blocks it, its worktree, labels, due date, pull request. `presence`: whether Claude at work there shows here (a card shows it under itself, in OnItLine). */
export function IssueMeta({ issue, compact, labels = true, progress: ring = true, presence = true }: { issue: Issue; compact?: boolean; labels?: boolean; progress?: boolean; presence?: boolean }) {
  // Only what this issue shows, as plain values: a change elsewhere on the board doesn't render every card again.
  const done = useApp((s) => progressOf(s.board, issue).done);
  const total = useApp((s) => progressOf(s.board, issue).total);
  const progress = { done, total };
  // The epic it's part of (its parent).
  const epicKey = useApp((s) => (issue.parent ? issueById(s.board, issue.parent)?.key : undefined));
  const epicTitle = useApp((s) => (issue.parent ? issueById(s.board, issue.parent)?.title : undefined));
  const blocked = useApp((s) => openBlockers(s.board, issue).length);
  const waitsOn = useApp((s) => openBlockers(s.board, issue).map((b) => `${b.key} ${b.title}`).join(', '));
  const blockedBy = useApp((s) => openBlockers(s.board, issue).map((b) => b.key).join(', '));
  const last = worktreeOf(issue);
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
      {epicKey ? (
        <Tip label={`Part of the epic ${epicKey} ${epicTitle ?? ''}`}>
          <span className={t.epicOf}>
            <Icon name="epic" size={11} />
            {epicKey}
          </span>
        </Tip>
      ) : null}
      {ring && progress.total ? (
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
      <IssueMark issue={issue} compact={compact} />
      {labels ? issue.labels.slice(0, compact ? 3 : 4).map((l) => <LabelChip key={l} label={l} projectId={issue.projectId} iconOnly={compact} />) : null}
      {due ? (
        <span className={cx(t.due, due.late && STATUS_INFO[issue.status].open && t.dueLate)}>
          <Icon name="calendar" size={11} />
          {due.text}
        </span>
      ) : null}
      {!presence ? null : running ? (
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

/**
 * Who's on a task right now, under its card (BLG-278): their avatars, a soft ring turning round each
 * one whose Claude is at work, and a line moving along the card's bottom edge while any is. Who it's
 * for is the avatar on top; this is who's doing it (you, from your worktree; teammates, from theirs).
 */
export function OnItLine({ issue, self }: { issue: Issue; self: { readonly id: string; readonly name: string } }) {
  const last = worktreeOf(issue);
  const worktree = useApp((s) => (last && STATUS_INFO[issue.status].open && s.projects.some((p) => p.workspaces.some((w) => w.id === last && !w.archived)) ? last : undefined));
  const running = useApp((s) => (worktree ? activityOf(s.log, `ws:${worktree}`).running : false));
  const run = useApp((s) => (worktree && running ? liveOf(s.log).run?.(`ws:${worktree}`) : undefined));
  // What it's doing is only in the tooltip, as of now: the card just says working (no ticking step and timer on every card).
  const pulse = running ? pulseOf(run, false, undefined) : undefined;
  const doing = pulse ? pulseWords(pulse, Date.now()).sub : undefined;
  const mates = useApp((s) => (STATUS_INFO[issue.status].open ? workingOn(s.team, issue.id) : NONE), sameDeep);
  const people = onIt(self, { here: Boolean(worktree), running }, mates);
  if (!people.length) return null;
  const live = people.some((p) => p.running);
  return (
    <div className={t.onIt}>
      <span className={t.onItFaces}>
        {people.slice(0, 3).map((p) => (
          <Tip key={p.peerId} label={onItTip(p, p.you ? doing : undefined)}>
            <span className={cx(t.onItFace, p.running && t.onItLive)} aria-label={onItTip(p, p.you ? doing : undefined)}>
              <Avatar name={p.name} id={p.peerId} size={16} />
            </span>
          </Tip>
        ))}
      </span>
      <span className={t.onItWords}>{onItWords(people)}</span>
      {live ? <span className={t.onItSheen} aria-hidden="true" /> : null}
    </div>
  );
}

/** An epic's sub-tasks done, as a bar across its card (canceled ones left out). */
export function EpicBar({ issue }: { issue: Issue }) {
  const done = useApp((s) => progressOf(s.board, issue).done);
  const total = useApp((s) => progressOf(s.board, issue).total);
  const all = useApp((s) => childrenOf(s.board, issue).length);
  const words = total ? `${done} of ${total} done` : `${all} sub-task${all === 1 ? '' : 's'}, all canceled`;
  return (
    <span className={t.epicBar} role="img" aria-label={`Sub-tasks: ${words}`}>
      <span className={t.epicTrack}>
        <span className={t.epicFill} style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </span>
      <span className={t.epicCount}>{words}</span>
      <TuckButton issue={issue} />
    </span>
  );
}

/**
 * The eye on an epic: its sub-tasks start tucked under it (the epic's card stands for them); the
 * eye pops them out, one after another, or tucks them back. Always there, never behind a menu;
 * tinted, with how many, while they're tucked away. Your choice alone: others' boards don't change.
 */
export function TuckButton({ issue }: { issue: Issue }) {
  const opened = useTasksPrefs().opened;
  const away = !opened.includes(issue.id);
  const n = useApp((s) => childrenOf(s.board, issue).length);
  const label = away ? `Show its ${n} sub-task${n === 1 ? '' : 's'}` : 'Tuck its sub-tasks under it';
  // A press here isn't the card's: no drag, no opening the task.
  const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation();
  return (
    <Tip label={label}>
      <button
        type="button"
        className={cx(t.tuck, away && t.tuckAway)}
        aria-label={label}
        aria-pressed={away}
        onPointerDown={stop}
        onMouseDown={stop}
        onKeyDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          if (away) revealSubTasks([issue.id]);
          setTasksPrefs({ opened: toggleOpened(opened, issue.id) });
        }}
      >
        <Icon name={away ? 'eyeOff' : 'eye'} size={12} />
        {away ? <span>{n}</span> : null}
      </button>
    </Tip>
  );
}

/** Right-click (and ⋯) on a task: open it, its worktree, start one (or reopen a finished one), change it, copy, delete. */
export function useIssueMenu(): (issue: Issue) => ActionItem[] {
  const { api, act, open, openWorktree } = useTaskActions();
  const { client } = useBeluga();
  const projects = useApp((s) => s.projects);
  const team = useApp((s) => s.team);
  const friends = useApp((s) => s.network.friends);
  /** Your chat with a teammate, the task in the box (BLG-263: you ask, nothing is given to their Claude). */
  const askIn = (issue: Issue): ActionItem[] => {
    const mates = teammatesOf(team, issue.projectId).filter((m) => friends.some((f) => f.peerId === m.peerId));
    if (!mates.length) return [];
    const go = (peerId: string, text: string): void => {
      draftIn(`dm:${peerId}`, text);
      client.store.dispatch({ type: 'view', view: { kind: 'conversation', id: `dm:${peerId}` } });
    };
    return [
      {
        label: 'Ask in a Chat',
        icon: 'chat',
        separate: true,
        submenu: mates.flatMap((m) => [
          { label: `${m.name}’s Claude`, hint: `@claude:… @${issue.key}`, onSelect: () => go(m.peerId, askAboutTask(issue.key, m.name, true)) },
          { label: m.name, hint: `@${issue.key}`, onSelect: () => go(m.peerId, askAboutTask(issue.key, m.name, false)) },
        ]),
        onSelect: () => undefined,
      },
    ];
  };
  return (issue) => {
    // Only a worktree that's still here (an archived one can be restored from its page): its own, or one carrying its work.
    const worktree = worktreeDoing(issue, (id) => projects.some((p) => p.workspaces.some((w) => w.id === id && !w.archived)));
    const startable = isStartable(issue);
    // Archived: its words to read, back out of the Archive, or gone for good.
    if (isArchived(issue)) {
      return [
        { label: 'Open', icon: 'task', onSelect: () => open(issue) },
        { label: 'Restore from Archive', icon: 'refresh', separate: true, onSelect: () => void act(() => api.unarchive(issue.id), `${issue.key} is back on the board`) },
        { label: 'Copy Key', icon: 'copy', separate: true, hint: issue.key, onSelect: () => void copyText(issue.key).then(() => toast(client, `Copied ${issue.key}`, 'success')) },
        { label: 'Delete for Good…', danger: true, separate: true, onSelect: () => confirmDelete(issue, () => void act(() => api.remove(issue.id), `Deleted ${issue.key}`)) },
      ];
    }
    return [
      { label: 'Open', icon: 'task', onSelect: () => open(issue) },
      ...(worktree
        ? [{ label: 'Open Worktree', icon: 'branch' as const, onSelect: () => openWorktree(worktree) }]
        : startable
          ? [
              { label: 'Start', icon: 'play' as const, hint: 'A new worktree, Claude working on it', onSelect: () => void act(() => api.start(issue.id, { claude: true })) },
              { label: 'Start Worktree Only', icon: 'branch' as const, hint: 'Without Claude', onSelect: () => void act(() => api.start(issue.id, {})) },
            ]
          : []),
      // Finished (or canceled) work starts again only deliberately: back to Ready, then Start.
      ...(startable ? [] : [{ label: 'Reopen the Task', icon: 'refresh' as const, onSelect: () => void act(() => api.update(issue.id, { status: 'todo' }), `Reopened ${issue.key}`) }]),
      ...askIn(issue),
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
      ...(isOpen(issue.status) ? [] : [{ label: 'Archive', icon: 'archive' as const, hint: 'Off the board; its proof files let go', onSelect: () => void act(() => api.archive(issue.id), `Archived ${issue.key}`) }]),
      { label: 'Copy Key', icon: 'copy', separate: true, hint: issue.key, onSelect: () => void copyText(issue.key).then(() => toast(client, `Copied ${issue.key}`, 'success')) },
      { label: 'Copy Title and Key', onSelect: () => void copyText(`${issue.key} ${issue.title}`).then(() => toast(client, 'Copied', 'success')) },
      { label: 'Delete Task…', danger: true, onSelect: () => confirmDelete(issue, () => void act(() => api.remove(issue.id), `Deleted ${issue.key}`)) },
    ];
  };
}

function confirmDelete(issue: Issue, run: () => void): void {
  openSheet({
    kind: 'confirm',
    title: `Delete ${issue.key}?`,
    message: `“${issue.title}”, its brief and its history go away. Its sub-tasks stay, as tasks of their own. Its worktree isn't touched.`,
    confirm: 'Delete Task',
    destructive: true,
    run,
  });
}

/** Done's one click: every Done task in the project to the Archive (shown while there are any). */
export function ArchiveDoneButton({ projectId }: { projectId?: string }) {
  const { api, act } = useTaskActions();
  const n = useApp((s) => doneCount(s.board, projectId));
  if (!n || !projectId) return null;
  return <IconButton icon="archive" label={`Archive ${n} Done ${n === 1 ? 'Task' : 'Tasks'}`} onClick={() => void act(() => api.archiveDone(projectId), `Archived ${n} done ${n === 1 ? 'task' : 'tasks'}: they’re in the Archive`)} />;
}
