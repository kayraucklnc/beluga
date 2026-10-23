import { useEffect, useRef, useState } from 'react';
import { type Issue, PRIORITY_INFO, STATUS_INFO, actorName, assigneeName, isFinished, issueById } from '@beluga/core/board/model.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp } from '../lib/beluga.js';
import { usePlanActions } from '../plans/use-plans.js';
import { ActivityFeed } from './Activity.js';
import { Brief } from './Brief.js';
import { AssigneeMark, LabelChip, PrChip, PriorityIcon, StatusIcon } from './marks.js';
import { useIssueMenu } from './parts.js';
import { AssigneePicker, LabelsPicker, PriorityPicker, StatusPicker, TaskPicker } from './pickers.js';
import { ProofList, Relations, SubTasks } from './TaskSections.js';
import { unexplained } from '@beluga/core/board/criteria.js';
import { ago, dueText } from './tasks-model.js';
import { useBoard, useSelfId, useSolo, useTaskActions } from './use-tasks.js';
import { useSwipeBack } from './use-swipe-back.js';
import { SwipeBackEdge } from './SwipeBackEdge.js';
import t from './tasks.module.css';

/**
 * One task: its title (click to rename), what to do next (start a worktree with Claude on it, or
 * open the one doing it), the brief, sub-tasks, what waits on what, proof and everything that
 * happened, with its properties down the right.
 */
export function TaskPage({ id }: { id: string }) {
  const board = useBoard();
  const issue = issueById(board, id);
  if (!board.enabled) return <Empty icon="task" title="Tasks need the Beluga app" />;
  if (!issue) return <Empty icon="task" title="This task isn’t here anymore" detail="It may have been deleted." />;
  return <IssuePage issue={issue} />;
}

/**
 * The page itself. Getting back out is always at hand (BLG-5): the header with Back stays at the
 * top while the page scrolls, and a two-finger swipe right, ⌘[ or Esc go back too.
 */
function IssuePage({ issue }: { issue: Issue }) {
  const wrap = useRef<HTMLDivElement>(null);
  const { back } = useTaskActions();
  const swipe = useSwipeBack(wrap, () => back(issue.projectId));
  const proofFirst = isFinished(issue.status) && issue.proof.length > 0;
  return (
    <div ref={wrap} className={t.pageWrap}>
    <SwipeBackEdge progress={swipe} />
    <div className={t.page}>
      <div className={t.pageMain}>
        <Header issue={issue} />
        {/* Finished work: what shows it works comes first (BLG-13). */}
        {proofFirst ? <ProofList issue={issue} /> : null}
        <Brief issue={issue} />
        <SubTasks issue={issue} />
        <Relations issue={issue} />
        {proofFirst ? null : <ProofList issue={issue} />}
        <section className={t.block} aria-label="Activity">
          <header className={t.blockHead}>
            <h3 className={t.sectionTitle}>Activity</h3>
          </header>
          <ActivityFeed issue={issue} />
        </section>
      </div>
      <Properties issue={issue} />
    </div>
    </div>
  );
}

function Header({ issue }: { issue: Issue }) {
  const board = useBoard();
  const project = useApp((s) => s.projects.find((p) => p.id === issue.projectId));
  const parent = issue.parent ? issueById(board, issue.parent) : undefined;
  const { open, openList, back } = useTaskActions();
  const menu = useIssueMenu();
  // The bar is the page's own child (not the header's), so it stays at the top all the way down.
  return (
    <>
      <nav className={t.crumbs} aria-label="Where this task is">
        <IconButton icon="back" label="Back" keys="⌘[" className={t.crumbBack} onClick={() => back(issue.projectId)} />
        <button type="button" className={t.crumb} onClick={() => openList(issue.projectId)}>
          Tasks
        </button>
        <Icon name="chevronRight" size={10} />
        <span className={t.crumbPlain}>{project?.name ?? 'Project'}</span>
        {parent ? (
          <>
            <Icon name="chevronRight" size={10} />
            <button type="button" className={t.crumb} onClick={() => open(parent)}>
              {parent.key} {parent.title}
            </button>
          </>
        ) : null}
        <span className={t.grow} />
        <span className={t.pageKey}>{issue.key}</span>
        <ActionsDropdown items={menu(issue).filter((i) => i.label !== 'Open')}>
          <IconButton icon="more" label="More" />
        </ActionsDropdown>
      </nav>
      <header className={t.pageHead}>
        <Title issue={issue} />
        <GoneBanner issue={issue} />
        <ChecksBanner issue={issue} />
        <NextStep issue={issue} />
      </header>
    </>
  );
}

