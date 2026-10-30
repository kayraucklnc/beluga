import type { BoardTools, TaskDefinition } from '../../agent/types.js';
import { type DraftContext, type TaskDraft, firstLineTitle } from '../../agent/task-drafter.js';
import { personMentions } from '../person-mentions.js';
import { teammatesOf } from '../team/model.js';
import { slugify } from '../../agent/namer.js';
import { isSecretPath } from '../shares.js';
import type { Action, LogItem, Store } from '../store.js';
import type { Workspace } from '../../workspaces/types.js';
import type { WorkspaceController, WorktreeEvent } from '../workspace-controller.js';
import { Board, type IssuePatch, type NewIssue } from './board.js';
import type { IssuePr } from './model.js';
import { agentLabel, agentName } from '../../shared/agent-label.js';
import { defaultAgentOf } from '../../protocol.js';
import { needsChecksText, unexplained } from './criteria.js';
import { inSet, labelsFor } from './labels.js';
import { aboutPrompt, briefPrompt, boardNote, definePrompt, describeIssue, describeList, gitHubLine } from './prompt.js';
import { type Actor, type Assignee, BRIEF_SECTIONS, type BriefSection, type Issue, STATUS_INFO, filterIssues, isArchived, isFinished, isOpen, issueForWorkspace, titleFromName, worktreeDoing } from './model.js';

/** How a name is written after "@" (as the message box completes it: src/ui/suggest.ts friendMention). */
const handleOf = (name: string): string => `@${name.replace(/[^\p{L}\p{N}_.-]+/gu, '')}`;

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
  /** Ask your Claude in a conversation (`ws:<id>`); `shown`: what the conversation shows you asked, when not the prompt itself. */
  readonly askClaude: (prompt: string, channel: string, shown?: string) => void;
  /** Your Claude writes a task from a description (none: the first line is the title). */
  readonly draftTask?: (text: string, ctx: DraftContext) => Promise<TaskDraft | undefined>;
  /** Your Claude writes what a project is about from a quick look at its folder (none: people write it). */
  readonly describeProject?: (dir: string, project: string) => Promise<string | undefined>;
  /** A quiet word on screen (what Claude wrote in the background). */
  readonly toast?: (text: string) => void;
  /** A branch's pull request, asked of gh (none: tasks whose worktree went aren't looked after). Throws when gh can't tell. */
  readonly findPr?: (dir: string, branch: string) => Promise<IssuePr | undefined>;
  /** How often to look for merged pull requests of tasks nobody watches any more (0: only when asked). */
  readonly sweepMs?: number;
}

/** Looking for shipped work: soon after start, then every ten minutes. */
const SWEEP_FIRST_MS = 30_000;
const SWEEP_MS = 10 * 60_000;

const WS = 'ws:';

export class BoardWork {
  readonly board: Board;
  /** Tasks Claude defined while planning (plan mode), by conversation: they go on the board when you approve the plan. */
  private readonly pending = new Map<string, TaskDefinition>();
  /** Tasks made by approving a plan in a main folder's chat (by that chat's workspace id): the worktree it continues in does it. */
  private readonly carried = new Map<string, string>();
  /** Projects whose About This Project your Claude was asked to write this run. */
  private readonly described = new Set<string>();
  /** Worktrees being started for tasks (Start Worktree): the one that opens under that name belongs to that task. */
  private readonly expecting: Array<{ readonly projectId: string; readonly name: string; readonly issueId: string }> = [];
  private readonly names = new Map<string, string>();
  private readonly offs: Array<() => void> = [];
  /** More for a run doing a task (the plan it's part of): see setBriefExtra. */
  private briefExtra: (issue: Issue) => string = () => '';
  /** A run's own instructions (a plan milestone's worktree): see setRunBrief. */
  private runBrief: (channel: string) => { readonly brief: string; readonly current?: Issue } | undefined = () => undefined;
  /** Tasks Claude is writing from a description (by id): starting one waits for its words. */
  private readonly drafts = new Map<string, Promise<void>>();

