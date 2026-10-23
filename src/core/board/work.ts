import type { BoardTools, TaskDefinition } from '../../agent/types.js';
import { type DraftContext, type TaskDraft, firstLineTitle } from '../../agent/task-drafter.js';
import { slugify } from '../../agent/namer.js';
import { isSecretPath } from '../shares.js';
import type { Action, LogItem, Store } from '../store.js';
import type { Workspace } from '../../workspaces/types.js';
import type { WorkspaceController, WorktreeEvent } from '../workspace-controller.js';
import { Board, type IssuePatch, type NewIssue } from './board.js';
import { needsChecksText, unexplained } from './criteria.js';
import { briefPrompt, boardNote, definePrompt, describeIssue, describeList } from './prompt.js';
import { type Actor, type Assignee, BRIEF_SECTIONS, type BriefSection, type Issue, STATUS_INFO, filterIssues, isFinished, isOpen, issueForWorkspace, titleFromName } from './model.js';

/**
 * The board at work: tasks open with worktrees and follow their pull requests, a task can start
 * its own worktree (with Claude on it), and Claude's runs get the task they're doing (its brief
 * in the prompt, tools to keep it true).
 */

export interface BoardWorkDeps {
  readonly store: Store;
  readonly board: Board;
  readonly controller?: WorkspaceController;
  readonly selfId: () => string;
  readonly selfName: () => string;
  /** Ask your Claude in a conversation (`ws:<id>`). */
  readonly askClaude: (prompt: string, channel: string) => void;
  /** Your Claude writes a task from a description (none: the first line is the title). */
  readonly draftTask?: (text: string, ctx: DraftContext) => Promise<TaskDraft | undefined>;
}

const WS = 'ws:';

export class BoardWork {
  readonly board: Board;
  /** Tasks Claude defined while planning (plan mode), by conversation: they go on the board when you approve the plan. */
  private readonly pending = new Map<string, TaskDefinition>();
  /** Tasks made by approving a plan in a main folder's chat (by that chat's workspace id): the worktree it continues in does it. */
  private readonly carried = new Map<string, string>();
  /** Worktrees being started for tasks (Start Worktree): the one that opens under that name belongs to that task. */
  private readonly expecting: Array<{ readonly projectId: string; readonly name: string; readonly issueId: string }> = [];
  private readonly names = new Map<string, string>();
  private readonly offs: Array<() => void> = [];
  /** More for a run doing a task (the plan it's part of): see setBriefExtra. */
  private briefExtra: (issue: Issue) => string = () => '';
  /** Tasks Claude is writing from a description (by id): starting one waits for its words. */
  private readonly drafts = new Map<string, Promise<void>>();

  constructor(private readonly deps: BoardWorkDeps) {
    this.board = deps.board;
    if (deps.controller) this.offs.push(deps.controller.onWorktree((e) => this.onWorktree(e)));
    // After the action that caused it has reached everyone (never inside its dispatch).
    this.offs.push(
      deps.store.onAction((a) =>
        queueMicrotask(() => {
          try {
            this.onAction(a);
          } catch {
            // A task that went away meanwhile: nothing to follow.
          }
        }),
      ),
    );
    for (const ws of this.workspaces()) this.names.set(ws.id, ws.name);
  }

  /** Something to add to the instructions of a run doing a task (Plans adds the plan it's part of). */
  setBriefExtra(fn: (issue: Issue) => string): void {
    this.briefExtra = fn;
  }

  stop(): void {
    for (const off of this.offs) off();
    this.board.flush();
  }

  me(): Actor & Assignee {
    return { kind: 'person', id: this.deps.selfId(), name: this.deps.selfName() };
  }

  myClaude(): Actor & Assignee {
    return { kind: 'claude', owner: this.deps.selfId(), ownerName: this.deps.selfName() };
  }

