/**
 * Tasks (the board) in the shared state: issues per project, with a status, a priority, who it's
 * for, sub-tasks and blockers, the worktree and pull request doing it, a living brief Claude and
 * people keep true (with its revisions), proof and an activity feed. The code says "board" and
 * "issue" (the gateway's "tasks" are tasks between Claudes); the window says Tasks.
 * Browser-safe: the Mac app runs it. See docs/tasks-and-plans.md.
 */

export const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'in_plan', 'done', 'canceled'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export type StatusTone = 'muted' | 'neutral' | 'claude' | 'info' | 'ok' | 'error';

export const STATUS_INFO: Readonly<Record<IssueStatus, { readonly label: string; readonly tone: StatusTone; readonly open: boolean }>> = {
  backlog: { label: 'Backlog', tone: 'muted', open: true },
  todo: { label: 'Ready', tone: 'neutral', open: true },
  in_progress: { label: 'In Progress', tone: 'claude', open: true },
  in_review: { label: 'In Review', tone: 'info', open: true },
  /** A plan's task whose milestone passed: merged into the plan's branch, waiting for the plan's PR. */
  in_plan: { label: 'Merged into Plan', tone: 'info', open: true },
  done: { label: 'Done', tone: 'ok', open: false },
  canceled: { label: 'Canceled', tone: 'muted', open: false },
};

export const isOpen = (status: IssueStatus): boolean => STATUS_INFO[status].open;

/** Its work is finished (in review, merged into its plan, or shipped): nothing to start until it's reopened. */
export const isFinished = (status: IssueStatus): boolean => status === 'in_review' || status === 'in_plan' || status === 'done';

/** Linear's order: urgent first; "none" sorts last. */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_INFO: Readonly<Record<Priority, { readonly label: string; readonly rank: number }>> = {
  urgent: { label: 'Urgent', rank: 0 },
  high: { label: 'High', rank: 1 },
  medium: { label: 'Medium', rank: 2 },
  low: { label: 'Low', rank: 3 },
  none: { label: 'No priority', rank: 4 },
};

/** The brief's sections, in order: what later agents (and people) rely on. */
export const BRIEF_SECTIONS = ['goal', 'context', 'acceptance', 'decisions', 'questions', 'handoff'] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

export const SECTION_INFO: Readonly<Record<BriefSection, { readonly label: string; readonly hint: string }>> = {
  goal: { label: 'Goal', hint: 'What this task is for, in a sentence or two' },
  context: { label: 'Context', hint: 'What someone new needs to know: where the code is, how it works today' },
  acceptance: { label: 'Acceptance criteria', hint: 'A checklist: done means all of these are true' },
  decisions: { label: 'Decisions', hint: 'What was decided and why, newest last' },
  questions: { label: 'Open questions', hint: 'What is still unclear' },
  handoff: { label: 'Notes for the next agent', hint: 'Where things stand, and what to do next' },
};

export const ESTIMATES = [1, 2, 3, 5, 8] as const;

/**
 * Who did something: a person (you or a friend, by peer id), someone's Claude, or klaud itself
 * (a worktree opened, a pull request merged). Peer ids, not "you": boards are shared later.
 */
export type Actor =
  | { readonly kind: 'person'; readonly id: string; readonly name: string }
  | { readonly kind: 'claude'; readonly owner: string; readonly ownerName: string }
  | { readonly kind: 'klaud' };

/** Who a task is for: a person, or someone's Claude. */
export type Assignee = { readonly kind: 'person'; readonly id: string; readonly name: string } | { readonly kind: 'claude'; readonly owner: string; readonly ownerName: string };

export interface BriefRevision {
  readonly id: string;
  readonly at: number;
  readonly by: Actor;
  readonly section: BriefSection;
  readonly before: string;
  readonly after: string;
  /** Why (Claude says, people may). */
  readonly reason?: string;
}

export type ActivityKind = 'created' | 'title' | 'status' | 'priority' | 'assignee' | 'labels' | 'estimate' | 'due' | 'parent' | 'relation' | 'brief' | 'comment' | 'note' | 'worktree' | 'pr' | 'proof' | 'project' | 'plan';

