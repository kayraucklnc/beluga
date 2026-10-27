import path from 'node:path';
import { readJson, writeJson } from '../../net/mesh/files.js';
import type { Board } from '../board/board.js';
import { type Actor, type AnyAssignee, type Issue, personOf } from '../board/model.js';
import type { TaskView } from '../gateway/model.js';
import { isFinal } from '../gateway/model.js';
import type { Action } from '../store.js';
import type { TeamBoardSync } from './board-sync.js';
import type { Field } from './crdt.js';
import type { TeamAssignment, TeamState } from './model.js';
import type { TeamBoards, TeamPart } from './service.js';

/**
 * Giving a team task to a teammate (BLG-223). A task is for a person, never a Claude (BLG-278).
 *
 * - **To a teammate:** the assignee travels with the board. On their Mac it's in My Tasks, and a
 *   teammate's change that makes it theirs notifies them and waits in their inbox (`assigned`; the
 *   phone's NeedsYou card, Got It) until they've seen it.
 * - **Not to a teammate's Claude** (BLG-262): giving one a task only pinged them to start, so it's
 *   gone (the board makes one given to someone's Claude theirs). You ask their Claude in a chat with them, @-mentioning the
 *   task. A request sent before that still lands on the task when it's answered: its summary and
 *   files as proof, and a note from their Claude (the note travels with the board).
 *
 * File: `team-asks.json` (requests sent for a task, until they're answered).
 */

export interface AssignDeps {
  readonly board: Board;
  readonly sync: TeamBoardSync;
  readonly dir: string | null;
}

interface Asked {
  readonly task: string;
  readonly issueId: string;
  readonly peerId: string;
  readonly at: number;
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
        return !i || i.assignee?.id !== self;
      });
      if (gone.length) {
        this.inbox = this.inbox.filter((a) => !gone.includes(a));
        this.save();
        this.team.publish();
      }
    }
  }

  /** A teammate gave it to you (an older teammate's "your Claude" is you too). */
  private theirs(issue: Issue, f: Field, by: string): void {
    const self = this.team.self;
    const a = f.v ? personOf(f.v as AnyAssignee) : null;
    if (a?.id !== self) return;
    // Only who set it counts (a teammate passing it on isn't who gave it).
    const giver = f.a === self ? by : f.a;
    const name = this.team.nameOf(giver);
    this.inbox = [...this.inbox.filter((x) => x.issueId !== issue.id), { issueId: issue.id, key: issue.key, title: issue.title, projectId: issue.projectId, byId: giver, by: name, at: this.team.now() }].slice(-50);
    this.save();
    this.team.publish();
    this.team.deps.notify?.({ kind: 'needsYou', tag: 'task', title: `${name} gave you ${issue.key}`, body: issue.title, need: `team-task:${issue.id}`, key: `team-assign:${issue.id}:${f.l}:${f.a}` });
  }

  /** Their Claude's answer to a request sent before BLG-262: proof and a note on the task. */
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
