import path from 'node:path';
import { readJson, writeJson } from '../../net/mesh/files.js';
import type { Board } from '../board/board.js';
import { type Activity, type Actor, type Assignee, BRIEF_SECTIONS, type BriefSection, type Issue, isArchived, worktreeDoing } from '../board/model.js';
import type { Action } from '../store.js';
import { type Field, LOCAL_ACTS, type SharedTask, canon, digest, fieldsOf, fromBoard, maxClock, merge, onBoard } from './crdt.js';
import type { TeamState } from './model.js';
import { type TaskDelta, type TeamMsg, fieldValue } from './protocol.js';
import type { TeamBoards, TeamLink, TeamPart } from './service.js';

/**
 * A team's board stays in step on every Mac (BLG-222). Every change to a task of a teamed project
 * here, however it was made (you, your Claude's task tools, a plan, a pull request moving it), is
 * seen as it reaches the shared state: the fields that differ from what the team has get a new
 * Lamport time and go to every teammate, with new activity. What comes from a teammate is merged
 * (crdt.ts), what won is written to the board quietly (no activity of its own: the author's
 * lines come with it), and passed on to the other teammates who haven't seen it, so a team of
 * three agrees even where two of them aren't linked to each other.
 *
 * Tasks keep one id on every Mac; each Mac gives them a key of its own project ("BLG-12" here may
 * be "API-40" on Ata's Mac), so keys never clash. Worktrees, branches, pull requests, proof files
 * and run details stay local; teammates see "Ata is working on this".
 *
 * Offline: changes wait in the courier's outbox (7 days). When a link comes up, both send a
 * digest of every field's clock; a different one is answered with a snapshot (everything, in
 * batches), so a teammate back after longer catches up too.
 *
 * File: `team-board.json` (each project's tasks as the team has them, and its clock).
 */

export interface BoardSyncDeps {
  readonly board: Board;
  /** A workspace is still here and not archived. */
  readonly live: (workspaceId: string) => boolean;
  /** Where team-board.json lives; null: memory only. */
  readonly dir: string | null;
}

/** What other parts hear: a teammate's change won here (assignment, BLG-223; issues, BLG-224). */
export interface TeamChange {
  readonly link: TeamLink;
  readonly issue: Issue;
  readonly won: Readonly<Record<string, Field>>;
  readonly fresh: boolean;
}

const BATCH_TASKS = 40;
const BATCH_BYTES = 700_000;
const SNAPSHOT_ACTS = 60;

export class TeamBoardSync implements TeamPart {
  private clocks: Record<string, number> = {};
  private tasks: Record<string, Record<string, SharedTask>> = {};
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly listeners: Array<(c: TeamChange) => void> = [];
  private readonly reconciled = new Set<string>();
  private readonly locals: Array<(issue: Issue, changed: Readonly<Record<string, Field>>) => void> = [];

  constructor(
    private readonly team: TeamBoards,
    private readonly deps: BoardSyncDeps,
  ) {
    this.load();
  }

  private get self(): string {
    return this.team.self;
  }

  /** Hear what a teammate changed (after it's on the board). */
  onChange(fn: (c: TeamChange) => void): void {
    this.listeners.push(fn);
  }

  /** Hear what changed here and went to the team (the fields, with their new clocks). */
  onLocal(fn: (issue: Issue, changed: Readonly<Record<string, Field>>) => void): void {
    this.locals.push(fn);
  }

  /** The team's copy of a task (undefined: not a team task). */
  shared(issueId: string): SharedTask | undefined {
    for (const byId of Object.values(this.tasks)) if (byId[issueId]) return byId[issueId];
    return undefined;
  }

  // ------------------------------------------------------------------ TeamPart

  joined(link: TeamLink, fresh: boolean): void {
    if (!fresh) {
      // Starting again (the network was off): what changed here meanwhile goes out now.
      if (this.reconciled.has(link.projectId) || !this.tasks[link.projectId]) return;
      this.reconciled.add(link.projectId);
      for (const issue of this.deps.board.list()) if (issue.projectId === link.projectId && (this.tasks[link.projectId]![issue.id] || !isArchived(issue))) this.observe(issue, true);
      return;
    }
    if (!this.tasks[link.projectId]) {
      this.tasks[link.projectId] = {};
      // Teaming up shares the board as it is (archived tasks stay yours).
      for (const issue of this.deps.board.list()) if (issue.projectId === link.projectId && !isArchived(issue)) this.observe(issue, false);
    }
    this.snapshot(link);
    this.save();
  }