export interface Activity {
  readonly id: string;
  readonly at: number;
  readonly by: Actor;
  readonly kind: ActivityKind;
  /** In words ("moved this to In Review", "opened PR #42"); a comment's or note's text is `body`. */
  readonly text: string;
  readonly body?: string;
  /** Who it was assigned to (screens say "you" and "your Claude" from where they look). */
  readonly assignee?: Assignee | null;
  /**
   * What the field was before this run of changes (quick changes to one field by one person
   * become one line: clicking through estimates leaves "estimated this at 5 points", once).
   */
  readonly was?: string;
  /** What it is now (in the same words as `was`). */
  readonly now?: string;
}

/** Something that shows the work: a screenshot, a page, a file, a graph, a result. */
export interface Proof {
  readonly id: string;
  readonly kind: 'image' | 'url' | 'file' | 'graph' | 'text';
  readonly title: string;
  /** A file on this Mac (image, file). */
  readonly path?: string;
  readonly url?: string;
  /** A klaud-graph's JSON, or text. */
  readonly body?: string;
  readonly at: number;
  readonly by: Actor;
}

/** The pull request a task's worktree opened (as the workbench last saw it). */
export interface IssuePr {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly title: string;
  readonly draft: boolean;
  readonly checks: 'passing' | 'failing' | 'pending' | 'none';
  readonly review?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
}

export interface Issue {
  readonly id: string;
  /** "BOB-12": the project's prefix and the task's number in it. */
  readonly key: string;
  readonly number: number;
  readonly projectId: string;
  readonly title: string;
  /** The title came from a worktree's name and follows it until someone renames the task. */
  readonly autoTitle?: boolean;
  /** Made from a description: Claude is writing its title and goal (the first line stands in meanwhile). */
  readonly drafting?: boolean;
  readonly status: IssueStatus;
  readonly priority: Priority;
  readonly labels: readonly string[];
  readonly estimate?: number;
  /** YYYY-MM-DD. */
  readonly due?: string;
  readonly assignee?: Assignee;
  /** A sub-task's parent (its id). */
  readonly parent?: string;
  /** Tasks that must be done before this one can be (ids). "Blocks" is the other side of it. */
  readonly blockedBy: readonly string[];
  readonly related: readonly string[];
  /** Order inside a status (the board's columns, the list's groups): smaller first. */
  readonly rank: number;
  readonly brief: Readonly<Partial<Record<BriefSection, string>>>;
  readonly revisions: readonly BriefRevision[];
  /** Worktrees doing it (workspace ids), the current one last. */
  readonly worktrees: readonly string[];
  readonly branch?: string;
  readonly pr?: IssuePr;
  /** Its worktree went away (archived or deleted) before it was done: screens ask what's next. */
  readonly worktreeGone?: boolean;
  readonly proof: readonly Proof[];
  readonly activity: readonly Activity[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly createdBy: Actor;
  /** When it reached Done or Canceled. */
  readonly closedAt?: number;
  /** How it started: by hand, a worktree opening, Claude, or an approved plan. */
  readonly origin: 'manual' | 'worktree' | 'claude' | 'plan';
  /** The plan it's part of: the plan, its milestone and its task there (ids). */
  readonly plan?: IssuePlan;
}

export interface IssuePlan {
  readonly id: string;
  readonly milestone: string;
  readonly task: string;
}

/** A project's board settings. */
export interface BoardProject {
  /** "BOB": what keys start with. */
  readonly prefix: string;
  /** The next task's number. */
  readonly next: number;
}

export interface BoardState {
  /** The board runs (the Mac app's daemon); off elsewhere. */
  readonly enabled: boolean;
  readonly issues: readonly Issue[];
  readonly projects: Readonly<Record<string, BoardProject>>;
  /** Open a task for every new worktree (off by default: tasks come from plans). */
  readonly autoTasks: boolean;
}

export interface BoardSlice {
  readonly board: BoardState;
}

export const KEEP_ACTIVITY = 200;
/** Versions kept per brief section. */
export const KEEP_REVISIONS = 20;
export const KEEP_PROOF = 40;
/** Changes to one field by one person this close together are one change in the activity. */
export const COALESCE_MS = 2 * 60 * 1000;

export const NO_BOARD: BoardState = { enabled: false, issues: [], projects: {}, autoTasks: false };
export const initialBoard: BoardSlice = { board: NO_BOARD };

export type BoardAction =
  /** Everything at once (on start). */
  | { type: 'board_init'; state: BoardState }
  /** One task changed (same id: replaced) or was added. */
  | { type: 'board_issue'; issue: Issue }
  | { type: 'board_remove'; id: string }
  | { type: 'board_meta'; projects: Readonly<Record<string, BoardProject>>; autoTasks: boolean }
  | { type: 'board_off' };

export const BOARD_ACTIONS: ReadonlySet<string> = new Set(['board_init', 'board_issue', 'board_remove', 'board_meta', 'board_off']);

export function reduceBoard(state: BoardSlice, action: BoardAction): BoardSlice {
  switch (action.type) {
    case 'board_init':
      return { board: action.state };
    case 'board_issue': {
      const list = state.board.issues;
      const at = list.findIndex((i) => i.id === action.issue.id);
      return { board: { ...state.board, issues: at >= 0 ? list.map((i, n) => (n === at ? action.issue : i)) : [...list, action.issue] } };
    }
    case 'board_remove':
      return { board: { ...state.board, issues: state.board.issues.filter((i) => i.id !== action.id) } };
    case 'board_meta':
      return { board: { ...state.board, projects: action.projects, autoTasks: action.autoTasks } };
    case 'board_off':
      return { board: NO_BOARD };
    default:
      return state;
  }
}

// ---- for screens and Claude

/**
 * A project's key prefix from its name: a short first word of two ("bob-api" → "BOB"), else the
 * words' initials ("my-cool-app" → "MCA"), else one word's first letter and consonants ("landing" →
 * "LND"). Taken prefixes get a number ("BOB2").
 */
export function prefixFor(name: string, taken: ReadonlySet<string> = new Set()): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
  const [first = 'T'] = words;
  const consonants = (w: string): string => w[0] + w.slice(1).replace(/[AEIOU]/g, '');
  const base = words.length === 2 && first.length <= 4 ? first : words.length > 1 ? words.map((w) => w[0]).join('') : consonants(first);
  const short = base.slice(0, words.length > 1 ? 4 : 3).padEnd(2, 'X');
  if (!taken.has(short)) return short;
  for (let n = 2; n < 100; n++) if (!taken.has(`${short}${n}`)) return `${short}${n}`;
  return `${short}${taken.size}`;
}