/** The title, renamed in place (Return saves, Esc puts it back). */
function Title({ issue }: { issue: Issue }) {
  const [draft, setDraft] = useState<string>();
  const { api, act } = useTaskActions();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, issue.title]);
  const save = (): void => {
    const next = draft?.replace(/\s+/g, ' ').trim();
    setDraft(undefined);
    if (next && next !== issue.title) void act(() => api.update(issue.id, { title: next }));
  };
  return (
    <textarea
      ref={input}
      className={t.pageTitle}
      value={draft ?? issue.title}
      rows={1}
      aria-label="Title"
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(undefined);
          requestAnimationFrame(() => input.current?.blur());
        }
      }}
    />
  );
}

/** Kept out of review: which criteria still need a tick or a reason. */
function ChecksBanner({ issue }: { issue: Issue }) {
  if (!issue.needsChecks || !STATUS_INFO[issue.status].open) return null;
  const open = unexplained(issue.brief.acceptance);
  if (!open.length) return null;
  return (
    <div className={t.banner} role="status">
      <Icon name="alert" size={14} />
      <span className={t.bannerText}>
        <strong>Needs its checks.</strong> {open.length === 1 ? 'A criterion is' : `${open.length} criteria are`} neither ticked nor explained, so it stays out of review: tick each one, or add “— deferred: why” after it.
      </span>
    </div>
  );
}

/** Its worktree was archived or deleted before it was done: what now? */
function GoneBanner({ issue }: { issue: Issue }) {
  const { api, act } = useTaskActions();
  if (!issue.worktreeGone) return null;
  return (
    <div className={t.banner} role="status">
      <Icon name="archive" size={14} />
      <span className={t.bannerText}>Its worktree was put away before the task was done.</span>
      <Button size="small" variant="quiet" onClick={() => void act(() => api.settleGone(issue.id, 'keep'))}>
        Keep As Is
      </Button>
      <Button size="small" onClick={() => void act(() => api.settleGone(issue.id, 'backlog'))}>
        Back to Backlog
      </Button>
      <Button size="small" onClick={() => void act(() => api.settleGone(issue.id, 'canceled'))}>
        Cancel Task
      </Button>
    </div>
  );
}

/**
 * The worktree a task has (or had): the last one that did it, even once it's archived or its work
 * finished (BLG-13). `had`: some worktree did it (perhaps since removed): that's where its work is,
 * so the page offers no Start (starting afresh is ⋯ › Start).
 */
function useTaskWorktree(issue: Issue): { readonly ws: Workspace | undefined; readonly live: Workspace | undefined; readonly had: boolean } {
  const last = issue.worktrees.at(-1);
  const ws = useApp((s) => (last ? findWorkspace(s.projects, last) : undefined));
  const live = ws && !ws.archived ? ws : undefined;
  const had = Boolean(ws) || issue.worktrees.length > 0 || issue.activity.some((a) => a.kind === 'worktree');
  return { ws, live, had };
}

/** Where a task's work is: its worktree (open it, reveal its folder in Finder), or what became of it. */
function WorktreeLinks({ issue, ws, live }: { issue: Issue; ws: Workspace | undefined; live: Workspace | undefined }) {
  const { openWorktree } = useTaskActions();
  const api = useApi();
  if (live) {
    return (
      <>
        <Button variant="primary" size="small" icon="branch" onClick={() => openWorktree(live.id)}>
          Open Worktree
        </Button>
        <Button size="small" variant="quiet" icon="folder" onClick={() => void api.workspaces.openInFinder(live.id)}>
          Reveal Folder
        </Button>
        <span className={t.nextInfo}>
          <span className={t.mono}>{live.name}</span>
          {issue.branch ? <span className={t.nextBranch}>on {issue.branch}</span> : null}
        </span>
      </>
    );
  }
  // Archived: its conversation is still there (it's restored from there); removed: its branch is what's left.
  return (
    <>
      {ws ? (
        <Button size="small" icon="chat" onClick={() => openWorktree(ws.id)}>
          Open the Conversation
        </Button>
      ) : null}
      <span className={t.nextInfo}>
        {ws ? (
          <>
            <span className={t.mono}>{ws.name}</span> is archived
          </>
        ) : (
          'Its worktree was removed'
        )}
        {issue.branch ? <span className={t.nextBranch}>on {issue.branch}</span> : null}
      </span>
    </>
  );
}

