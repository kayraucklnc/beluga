import type { Assignee, BoardState, Issue, IssueStatus } from '../../../../src/core/board/model.js';
import { ISSUE_STATUSES, STATUS_INFO, childrenOf, filterIssues, isOpen, openBlockers } from '../../../../src/core/board/model.js';
import { type Tally, parseCriterion, tally } from '../../../../src/core/board/criteria.js';
import type { Graph, GraphNode, GraphEdge } from '../../../../src/shared/graph-spec.js';

/**
 * The Tasks screen's pure parts (no DOM): what you're looking at (remembered per window), the
 * people a task can be for, the dependency graph, and words for times and counts.
 */

export type Scope = 'active' | 'backlog' | 'all';
export type Display = 'list' | 'board' | 'graph';

export interface TasksPrefs {
  readonly scope: Scope;
  readonly display: Display;
  /** The project you were last in (Tasks opens on it). Tasks never mix projects. */
  readonly project: string;
  /** Whose tasks ('' = everyone's): an assignee key (assigneeKey), or 'nobody'. */
  readonly who: string;
  /** Status groups folded in the list. */
  readonly folded: readonly IssueStatus[];
}

export const DEFAULT_TASKS_PREFS: TasksPrefs = { scope: 'active', display: 'list', project: '', who: '', folded: ['canceled'] };

export const SCOPES: ReadonlyArray<{ readonly value: Scope; readonly label: string; readonly hint: string }> = [
  { value: 'active', label: 'Active', hint: 'Todo, In Progress and In Review' },
  { value: 'backlog', label: 'Backlog', hint: 'Not planned yet' },
  { value: 'all', label: 'All', hint: 'Everything open, and what finished this week' },
];

/** Saved prefs, read kindly (anything odd falls back to the default). */
export function readTasksPrefs(raw: string | null): TasksPrefs {
  try {
    const p = JSON.parse(raw ?? '{}') as Partial<TasksPrefs>;
    return {
      scope: SCOPES.some((s) => s.value === p.scope) ? p.scope! : DEFAULT_TASKS_PREFS.scope,
      display: p.display === 'board' || p.display === 'graph' || p.display === 'list' ? p.display : DEFAULT_TASKS_PREFS.display,
      project: typeof p.project === 'string' ? p.project : '',
      who: typeof p.who === 'string' ? p.who : '',
      folded: Array.isArray(p.folded) ? p.folded.filter((s): s is IssueStatus => (ISSUE_STATUSES as readonly string[]).includes(s)) : DEFAULT_TASKS_PREFS.folded,
    };
  } catch {
    return DEFAULT_TASKS_PREFS;
  }
}

/** The statuses a scope shows as groups (or columns), in order. */
export function statusesFor(scope: Scope): readonly IssueStatus[] {
  switch (scope) {
    case 'active':
      return ['todo', 'in_progress', 'in_review', 'in_plan'];
    case 'backlog':
      return ['backlog'];
    default:
      return ISSUE_STATUSES;
  }
}

/** Whether a task is for `who` ('' = anyone, 'nobody' = unassigned, else an assignee key). */
export const isFor = (issue: Issue, who: string): boolean => (!who ? true : who === 'nobody' ? !issue.assignee : assigneeKey(issue.assignee) === who);

/** One project's tasks in a scope, for someone, matching words, in list order. */
export function scoped(board: BoardState, prefs: Pick<TasksPrefs, 'scope' | 'project' | 'who'>, selfId: string, query = '', now = Date.now()): Issue[] {
  return filterIssues(board, { scope: prefs.scope, selfId, now, projectId: prefs.project, ...(query.trim() ? { query } : {}) }).filter((i) => isFor(i, prefs.who));
}

/** How many unfinished tasks each scope has in a project (for someone): the tabs' counts. */
export function scopeCounts(board: BoardState, project: string, who: string, selfId: string, now = Date.now()): Readonly<Record<Scope, number>> {
  const count = (scope: Scope): number => scoped(board, { scope, project, who }, selfId, '', now).filter((i) => isOpen(i.status)).length;
  return { active: count('active'), backlog: count('backlog'), all: count('all') };
}