/** A worktree's name as a task's title: "add-rate-limiting" → "Add rate limiting". */
export function titleFromName(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Untitled task';
}

export const issueById = (board: BoardState, id: string): Issue | undefined => board.issues.find((i) => i.id === id);

/** A task by its key ("BOB-12", any case) or its id. */
export function findIssue(board: BoardState, ref: string): Issue | undefined {
  const k = ref.trim().toUpperCase();
  return board.issues.find((i) => i.key === k) ?? board.issues.find((i) => i.id === ref.trim());
}

/** The task a workspace (worktree) is doing, if any. */
export const issueForWorkspace = (board: BoardState, workspaceId: string): Issue | undefined => board.issues.find((i) => i.worktrees.includes(workspaceId));

/** Tasks this one waits on that aren't finished. */
export const openBlockers = (board: BoardState, issue: Issue): Issue[] => issue.blockedBy.map((id) => issueById(board, id)).filter((i): i is Issue => Boolean(i && isOpen(i.status)));

/** Tasks waiting on this one. */
export const blocking = (board: BoardState, issue: Issue): Issue[] => board.issues.filter((i) => i.blockedBy.includes(issue.id));

export const childrenOf = (board: BoardState, issue: Issue): Issue[] => board.issues.filter((i) => i.parent === issue.id).sort(byRank);

/** Sub-tasks done out of all of them (not counting canceled ones). */
export function progressOf(board: BoardState, issue: Issue): { readonly done: number; readonly total: number } {
  const kids = childrenOf(board, issue).filter((i) => i.status !== 'canceled');
  return { done: kids.filter((i) => i.status === 'done').length, total: kids.length };
}

export const byRank = (a: Issue, b: Issue): number => a.rank - b.rank || a.number - b.number;