/** What to do next: open the worktree doing it (and its pull request), or start one; finished work shows how it ended. */
function NextStep({ issue }: { issue: Issue }) {
  const { api, act } = useTaskActions();
  const { ws, live, had } = useTaskWorktree(issue);
  const [starting, setStarting] = useState(false);
  const start = async (claude: boolean): Promise<void> => {
    setStarting(true);
    await act(() => api.start(issue.id, { claude }));
    setStarting(false);
  };
  if (isFinished(issue.status)) return <Outcome issue={issue} ws={ws} live={live} />;
  if (!STATUS_INFO[issue.status].open && !live) return null;
  return (
    <div className={t.nextStep}>
      {had ? (
        <WorktreeLinks issue={issue} ws={ws} live={live} />
      ) : (
        <>
          <Button variant="primary" size="small" icon="claude" disabled={starting} onClick={() => void start(true)}>
            Start with Claude
          </Button>
          <Button size="small" icon="branch" disabled={starting} onClick={() => void start(false)}>
            Start Worktree
          </Button>
          <span className={t.nextInfo}>A new worktree from the latest origin{issue.brief.goal ? ', and Claude reads this brief' : ''}</span>
        </>
      )}
      <span className={t.grow} />
      {issue.pr ? <PrLink pr={issue.pr} /> : null}
    </div>
  );
}

/**
 * A finished task (in review, merged into its plan, or shipped): what happened, where its work is
 * (branch, its worktree and folder, pull request, plan) and its conversation, to look at it or
 * ask it things still. Starting again is ⋯ › Reopen the Task.
 */
function Outcome({ issue, ws, live }: { issue: Issue; ws: Workspace | undefined; live: Workspace | undefined }) {
  const { openWorktree } = useTaskActions();
  const api = useApi();
  const plan = useApp((s) => (issue.plan ? s.plans.plans.find((p) => p.id === issue.plan!.id) : undefined));
  const { open: openPlan } = usePlanActions();
  const what =
    issue.status === 'in_review'
      ? issue.pr ? 'In review · its pull request is open' : 'In review'
      : issue.status === 'in_plan'
        ? 'Merged into the plan · ships with the plan’s pull request'
        : plan ? 'Done · shipped with the plan' : 'Done';
  const pr = issue.status === 'in_plan' ? (plan?.pr ?? issue.pr) : issue.pr;
  return (
    <div className={t.nextStep} data-testid="task-outcome">
      <span className={t.outcome}>
        <StatusIcon status={issue.status} />
        {what}
      </span>
      {issue.branch ? <span className={t.mono}>{issue.branch}</span> : null}
      <span className={t.grow} />
      {pr ? <PrLink pr={pr} /> : null}
      {plan ? (
        <Button size="small" variant="quiet" icon="graph" onClick={() => openPlan(plan.id)}>
          Open the Plan
        </Button>
      ) : null}
      {live ? (
        <>
          <Button size="small" variant="quiet" icon="folder" onClick={() => void api.workspaces.openInFinder(live.id)}>
            Reveal Folder
          </Button>
          <Button size="small" icon="branch" onClick={() => openWorktree(live.id)}>
            Open Worktree
          </Button>
        </>
      ) : ws ? (
        <Button size="small" icon="chat" onClick={() => openWorktree(ws.id)}>
          Open the Conversation
        </Button>
      ) : null}
    </div>
  );
}

function PrLink({ pr }: { pr: NonNullable<Issue['pr']> }) {
  const actions = useActions();
  return (
    <button type="button" className={t.prLink} onClick={() => actions.openLink({ kind: 'url', url: pr.url })}>
      <PrChip pr={pr} />
      <span className={t.prTitle}>{pr.title}</span>
      <Icon name="external" size={11} />
    </button>
  );
}