  /**
   * A task from a description: on the board at once under its first line, while your Claude writes
   * its title, goal and criteria (labels only from the board's own); they fill in when it's done.
   */
  createDescribed(input: Omit<NewIssue, 'title' | 'brief' | 'drafting'>, describe: string): Issue {
    const text = describe.trim();
    if (!text) throw new Error('Say what the task is');
    const draft = this.deps.draftTask;
    const title = firstLineTitle(text);
    // Without your Claude: the first line, and what was said as the goal if it says more.
    if (!draft) return this.board.create({ ...input, title, ...(text.replace(/\s+/g, ' ') !== title ? { brief: { goal: text } } : {}) }, this.me());
    const issue = this.board.create({ ...input, title, drafting: true }, this.me());
    const labels = [...new Set(this.board.list().flatMap((i) => i.labels))].sort();
    const project = this.deps.store.getState().projects.find((p) => p.id === issue.projectId)?.name;
    const done = draft(text, { labels, ...(project ? { project } : {}) })
      .catch(() => undefined)
      .then((d) => {
        try {
          this.board.finishDraft(issue.id, d, this.myClaude(), text);
        } catch {
          // Deleted meanwhile.
        }
      })
      .finally(() => this.drafts.delete(issue.id));
    this.drafts.set(issue.id, done);
    return issue;
  }

  /**
   * Start a worktree for a task (from the latest origin, or `base`), named after it, and open it;
   * with `claude`, your Claude starts on the task there with its brief. → the workspace's id.
   */
  async start(ref: string, opts: { readonly claude?: boolean; readonly base?: string; readonly quiet?: boolean } = {}): Promise<string> {
    const controller = this.deps.controller;
    if (!controller) throw new Error('Worktrees need a project folder');
    // Claude still writing it: its worktree is named after, and Claude starts with, the real words.
    await this.drafts.get(this.board.need(ref).id);
    const issue = this.board.need(ref);
    // Finished work starts again only deliberately: reopened (back to Ready) first.
    if (isFinished(issue.status)) throw new Error(`${issue.key} is ${STATUS_INFO[issue.status].label.toLowerCase()}: reopen it to start it again`);
    // One worktree per task at a time: another one already doing it is where to go.
    const doing = issue.worktrees.at(-1);
    const live = doing && !issue.worktreeGone ? this.workspaces().find((w) => w.id === doing && !w.archived) : undefined;
    if (live) throw new Error(`${issue.key} is already being worked on in ${live.name}: open it there`);
    const name = slugify(`${issue.key} ${issue.title}`).slice(0, 48) || issue.key.toLowerCase();
    const ticket = { projectId: issue.projectId, name, issueId: issue.id };
    this.expecting.push(ticket);
    let ws: Workspace | undefined;
    try {
      ws = await controller.newWorktree(issue.projectId, name, { ...(opts.base ? { base: opts.base } : {}), ...(opts.quiet ? { quiet: true } : {}) });
    } finally {
      const at = this.expecting.indexOf(ticket);
      if (at >= 0) this.expecting.splice(at, 1);
    }
    if (!ws) throw new Error('Couldn’t create the worktree');
    // (Linked as it opened; started here in case the event came from elsewhere.)
    if (!this.board.need(issue.id).worktrees.includes(ws.id)) this.board.linkWorktree(issue.id, ws.id, { branch: ws.branch, name: ws.name }, this.me());
    const now = this.board.need(issue.id);
    const patch: IssuePatch = {
      ...(now.status === 'backlog' || now.status === 'todo' ? { status: 'in_progress' as const } : {}),
      ...(opts.claude && !now.assignee ? { assignee: this.myClaude() } : {}),
    };
    if (Object.keys(patch).length) this.board.update(issue.id, patch, this.me());
    if (opts.claude) this.deps.askClaude(startPrompt(this.board.need(issue.id)), `${WS}${ws.id}`);
    return ws.id;
  }