  left(link: TeamLink): void {
    if (this.team.linksOf(link.projectId).length) return;
    // Nobody left to share with: your tasks stay as they are, and stop being team tasks.
    delete this.tasks[link.projectId];
    delete this.clocks[link.projectId];
    this.save();
  }

  linkUp(peerId: string): void {
    for (const link of this.team.allLinks()) if (link.peerId === peerId) this.team.courier.send(peerId, { k: 'digest', link: link.id, hash: this.hashOf(link.projectId) }, { reliable: false });
  }

  receive(from: string, m: TeamMsg): boolean {
    if (m.k !== 'ops' && m.k !== 'digest') return false;
    const link = this.team.linkById(m.link);
    if (!link || link.peerId !== from) return true;
    if (m.k === 'digest') {
      if (m.hash !== this.hashOf(link.projectId)) this.snapshot(link);
      return true;
    }
    for (const d of m.tasks) this.take(link, d);
    this.save();
    return true;
  }

  onAction(action: Action): void {
    // While a teammate's change is written, the team's copy already has it: only what follows from
    // it here (a parent's sub-tasks reaching Done) reads as a change, and goes out like any other.
    if (action.type === 'board_issue') this.observe(action.issue, true);
    if (action.type === 'board_remove') this.removed(action.id);
  }

  view(): Partial<TeamState> {
    const working: Record<string, Array<{ peerId: string; name: string }>> = {};
    for (const byId of Object.values(this.tasks)) {
      for (const t of Object.values(byId)) {
        for (const [name, f] of Object.entries(t.fields)) {
          if (!name.startsWith('working.') || f.v !== true) continue;
          const peerId = name.slice(8);
          if (peerId === this.self) continue;
          (working[t.id] ??= []).push({ peerId, name: this.team.nameOf(peerId) });
        }
      }
    }
    return { working };
  }

  stop(): void {
    if (this.saveTimer) this.saveNow();
  }

  // ------------------------------------------------------------------ my changes

  private has = (id: string): boolean => Boolean(this.deps.board.get(id));

  private tick(projectId: string): number {
    const l = (this.clocks[projectId] ?? 0) + 1;
    this.clocks[projectId] = l;
    return l;
  }

  /** A task changed here: what differs from the team's copy goes to every teammate. */
  private observe(issue: Issue, send: boolean): void {
    const byId = this.tasks[issue.projectId];
    if (!byId || !this.team.teamed(issue.projectId)) return;
    const rec = byId[issue.id];
    const doing = worktreeDoing(issue, this.deps.live) !== undefined;
    const mine = fieldsOf(issue, this.self, doing);
    const changed: Record<string, Field> = {};
    for (const [name, value] of Object.entries(mine)) {
      const cur = rec?.fields[name];
      if (cur && canon(onBoard(name, cur.v, this.has)) === canon(value)) continue;
      // Nothing of mine to say yet (no one works on it, no deletion): only once it's something.
      if (!cur && (value === null || value === false) && name.startsWith('working.')) continue;
      const v = cur ? fromBoard(name, value, cur.v, this.has) : value;
      if (cur && canon(v) === canon(cur.v)) continue;
      changed[name] = { v, l: this.tick(issue.projectId), a: this.self };
    }
    // New lines (never this Mac's own kinds); a line I took back (folded into the next) goes for everyone.
    const known = new Set((rec?.acts ?? []).map((a) => a.id));
    const added = issue.activity.filter((a) => !known.has(a.id) && !LOCAL_ACTS.has(a.kind));
    const present = new Set(issue.activity.map((a) => a.id));
    const oldest = issue.activity[0]?.at ?? 0;
    const own = new Set(rec?.own ?? []);
    const drop = (rec?.acts ?? []).filter((a) => own.has(a.id) && !present.has(a.id) && a.at >= oldest).map((a) => a.id);
    if (!Object.keys(changed).length && !added.length && !drop.length && rec) return;
    const born = rec?.born ?? { at: issue.createdAt, by: issue.createdBy, origin: issue.origin };
    const merged = merge(rec, { id: issue.id, fields: changed, acts: added, drop, born });
    const ownNow = [...[...own].filter((id) => !drop.includes(id)), ...added.map((a) => a.id)].slice(-400);
    byId[issue.id] = { ...merged.task, own: ownNow };
    this.save();
    if (!send) return;
    const delta: TaskDelta = { id: issue.id, fields: changed, acts: [...added] as TaskDelta['acts'], ...(drop.length ? { drop } : {}), ...(rec ? {} : { born }) };
    for (const link of this.team.linksOf(issue.projectId)) this.team.send(link.peerId, { k: 'ops', link: link.id, tasks: [delta] });
    this.team.publish();
    if (Object.keys(changed).length) for (const fn of this.locals) fn(issue, changed);
  }