  constructor(private readonly deps: BoardWorkDeps) {
    this.board = deps.board;
    if (deps.controller) this.offs.push(deps.controller.onWorktree((e) => this.onWorktree(e)));
    // Proof made in a worktree outlives it: kept before its folder goes (proof-files.ts).
    if (deps.controller?.onWorktreeGoing) this.offs.push(deps.controller.onWorktreeGoing((ws) => void this.board.keepProofs(ws.path)));
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
    const every = deps.sweepMs ?? SWEEP_MS;
    if (deps.findPr && every > 0) {
      const first = setTimeout(() => void this.sweepShipped(), Math.min(SWEEP_FIRST_MS, every));
      const timer = setInterval(() => void this.sweepShipped(), every);
      first.unref?.();
      timer.unref?.();
      this.offs.push(() => {
        clearTimeout(first);
        clearInterval(timer);
      });
    }
  }

  /**
   * Tasks still open whose work went out on a branch nobody watches any more (its worktree archived
   * or gone, so the workbench stopped asking about its pull request): gh is asked, and a merged one
   * makes them Done. → how many moved.
   */
  async sweepShipped(): Promise<number> {
    const find = this.deps.findPr;
    if (!find) return 0;
    const live = new Set(this.workspaces().filter((w) => !w.archived).map((w) => w.id));
    const roots = new Map(this.deps.store.getState().projects.flatMap((p) => (p.root ? [[p.id, p.root] as const] : [])));
    const waiting = new Map<string, { readonly root: string; readonly branch: string; readonly ids: string[] }>();
    for (const issue of this.board.list()) {
      const via = issue.carriedBy ?? issue.worktrees.at(-1);
      const root = roots.get(issue.projectId);
      if (!issue.branch || !root || issue.archivedAt !== undefined || (via && live.has(via))) continue;
      if (issue.status !== 'in_progress' && issue.status !== 'in_review') continue;
      const key = `${root}\0${issue.branch}`;
      const group = waiting.get(key) ?? { root, branch: issue.branch, ids: [] };
      group.ids.push(issue.id);
      waiting.set(key, group);
    }
    let moved = 0;
    for (const { root, branch, ids } of waiting.values()) {
      let pr: IssuePr | undefined;
      try {
        pr = await find(root, branch);
      } catch {
        continue; // gh couldn't tell this time
      }
      if (pr?.state !== 'MERGED') continue;
      for (const id of ids) {
        try {
          if (this.board.branchShipped(id, pr).status === 'done') moved++;
        } catch {
          // Deleted meanwhile.
        }
      }
    }
    return moved;
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

  /** This Mac's agent by name ("Claude", "Codex"). */
  private agent(): string {
    return agentName(defaultAgentOf(this.deps.store.getState().self));
  }

  myClaude(): Actor {
    return { kind: 'claude', owner: this.deps.selfId(), ownerName: this.deps.selfName() };
  }

  /**
   * A task from a description: on the board at once under its first line, while your Claude writes
   * its title, goal, criteria and labels (from the project's set); they fill in when it's done.
   */
  /**
   * What your Claude writes for a task described in words, without adding it yet (the phone shows
   * the draft first, then adds it with addDraft). Without your Claude: the first line as the title.
   */
  async draft(projectId: string, describe: string, opts: { readonly several?: boolean } = {}): Promise<TaskDraft> {
    const text = describe.trim();
    if (!text) throw new Error('Say what the task is');
    const title = firstLineTitle(text);
    const plain: TaskDraft = { title, goal: text, acceptance: [], labels: [] };
    if (!this.deps.draftTask) return plain;
    // `several` (a phone that shows them all, BLG-322): the words may ask for several tasks, an epic, and who does each.
    return (await this.deps.draftTask(text, this.draftContext(projectId, text, undefined, opts.several)).catch(() => undefined)) ?? plain;
  }

  /**
   * What the describer knows besides the words: the project's name, what it's about (BLG-298), and
   * its labels; with `several` (BLG-319), who on its team a task can be for (you first); and who
   * the words' "@mia"s are, teammates and friends (BLG-342).
   */
  private draftContext(projectId: string, text: string, look?: string, several = false): DraftContext {
    const labels = labelsFor(this.board.state(), projectId).map((l) => l.name);
    const project = this.deps.store.getState().projects.find((p) => p.id === projectId)?.name;
    const about = this.board.state().projects[projectId]?.context?.text;
    const people = several ? this.people(projectId).map((p) => p.name) : [];
    const named = this.named(projectId, text);
    return {
      labels,
      ...(project ? { project } : {}),
      ...(about ? { about } : {}),
      ...(look ? { look } : {}),
      ...(several ? { several, ...(people.length > 1 ? { people } : {}) } : {}),
      ...(named.length ? { named } : {}),
    };
  }

  /** The people "@" names in the words: the project's teammates, then your other friends (never you). */
  private named(projectId: string, text: string): NonNullable<DraftContext['named']> {
    if (!text.includes('@')) return [];
    const team = this.people(projectId).filter((p) => p.id !== this.deps.selfId());
    const friends = (this.deps.store.getState().network?.friends ?? []).filter((f) => f.peerId !== this.deps.selfId() && !team.some((m) => m.id === f.peerId));
    const onTeam = new Set(team.map((m) => m.id));
    return personMentions(text, [...team.map((m) => ({ peerId: m.id, name: m.name })), ...friends]).map((p) => ({ handle: handleOf(p.name), name: p.name, team: onTeam.has(p.peerId) }));
  }

  /** Who a project's task can be for: you, then its teammates (BLG-299). */
  private people(projectId: string): Assignee[] {
    const mates = teammatesOf(this.deps.store.getState().team, projectId).map((m): Assignee => ({ kind: 'person', id: m.peerId, name: m.name }));
    return [this.me(), ...mates.filter((m) => m.id !== this.deps.selfId())];
  }

  /**
   * A draft (from draft, maybe changed) added as a task: its title, goal, criteria, labels and
   * priority, for whoever it names on the team; with `more`, those too (under it when `epic`). → the first (or the epic), then the rest.
   */
  addDraft(projectId: string, d: TaskDraft): Issue[] {
    const who = d.epic ? undefined : this.whom(projectId, d.for);
    const first = this.board.create({ projectId, title: d.title, labels: d.labels, ...(d.priority ? { priority: d.priority } : {}), ...(who ? { assignee: who } : {}), brief: draftBrief(d) }, this.me());
    return [first, ...this.addMore(first, {}, d)];
  }

  /** The person a draft names, if they're on the project's team (you or a teammate). */
  private whom(projectId: string, name: string | undefined): Assignee | undefined {
    return name ? this.people(projectId).find((p) => p.name === name) : undefined;
  }

  /**
   * `look`: a folder Claude may read first (the project's main folder), so the task also says where
   * the code is and what's likely behind it; it takes a minute or two rather than seconds.
   * `several` (New Task, BLG-319): the words may ask for several tasks, or an epic with its
   * sub-tasks, and say who each is for. The first (or the epic) fills in this task; the rest are
   * added beside it (or under it), in its column, each for whoever the words gave it to.
   */
  createDescribed(input: Omit<NewIssue, 'title' | 'brief' | 'drafting'>, describe: string, opts: { readonly look?: string; readonly origin?: Issue['origin']; readonly several?: boolean } = {}): Issue {
    const text = describe.trim();
    if (!text) throw new Error('Say what the task is');
    const draft = this.deps.draftTask;
    const title = firstLineTitle(text);
    // Without your Claude: the first line, and what was said as the goal if it says more.
    if (!draft) return this.board.create({ ...input, title, ...(text.replace(/\s+/g, ' ') !== title ? { brief: { goal: text } } : {}) }, this.me(), opts.origin);
    const issue = this.board.create({ ...input, title, drafting: true }, this.me(), opts.origin);
    const done = draft(text, this.draftContext(issue.projectId, text, opts.look, opts.several))
      .catch(() => undefined)
      .then((d) => {
        try {
          this.board.finishDraft(issue.id, d, this.myClaude(), text);
          if (d && opts.several) this.addTheRest(issue, input, d);
        } catch {
          // Deleted meanwhile.
        }
      })
      .finally(() => this.drafts.delete(issue.id));
    this.drafts.set(issue.id, done);
    return issue;
  }

  /** The tasks after the first that one New Task message asked for, and who each is for (BLG-319). */
  private addTheRest(first: Issue, input: Omit<NewIssue, 'title' | 'brief' | 'drafting'>, d: TaskDraft): void {
    const now = this.board.need(first.id);
    // Words naming someone beat the sheet's Assignee; one changed by hand meanwhile stays.
    const named = d.epic ? undefined : this.whom(now.projectId, d.for);
    if (named && now.assignee?.id === input.assignee?.id && named.id !== now.assignee?.id) this.board.update(now.id, { assignee: named }, this.me());
    const made = this.addMore(now, input, d);
    if (!made.length) return;
    const list = andList(made.map((i) => i.key));
    this.deps.toast?.(d.epic ? `${now.key} is an epic: ${this.agent()} added ${list} under it` : `${this.agent()} also made ${list}, from what you wrote`);
  }

  /** A draft's `more`: beside the first (or under it, an epic), in its column, each for whom it names. */
  private addMore(first: Issue, input: Pick<NewIssue, 'labels' | 'priority' | 'assignee' | 'parent'>, d: TaskDraft): Issue[] {
    return (d.more ?? []).map((m) => {
      const who = this.whom(first.projectId, m.for) ?? input.assignee;
      return this.board.create(
        {
          projectId: first.projectId,
          title: m.title,
          status: first.status,
          labels: [...new Set([...(input.labels ?? []), ...m.labels])],
          ...(m.priority ? { priority: m.priority } : input.priority ? { priority: input.priority } : {}),
          ...(who ? { assignee: who } : {}),
          ...(d.epic ? { parent: first.id } : input.parent ? { parent: input.parent } : {}),
          brief: draftBrief(m),
        },
        this.me(),
      );
    });
  }

  /**
   * Start a worktree for a task (from the latest origin, or `base`), named after it, and open it;
   * with `claude`, your Claude starts on the task there with its brief. → the workspace's id.
   */
  async start(ref: string, opts: { readonly claude?: boolean; readonly base?: string; readonly quiet?: boolean; /** What your Claude is told instead of working the task through (it implies `claude`), and the line the conversation shows for it. */ readonly prompt?: (issue: Issue, ws: Workspace) => string; readonly shown?: string } = {}): Promise<string> {
    const controller = this.deps.controller;
    if (!controller) throw new Error('Worktrees need a project folder');
    // Claude still writing it: its worktree is named after, and Claude starts with, the real words.
    await this.drafts.get(this.board.need(ref).id);
    const issue = this.board.need(ref);
    // Finished (or canceled) work starts again only deliberately: reopened (back to Ready) first.
    if (isFinished(issue.status) || issue.status === 'canceled') throw new Error(`${issue.key} is ${STATUS_INFO[issue.status].label.toLowerCase()}: reopen it to start it again`);
    if (isArchived(issue)) throw new Error(`${issue.key} is in the Archive: restore it to start it`);
    // One worktree per task at a time: its own, or another carrying its work, is where to go.
    const doing = worktreeDoing(issue, (id) => this.workspaces().some((w) => w.id === id && !w.archived));
    const live = doing ? this.workspaces().find((w) => w.id === doing) : undefined;
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
      // You took it on (when it was nobody's): it's yours. Someone else's stays theirs; that you work on it shows on its own.
      // A plan's task stays no one's: the plan's Claude does it (one given to a person waits for them).
      ...((opts.claude || opts.prompt) && !now.assignee && !now.plan ? { assignee: this.me() } : {}),
    };
    if (Object.keys(patch).length) this.board.update(issue.id, patch, this.me());
    if (opts.prompt) this.deps.askClaude(opts.prompt(this.board.need(issue.id), ws), `${WS}${ws.id}`, opts.shown);
    else if (opts.claude) this.deps.askClaude(startPrompt(this.board.need(issue.id)), `${WS}${ws.id}`);
    return ws.id;
  }

