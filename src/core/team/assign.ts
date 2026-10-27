import path from 'node:path';
import { readJson, writeJson } from '../../net/mesh/files.js';
import type { Board } from '../board/board.js';
import { type Actor, type Assignee, type Issue, githubRef } from '../board/model.js';
import type { TaskView } from '../gateway/model.js';
import { isFinal } from '../gateway/model.js';
import type { Action } from '../store.js';
import type { TeamBoardSync } from './board-sync.js';
import type { Field } from './crdt.js';
import type { TeamAssignment, TeamState } from './model.js';
import type { TeamBoards, TeamPart } from './service.js';

/**
 * Giving a team task to a teammate or their Claude (BLG-223).
 *
 * - **To a teammate:** the assignee travels with the board. On their Mac it's in My Tasks, and a
 *   teammate's change that makes it theirs notifies them and waits in their inbox (`assigned`; the
 *   phone's NeedsYou card, Got It) until they've seen it.
 * - **To a teammate's Claude:** the Mac where it was assigned sends it as a request to their
 *   Claude (the gateway's `ask`, as you: their usual trust, rules and approval card apply), with the
 *   task's brief, in their own project. What comes back lands on the task here: its summary and
 *   files as proof, and a note from their Claude (the note travels with the board).
 *
 * File: `team-asks.json` (requests sent for a task, until they're answered).
 */

export interface AssignDeps {
  readonly board: Board;
  readonly sync: TeamBoardSync;
  /** Ask a teammate's Claude (the gateway; undefined while it isn't running) → the request's id. */
  readonly askClaude?: (peerId: string, ask: string, summary: string, project: string | undefined) => string;
  readonly dir: string | null;
}

interface Asked {
  readonly task: string;
  readonly issueId: string;
  readonly peerId: string;
  readonly at: number;
}

/** What a teammate's Claude is asked when a task is given to it: the brief, never anything of yours. */
export function assignPrompt(issue: Issue, from: string, repo: string): string {
  const lines = [`${from} gave your Claude a task you two keep on a shared board for ${repo}: “${issue.title}” (${issue.key} on ${from}'s board).`, 'Work on it in this project, then end with what you did and how to check it.'];
  const part = (label: string, text: string | undefined): void => {
    if (text?.trim()) lines.push('', label, text.trim());
  };
  part('Goal:', issue.brief.goal);
  part('Done means:', issue.brief.acceptance);
  part('Context:', issue.brief.context);
  part('Decided already:', issue.brief.decisions);
  if (issue.github) lines.push('', `It's for GitHub issue ${githubRef(issue.github)} (${issue.github.url}).`);
  return lines.join('\n');
}

export class TeamAssign implements TeamPart {
  private inbox: TeamAssignment[] = [];
  private asked: Asked[] = [];

  constructor(
    private readonly team: TeamBoards,
    private readonly deps: AssignDeps,
  ) {
    this.load();
    deps.sync.onChange((c) => {
      if (c.won.assignee) this.theirs(c.issue, c.won.assignee, c.link.peerId);
    });
    deps.sync.onLocal((issue, changed) => {
      if (changed.assignee) this.mine(issue, changed.assignee);
    });
  }

  view(): Partial<TeamState> {
    return { assigned: this.inbox };
  }

  /** You've seen it (Got It): out of your inbox. */
  ack(issueId: string): void {
    const before = this.inbox.length;
    this.inbox = this.inbox.filter((a) => a.issueId !== issueId);
    if (this.inbox.length !== before) {
      this.save();
      this.team.publish();
    }
  }

  onAction(action: Action): void {
    if (action.type === 'gw_task') this.result(action.task);
    if (action.type === 'board_issue' || action.type === 'board_remove') {
      // No longer yours (someone else took it, or it went): out of the inbox.
      const self = this.team.self;
      const gone = this.inbox.filter((a) => {
        const i = this.deps.board.get(a.issueId);
        return !i || !((i.assignee?.kind === 'person' && i.assignee.id === self) || (i.assignee?.kind === 'claude' && i.assignee.owner === self));
      });
      if (gone.length) {
        this.inbox = this.inbox.filter((a) => !gone.includes(a));
        this.save();
        this.team.publish();
      }
    }
  }

