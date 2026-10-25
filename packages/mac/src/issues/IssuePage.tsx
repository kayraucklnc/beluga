import { forwardRef, useRef, useState } from 'react';
import { type Issue, STATUS_INFO } from '@beluga/core/board/model.js';
import { type GhIssueFull, type IssueStage, repoSlug } from '@beluga/core/issues/model.js';
import { issueBrief } from '@beluga/core/issues/prompts.js';
import type { GitHubRepo } from '@beluga/workspaces/github.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon, type IconName } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Avatar, Button, Empty, EmptyActions, IconButton, Tip, cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { LiveDot } from '../plans/marks.js';
import { PrChip, StatusIcon } from '../tasks/marks.js';
import { issueWayBack } from '../tasks/use-tasks.js';
import { useSwipeBack } from '../tasks/use-swipe-back.js';
import { SwipeBackEdge } from '../tasks/SwipeBackEdge.js';
import { agoWords, comments, lastReport, stateOf } from './issues-model.js';
import { GhLabelChip, IssueStateIcon, useIssueMenu } from './parts.js';
import { useIssue, useIssueActions, useIssueStage } from './use-issues.js';
import { useActions } from '../lib/actions.js';
import t from '../tasks/tasks.module.css';
import s from './issues.module.css';

/**
 * One GitHub issue: what it says and what people said since, and what Claude should do about it.
 * Nothing done yet: three choices (Investigate, Fix It, Make a Task). Once Claude is on it, the
 * same place shows how it's going: investigating, what it found (with Fix It, in the same
 * worktree), fixing, its pull request, done. Everything goes through the issue's task.
 */
export function IssuePage({ projectId, number }: { projectId: string; number: number }) {
  const { data, error, loading, refresh } = useIssue(projectId, number);
  const actions = useActions();
  if (!data) {
    if (error) {
      return (
        <Empty
          icon="alert"
          title={`Couldn’t read #${number}`}
          detail={error}
          action={
            <EmptyActions>
              <Button onClick={refresh}>Try Again</Button>
              <Button variant="quiet" onClick={() => actions.run({ type: 'view', view: issueWayBack(projectId) })}>
                Back
              </Button>
            </EmptyActions>
          }
        />
      );
    }
    return <Empty icon="issue" title="Asking GitHub…" detail={`For issue #${number}`} />;
  }
  return <Page projectId={projectId} repo={data.repo} issue={data.issue} loading={loading} refresh={refresh} />;
}

