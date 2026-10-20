import type { BoardTools } from '../../agent/types.js';
import { slugify } from '../../agent/namer.js';
import { isSecretPath } from '../shares.js';
import type { Action, Store } from '../store.js';
import type { Workspace } from '../../workspaces/types.js';
import type { WorkspaceController, WorktreeEvent } from '../workspace-controller.js';
import { Board, type IssuePatch } from './board.js';
import { briefPrompt, boardNote, describeIssue, describeList } from './prompt.js';
import { type Actor, type Assignee, BRIEF_SECTIONS, type BriefSection, type Issue, filterIssues, isOpen, issueForWorkspace, titleFromName } from './model.js';

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
}

const WS = 'ws:';

export class BoardWork {
  readonly board: Board;
  /** Worktrees opened as tasks without knowing what for yet: the first thing you say there becomes the goal. */
  private readonly awaitingGoal = new Set<string>();
  /** Worktrees being started for tasks (Start Worktree): the one that opens under that name belongs to that task. */
  private readonly expecting: Array<{ readonly projectId: string; readonly name: string; readonly issueId: string }> = [];
  private readonly names = new Map<string, string>();
  private readonly offs: Array<() => void> = [];

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
   * Start a worktree for a task (from the latest origin, or `base`), named after it, and open it;
   * with `claude`, your Claude starts on the task there with its brief. → the workspace's id.
   */
  async start(ref: string, opts: { readonly claude?: boolean; readonly base?: string } = {}): Promise<string> {
    const controller = this.deps.controller;
    if (!controller) throw new Error('Worktrees need a project folder');
    const issue = this.board.need(ref);
    const name = slugify(`${issue.key} ${issue.title}`).slice(0, 48) || issue.key.toLowerCase();
    const ticket = { projectId: issue.projectId, name, issueId: issue.id };
    this.expecting.push(ticket);
    let ws: Workspace | undefined;
    try {
      ws = await controller.newWorktree(issue.projectId, name, opts.base ? { base: opts.base } : {});
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

  /** What one of Claude's runs gets: the task it's doing (in its prompt) and the task tools (your own runs only). */
  forRun(channel: string, from: string): { readonly tools?: BoardTools; readonly brief?: string } | undefined {
    if (from !== this.deps.selfId()) return undefined;
    const issue = channel.startsWith(WS) ? issueForWorkspace(this.board.state(), channel.slice(WS.length)) : undefined;
    const tools = this.toolsFor(channel, issue);
    return { tools, brief: issue ? briefPrompt(this.board.state(), issue) : boardNote() };
  }

  // ------------------------------------------------------------------ following worktrees

  private onWorktree(event: WorktreeEvent): void {
    switch (event.kind) {
      case 'created':
        return this.opened(event.ws, event.from, event.about);
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

  private opened(ws: Workspace, from: string | undefined, about: string | undefined): void {
    this.names.set(ws.id, ws.name);
    if (ws.kind !== 'worktree') return;
    const state = this.board.state();
    const linked = (id: string): Issue | undefined => issueForWorkspace(state, id);
    const klaud: Actor = { kind: 'klaud' };
    // Started from a task: the worktree opened under its name (perhaps with "-2" when taken).
    const at = this.expecting.findIndex((e) => e.projectId === ws.projectId && (ws.name === e.name || ws.name.startsWith(`${e.name}-`)));
    if (at >= 0) {
      const [expected] = this.expecting.splice(at, 1);
      this.board.linkWorktree(expected!.issueId, ws.id, { branch: ws.branch, name: ws.name }, this.me());
      return;
    }
    // A fork, or a conversation carried on: the same task, in its new worktree.
    const source = from ? linked(from) : undefined;
    if (source) {
      this.board.linkWorktree(source.id, ws.id, { branch: ws.branch, name: ws.name }, klaud);
      return;
    }
    if (!this.board.autoTasksOn || !this.deps.store.getState().projects.some((p) => p.id === ws.projectId && p.root)) return;
    const goal = about?.trim();
    const issue = this.board.create(
      { projectId: ws.projectId, title: titleFromName(ws.name), autoTitle: true, status: 'in_progress', assignee: this.myClaude(), ...(goal ? { brief: { goal } } : {}) },
      klaud,
      'worktree',
    );
    this.board.linkWorktree(issue.id, ws.id, { branch: ws.branch, name: ws.name }, klaud);
    if (!goal) this.awaitingGoal.add(ws.id);
  }

  private onAction(action: Action): void {
    switch (action.type) {
      case 'pr':
        this.board.prChanged(action.id, action.pr);
        return;
      case 'projects':
        this.renamed();
        return;
      case 'chat': {
        const id = action.channel?.startsWith(WS) ? action.channel.slice(WS.length) : undefined;
        if (!id || !this.awaitingGoal.has(id) || action.byAgent || action.from !== this.deps.selfId()) return;
        this.awaitingGoal.delete(id);
        const issue = issueForWorkspace(this.board.state(), id);
        if (issue && !issue.brief.goal && action.text.trim()) this.board.editBrief(issue.id, 'goal', action.text.trim(), this.me(), { reason: 'what you first asked in its worktree' });
        return;
      }
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

  private toolsFor(channel: string, current: Issue | undefined): BoardTools {
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
    return {
      ...(current ? { current: current.key } : {}),
      get: (key) => describeIssue(state(), pick(key), this.deps.selfId()),
      list: (f) => {
        // open (the default): every unfinished task; mine: yours and your Claude's; all: recently finished too.
        const found = filterIssues(state(), {
          scope: f.scope === 'mine' ? 'mine' : 'all',
          selfId: this.deps.selfId(),
          ...(f.project ? { projectId: projectByName(f.project) } : {}),
          ...(f.query ? { query: f.query } : {}),
        });
        return describeList(f.scope === 'all' || f.scope === 'mine' ? found : found.filter((i) => isOpen(i.status)));
      },
      create: (input) => {
        const projectId = input.project ? projectByName(input.project) : input.parent ? board.need(input.parent).projectId : (current?.projectId ?? wsProject());
        if (!projectId) throw new Error('Say which project (project: its name)');
        const brief: Partial<Record<BriefSection, string>> = { ...(input.goal ? { goal: input.goal } : {}), ...(input.acceptance ? { acceptance: input.acceptance } : {}), ...(input.context ? { context: input.context } : {}) };
        const issue = board.create(
          {
            projectId,
            title: input.title,
            status: input.status ?? 'todo',
            ...(input.priority ? { priority: input.priority } : {}),
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
        const next = board.update(issue.id, { ...(patch.title ? { title: patch.title } : {}), ...(patch.status ? { status: patch.status } : {}), ...(patch.priority ? { priority: patch.priority } : {}), ...(patch.labels ? { labels: patch.labels } : {}), ...(assignee !== undefined ? { assignee } : {}) }, by());
        return `${next.key} is now: ${next.title} · ${next.status} · priority ${next.priority}`;
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

/** What Claude is told when a task starts its worktree with Claude on it. */
export function startPrompt(issue: Issue): string {
  const lines = [`Work on ${issue.key}: ${issue.title}.`];
  if (issue.brief.goal) lines.push('', issue.brief.goal);
  if (issue.brief.acceptance) lines.push('', 'Done means:', issue.brief.acceptance);
  lines.push('', 'Its full brief is in your instructions. Keep the task true as you go (decisions, sub-tasks, proof, notes for the next agent).');
  return lines.join('\n');
}