  /**
   * One worktree for several tasks (a plan milestone's one Claude does them in order): named
   * `name`, from the latest origin or `base`, linked to every task (the first goes In Progress,
   * all are your Claude's). Nobody is asked anything: the caller sends the brief. → the workspace.
   */
  async startShared(refs: readonly string[], name: string, opts: { readonly base?: string; readonly quiet?: boolean } = {}): Promise<Workspace> {
    const controller = this.deps.controller;
    if (!controller) throw new Error('Worktrees need a project folder');
    if (!refs.length) throw new Error('No tasks to start');
    for (const ref of refs) await this.drafts.get(this.board.need(ref).id);
    const issues = refs.map((ref) => this.board.need(ref));
    for (const issue of issues) if (isFinished(issue.status)) throw new Error(`${issue.key} is ${STATUS_INFO[issue.status].label.toLowerCase()}: reopen it to start it again`);
    const first = issues[0]!;
    const slug = slugify(name).slice(0, 48) || first.key.toLowerCase();
    const ticket = { projectId: first.projectId, name: slug, issueId: first.id };
    this.expecting.push(ticket);
    let ws: Workspace | undefined;
    try {
      ws = await controller.newWorktree(first.projectId, slug, { ...(opts.base ? { base: opts.base } : {}), ...(opts.quiet ? { quiet: true } : {}) });
    } finally {
      const at = this.expecting.indexOf(ticket);
      if (at >= 0) this.expecting.splice(at, 1);
    }
    if (!ws) throw new Error('Couldn’t create the worktree');
    for (const issue of issues) this.linkShared(issue.id, ws);
    const now = this.board.need(first.id);
    if (now.status === 'backlog' || now.status === 'todo') this.board.update(first.id, { status: 'in_progress' }, this.me());
    return ws;
  }