function Page({ projectId, repo, issue, loading, refresh }: { projectId: string; repo: GitHubRepo; issue: GhIssueFull; loading: boolean; refresh: () => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const actions = useActions();
  const back = (): void => actions.run({ type: 'view', view: issueWayBack(projectId) });
  const swipe = useSwipeBack(wrap, back);
  const stage = useIssueStage(projectId, repo, issue.number);
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const menu = useIssueMenu(projectId);
  const a = useIssueActions();
  const state = stateOf(issue);
  // What Claude found can go on GitHub as your comment (⋯), after you've seen what it says.
  const found = useFindings(stage, issue);
  const post: ActionItem[] = found
    ? [
        {
          label: 'Post the Findings on GitHub…',
          icon: 'send',
          hint: `As a comment from you on #${issue.number}`,
          onSelect: () =>
            openSheet({
              kind: 'confirm',
              title: `Post the findings on #${issue.number}?`,
              message: `What Claude found goes on GitHub as a comment from you, for everyone who can see the issue.\n\n${found.length > 600 ? `${found.slice(0, 600)}…` : found}`,
              confirm: 'Post Comment',
              run: () => void a.comment(projectId, issue.number, `**Findings**\n\n${found}`).then((url) => url && refresh()),
            }),
        },
      ]
    : [];
  return (
    <div ref={wrap} className={t.pageWrap}>
      <SwipeBackEdge progress={swipe} />
      <div className={t.page}>
        <div className={t.pageMain}>
          <nav className={t.crumbs} aria-label="Where this issue is">
            <IconButton icon="back" label="Back" keys="⌘[" className={t.crumbBack} onClick={back} />
            <button type="button" className={t.crumb} onClick={() => a.openList(projectId)}>
              Issues
            </button>
            <Icon name="chevronRight" size={10} />
            <span className={t.crumbPlain}>{project?.name ?? repoSlug(repo)}</span>
            <span className={t.grow} />
            <span className={t.pageKey}>#{issue.number}</span>
            <IconButton icon="refresh" label={loading ? 'Asking GitHub…' : 'Ask GitHub Again'} className={cx(loading && s.spinning)} onClick={refresh} />
            <ActionsDropdown items={[...post, ...menu(issue, stage, { open: false })]}>
              <IconButton icon="more" label="More" />
            </ActionsDropdown>
          </nav>
          <header className={t.pageHead}>
            <h1 className={s.pageTitle}>{issue.title}</h1>
            <div className={s.byline}>
              <span className={cx(s.statePill, s[`statePill_${state.tone}`])}>
                <IssueStateIcon issue={issue} size={13} />
                {state.label}
              </span>
              <span>
                {issue.author ? <strong>{issue.author}</strong> : 'Someone'} opened this {agoWords(issue.createdAt)}
                {issue.comments ? ` · ${comments(issue.comments)}` : ''}
              </span>
            </div>
            <NextStep projectId={projectId} issue={issue} stage={stage} />
          </header>
          <section className={s.thread} aria-label="The issue and its comments">
            <Post author={issue.author} at={issue.createdAt} what="opened this" body={issue.body} url={issue.url} />
            {issue.thread.map((c, i) => (
              <Post key={`${c.url}-${i}`} author={c.author} at={c.createdAt} what="commented" body={c.body} url={c.url} />
            ))}
            {issue.moreComments || issue.thread.length < issue.comments ? (
              <button type="button" className={s.moreComments} onClick={() => actions.openLink({ kind: 'url', url: issue.url })}>
                {issue.comments - issue.thread.length} more on GitHub
                <Icon name="external" size={11} />
              </button>
            ) : null}
          </section>
        </div>
        <Properties repo={repo} issue={issue} stage={stage} />
      </div>
    </div>
  );
}

/** What Claude found: the task's context, once it's more than the report it started from. */
function findingsOf(task: Issue, issue: GhIssueFull): string | undefined {
  const context = task.brief.context?.trim();
  return context && context !== issueBrief(issue).context.trim() ? context : undefined;
}

/**
 * What Claude found, to show and to post: its report in the conversation (what happens, why, how
 * to fix it, a verdict), else what it wrote in the task's brief. Only once it has investigated.
 */
function useFindings(stage: IssueStage, issue: GhIssueFull): string | undefined {
  const ws = stage.kind === 'investigated' || stage.kind === 'investigating' || stage.kind === 'fixing' ? stage.ws : undefined;
  const report = useApp((st) => (ws && stage.kind === 'investigated' ? lastReport(st.log, `ws:${ws}`) : undefined));
  if (stage.kind === 'new' || stage.kind === 'investigating') return undefined;
  return report ?? findingsOf(stage.task, issue);
}

/** What to do next, or how it's going: the one place on the page that changes as Claude works. */
function NextStep({ projectId, issue, stage }: { projectId: string; issue: GhIssueFull; stage: IssueStage }) {
  const a = useIssueActions();
  const [busy, setBusy] = useState<'investigate' | 'fix' | 'task' | 'look'>();
  const run = async (what: NonNullable<typeof busy>, job: () => Promise<unknown>): Promise<void> => {
    setBusy(what);
    await job();
    setBusy(undefined);
  };
  const n = issue.number;
  const ws = useApp((st) => (stage.kind === 'investigating' || stage.kind === 'investigated' || stage.kind === 'fixing' ? findWorkspace(st.projects, stage.ws) : undefined));
  const found = useFindings(stage, issue);
  // Stopped while fixing: what it said (why there's no pull request).
  const said = useApp((st) => (stage.kind === 'fixing' && !stage.working ? lastReport(st.log, `ws:${stage.ws}`) : undefined));

  if (stage.kind === 'new' || stage.kind === 'task') {
    const task = stage.kind === 'task' ? stage.task : undefined;
    return (
      <section className={s.next} aria-label="What should Claude do?">
        <h2 className={s.nextTitle}>{task ? `${task.key} is on the board · what should Claude do?` : 'What should Claude do?'}</h2>
        <div className={s.choices}>
          <Choice icon="search" tone="info" title="Investigate" busy={busy === 'investigate'} disabled={Boolean(busy)} onClick={() => void run('investigate', () => a.investigate(projectId, n))}>
            Find out why it happens and reproduce it, in a worktree. Nothing is fixed yet.
          </Choice>
          <Choice icon="wrench" tone="claude" title="Fix It" busy={busy === 'fix'} disabled={Boolean(busy)} onClick={() => void run('fix', () => a.fix(projectId, n))}>
            Fix it in a new worktree, then open a pull request that closes #{n}.
          </Choice>
          {task ? (
            <Choice icon="task" tone="merged" title={`Open ${task.key}`} onClick={() => a.openTask(task.id)}>
              {task.drafting ? 'Claude is still writing it up.' : `${STATUS_INFO[task.status].label}: its brief, and everything that happens to it.`}
            </Choice>
          ) : (
            <ActionsDropdown
              align="end"
              items={[
                { label: 'From the Issue', icon: 'task', hint: 'Claude writes the title, goal and criteria from what it says', onSelect: () => void run('task', () => a.toTask(projectId, n)) },
                { label: 'After a Quick Look at the Code', icon: 'search', hint: 'Claude reads the code first (read-only), and adds where it is and the likely cause', onSelect: () => void run('look', () => a.toTask(projectId, n, true)) },
              ]}
            >
              <Choice icon="task" tone="merged" title="Make a Task" menu busy={busy === 'task' || busy === 'look'} disabled={Boolean(busy)}>
                Put it on the board, written up by Claude, to do later.
              </Choice>
            </ActionsDropdown>
          )}
        </div>
      </section>
    );
  }

  const task = stage.task;
  const taskButton = (
    <Button size="small" icon="task" onClick={() => a.openTask(task.id)}>
      Open {task.key}
    </Button>
  );
  const chatButton = (primary: boolean) =>
    ws ? (
      <Button size="small" variant={primary ? 'primary' : 'plain'} icon="chat" onClick={() => a.openWorktree(ws.id)}>
        Open the Conversation
      </Button>
    ) : null;
  const where = ws ? (
    <span className={t.nextInfo}>
      in <span className={t.mono}>{ws.name}</span>
    </span>
  ) : null;

  if (stage.kind === 'investigating') {
    return (
      <Status icon={<LiveDot />} title="Claude is investigating" where={where} tone="claude" text={`Finding out why it happens and reproducing it. What it finds goes into ${task.key}’s brief; nothing is fixed yet.`}>
        <div className={s.statusActions}>
          {chatButton(true)}
          {taskButton}
        </div>
      </Status>
    );
  }

  if (stage.kind === 'investigated') {
    return (
      <Status icon={<Icon name="search" size={13} />} title="Claude investigated" where={where} tone="info" text={found ? undefined : 'Its report is in the conversation.'}>
        {found ? <Report text={found} /> : null}
        <div className={s.statusActions}>
          <Button variant="primary" size="small" icon="wrench" disabled={busy === 'fix'} onClick={() => void run('fix', () => a.fix(projectId, n))}>
            {busy === 'fix' ? 'Asking Claude…' : 'Fix It'}
          </Button>
          <span className={t.nextInfo}>In the same worktree, with a pull request that closes #{n}</span>
          <span className={t.grow} />
          {chatButton(false)}
          {taskButton}
        </div>
      </Status>
    );
  }

  if (stage.kind === 'fixing') {
    return (
      <Status
        icon={stage.working ? <LiveDot /> : <Icon name="wrench" size={13} />}
        title={stage.working ? 'Claude is fixing it' : 'Claude stopped before a pull request'}
        where={where}
        tone="claude"
        text={stage.working ? `Its pull request closes #${n} when it merges.` : said ? undefined : 'See what it said in the conversation: it may need you, or it may not be a bug.'}
      >
        {said ? <Report text={said} /> : null}
        <div className={s.statusActions}>
          {chatButton(true)}
          {taskButton}
        </div>
      </Status>
    );
  }

  if (stage.kind === 'review') {
    const pr = task.pr;
    return (
      <Status icon={<StatusIcon status="in_review" size={13} />} title={pr ? 'Its pull request is open' : 'In review'} tone="info" text={`Merging it closes #${n} and finishes ${task.key}.`}>
        <div className={s.statusActions}>
          {pr ? (
            <Button variant="primary" size="small" icon="pr" onClick={() => a.openOnGitHub(pr.url)}>
              Open Pull Request #{pr.number}
            </Button>
          ) : null}
          {pr ? <PrChip pr={pr} /> : null}
          <span className={t.grow} />
          {taskButton}
        </div>
      </Status>
    );
  }

  return (
    <Status icon={<StatusIcon status={task.status} size={13} />} title={task.status === 'done' ? `Done in ${task.key}` : `${task.key} was canceled`} tone={task.status === 'done' ? 'ok' : 'muted'} text={task.status === 'done' ? (issue.state === 'open' ? 'Its pull request closes the issue on GitHub when it merges, or close it there.' : undefined) : 'Reopen it on its page to work on the issue again.'}>
      <div className={s.statusActions}>
        {task.pr ? <PrChip pr={task.pr} /> : null}
        <span className={t.grow} />
        {taskButton}
      </div>
    </Status>
  );
}

interface ChoiceProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  readonly icon: IconName;
  readonly tone: 'info' | 'claude' | 'merged';
  readonly title: string;
  readonly busy?: boolean;
  /** It opens a menu (Make a Task's two ways). */
  readonly menu?: boolean;
}