/** The right column: every property, each one a menu. */
function Properties({ issue }: { issue: Issue }) {
  const board = useBoard();
  const solo = useSolo(issue.projectId);
  const selfId = useSelfId();
  const { api, act, open } = useTaskActions();
  const project = useApp((s) => s.projects.find((p) => p.id === issue.projectId));
  const parent = issue.parent ? issueById(board, issue.parent) : undefined;
  const due = issue.due ? dueText(issue.due) : undefined;
  const parents = board.issues.filter((i) => i.id !== issue.id && i.projectId === issue.projectId && i.parent !== issue.id);
  return (
    <aside className={t.props} aria-label="Properties">
      <Prop label="Status">
        <StatusPicker issue={issue} align="end">
          <button type="button" className={t.propValue}>
            <StatusIcon status={issue.status} />
            {STATUS_INFO[issue.status].label}
          </button>
        </StatusPicker>
      </Prop>
      <Prop label="Priority">
        <PriorityPicker issue={issue} align="end">
          <button type="button" className={t.propValue}>
            <PriorityIcon priority={issue.priority} />
            {PRIORITY_INFO[issue.priority].label}
          </button>
        </PriorityPicker>
      </Prop>
      {solo ? null : <Prop label="Assignee">
        <AssigneePicker value={issue.assignee} onChange={(a) => void act(() => api.update(issue.id, { assignee: a }))} align="end">
          <button type="button" className={t.propValue}>
            <AssigneeMark assignee={issue.assignee} selfId={selfId} size={16} />
            {assigneeName(issue.assignee, selfId)}
          </button>
        </AssigneePicker>
      </Prop>}
      <Prop label="Labels">
        <div className={t.propLabels}>
          {issue.labels.map((l) => (
            <LabelChip key={l} label={l} onRemove={() => void act(() => api.update(issue.id, { labels: issue.labels.filter((x) => x !== l) }))} />
          ))}
          <LabelsPicker issue={issue} align="end">
            <button type="button" className={cx(t.propValue, t.propAdd)}>
              <Icon name="plus" size={11} />
              {issue.labels.length ? '' : 'Add Label'}
            </button>
          </LabelsPicker>
        </div>
      </Prop>
      <Prop label="Estimate">
        <div className={t.estimates} role="radiogroup" aria-label="Estimate">
          {[1, 2, 3, 5, 8].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={issue.estimate === n} className={cx(t.estimate, issue.estimate === n && t.estimateOn)} onClick={() => void act(() => api.update(issue.id, { estimate: issue.estimate === n ? null : n }))}>
              {n}
            </button>
          ))}
        </div>
      </Prop>
      <Prop label="Due">
        <DuePicker issue={issue} late={Boolean(due?.late && STATUS_INFO[issue.status].open)} text={due?.text} />
      </Prop>
      <Prop label="Parent">
        {parent ? (
          <div className={t.propRow}>
            <button type="button" className={t.propValue} onClick={() => open(parent)}>
              <StatusIcon status={parent.status} />
              <span className={t.ellipsis}>
                {parent.key} {parent.title}
              </span>
            </button>
            <IconButton icon="x" label="Make It a Task of Its Own" onClick={() => void act(() => api.update(issue.id, { parent: null }))} />
          </div>
        ) : (
          <TaskPicker label="Parent" candidates={parents} onPick={(p) => void act(() => api.update(issue.id, { parent: p.id }))} align="end">
            <button type="button" className={cx(t.propValue, t.propAdd)}>
              <Icon name="plus" size={11} />
              Set Parent
            </button>
          </TaskPicker>
        )}
      </Prop>
      <div className={t.propsRule} />
      <Prop label="Project" quiet>
        <span className={t.propStatic}>{project?.name ?? '—'}</span>
      </Prop>
      {issue.branch ? (
        <Prop label="Branch" quiet>
          <Tip label={issue.branch}>
            <span className={cx(t.propStatic, t.mono, t.ellipsis)}>{issue.branch}</span>
          </Tip>
        </Prop>
      ) : null}
      <Prop label="Created" quiet>
        <span className={t.propStatic}>
          {ago(issue.createdAt)} by {actorName(issue.createdBy, selfId)}
        </span>
      </Prop>
      <Prop label="Updated" quiet>
        <span className={t.propStatic}>{ago(issue.updatedAt)}</span>
      </Prop>
    </aside>
  );
}

/** A due date: the Mac's date picker from a plain button, and a way to clear it. */
function DuePicker({ issue, late, text }: { issue: Issue; late: boolean; text: string | undefined }) {
  const { api, act } = useTaskActions();
  const input = useRef<HTMLInputElement>(null);
  const pick = (): void => {
    const el = input.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };
  return (
    <div className={t.propRow}>
      <button type="button" className={cx(t.propValue, !issue.due && t.propAdd, late && t.dueLate)} onClick={pick}>
        <Icon name="calendar" size={12} />
        {issue.due ? `${new Date(`${issue.due}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} · ${text ?? ''}` : 'Set Due Date'}
      </button>
      {issue.due ? <IconButton icon="x" label="Remove the Due Date" onClick={() => void act(() => api.update(issue.id, { due: null }))} /> : null}
      <input ref={input} type="date" className={t.dateHidden} tabIndex={-1} aria-hidden="true" value={issue.due ?? ''} onChange={(e) => void act(() => api.update(issue.id, { due: e.target.value || null }))} />
    </div>
  );
}

function Prop({ label, children, quiet }: { label: string; children: React.ReactNode; quiet?: boolean }) {
  return (
    <div className={cx(t.prop, quiet && t.propStaticRow)}>
      <span className={t.propLabel}>{label}</span>
      <div className={t.propControl}>{children}</div>
    </div>
  );
}