  /**
   * What one of Claude's runs gets: the task it's doing (in its prompt) and the task tools (your
   * own runs only). Planning (plan mode), Claude defines the task the plan is for; it goes on the
   * board when you approve the plan (`planApproved`), never before.
   */
  forRun(channel: string, from: string, opts: { readonly plan?: boolean } = {}): RunBoard | undefined {
    if (from !== this.deps.selfId()) return undefined;
    const issue = channel.startsWith(WS) ? issueForWorkspace(this.board.state(), channel.slice(WS.length)) : undefined;
    const tools = this.toolsFor(channel, issue, Boolean(opts.plan));
    const parallel = this.parallelNote(channel, issue);
    const brief = (issue ? briefPrompt(this.board.state(), issue) + this.briefExtra(issue) : boardNote()) + parallel + (opts.plan ? definePrompt(Boolean(issue)) : '');
    if (!opts.plan) return { tools, brief };
    this.pending.delete(channel);
    return {
      tools,
      brief,
      // Asked once per run: a plan without its task defined goes back to Claude to define it first.
      needsDefinition: () => !this.pending.has(channel) && !issue,
      planApproved: () => this.applyDefinition(channel),
    };
  }

  /** The task a plan was for, on the board now (you approved the plan). */
  private applyDefinition(channel: string): void {
    const def = this.pending.get(channel);
    if (!def) return;
    this.pending.delete(channel);
    try {
      this.define(channel, def, issueForWorkspaceOf(this.board, channel));
    } catch {
      // The project went away meanwhile: nothing to put it on.
    }
  }

  /** Make (or rewrite) the task a conversation is doing from Claude's definition. */
  private define(channel: string, def: TaskDefinition, current: Issue | undefined): Issue {
    const by: Actor = this.myClaude();
    const wsId = channel.startsWith(WS) ? channel.slice(WS.length) : undefined;
    const ws = wsId ? this.workspaces().find((w) => w.id === wsId) : undefined;
    const projectId = current?.projectId ?? ws?.projectId;
    if (!projectId || !this.deps.store.getState().projects.some((p) => p.id === projectId && p.root)) throw new Error('This conversation isn’t in a project, so its task has nowhere to go');
    const sections: Array<[BriefSection, string | undefined]> = [
      ['goal', def.goal],
      ['context', def.context],
      ['acceptance', checklistOf(def.acceptance)],
      ['decisions', listOf(def.decisions)],
      ['questions', listOf(def.questions)],
    ];
    const inWorktree = ws?.kind === 'worktree' && !ws.askOnly;
    let issue = current;
    if (!issue) {
      issue = this.board.create(
        {
          projectId,
          title: def.title,
          status: inWorktree ? 'in_progress' : 'todo',
          assignee: this.myClaude(),
          ...(def.priority ? { priority: def.priority } : {}),
          ...(def.estimate ? { estimate: def.estimate } : {}),
          ...(def.labels?.length ? { labels: def.labels } : {}),
          brief: Object.fromEntries(sections.filter(([, v]) => v?.trim())),
        },
        by,
        'claude',
      );
      if (inWorktree) this.board.linkWorktree(issue.id, ws.id, { branch: ws.branch, name: ws.name }, by);
      else if (wsId) this.carried.set(wsId, issue.id);
      return issue;
    }
    this.board.update(issue.id, { title: def.title, ...(def.priority ? { priority: def.priority } : {}), ...(def.estimate ? { estimate: def.estimate } : {}), ...(def.labels ? { labels: def.labels } : {}) }, by);
    for (const [section, text] of sections) if (text?.trim()) this.board.editBrief(issue.id, section, text, by, { reason: 'the plan' });
    return this.board.need(issue.id);
  }

  /** Other tasks being worked on in this project right now: so Claudes working side by side know about each other. */
  private parallelNote(channel: string, current: Issue | undefined): string {
    const wsId = channel.startsWith(WS) ? channel.slice(WS.length) : undefined;
    const projectId = current?.projectId ?? (wsId ? this.workspaces().find((w) => w.id === wsId)?.projectId : undefined);
    if (!projectId) return '';
    const state = this.deps.store.getState();
    const busy = busyChannels(state.log);
    const others = this.board
      .list()
      .filter((i) => i.projectId === projectId && i.id !== current?.id && (i.status === 'in_progress' || i.status === 'in_review'))
      .flatMap((i) => {
        const w = i.worktrees.at(-1);
        const place = w ? this.workspaces().find((x) => x.id === w && !x.archived) : undefined;
        return place ? [{ issue: i, place, working: busy.has(`${WS}${place.id}`) }] : [];
      })
      .slice(0, 12);
    if (!others.length) return '';
    return [
      '',
      'Being worked on in this project right now, in other worktrees (coordinate: don’t redo their work, and leave a task_note on theirs if you must touch what they own):',
      ...others.map(({ issue, place, working }) => `- ${issue.key} “${issue.title}” (${issue.status === 'in_review' ? 'in review' : 'in progress'}) in worktree ${place.name}${place.branch ? ` on ${place.branch}` : ''}${working ? ', its Claude is working now' : ''}`),
    ].join('\n');
  }