/** List order: by status, then priority (urgent first), then rank. */
export function listOrder(a: Issue, b: Issue): number {
  return ISSUE_STATUSES.indexOf(a.status) - ISSUE_STATUSES.indexOf(b.status) || PRIORITY_INFO[a.priority].rank - PRIORITY_INFO[b.priority].rank || byRank(a, b);
}

/** A rank between two neighbours (dropping a card between them); the ends get room around them. */
export function rankBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1000;
  if (before === undefined) return after! - 1000;
  if (after === undefined) return before + 1000;
  return (before + after) / 2;
}

/** Whether a task is yours: assigned to you, or to your Claude. */
export const isMine = (issue: Issue, selfId: string): boolean => (issue.assignee?.kind === 'person' && issue.assignee.id === selfId) || (issue.assignee?.kind === 'claude' && issue.assignee.owner === selfId);

export interface IssueFilter {
  readonly scope?: 'mine' | 'active' | 'backlog' | 'all';
  readonly projectId?: string;
  readonly query?: string;
  readonly selfId?: string;
  /** Keep closed (Done, Canceled) tasks closed in the last this-many ms (the default: a week). */
  readonly closedWithin?: number;
  readonly now?: number;
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Words in the title, key, labels or brief, all of them (any order, any case). */
export function matches(issue: Issue, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [issue.key, issue.title, ...issue.labels, ...Object.values(issue.brief)].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The tasks a view shows (scope, project, words), in list order. */
export function filterIssues(board: BoardState, f: IssueFilter = {}): Issue[] {
  const now = f.now ?? Date.now();
  const within = f.closedWithin ?? WEEK;
  return board.issues
    .filter((i) => (f.projectId ? i.projectId === f.projectId : true))
    .filter((i) => {
      switch (f.scope ?? 'all') {
        case 'mine':
          return Boolean(f.selfId && isMine(i, f.selfId)) && (isOpen(i.status) || now - (i.closedAt ?? i.updatedAt) < within);
        case 'active':
          return i.status === 'todo' || i.status === 'in_progress' || i.status === 'in_review' || i.status === 'in_plan';
        case 'backlog':
          return i.status === 'backlog';
        default:
          return isOpen(i.status) || now - (i.closedAt ?? i.updatedAt) < within;
      }
    })
    .filter((i) => (f.query ? matches(i, f.query) : true))
    .sort(listOrder);
}

/** Tasks grouped by status, every status present (empty groups too), in board order. */
export function byStatus(issues: readonly Issue[]): ReadonlyArray<{ readonly status: IssueStatus; readonly issues: readonly Issue[] }> {
  return ISSUE_STATUSES.map((status) => ({ status, issues: issues.filter((i) => i.status === status).sort((a, b) => PRIORITY_INFO[a.priority].rank - PRIORITY_INFO[b.priority].rank || byRank(a, b)) }));
}

/** Whose name to show for an actor, from where you look ("You", "Your Claude", "bob", "bob's Claude", "Klaud"). */
export function actorName(actor: Actor, selfId: string): string {
  switch (actor.kind) {
    case 'person':
      return actor.id === selfId ? 'You' : actor.name;
    case 'claude':
      return actor.owner === selfId ? 'Your Claude' : `${actor.ownerName}’s Claude`;
    default:
      return 'Klaud';
  }
}

export function assigneeName(assignee: Assignee | undefined, selfId: string): string {
  if (!assignee) return 'No one';
  return assignee.kind === 'person' ? (assignee.id === selfId ? 'You' : assignee.name) : assignee.owner === selfId ? 'Your Claude' : `${assignee.ownerName}’s Claude`;
}

/** An activity line in words from where you look ("assigned this to your Claude"). */
export function activityText(entry: Activity, selfId: string): string {
  if (entry.kind !== 'assignee' || entry.assignee === undefined) return entry.text;
  if (entry.assignee === null) return 'unassigned this';
  const name = assigneeName(entry.assignee, selfId);
  return `assigned this to ${name === 'You' ? 'you' : name === 'Your Claude' ? 'your Claude' : name}`;
}

/** A label's color, the same everywhere (a few calm hues). */
export function labelHue(label: string): number {
  let h = 0;
  for (const c of label.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return [212, 152, 268, 28, 340, 190, 96][h % 7]!;
}