/**
 * The project Tasks shows: the one asked for, else the one you were last in, else the one with
 * the most unfinished tasks, else the first. Never all of them at once.
 */
export function projectToShow(board: BoardState, projects: ReadonlyArray<{ readonly id: string }>, asked: string | undefined, last: string): string | undefined {
  const known = (id: string | undefined): id is string => Boolean(id && projects.some((p) => p.id === id));
  if (known(asked)) return asked;
  if (known(last)) return last;
  const open = (id: string): number => board.issues.filter((i) => i.projectId === id && isOpen(i.status)).length;
  return [...projects].sort((a, b) => open(b.id) - open(a.id))[0]?.id;
}

/**
 * Whether you work alone on a project: nobody else around (no one in the room, no friends) and no
 * task there for anyone but you or your Claude. Then who a task is for isn't shown at all.
 */
export function isSolo(board: BoardState, projectId: string | undefined, selfId: string, others: number): boolean {
  if (others > 0) return false;
  return !board.issues.some((i) => i.projectId === projectId && i.assignee && (i.assignee.kind === 'person' ? i.assignee.id !== selfId : i.assignee.owner !== selfId));
}

/** The people (and Claudes) a project's tasks are for, for the filter: you first, then the rest by name. */
export function assigneesIn(board: BoardState, projectId: string | undefined, selfId: string): ReadonlyArray<{ readonly key: string; readonly label: string; readonly assignee: Assignee }> {
  const seen = new Map<string, Assignee>();
  for (const i of board.issues) if (i.projectId === projectId && i.assignee) seen.set(assigneeKey(i.assignee), i.assignee);
  const label = (a: Assignee): string => (a.kind === 'person' ? (a.id === selfId ? 'You' : a.name) : a.owner === selfId ? 'Your Claude' : `${a.ownerName}’s Claude`);
  const mine = (a: Assignee): number => ((a.kind === 'person' ? a.id : a.owner) === selfId ? 0 : 1);
  return [...seen.entries()].map(([key, assignee]) => ({ key, label: label(assignee), assignee })).sort((x, y) => mine(x.assignee) - mine(y.assignee) || x.label.localeCompare(y.label));
}

export interface Person {
  readonly id: string;
  readonly name: string;
}

/** Who a task can be for: you, your Claude, then people you know (and their Claudes). */
export function assigneeChoices(self: Person, people: readonly Person[]): ReadonlyArray<{ readonly key: string; readonly label: string; readonly assignee: Assignee }> {
  const others = people.filter((p) => p.id !== self.id).sort((a, b) => a.name.localeCompare(b.name));
  return [
    { key: `person:${self.id}`, label: 'You', assignee: { kind: 'person', id: self.id, name: self.name } },
    { key: `claude:${self.id}`, label: 'Your Claude', assignee: { kind: 'claude', owner: self.id, ownerName: self.name } },
    ...others.flatMap((p) => [
      { key: `person:${p.id}`, label: p.name, assignee: { kind: 'person', id: p.id, name: p.name } as Assignee },
      { key: `claude:${p.id}`, label: `${p.name}’s Claude`, assignee: { kind: 'claude', owner: p.id, ownerName: p.name } as Assignee },
    ]),
  ];
}

export const assigneeKey = (a: Assignee | undefined): string => (!a ? '' : a.kind === 'person' ? `person:${a.id}` : `claude:${a.owner}`);

/** A status on the graph: blocked when an unfinished task waits on another unfinished one; the backlog and canceled say so in words. */
function graphStatus(board: BoardState, issue: Issue): Pick<GraphNode, 'status' | 'sublabel'> {
  if (isOpen(issue.status) && openBlockers(board, issue).length) return { status: 'blocked' };
  switch (issue.status) {
    case 'todo':
      return { status: 'todo' };
    case 'in_progress':
      return { status: 'active' };
    case 'in_review':
    case 'in_plan':
      return { status: 'review' };
    case 'done':
      return { status: 'done' };
    default:
      return { sublabel: STATUS_INFO[issue.status].label };
  }
}