  private removed(id: string): void {
    for (const [projectId, byId] of Object.entries(this.tasks)) {
      const rec = byId[id];
      if (!rec || rec.fields.deleted?.v === true) continue;
      const f: Field = { v: true, l: this.tick(projectId), a: this.self };
      byId[id] = { ...rec, fields: { ...rec.fields, deleted: f } };
      this.save();
      for (const link of this.team.linksOf(projectId)) this.team.send(link.peerId, { k: 'ops', link: link.id, tasks: [{ id, fields: { deleted: f }, acts: [] }] });
    }
  }

  // ------------------------------------------------------------------ theirs

  /** A teammate's word on one task: merged, written to the board, passed on. */
  private take(link: TeamLink, d: TaskDelta): void {
    const projectId = link.projectId;
    const byId = (this.tasks[projectId] ??= {});
    // Only values each field may hold; someone's "working" only from themselves.
    const fields: Record<string, Field> = {};
    for (const [name, f] of Object.entries(d.fields)) {
      const check = fieldValue(name);
      if (!check?.safeParse(f.v).success) continue;
      if (name.startsWith('working.') && name.slice(8) !== f.a) continue;
      if (name === `working.${this.self}`) continue;
      fields[name] = f;
    }
    const other = this.deps.board.get(d.id);
    if (other && other.projectId !== projectId) return;
    const rec = byId[d.id];
    const merged = merge(rec, { id: d.id, fields, acts: d.acts, ...(d.drop ? { drop: d.drop } : {}), ...(d.born ? { born: d.born } : {}) });
    this.clocks[projectId] = Math.max(this.clocks[projectId] ?? 0, maxClock(fields));
    byId[d.id] = merged.task;
    const { won, added, dropped } = merged;
    if (!Object.keys(won).length && !added.length && !dropped.length) return;
    const issue = this.write(projectId, merged.task, won, added, dropped);
    // Passed on to teammates who may not have it (each skips what it already has).
    const pass: TaskDelta = { id: d.id, fields: won, acts: [...added] as TaskDelta['acts'], ...(dropped.length ? { drop: [...dropped] } : {}), ...(merged.task.born ? { born: merged.task.born } : {}) };
    for (const l of this.team.linksOf(projectId)) if (l.peerId !== link.peerId) this.team.send(l.peerId, { k: 'ops', link: l.id, tasks: [pass] });
    this.team.publish();
    if (issue) for (const fn of this.listeners) fn({ link, issue, won, fresh: !rec });
  }