  // ------------------------------------------------------------------ following worktrees

  private onWorktree(event: WorktreeEvent): void {
    switch (event.kind) {
      case 'created':
        return this.opened(event.ws, event.from);
      case 'merged':
        return this.board.worktreeMerged(event.id);
      case 'archived':
        return this.board.worktreeGone(event.id, true, 'archived');
      case 'removed':
        return this.board.worktreeGone(event.id, true, 'deleted');
      case 'restored':
        return this.board.worktreeGone(event.id, false, 'restored');
    }
  }

  private opened(ws: Workspace, from: string | undefined): void {
    this.names.set(ws.id, ws.name);
    if (ws.kind !== 'worktree') return;
    const state = this.board.state();
    const linked = (id: string): Issue | undefined => issueForWorkspace(state, id);
    const beluga: Actor = { kind: 'beluga' };
    // Started from a task: the worktree opened under its name (perhaps with "-2" when taken).
    const at = this.expecting.findIndex((e) => e.projectId === ws.projectId && (ws.name === e.name || ws.name.startsWith(`${e.name}-`)));
    if (at >= 0) {
      const [expected] = this.expecting.splice(at, 1);
      this.board.linkWorktree(expected!.issueId, ws.id, { branch: ws.branch, name: ws.name }, this.me());
      return;
    }
    // A fork, or a conversation carried on: the same task, in its new worktree (also one approved in a main folder's chat).
    const carried = from ? this.carried.get(from) : undefined;
    const source = from ? (linked(from) ?? (carried ? this.board.get(carried) : undefined)) : undefined;
    if (source) {
      if (carried) this.carried.delete(from!);
      this.board.linkWorktree(source.id, ws.id, { branch: ws.branch, name: ws.name }, beluga);
      if (source.status === 'todo' || source.status === 'backlog') this.board.update(source.id, { status: 'in_progress' }, beluga);
      return;
    }
    // Only when you asked for a task per worktree (tasks come from plans). Claude writes its brief: what you said isn't pasted in.
    if (!this.board.autoTasksOn || !this.deps.store.getState().projects.some((p) => p.id === ws.projectId && p.root)) return;
    const issue = this.board.create({ projectId: ws.projectId, title: titleFromName(ws.name), autoTitle: true, status: 'in_progress', assignee: this.myClaude() }, beluga, 'worktree');
    this.board.linkWorktree(issue.id, ws.id, { branch: ws.branch, name: ws.name }, beluga);
  }

  private onAction(action: Action): void {
    switch (action.type) {
      case 'pr':
        this.board.prChanged(action.id, action.pr);
        return;
      case 'projects':
        this.renamed();
        return;
      default:
        return;
    }
  }

  /** Worktrees renamed (a small model named them): tasks titled after them follow. */
  private renamed(): void {
    for (const ws of this.workspaces()) {
      const before = this.names.get(ws.id);
      this.names.set(ws.id, ws.name);
      if (before === undefined || before === ws.name) continue;
      const issue = issueForWorkspace(this.board.state(), ws.id);
      if (issue?.autoTitle) this.board.retitle(issue.id, titleFromName(ws.name));
    }
  }

  private workspaces(): Workspace[] {
    return this.deps.store.getState().projects.flatMap((p) => p.workspaces);
  }

  // ------------------------------------------------------------------ Claude's tools