/** Tasks that wait on, hold up, contain or sit in another one shown: the ones a dependency graph is about. */
export function connected(board: BoardState, issues: readonly Issue[]): Issue[] {
  const shown = new Set(issues.map((i) => i.id));
  const linked = new Set<string>();
  for (const i of issues) {
    const ties = [...i.blockedBy, ...(i.parent ? [i.parent] : [])].filter((id) => shown.has(id));
    if (!ties.length) continue;
    linked.add(i.id);
    for (const id of ties) linked.add(id);
  }
  return issues.filter((i) => linked.has(i.id));
}

/**
 * What waits on what, as a graph: a task with sub-tasks is a box around them, a blocker points at
 * what it holds up (in the problem color while it's unfinished). Only the tasks shown.
 */
export function taskGraph(board: BoardState, issues: readonly Issue[]): Graph {
  const shown = new Set(issues.map((i) => i.id));
  const boxes = new Set(issues.filter((i) => childrenOf(board, i).some((c) => shown.has(c.id))).map((i) => i.id));
  const nodes: GraphNode[] = issues.map((i) => {
    const box = boxes.has(i.id);
    const inBox = i.parent && boxes.has(i.parent) ? { group: i.parent } : {};
    return {
      id: i.id,
      type: box ? 'group' : 'task',
      label: i.title.length > 80 ? `${i.title.slice(0, 79)}…` : i.title,
      tag: i.key,
      ...(box ? { sublabel: STATUS_INFO[i.status].label } : graphStatus(board, i)),
      ...inBox,
      ...(i.brief.goal ? { details: i.brief.goal.slice(0, 4000) } : {}),
      ...(i.priority === 'urgent' ? { emphasis: true } : {}),
    } as GraphNode;
  });
  const edges: GraphEdge[] = issues.flatMap((i) =>
    i.blockedBy
      .filter((b) => shown.has(b))
      .map((b) => {
        const blocker = issues.find((x) => x.id === b)!;
        return { id: `${b}->${i.id}`, from: b, to: i.id, kind: isOpen(blocker.status) ? ('blocks' as const) : ('depends' as const) };
      }),
  );
  return { title: 'What waits on what', direction: 'right', nodes, edges, steps: [] };
}

/** "just now", "5 min ago", "3 h ago", "Yesterday", "Oct 12". */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86_400) return 'Yesterday';
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** A due date in words: "Today", "Tomorrow", "In 3 days", "2 days late", "Nov 3". */
export function dueText(day: string, now = Date.now()): { readonly text: string; readonly late: boolean } {
  const [y, m, d] = day.split('-').map(Number);
  const due = new Date(y!, m! - 1, d!).getTime();
  const today = new Date(new Date(now).toDateString()).getTime();
  const days = Math.round((due - today) / 86_400_000);
  if (days === 0) return { text: 'Today', late: false };
  if (days === 1) return { text: 'Tomorrow', late: false };
  if (days < 0) return { text: `${-days} day${days === -1 ? '' : 's'} late`, late: true };
  if (days < 7) return { text: `In ${days} days`, late: false };
  return { text: new Date(due).toLocaleDateString([], { month: 'short', day: 'numeric' }), late: false };
}

/** Acceptance criteria: ticked, deferred and not done (with a reason), and open, out of all of them. */
export function checklist(text: string | undefined): Tally {
  return tally(text);
}

/** Tick or untick the n-th checkbox in Markdown (clicking it on a task page). Ticking drops its reason: it's met now. */
export function toggleCheck(text: string, index: number): string {
  let n = -1;
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*[-*]\s+\[)([ xX])(\].*)$/.exec(line);
      if (!m) return line;
      n++;
      if (n !== index) return line;
      if (m[2] !== ' ') return `${m[1]} ${m[3]}`;
      const c = parseCriterion(line);
      return c?.reason ? `${m[1]}x] ${c.text}` : `${m[1]}x${m[3]}`;
    })
    .join('\n');
}
