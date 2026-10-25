import { type BoardState, type Issue, isOpen, taskForGitHub } from '../board/model.js';
import type { GitHubRepo } from '../../workspaces/github.js';

/**
 * A project's GitHub issues, as the screens see them (read through gh by core/issues/issues.ts),
 * and how far Beluga has got with each: nothing yet, a task on the board, Claude finding out why,
 * Claude fixing it, its pull request, done. Browser-safe: the Mac app runs it.
 */

export type GhIssueState = 'open' | 'closed';

/** Why a closed issue closed (GitHub's state_reason). */
export type GhCloseReason = 'completed' | 'not_planned' | 'duplicate';

export interface GhLabel {
  readonly name: string;
  /** GitHub's colour, without the # ("d73a4a"). */
  readonly color: string;
}

/** An issue as the list shows it. */
export interface GhIssue {
  readonly number: number;
  readonly title: string;
  readonly state: GhIssueState;
  readonly reason?: GhCloseReason;
  readonly url: string;
  /** Their GitHub login. */
  readonly author?: string;
  readonly labels: readonly GhLabel[];
  readonly assignees: readonly string[];
  readonly comments: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt?: number;
}

export interface GhComment {
  readonly author?: string;
  /** Markdown. */
  readonly body: string;
  readonly createdAt: number;
  readonly url: string;
}

/** One issue in full: what it says, and what people said about it since. */
export interface GhIssueFull extends GhIssue {
  /** Markdown. */
  readonly body: string;
  readonly thread: readonly GhComment[];
  /** There are more comments than were read. */
  readonly moreComments?: boolean;
}

/** What asking for a project's issues gives. */
export type IssuesList =
  /** The project isn't on GitHub (no remote, or another host). */
  | { readonly kind: 'none' }
  /** The GitHub CLI isn't installed or signed in (Connect GitHub). */
  | { readonly kind: 'no_gh'; readonly repo: GitHubRepo }
  /** GitHub didn't answer, or refused (gh's own words, which never hold a token). */
  | { readonly kind: 'error'; readonly repo: GitHubRepo; readonly message: string }
  | { readonly kind: 'github'; readonly repo: GitHubRepo; readonly issues: readonly GhIssue[]; /** More than were read: narrow it with search. */ readonly more: boolean; readonly fetchedAt: number };

export interface IssuesQuery {
  readonly state?: GhIssueState;
  /** GitHub's search words ("login 500", "label:bug"). */
  readonly search?: string;
  /** Ask GitHub again rather than use what was read a moment ago. */
  readonly force?: boolean;
}

/** "owner/repo". */
export const repoSlug = (repo: Pick<GitHubRepo, 'owner' | 'repo'>): string => `${repo.owner}/${repo.repo}`;

/** The task made from an issue of this repository, if there is one. */
export const taskForIssue = (board: Pick<BoardState, 'issues'>, projectId: string, repo: Pick<GitHubRepo, 'owner' | 'repo'>, number: number): Issue | undefined => taskForGitHub(board, projectId, repoSlug(repo), number);

/**
 * How far Beluga has got with an issue, from its task (and whether that task's Claude is working
 * now): what its page offers next.
 */
export type IssueStage =
  /** Nothing yet: Investigate, Fix It or Make a Task. */
  | { readonly kind: 'new' }
  /** On the board, not started. */
  | { readonly kind: 'task'; readonly task: Issue }
  /** Claude is finding out why, in the task's worktree. */
  | { readonly kind: 'investigating'; readonly task: Issue; readonly ws: string }
  /** Claude found out (the brief says what): Fix It continues there. */
  | { readonly kind: 'investigated'; readonly task: Issue; readonly ws: string }
  /** Claude is fixing it (or was asked to and stopped before a pull request). */
  | { readonly kind: 'fixing'; readonly task: Issue; readonly ws: string; readonly working: boolean }
  /** Its pull request is open (or the task is in review). */
  | { readonly kind: 'review'; readonly task: Issue }
  /** The task is done or canceled. */
  | { readonly kind: 'closed'; readonly task: Issue };

/**
 * `live`: whether a worktree is still there (not archived); `working`: whether your Claude is busy
 * in a conversation (`ws:<id>`).
 */
export function issueStage(task: Issue | undefined, live: (wsId: string) => boolean, working: (wsId: string) => boolean): IssueStage {
  if (!task) return { kind: 'new' };
  if (!isOpen(task.status)) return { kind: 'closed', task };
  if (task.status === 'in_review' || task.status === 'in_plan' || task.pr?.state === 'OPEN') return { kind: 'review', task };
  const ws = [task.carriedBy, task.worktrees.at(-1)].find((w): w is string => Boolean(w && live(w)));
  if (!ws) return { kind: 'task', task };
  const busy = working(ws);
  if (task.github?.step === 'investigate') return busy ? { kind: 'investigating', task, ws } : { kind: 'investigated', task, ws };
  return { kind: 'fixing', task, ws, working: busy };
}

/** The stage in a few words, for a pill on the issue's row. */
export function stageWords(stage: IssueStage): { readonly label: string; readonly tone: 'muted' | 'claude' | 'info' | 'ok' | 'neutral' } | undefined {
  switch (stage.kind) {
    case 'new':
      return undefined;
    case 'task':
      return { label: stage.task.key, tone: 'neutral' };
    case 'investigating':
      return { label: 'Investigating', tone: 'claude' };
    case 'investigated':
      return { label: 'Ready to fix', tone: 'info' };
    case 'fixing':
      return { label: stage.working ? 'Fixing' : 'Being fixed', tone: 'claude' };
    case 'review':
      return { label: stage.task.pr ? `PR #${stage.task.pr.number}` : 'In review', tone: 'info' };
    case 'closed':
      return { label: stage.task.status === 'done' ? 'Done' : 'Canceled', tone: stage.task.status === 'done' ? 'ok' : 'muted' };
  }
}

/** Labels that only say how to triage on GitHub: they don't come along to the board. */
const TRIAGE = new Set(['good first issue', 'help wanted', 'question', 'duplicate', 'wontfix', "won't fix", 'invalid', 'triage', 'needs triage', 'stale']);

/** An issue's labels as the board's (lowercase, at most four, triage ones left out). */
export const boardLabels = (labels: readonly GhLabel[]): string[] =>
  [...new Set(labels.map((l) => l.name.trim().toLowerCase()).filter((l) => l && !TRIAGE.has(l)))].map((l) => l.slice(0, 32)).slice(0, 4);