  private toolsFor(channel: string, current: Issue | undefined, planning = false): BoardTools {
    const board = this.board;
    const by = (): Actor => ({ kind: 'claude', owner: this.deps.selfId(), ownerName: this.deps.selfName() });
    const state = (): ReturnType<Board['state']> => board.state();
    const pick = (key: string | undefined): Issue => {
      if (key) return board.need(key);
      if (current) return board.need(current.id);
      throw new Error('Name a task (its key, like BOB-12): this conversation isn’t doing one');
    };
    const wsProject = (): string | undefined => {
      const id = channel.startsWith(WS) ? channel.slice(WS.length) : undefined;
      return id ? this.workspaces().find((w) => w.id === id)?.projectId : undefined;
    };
    const projectByName = (name: string): string => {
      const p = this.deps.store.getState().projects.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
      if (!p) throw new Error(`There's no project called ${name}`);
      return p.id;
    };
    const assign = (to: 'me' | 'claude' | 'nobody' | undefined): Assignee | null | undefined =>
      to === 'me' ? { kind: 'person', id: this.deps.selfId(), name: this.deps.selfName() } : to === 'claude' ? this.myClaude() : to === 'nobody' ? null : undefined;
    const where = (issue: Issue): string | undefined => {
      const w = issue.worktrees.at(-1);
      const place = w ? this.workspaces().find((x) => x.id === w && !x.archived) : undefined;
      if (!place) return undefined;
      const working = busyChannels(this.deps.store.getState().log).has(`${WS}${place.id}`);
      return `worktree ${place.name}${place.branch ? ` (${place.branch})` : ''}${`${WS}${place.id}` === channel ? ', this conversation' : working ? ', its Claude is working there now' : ''}`;
    };
    return {
      ...(current ? { current: current.key } : {}),
      define: (def) => {
        if (planning) {
          this.pending.set(channel, def);
          return `Saved “${def.title}”: it becomes ${current ? `the new brief of ${current.key}` : 'this work’s task in Tasks'} when the user approves your plan. Call ExitPlanMode now.`;
        }
        const issue = this.define(channel, def, current);
        return `${issue.key} “${issue.title}” is defined`;
      },
      get: (key) => {
        const issue = pick(key);
        const at = where(issue);
        return describeIssue(state(), issue, this.deps.selfId()) + (at ? `\n\nBeing worked on in ${at}.` : '');
      },
      list: (f) => {
        // open (the default): every unfinished task; mine: yours and your Claude's; all: recently finished too.
        // In this worktree's project unless another is named (tasks don't mix projects).
        const projectId = f.project ? projectByName(f.project) : (current?.projectId ?? wsProject());
        const found = filterIssues(state(), {
          scope: f.scope === 'mine' ? 'mine' : 'all',
          selfId: this.deps.selfId(),
          ...(projectId ? { projectId } : {}),
          ...(f.query ? { query: f.query } : {}),
        });
        return describeList(f.scope === 'all' || f.scope === 'mine' ? found : found.filter((i) => isOpen(i.status)));
      },
      create: (input) => {
        const projectId = input.project ? projectByName(input.project) : input.parent ? board.need(input.parent).projectId : (current?.projectId ?? wsProject());
        if (!projectId) throw new Error('Say which project (project: its name)');
        const brief: Partial<Record<BriefSection, string>> = {
          ...(input.goal ? { goal: input.goal } : {}),
          ...(input.acceptance ? { acceptance: checklistOf(input.acceptance) } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.decisions ? { decisions: input.decisions } : {}),
          ...(input.questions ? { questions: input.questions } : {}),
        };
        const issue = board.create(
          {
            projectId,
            title: input.title,
            status: input.status ?? 'todo',
            ...(input.priority ? { priority: input.priority } : {}),
            ...(input.estimate ? { estimate: input.estimate } : {}),
            ...(input.labels ? { labels: input.labels } : {}),
            ...(input.parent ? { parent: input.parent } : {}),
            ...(input.blockedBy ? { blockedBy: input.blockedBy } : {}),
            brief,
          },
          by(),
          'claude',
        );
        return `Created ${issue.key}: ${issue.title} (${issue.status})`;
      },
      update: (key, patch) => {
        const issue = pick(key);
        const assignee = assign(patch.assign);
        // To review only when every criterion is ticked or explained: its Claude is told which aren't.
        const open = patch.status === 'in_review' && issue.status !== 'in_review' ? unexplained(issue.brief.acceptance) : [];
        if (open.length) {
          board.holdForChecks(issue.id);
          throw new Error(needsChecksText(issue.key, open));
        }
        const next = board.update(issue.id, { ...(patch.title ? { title: patch.title } : {}), ...(patch.status ? { status: patch.status } : {}), ...(patch.priority ? { priority: patch.priority } : {}), ...(patch.labels ? { labels: patch.labels } : {}), ...(patch.estimate !== undefined ? { estimate: patch.estimate } : {}), ...(assignee !== undefined ? { assignee } : {}) }, by());
        return `${next.key} is now: ${next.title} · ${next.status} · priority ${next.priority}${next.estimate ? ` · ${next.estimate} points` : ''}`;
      },
      editBrief: (key, section, content, reason, mode) => {
        if (!BRIEF_SECTIONS.includes(section)) throw new Error(`Sections: ${BRIEF_SECTIONS.join(', ')}`);
        const next = board.editBrief(pick(key).id, section, content, by(), { reason, mode });
        return `Updated the ${section} of ${next.key}`;
      },
      note: (key, text) => `Noted on ${board.comment(pick(key).id, text, by()).key}`,
      relate: (key, relation, other, remove) => {
        const next = board.relate(pick(key).id, relation, other, !remove, by());
        return `${next.key} ${remove ? 'no longer' : 'now'} ${relation === 'blocked_by' ? 'waits on' : relation === 'blocks' ? 'blocks' : 'relates to'} ${board.need(other).key}`;
      },
      attachProof: (key, proof) => {
        // Secrets are never proof (boards are shared with friends later).
        if (proof.path && isSecretPath(proof.path)) throw new Error('That file holds secrets: it can’t be attached');
        const next = board.addProof(pick(key).id, proof, by());
        return `Attached “${proof.title}” to ${next.key}`;
      },
    };
  }
}

