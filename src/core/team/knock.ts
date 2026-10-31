import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson } from '../../net/mesh/files.js';
import type { WsRole } from '../../protocol.js';
import type { Board } from '../board/board.js';
import { worktreeDoing } from '../board/model.js';
import type { Intent } from '../intents.js';
import type { Action, Store } from '../store.js';
import { type MyKnock, type TeamKnock, type TeamState, workingOn } from './model.js';
import type { TeamMsg } from './protocol.js';
import type { TeamBoards, TeamLink, TeamPart } from './service.js';

/**
 * Knocking on a teammate's worktree (BLG-416). The board says Ata is working on a task; you
 * knock, and Ata's Mac finds the worktree doing it. The knock shows in that worktree's chat (a
 * card there) and as a notification, the bell's and the phone's: Let In as Viewer, as Editor, or
 * Not Now. Letting you in shares that one worktree with you the friend-share way, so its chat
 * and files work just as a worktree Ata shared by hand; your Mac opens it when it arrives.
 *
 * - Only teammates on the task's project can knock (only they see who's on what).
 * - A knock waits for the host's Mac (the courier mails it); a task no worktree does any more is
 *   answered `gone` by itself, and someone already in gets their way back in at once.
 * - Take it back (Cancel) and it's gone from their Mac too.
 *
 * File: `team-knocks.json` (knocks at your door, and yours, until answered or a day old).
 */

export interface KnockDeps {
  readonly board: Board;
  readonly store: Store;
  /** Is this worktree still there (not archived)? */
  readonly live: (workspaceId: string) => boolean;
  /** Share one worktree with a teammate (friend-share); throws when it can't. */
  readonly letIn: (peerId: string, workspaceId: string, role: WsRole) => void;
  readonly intend?: (intent: Intent) => void;
  readonly dir: string | null;
}

/** Answers older than this aren't shown on the task any more. */
const SHOW_ANSWER_MS = 6 * 3_600_000;
/** A knock nobody answered in a day is let go. */
const KNOCK_TTL_MS = 24 * 3_600_000;
/** Let in this soon after knocking: you're still waiting, so it opens by itself. */
const OPEN_WITHIN_MS = 15 * 60_000;

const newId = (): string => `kn_${randomBytes(9).toString('base64url')}`;
const roleWords = (role: WsRole): string => (role === 'contribute' ? 'as an editor' : 'as a viewer');

export class TeamKnocks implements TeamPart {
  private knocks: TeamKnock[] = [];
  private mine: MyKnock[] = [];
  /** Let in, waiting for the worktree to arrive to open it. */
  private opening = new Set<string>();

  constructor(
    private readonly team: TeamBoards,
    private readonly deps: KnockDeps,
  ) {
    this.load();
  }

  view(): Partial<TeamState> {
    const now = this.team.now();
    return {
      knocks: this.knocks,
      myKnocks: this.mine.filter((k) => k.state === 'waiting' || now - (k.answeredAt ?? k.at) < SHOW_ANSWER_MS),
    };
  }

  // ---------------------------------------------------------------- yours (the guest)

  /** Knock on the worktree doing a task: the teammate on it (or `peerId`, one of them) is asked to let you in. */
  knock(issueId: string, peerId?: string, note?: string): MyKnock {
    const issue = this.deps.board.get(issueId);
    if (!issue) throw new Error('That task isn’t on your board');
    const self = this.team.self;
    const on = workingOn(this.deps.store.getState().team, issueId).filter((p) => p.peerId !== self);
    const to = peerId ?? on[0]?.peerId;
    if (!to) throw new Error('No teammate is working on that task right now');
    const link = this.team.linksOf(issue.projectId).find((l) => l.peerId === to);
    // On the team through others (BLG-510): a worktree is shared over your own link.
    if (!link) throw new Error(this.team.rosters.members(issue.projectId, this.team.self).some((m) => m.peerId === to) ? `${this.team.nameOf(to)} is on the team through others: team up with them yourself to knock on their worktree` : `${this.team.nameOf(to)} isn’t on this project’s team`);
    const why = this.team.cannot(to, 'team.knock');
    if (why) throw new Error(why);
    const had = this.mine.find((k) => k.issueId === issueId && k.peerId === to && k.state === 'waiting');
    if (had) return had;
    const k: MyKnock = { id: newId(), issueId, peerId: to, name: this.team.nameOf(to), state: 'waiting', at: this.team.now() };
    this.mine = [k, ...this.mine.filter((x) => !(x.issueId === issueId && x.peerId === to))].slice(0, 50);
    this.save();
    this.team.send(to, { k: 'knock', link: link.id, id: k.id, task: issueId, ...(note?.trim() ? { note: note.trim().slice(0, 500) } : {}) });
    this.team.publish();
    this.team.deps.toast?.(`Knocked on ${k.name}’s worktree for ${issue.key}. You’ll hear when they answer`, 'success');
    return k;
  }