  /** What won, onto the board (quietly: no activity of its own). */
  private write(projectId: string, task: SharedTask, won: Readonly<Record<string, Field>>, added: readonly Activity[], dropped: readonly string[]): Issue | undefined {
    const board = this.deps.board;
    const value = (name: string): unknown => onBoard(name, task.fields[name]?.v, this.has);
    const existing = board.get(task.id);
    {
      if (task.fields.deleted?.v === true) {
        if (existing) board.remove(existing.id);
        return undefined;
      }
      if (!existing) {
        const title = task.fields.title?.v;
        const status = task.fields.status?.v;
        if (typeof title !== 'string' || typeof status !== 'string') return undefined;
        const brief = Object.fromEntries(BRIEF_SECTIONS.flatMap((s) => (typeof task.fields[`brief.${s}`]?.v === 'string' && task.fields[`brief.${s}`]!.v ? [[s, task.fields[`brief.${s}`]!.v as string]] : [])));
        const born = task.born ?? { at: Date.now(), by: { kind: 'beluga' } as Actor, origin: 'manual' as const };
        const assignee = value('assignee') as Assignee | null;
        const parent = value('parent') as string | null;
        const estimate = value('estimate') as number | null;
        const due = value('due') as string | null;
        const github = value('github') as Issue['github'] | null;
        return board.adoptTeam({
          id: task.id,
          projectId,
          title,
          status: status as Issue['status'],
          priority: (value('priority') as Issue['priority'] | null) ?? 'none',
          labels: (value('labels') as string[] | null) ?? [],
          ...(estimate ? { estimate } : {}),
          ...(due ? { due } : {}),
          ...(assignee ? { assignee } : {}),
          ...(parent ? { parent } : {}),
          blockedBy: value('blockedBy') as string[],
          related: value('related') as string[],
          ...(github ? { github } : {}),
          brief,
          activity: task.acts,
          createdAt: born.at,
          createdBy: born.by,
          origin: born.origin,
        });
      }
      const patch: Record<string, unknown> = {};
      const brief: Partial<Record<BriefSection, string>> = {};
      let by: Actor = { kind: 'beluga' };
      for (const [name, f] of Object.entries(won)) {
        const v = value(name);
        if (name.startsWith('brief.')) {
          brief[name.slice(6) as BriefSection] = typeof v === 'string' ? v : '';
          by = { kind: 'person', id: f.a, name: this.team.nameOf(f.a) };
        } else if (name === 'estimate' || name === 'due' || name === 'assignee' || name === 'parent' || name === 'github') patch[name] = v ?? undefined;
        else if (name !== 'deleted' && !name.startsWith('working.')) patch[name] = v;
      }
      if (Object.keys(brief).length) patch.brief = brief;
      if (!Object.keys(patch).length && !added.length && !dropped.length) return existing;
      return board.applyTeam(existing.id, patch as Parameters<Board['applyTeam']>[1], added, dropped, by);
    }
  }

  // ------------------------------------------------------------------ catching up

  private hashOf(projectId: string): string {
    return digest(Object.values(this.tasks[projectId] ?? {}));
  }

  /** Everything the team has of a project, for one teammate, in batches. */
  private snapshot(link: TeamLink): void {
    const all = Object.values(this.tasks[link.projectId] ?? {});
    let batch: TaskDelta[] = [];
    let bytes = 0;
    const flush = (): void => {
      if (batch.length) this.team.send(link.peerId, { k: 'ops', link: link.id, tasks: batch });
      batch = [];
      bytes = 0;
    };
    for (const t of all) {
      const d: TaskDelta = { id: t.id, fields: { ...t.fields }, acts: t.acts.slice(-SNAPSHOT_ACTS) as TaskDelta['acts'], ...(t.born ? { born: t.born } : {}) };
      const size = JSON.stringify(d).length;
      if (batch.length >= BATCH_TASKS || bytes + size > BATCH_BYTES) flush();
      batch.push(d);
      bytes += size;
    }
    flush();
  }

  // ------------------------------------------------------------------ the file

  private load(): void {
    if (!this.deps.dir) return;
    const saved = readJson(path.join(this.deps.dir, 'team-board.json')) as { clocks?: unknown; tasks?: unknown } | undefined;
    if (!saved || typeof saved !== 'object') return;
    if (saved.clocks && typeof saved.clocks === 'object') this.clocks = saved.clocks as Record<string, number>;
    if (saved.tasks && typeof saved.tasks === 'object') {
      for (const [projectId, list] of Object.entries(saved.tasks as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        this.tasks[projectId] = Object.fromEntries((list as SharedTask[]).filter((t) => t && typeof t.id === 'string' && t.fields && Array.isArray(t.acts)).map((t) => [t.id, t]));
      }
    }
  }

  private save(): void {
    if (!this.deps.dir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
    this.saveTimer.unref?.();
  }

  private saveNow(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.deps.dir) return;
    try {
      writeJson(path.join(this.deps.dir, 'team-board.json'), { clocks: this.clocks, tasks: Object.fromEntries(Object.entries(this.tasks).map(([p, byId]) => [p, Object.values(byId)])) });
    } catch {
      // Best effort: it's in memory, and written on the next change.
    }
  }
}