  /** One more task for a worktree that does several (a milestone's Claude): linked, the others kept. */
  linkShared(ref: string, ws: Pick<Workspace, 'id' | 'branch' | 'name'>): Issue {
    const issue = this.board.need(ref);
    if (!issue.worktrees.includes(ws.id) || issue.worktrees.at(-1) !== ws.id) this.board.linkWorktree(issue.id, ws.id, { branch: ws.branch, name: ws.name, shared: true }, this.me());
    return this.board.need(issue.id);
  }

  /** Instructions of their own for a run (a plan milestone's worktree): instead of the one task's brief. */
  setRunBrief(fn: (channel: string) => { readonly brief: string; readonly current?: Issue } | undefined): void {
    this.runBrief = fn;
  }

  /**
   * What one of Claude's runs gets: the task it's doing (in its prompt) and the task tools (your
   * own runs only). Planning (plan mode), Claude defines the task the plan is for; it goes on the
   * board when you approve the plan (`planApproved`), never before.
   */
  forRun(channel: string, from: string, opts: { readonly plan?: boolean } = {}): RunBoard | undefined {
    if (from !== this.deps.selfId()) return undefined;
    const own = opts.plan ? undefined : this.runBrief(channel);
    const issue = own ? own.current : channel.startsWith(WS) ? issueForWorkspace(this.board.state(), channel.slice(WS.length)) : undefined;
    const tools = this.toolsFor(channel, issue, Boolean(opts.plan));
    const parallel = this.parallelNote(channel, issue);
    const projectId = this.runProject(channel, issue);
    const about = projectId ? aboutPrompt(this.board.state(), projectId) : '';
    const brief = (own ? own.brief : issue ? briefPrompt(this.board.state(), issue) + this.briefExtra(issue) : boardNote()) + about + parallel + (opts.plan ? definePrompt(Boolean(issue)) : '');
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
          assignee: this.me(),
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

  /** The project a run is in: its task's, or its worktree's. */
  private runProject(channel: string, current: Issue | undefined): string | undefined {
    const wsId = channel.startsWith(WS) ? channel.slice(WS.length) : undefined;
    return current?.projectId ?? (wsId ? this.workspaces().find((w) => w.id === wsId)?.projectId : undefined);
  }

  /** Other tasks being worked on in this project right now: so Claudes working side by side know about each other. */
  private parallelNote(channel: string, current: Issue | undefined): string {
    const projectId = this.runProject(channel, current);
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
      ...others.map(({ issue, place, working }) => `- ${issue.key} “${issue.title}” (${issue.status === 'in_review' ? 'in review' : 'in progress'}) in worktree ${place.name}${place.branch ? ` on ${place.branch}` : ''}${working ? ', its agent is working now' : ''}`),
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
        this.board.keepProofs();
        return this.board.worktreeGone(event.id, true, 'archived');
      case 'removed':
        this.board.keepProofs();
        return this.board.worktreeGone(event.id, true, 'deleted');
      case 'restored':
        return this.board.worktreeGone(event.id, false, 'restored');
    }
  }