/** One of the three choices: an icon in a soft tint, what it does, and its words. (A menu's trigger too: it forwards its ref.) */
const Choice = forwardRef<HTMLButtonElement, ChoiceProps>(function Choice({ icon, tone, title, children, busy, disabled, menu, className, ...rest }, ref) {
  return (
    <button ref={ref} type="button" {...rest} className={cx(s.choice, s[`tone_${tone}`], className)} disabled={disabled && !busy} aria-busy={busy || undefined} data-choice={title}>
      <span className={s.choiceIcon}>
        <Icon name={icon} size={15} />
      </span>
      <span className={s.choiceTitle}>
        {busy ? 'Asking Claude…' : title}
        {menu ? <Icon name="chevronDown" size={10} /> : null}
      </span>
      <span className={s.choiceText}>{children}</span>
    </button>
  );
});

/** How it's going, in a soft card: what Claude is at, where, and what you can do. */
function Status({ icon, title, where, tone, text, children }: { icon: React.ReactNode; title: string; where?: React.ReactNode; tone: 'claude' | 'info' | 'ok' | 'muted'; text?: string; children: React.ReactNode }) {
  return (
    <section className={cx(s.status, s[`tone_${tone}`])} aria-label={title} data-testid="issue-status">
      <div className={s.statusHead}>
        <span className={s.statusIcon}>{icon}</span>
        <strong>{title}</strong>
        {where}
      </div>
      {text ? <p className={s.statusText}>{text}</p> : null}
      {children}
    </section>
  );
}