  /** Take a knock of yours back (or clear one they answered). */
  cancel(id: string): void {
    const k = this.mine.find((x) => x.id === id);
    if (!k) return;
    this.mine = this.mine.filter((x) => x !== k);
    this.opening.delete(id);
    this.save();
    if (k.state === 'waiting') {
      const link = this.linkWith(k.peerId, k.issueId);
      if (link) this.team.send(k.peerId, { k: 'knock_cancel', link: link.id, id });
    }
    this.team.publish();
  }

  private onAnswer(from: string, m: Extract<TeamMsg, { k: 'knock_answer' }>): void {
    const k = this.mine.find((x) => x.id === m.id && x.peerId === from);
    if (!k) return;
    const now = this.team.now();
    const role = m.answer === 'view' || m.answer === 'contribute' ? m.answer : undefined;
    const next: MyKnock = { ...k, state: role ? 'in' : m.answer === 'gone' ? 'gone' : 'declined', answeredAt: now, ...(role ? { role } : {}), ...(role && m.ws ? { workspaceId: m.ws } : {}) };
    this.mine = this.mine.map((x) => (x === k ? next : x));
    this.save();
    this.team.publish();
    const issue = this.deps.board.get(k.issueId);
    const what = issue ? `${issue.key}’s worktree` : 'their worktree';
    if (role) {
      this.team.deps.notify?.({ kind: 'people', tag: 'joined', title: `${k.name} let you in ${roleWords(role)}`, body: `You’re in ${what}${role === 'contribute' ? ': you can talk to their Claude there' : ': you can follow along'}. It’s in Projects.`, key: `knock-in:${k.id}` });
      if (m.ws && now - k.at < OPEN_WITHIN_MS) {
        this.opening.add(k.id);
        this.openIfThere(next);
      }
    } else if (m.answer === 'gone') this.team.deps.toast?.(`${k.name}’s worktree for ${issue?.key ?? 'that task'} isn’t there any more`, 'info');
    else this.team.deps.toast?.(`${k.name} said not now to joining ${what}`, 'info');
  }

  /** Let in: go to the worktree once friend-share has brought it. */
  private openIfThere(k: MyKnock): void {
    if (!this.opening.has(k.id) || !k.workspaceId) return;
    const ws = this.deps.store.getState().shared.find((w) => w.id === k.workspaceId && w.owner === k.peerId);
    if (!ws) return;
    this.opening.delete(k.id);
    this.deps.intend?.({ type: 'navigate', view: { kind: 'shared', owner: k.peerId, id: ws.id, tab: 'chat' } });
  }

  // ---------------------------------------------------------------- at your door (the host)

  /** Let a teammate in (as a viewer or an editor), or say not now. */
  answer(id: string, answer: WsRole | 'decline'): void {
    const k = this.knocks.find((x) => x.id === id);
    if (!k) throw new Error('That knock isn’t here any more');
    const link = this.linkWith(k.peerId, k.issueId);
    if (answer !== 'decline') {
      if (!this.deps.live(k.workspaceId)) {
        this.settle(k, 'gone');
        throw new Error(`${k.worktree} isn’t there any more`);
      }
      // Sharing can say no (their Beluga is too old for shared worktrees): the knock stays.
      this.deps.letIn(k.peerId, k.workspaceId, answer);
      this.line(k, `You let ${k.name} in ${roleWords(answer)}`);
    } else this.line(k, `You said not now to ${k.name}`);
    this.drop(k);
    if (link) this.team.send(k.peerId, { k: 'knock_answer', link: link.id, id, answer, ...(answer !== 'decline' ? { ws: k.workspaceId } : {}) });
  }