/** What a run gets from the board (see BoardWork.forRun). */
export interface RunBoard {
  readonly tools?: BoardTools;
  readonly brief?: string;
  /** Planning: whether the plan's task still has to be defined (before Claude asks you to approve the plan). */
  readonly needsDefinition?: () => boolean;
  /** Planning: you approved the plan; its task goes on the board. */
  readonly planApproved?: () => void;
}

const issueForWorkspaceOf = (board: Board, channel: string): Issue | undefined => (channel.startsWith(WS) ? issueForWorkspace(board.state(), channel.slice(WS.length)) : undefined);

/** Conversations where a Claude is working right now. */
export function busyChannels(log: readonly LogItem[]): Set<string> {
  const last = new Map<string, string>();
  for (const l of log) if (l.type === 'agent') last.set(l.channel, l.status);
  return new Set([...last].filter(([, s]) => s === 'queued' || s === 'awaiting_approval' || s === 'started' || s === 'answered').map(([c]) => c));
}

/** A checklist from lines or text ("- [ ] …" each; ticks kept). */
export function checklistOf(input: string | readonly string[] | undefined): string | undefined {
  const items = (typeof input === 'string' ? input.split('\n') : [...(input ?? [])]).map((l) => l.trim()).filter(Boolean);
  if (!items.length) return undefined;
  return items.map((l) => (/^[-*]\s+\[[ xX]\]/.test(l) ? l : `- [ ] ${l.replace(/^[-*]\s+/, '')}`)).join('\n');
}

const listOf = (input: string | readonly string[] | undefined): string | undefined => {
  if (typeof input === 'string') return input.trim() || undefined;
  const items = [...(input ?? [])].map((l) => l.trim()).filter(Boolean);
  return items.length ? items.map((l) => (/^[-*]\s/.test(l) ? l : `- ${l}`)).join('\n') : undefined;
};

/** What Claude is told when a task starts its worktree with Claude on it. */
export function startPrompt(issue: Issue): string {
  const lines = [`Work on ${issue.key}: ${issue.title}.`];
  if (issue.brief.goal) lines.push('', issue.brief.goal);
  if (issue.brief.acceptance) lines.push('', 'Done means:', issue.brief.acceptance);
  lines.push('', 'Its full brief is in your instructions. Keep the task true as you go (decisions, sub-tasks, proof, notes for the next agent).');
  return lines.join('\n');
}