/** What Claude said (its report, or the task's context), folded when it's long. */
function Report({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 900 || text.split('\n').length > 16;
  return (
    <>
      <div className={cx(s.findings, long && !open && s.findingsFolded)}>
        <Markdown text={text} paths tasks />
      </div>
      {long ? (
        <button type="button" className={s.findingsMore} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Show Less' : 'Show All'}
        </button>
      ) : null}
    </>
  );
}

/** The issue's description or a comment: who, when, and what they wrote. */
function Post({ author, at, what, body, url }: { author: string | undefined; at: number; what: string; body: string; url: string }) {
  const actions = useActions();
  return (
    <article className={s.post}>
      <header className={s.postHead}>
        <Avatar name={author ?? '?'} id={`gh:${author ?? ''}`} size={20} />
        <strong>{author ?? 'Someone'}</strong>
        <span>
          {what} {agoWords(at)}
        </span>
        <span className={t.grow} />
        <Tip label="Open on GitHub">
          <button type="button" className={s.postLink} aria-label="Open on GitHub" onClick={() => actions.openLink({ kind: 'url', url })}>
            <Icon name="external" size={11} />
          </button>
        </Tip>
      </header>
      <div className={s.postBody}>{body.trim() ? <Markdown text={body} /> : <p className={s.none}>No description.</p>}</div>
    </article>
  );
}

/** The right column: the issue's facts, and its task. */
function Properties({ repo, issue, stage }: { repo: GitHubRepo; issue: GhIssueFull; stage: IssueStage }) {
  const a = useIssueActions();
  const task = stage.kind === 'new' ? undefined : stage.task;
  const state = stateOf(issue);
  return (
    <aside className={t.props} aria-label="Properties">
      <Prop label="State">
        <span className={cx(t.propStatic, s.propState, s[`propState_${state.tone}`])}>
          <IssueStateIcon issue={issue} size={13} />
          {state.label}
        </span>
      </Prop>
      <Prop label="Task">
        {task ? (
          <button type="button" className={t.propValue} onClick={() => a.openTask(task.id)}>
            <StatusIcon status={task.status} />
            <span className={t.ellipsis}>{task.key}</span>
          </button>
        ) : (
          <span className={t.propStatic}>None yet</span>
        )}
      </Prop>
      <Prop label="Labels">
        <div className={t.propLabels}>{issue.labels.length ? issue.labels.map((l) => <GhLabelChip key={l.name} label={l} />) : <span className={t.propStatic}>None</span>}</div>
      </Prop>
      <Prop label="Assignees">
        <span className={t.propStatic}>{issue.assignees.length ? issue.assignees.join(', ') : 'No one'}</span>
      </Prop>
      <div className={t.propsRule} />
      <Prop label="Opened" quiet>
        <span className={t.propStatic}>{agoWords(issue.createdAt)}</span>
      </Prop>
      <Prop label="Updated" quiet>
        <span className={t.propStatic}>{agoWords(issue.updatedAt)}</span>
      </Prop>
      {issue.closedAt ? (
        <Prop label="Closed" quiet>
          <span className={t.propStatic}>{agoWords(issue.closedAt)}</span>
        </Prop>
      ) : null}
      <Prop label="GitHub" quiet>
        <Tip label={`Open #${issue.number} on GitHub`}>
          <button type="button" className={t.propValue} onClick={() => a.openOnGitHub(issue.url)}>
            <span className={cx(t.mono, t.ellipsis)}>
              {repoSlug(repo)}#{issue.number}
            </span>
            <Icon name="external" size={11} />
          </button>
        </Tip>
      </Prop>
    </aside>
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