  private onKnock(from: string, m: Extract<TeamMsg, { k: 'knock' }>): void {
    const link = this.team.linkById(m.link);
    if (!link || link.peerId !== from) return;
    const issue = this.deps.board.get(m.task);
    const reply = (answer: 'view' | 'contribute' | 'gone', ws?: string): void => this.team.send(from, { k: 'knock_answer', link: link.id, id: m.id, answer, ...(ws ? { ws } : {}) });
    if (!issue || issue.projectId !== link.projectId) return reply('gone');
    const wsId = worktreeDoing(issue, this.deps.live);
    if (!wsId) return reply('gone');
    // Already in it: back in, the way they were.
    const role = this.deps.store.getState().members[wsId]?.[from];
    if (role) return reply(role, wsId);
    const name = this.team.nameOf(from);
    const ws = this.deps.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId);
    const worktree = ws?.name ?? issue.title;
    // One knock per teammate per worktree: knocking again only freshens it.
    const had = this.knocks.find((x) => x.peerId === from && x.workspaceId === wsId);
    const k: TeamKnock = { id: m.id, peerId: from, name, issueId: issue.id, key: issue.key, title: issue.title, projectId: issue.projectId, workspaceId: wsId, worktree, ...(m.note?.trim() ? { note: m.note.trim() } : {}), at: this.team.now() };
    this.knocks = [...this.knocks.filter((x) => x !== had && x.id !== m.id), k];
    this.save();
    this.team.publish();
    // In the worktree's chat (the Mac draws the knock's card there while it waits), and the bell.
    this.deps.store.dispatch({ type: 'system', id: `wt-knock-${k.id}`, channel: `ws:${wsId}`, text: `${name} knocked: they’d like to join this worktree${k.note ? `. “${k.note}”` : ''}` });
    this.team.deps.notify?.({ kind: 'needsYou', tag: 'invited', title: `${name} is knocking on ${worktree}`, body: k.note ? `“${k.note}”` : `They’d like to join the worktree doing ${issue.key}. Let them in as a viewer or an editor.`, channel: `ws:${wsId}`, need: `wt-knock:${k.id}`, key: `wt-knock:${k.id}` });
  }

  private onCancel(from: string, m: Extract<TeamMsg, { k: 'knock_cancel' }>): void {
    const k = this.knocks.find((x) => x.id === m.id && x.peerId === from);
    if (!k) return;
    this.line(k, `${k.name} took their knock back`);
    this.drop(k);
  }

  /** A knock that can't be let in (its worktree went): they hear so. */
  private settle(k: TeamKnock, answer: 'gone'): void {
    const link = this.linkWith(k.peerId, k.issueId);
    if (link) this.team.send(k.peerId, { k: 'knock_answer', link: link.id, id: k.id, answer });
    this.drop(k);
  }

  private drop(k: TeamKnock): void {
    this.knocks = this.knocks.filter((x) => x.id !== k.id);
    this.save();
    this.team.publish();
  }

  private line(k: TeamKnock, text: string): void {
    this.deps.store.dispatch({ type: 'system', channel: `ws:${k.workspaceId}`, text });
  }

  // ---------------------------------------------------------------- the part

  receive(from: string, m: TeamMsg): boolean {
    if (m.k === 'knock') this.onKnock(from, m);
    else if (m.k === 'knock_answer') this.onAnswer(from, m);
    else if (m.k === 'knock_cancel') this.onCancel(from, m);
    else return false;
    return true;
  }

  left(link: TeamLink): void {
    const before = this.knocks.length + this.mine.length;
    this.knocks = this.knocks.filter((k) => !(k.peerId === link.peerId && k.projectId === link.projectId));
    this.mine = this.mine.filter((k) => !(k.peerId === link.peerId && this.deps.board.get(k.issueId)?.projectId === link.projectId));
    if (this.knocks.length + this.mine.length !== before) this.save();
  }

  onAction(action: Action): void {
    if (action.type === 'shared_add' && this.opening.size) for (const k of this.mine) if (k.workspaceId === action.ws.id) this.openIfThere(k);
    // A worktree that went (archived, deleted): the knocks on it are answered.
    if (action.type === 'projects' && this.knocks.length) for (const k of this.knocks.filter((x) => !this.deps.live(x.workspaceId))) this.settle(k, 'gone');
  }

  private linkWith(peerId: string, issueId: string): TeamLink | undefined {
    const projectId = this.deps.board.get(issueId)?.projectId;
    return this.team.allLinks().find((l) => l.peerId === peerId && (!projectId || l.projectId === projectId));
  }

  private load(): void {
    if (!this.deps.dir) return;
    const saved = readJson(path.join(this.deps.dir, 'team-knocks.json')) as { knocks?: unknown; mine?: unknown } | undefined;
    const fresh = (at: unknown): boolean => typeof at === 'number' && Date.now() - at < KNOCK_TTL_MS;
    if (Array.isArray(saved?.knocks)) this.knocks = (saved.knocks as TeamKnock[]).filter((k) => k && typeof k.id === 'string' && typeof k.workspaceId === 'string' && fresh(k.at));
    if (Array.isArray(saved?.mine)) this.mine = (saved.mine as MyKnock[]).filter((k) => k && typeof k.id === 'string' && typeof k.issueId === 'string' && fresh(k.answeredAt ?? k.at));
  }

  private save(): void {
    if (!this.deps.dir) return;
    try {
      writeJson(path.join(this.deps.dir, 'team-knocks.json'), { knocks: this.knocks, mine: this.mine });
    } catch {
      // Best effort.
    }
  }
}