  private opened(ws: Workspace, from: string | undefined): void {
    this.names.set(ws.id, ws.name);
    if (ws.kind !== 'worktree') return;
    void this.describeOnce(ws.projectId);
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
    const issue = this.board.create({ projectId: ws.projectId, title: titleFromName(ws.name), autoTitle: true, status: 'in_progress', assignee: this.me() }, beluga, 'worktree');
    this.board.linkWorktree(issue.id, ws.id, { branch: ws.branch, name: ws.name }, beluga);
  }

  /**
   * A project's first worktree here, and no one has written what it's about (BLG-298): your Claude
   * takes a quick look at its folder in the background and writes it. Never over one someone
   * wrote or cleared (a teammate's arriving meanwhile wins), and tried once per project per run.
   */
  async describeOnce(projectId: string): Promise<void> {
    const describe = this.deps.describeProject;
    if (!describe || this.described.has(projectId) || this.board.state().projects[projectId]?.context) return;
    const project = this.deps.store.getState().projects.find((p) => p.id === projectId && p.root);
    if (!project) return;
    this.described.add(projectId);
    const text = await describe(project.root, project.name).catch(() => undefined);
    if (!text || this.board.state().projects[projectId]?.context) return;
    try {
      this.board.setContext(projectId, text, agentLabel(defaultAgentOf(this.deps.store.getState().self), this.deps.selfName(), false));
    } catch {
      return; // The project went meanwhile.
    }
    this.deps.toast?.(`${this.agent()} wrote what ${project.name} is about: Tasks › ⋯ › About This Project`);
  }