  /** A teammate gave it to you (or your Claude). */
  private theirs(issue: Issue, f: Field, by: string): void {
    const self = this.team.self;
    const a = f.v as Assignee | null;
    if (!a) return;
    const toMe = a.kind === 'person' && a.id === self;
    const toMyClaude = a.kind === 'claude' && a.owner === self;
    if (!toMe && !toMyClaude) return;
    // Only who set it counts (a teammate passing it on isn't who gave it).
    const giver = f.a === self ? by : f.a;
    const name = this.team.nameOf(giver);
    if (toMe) {
      this.inbox = [...this.inbox.filter((x) => x.issueId !== issue.id), { issueId: issue.id, key: issue.key, title: issue.title, projectId: issue.projectId, byId: giver, by: name, at: this.team.now() }].slice(-50);
      this.save();
      this.team.publish();
    }
    this.team.deps.notify?.({ kind: 'needsYou', tag: 'task', title: toMe ? `${name} gave you ${issue.key}` : `${name} gave your Claude ${issue.key}`, body: toMe ? issue.title : `${issue.title}. Their request comes to you as usual.`, ...(toMe ? { need: `team-task:${issue.id}` } : {}), key: `team-assign:${issue.id}:${f.l}:${f.a}` });
  }

  /** You gave it to a teammate's Claude here: it goes to them as a request. */
  private mine(issue: Issue, f: Field): void {
    const a = f.v as Assignee | null;
    if (a?.kind !== 'claude' || a.owner === this.team.self) return;
    const link = this.team.linksOf(issue.projectId).find((l) => l.peerId === a.owner);
    if (!link) return;
    const by: Actor = { kind: 'beluga' };
    const why = this.team.cannot(a.owner, 'task.ask');
    if (why || !this.deps.askClaude) {
      this.deps.board.comment(issue.id, why ?? `Couldn't ask ${a.ownerName}'s Claude: requests to Claudes need the Beluga app`, by);
      return;
    }
    const repo = this.team.deps.store.getState().team.teams[issue.projectId]?.repo ?? 'this repository';
    try {
      const task = this.deps.askClaude(a.owner, assignPrompt(issue, this.selfName(), repo), `work on “${issue.title}”`.slice(0, 140), link.theirProject || undefined);
      this.asked = [...this.asked, { task, issueId: issue.id, peerId: a.owner, at: this.team.now() }].slice(-100);
      this.save();
    } catch (err) {
      this.deps.board.comment(issue.id, `Couldn't ask ${a.ownerName}'s Claude: ${err instanceof Error ? err.message : String(err)}`, by);
    }
  }

  private selfName(): string {
    const st = this.team.deps.store.getState();
    return st.network.self?.name ?? st.self?.name ?? 'Your teammate';
  }

  /** Their Claude's answer: proof and a note on the task. */
  private result(task: TaskView): void {
    const asked = this.asked.find((x) => x.task === task.id);
    if (!asked || !isFinal(task.state) || !task.result) return;
    this.asked = this.asked.filter((x) => x !== asked);
    this.save();
    const issue = this.deps.board.get(asked.issueId);
    if (!issue) return;
    const claude: Actor = { kind: 'claude', owner: asked.peerId, ownerName: this.team.nameOf(asked.peerId) };
    const r = task.result;
    if (r.status === 'done') {
      if (r.summary.trim()) this.deps.board.addProof(issue.id, { kind: 'text', title: `What ${claude.ownerName}'s Claude did`, body: r.summary.slice(0, 60_000) }, claude);
      for (const f of r.files.filter((x) => x.path)) this.deps.board.addProof(issue.id, { kind: f.image ? 'image' : 'file', title: f.name.slice(0, 120), path: f.path! }, claude);
      this.deps.board.comment(issue.id, r.summary.trim() ? r.summary.slice(0, 8000) : 'Done.', claude);
    } else this.deps.board.comment(issue.id, `${r.status === 'declined' ? 'Declined' : r.status === 'cancelled' ? 'Cancelled' : "Couldn't do it"}: ${r.summary.slice(0, 7000) || 'no reason given'}`, claude);
  }

  private load(): void {
    if (!this.deps.dir) return;
    const saved = readJson(path.join(this.deps.dir, 'team-asks.json')) as { inbox?: unknown; asked?: unknown } | undefined;
    if (Array.isArray(saved?.inbox)) this.inbox = (saved.inbox as TeamAssignment[]).filter((a) => a && typeof a.issueId === 'string');
    if (Array.isArray(saved?.asked)) this.asked = (saved.asked as Asked[]).filter((a) => a && typeof a.task === 'string');
  }

  private save(): void {
    if (!this.deps.dir) return;
    try {
      writeJson(path.join(this.deps.dir, 'team-asks.json'), { inbox: this.inbox, asked: this.asked });
    } catch {
      // Best effort.
    }
  }
}