  private onAction(action: Action): void {
    switch (action.type) {
      case 'pr':
        this.board.prChanged(action.id, action.pr);
        return;
      case 'system':
        // Continue After Merge's divider: the worktree's task carries on past its merged PR.
        if (action.shipped && action.channel?.startsWith(WS)) this.board.continuedAfterMerge(action.channel.slice(WS.length), action.shipped.number);
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

  /** This conversation's worktree carries a task Claude moved along here (when the task has no worktree of its own still there). */
  private carryHere(channel: string, issueId: string): void {
    const ws = channel.startsWith(WS) ? this.workspaces().find((w) => w.id === channel.slice(WS.length)) : undefined;
    if (ws?.kind !== 'worktree') return;
    this.board.carry(issueId, ws, (id) => this.workspaces().some((w) => w.id === id && !w.archived));
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
    // Labels come from the project's set: what wasn't in it is said, with the set, so Claude picks again.
    const leftOut = (projectId: string, wanted: readonly string[] | undefined, had: readonly string[] = []): string => {
      const set = labelsFor(state(), projectId);
      const { unknown } = inSet(set, wanted ?? []);
      const dropped = unknown.filter((l) => !had.includes(l));
      return dropped.length ? `. Left out ${dropped.join(', ')}: labels come from the board's set (${set.map((l) => l.name).join(', ')}); people add new ones` : '';
    };
    // A task is for a person (BLG-278): "claude" (an older tool call) means the user's.
    const assign = (to: 'me' | 'claude' | 'nobody' | undefined): Assignee | null | undefined => (to === 'me' || to === 'claude' ? this.me() : to === 'nobody' ? null : undefined);
    const where = (issue: Issue): string | undefined => {
      const w = issue.worktrees.at(-1);
      const place = w ? this.workspaces().find((x) => x.id === w && !x.archived) : undefined;
      if (!place) return undefined;
      const working = busyChannels(this.deps.store.getState().log).has(`${WS}${place.id}`);
      return `worktree ${place.name}${place.branch ? ` (${place.branch})` : ''}${`${WS}${place.id}` === channel ? ', this conversation' : working ? ', its agent is working there now' : ''}`;
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
        return describeList(f.scope === 'all' || f.scope === 'mine' ? found : found.filter((i) => isOpen(i.status)), state());
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
        return `Created ${issue.key}: ${issue.title} (${issue.status})${leftOut(projectId, input.labels)}`;
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
        // Moved along from a worktree that isn't doing it: that worktree's pull request ships it (see Board.carry).
        if (patch.status === 'in_progress' || patch.status === 'in_review') this.carryHere(channel, issue.id);
        const next = board.update(issue.id, { ...(patch.title ? { title: patch.title } : {}), ...(patch.status ? { status: patch.status } : {}), ...(patch.priority ? { priority: patch.priority } : {}), ...(patch.labels ? { labels: patch.labels } : {}), ...(patch.estimate !== undefined ? { estimate: patch.estimate } : {}), ...(assignee !== undefined ? { assignee } : {}) }, by());
        return `${next.key} is now: ${next.title} · ${next.status} · priority ${next.priority}${next.estimate ? ` · ${next.estimate} points` : ''}${next.labels.length ? ` · labels ${next.labels.join(', ')}` : ''}${leftOut(next.projectId, patch.labels, issue.labels)}`;
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
  const lines = [`Work on ${issue.key}: ${issue.title}.`, `You're working on ${issue.key} in this worktree, on your own: carry it through to done.`];
  const part = (label: string, text: string | undefined): void => {
    if (text?.trim()) lines.push('', label, text.trim());
  };
  part('Goal:', issue.brief.goal);
  part('Done means:', issue.brief.acceptance);
  part('Context:', issue.brief.context);
  part('Decided already:', issue.brief.decisions);
  if (issue.github) lines.push('', gitHubLine(issue.github));
  lines.push('', `Its full brief is in your instructions. Keep ${issue.key} true as you go (decisions, sub-tasks, proof, notes for the next agent).`);
  return lines.join('\n');
}

/** "BLG-1", "BLG-1 and BLG-2", "BLG-1, BLG-2 and BLG-3". */
export const andList = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** A draft's goal and criteria as a task's brief. */
function draftBrief(d: TaskDraft): Partial<Record<BriefSection, string>> {
  const acceptance = d.acceptance.map((a) => `- [ ] ${a.replace(/\s+/g, ' ').trim()}`).join('\n');
  return { ...(d.goal.trim() ? { goal: d.goal.trim() } : {}), ...(d.context?.trim() ? { context: d.context.trim() } : {}), ...(acceptance ? { acceptance } : {}) };
}
