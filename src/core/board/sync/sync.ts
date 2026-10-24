import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { belugaHome } from '../../home.js';
import type { Action, Store } from '../../store.js';
import type { Board, IssuePatch } from '../board.js';
import { type Actor, BRIEF_SECTIONS, type Issue, PROVIDER_INFO, type ProjectSync, SYNC_PROVIDERS, type SyncErrorCode, type SyncProvider, isArchived, isOpen } from '../model.js';
import { SYNCED, type SyncedField, fieldsOf, markdownToBrief, printsOf } from './fields.js';
import { LinearProvider, type LinearOptions, linearKeyProblem } from './linear.js';
import { type IssueFields, type Provider, type RemoteIssue, type RemoteTeam, SyncError } from './provider.js';

/**
 * A project's board kept in step with a team in another tracker (Linear), both ways. Issues there
 * become tasks here and tasks here become issues there. For each field, whichever side changed it
 * since the two last agreed wins; when both did, the newer change does. Each link keeps a
 * fingerprint of both sides (sync/fields.ts), so a sync sends only what changed and never loops.
 * Autosync asks the tracker every minute and sends a change made here a few seconds after it's
 * made. Keys live in ~/.beluga/task-sync.json, readable only by you, and never leave this computer:
 * screens get `board.sync` (the team, when it last synced, what went wrong).
 */

/** Autosync asks the tracker this often. */
export const AUTO_MS = 60_000;
/** A change here goes out this long after the last one in a row. */
export const SOON_MS = 4_000;
/** Look back a little before the last change seen, in case two clocks disagree (what didn't change is skipped). */
const OVERLAP_MS = 2_000;

const ErrorSchema = z.object({ code: z.enum(['auth', 'offline', 'rate_limited', 'remote', 'unknown']), message: z.string(), at: z.number() });
const EntrySchema = z.object({
  provider: z.enum(SYNC_PROVIDERS),
  key: z.string().min(1),
  teamId: z.string().min(1),
  team: z.string(),
  teamKey: z.string(),
  workspace: z.string().optional(),
  auto: z.boolean().default(true),
  /** Tasks that were here before connecting go there too (open ones). */
  pushExisting: z.boolean().default(false),
  connectedAt: z.number(),
  /** The newest change seen there (the tracker's clock). */
  cursor: z.number().optional(),
  syncedAt: z.number().optional(),
  error: ErrorSchema.optional(),
});
type Entry = z.infer<typeof EntrySchema>;

export const SyncFileSchema = z.object({ projects: z.record(z.string(), EntrySchema).default({}) });
type SyncFile = z.infer<typeof SyncFileSchema>;
const EMPTY: SyncFile = { projects: {} };

export const syncPath = (): string => path.join(belugaHome(), 'task-sync.json');

function loadFile(file: string): SyncFile {
  try {
    const parsed = SyncFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

function saveFile(data: SyncFile, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export interface ConnectSync {
  readonly provider: SyncProvider;
  readonly key: string;
  readonly teamId: string;
  readonly auto?: boolean;
  readonly pushExisting?: boolean;
}

export interface TaskSyncDeps {
  readonly store: Store;
  readonly board: Board;
  /** Where the keys are kept; null: only in memory (tests, the demo). */
  readonly file?: string | null;
  /** The tracker for a key (tests pass a fake one). */
  readonly provider?: (kind: SyncProvider, key: string) => Provider;
  readonly linear?: LinearOptions;
  readonly now?: () => number;
  readonly autoMs?: number;
  readonly soonMs?: number;
}

/** What the result of one sync says. */
export interface SyncResult {
  readonly pulled: number;
  readonly pushed: number;
  readonly created: number;
  readonly failed: number;
}

export function keyProblem(kind: SyncProvider, key: string): string | undefined {
  switch (kind) {
    case 'linear':
      return linearKeyProblem(key);
  }
}

export class TaskSync {
  private data: SyncFile;
  private readonly running = new Map<string, Promise<SyncResult | undefined>>();
  private readonly soon = new Map<string, ReturnType<typeof setTimeout>>();
  private timer?: ReturnType<typeof setInterval>;
  private off?: () => void;

  constructor(private readonly deps: TaskSyncDeps) {
    this.data = deps.file === null ? EMPTY : loadFile(deps.file ?? syncPath());
    for (const id of Object.keys(this.data.projects)) this.publish(id);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private providerFor(kind: SyncProvider, key: string): Provider {
    if (this.deps.provider) return this.deps.provider(kind, key);
    switch (kind) {
      case 'linear':
        return new LinearProvider(key, this.deps.linear);
    }
  }

  private save(): void {
    if (this.deps.file !== null) saveFile(this.data, this.deps.file ?? syncPath());
  }

  private put(projectId: string, entry: Entry | undefined): void {
    const { [projectId]: _old, ...others } = this.data.projects;
    this.data = { projects: entry ? { ...others, [projectId]: entry } : others };
    this.save();
  }

  /** What screens may know: the team, autosync, when it last synced, what went wrong. */
  private publish(projectId: string): void {
    const e = this.data.projects[projectId];
    if (!e) return void this.deps.store.dispatch({ type: 'board_sync', projectId });
    const linked = this.deps.board.list().filter((i) => i.projectId === projectId && i.link?.provider === e.provider).length;
    const sync: ProjectSync = {
      provider: e.provider,
      ...(e.workspace ? { workspace: e.workspace } : {}),
      team: e.team,
      teamKey: e.teamKey,
      auto: e.auto,
      ...(this.running.has(projectId) ? { syncing: true } : {}),
      ...(e.syncedAt ? { syncedAt: e.syncedAt } : {}),
      linked,
      ...(e.error ? { error: e.error } : {}),
    };
    this.deps.store.dispatch({ type: 'board_sync', projectId, sync });
  }

  // ------------------------------------------------------------------ connecting

  /** Check a key: the tracker's workspace and its teams, to pick one. */
  async teams(kind: SyncProvider, raw: string): Promise<{ readonly workspace?: string; readonly teams: readonly RemoteTeam[] }> {
    const key = raw.trim();
    const problem = keyProblem(kind, key);
    if (problem) throw new Error(problem);
    try {
      return await this.providerFor(kind, key).teams();
    } catch (err) {
      throw new Error(err instanceof SyncError ? err.message : `Couldn’t check the key with ${PROVIDER_INFO[kind].label}`);
    }
  }

  /** Link a project to a team: the key is kept, and the first sync starts. */
  async connect(projectId: string, input: ConnectSync): Promise<{ readonly team: string }> {
    if (!this.deps.store.getState().projects.some((p) => p.id === projectId)) throw new Error('That project is gone');
    const key = input.key.trim();
    const { workspace, teams } = await this.teams(input.provider, key);
    const team = teams.find((t) => t.id === input.teamId);
    if (!team) throw new Error('That team isn’t there any more: pick another');
    const before = this.data.projects[projectId];
    // Another tracker or team than before: the old links mean nothing there.
    if (before && (before.provider !== input.provider || before.teamId !== team.id)) this.unlinkAll(projectId);
    this.put(projectId, {
      provider: input.provider,
      key,
      teamId: team.id,
      team: team.name,
      teamKey: team.key,
      ...(workspace ? { workspace } : {}),
      auto: input.auto ?? true,
      pushExisting: input.pushExisting ?? false,
      connectedAt: before?.teamId === team.id ? before.connectedAt : this.now(),
      ...(before?.teamId === team.id && before.cursor ? { cursor: before.cursor } : {}),
    });
    this.publish(projectId);
    void this.sync(projectId).catch(() => undefined);
    return { team: team.name };
  }

  /** Forget the key and stop syncing; tasks stay, unlinked. Nothing in the tracker is touched. */
  disconnect(projectId: string): void {
    if (!this.data.projects[projectId]) return;
    this.put(projectId, undefined);
    this.unlinkAll(projectId);
    this.publish(projectId);
  }

  setAuto(projectId: string, on: boolean): void {
    const e = this.data.projects[projectId];
    if (!e) throw new Error('This project doesn’t sync with a tracker');
    this.put(projectId, { ...e, auto: on });
    this.publish(projectId);
    if (on) void this.sync(projectId).catch(() => undefined);
  }

  private unlinkAll(projectId: string): void {
    for (const issue of this.deps.board.list()) if (issue.projectId === projectId && issue.link) this.deps.board.setLink(issue.id, undefined);
  }

  // ------------------------------------------------------------------ syncing

  /** Sync one project now (or every connected one, one after another). */
  async sync(projectId?: string): Promise<SyncResult | undefined> {
    if (!projectId) {
      for (const id of Object.keys(this.data.projects)) await this.sync(id);
      return undefined;
    }
    if (!this.data.projects[projectId]) throw new Error('This project doesn’t sync with a tracker');
    const busy = this.running.get(projectId);
    if (busy) return busy;
    const run = this.run(projectId).finally(() => {
      this.running.delete(projectId);
      this.publish(projectId);
    });
    this.running.set(projectId, run);
    this.publish(projectId);
    return run;
  }

  private async run(projectId: string): Promise<SyncResult | undefined> {
    const start = this.data.projects[projectId];
    if (!start) return undefined;
    const provider = this.providerFor(start.provider, start.key);
    const counts = { pulled: 0, pushed: 0, created: 0, failed: 0 };
    let cursor = start.cursor;
    let error: Entry['error'];
    try {
      const pulled = await provider.changed(start.teamId, start.cursor === undefined ? undefined : start.cursor - OVERLAP_MS);
      const seen = new Set<string>();
      // New there: brought over first, so parents are here before their sub-tasks look for them.
      for (const remote of pulled) if (!this.byRemote(projectId, start.provider, remote.id)) this.each(counts, () => this.bringOver(projectId, start, remote));
      for (const remote of pulled) {
        seen.add(remote.id);
        cursor = Math.max(cursor ?? 0, remote.updatedAt);
        const issue = this.byRemote(projectId, start.provider, remote.id);
        if (issue) await this.eachAsync(counts, () => this.merge(provider, start, issue, remote, counts));
      }
      // New here: sent over, parents first.
      for (const issue of this.toSend(projectId, start)) await this.eachAsync(counts, () => this.send(provider, start, issue, counts));
      // Changed here only (the tracker's side is as it was).
      for (const issue of this.deps.board.list()) {
        if (issue.projectId !== projectId || issue.link?.provider !== start.provider || seen.has(issue.link.id) || isArchived(issue)) continue;
        await this.eachAsync(counts, () => this.merge(provider, start, issue, undefined, counts));
      }
      if (counts.failed) error = { code: 'remote', message: `${counts.failed === 1 ? 'A task' : `${counts.failed} tasks`} couldn’t be synced. Beluga tries again next time.`, at: this.now() };
    } catch (err) {
      const e = err instanceof SyncError ? err : new SyncError('unknown');
      error = { code: e.code, message: e.message, at: this.now() };
    }
    // Disconnected, or connected to another team, while syncing: nothing to keep.
    const now = this.data.projects[projectId];
    if (!now || now.teamId !== start.teamId || now.key !== start.key) return counts;
    const { error: _old, ...rest } = now;
    const ok = !error || error.code === 'remote';
    this.put(projectId, { ...rest, ...(cursor !== undefined ? { cursor } : {}), ...(ok ? { syncedAt: this.now() } : {}), ...(error ? { error } : {}) });
    return counts;
  }

  /** One task's part of a sync: a problem with it alone is counted and the rest go on; losing the tracker stops the sync. */
  private each(counts: { failed: number }, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (err instanceof SyncError && err.code !== 'remote') throw err;
      counts.failed++;
    }
  }

  private async eachAsync(counts: { failed: number }, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof SyncError && err.code !== 'remote') throw err;
      counts.failed++;
    }
  }

  private byRemote(projectId: string, provider: SyncProvider, remoteId: string): Issue | undefined {
    return this.deps.board.list().find((i) => i.projectId === projectId && i.link?.provider === provider && i.link.id === remoteId);
  }

  private actor(e: Entry): Actor {
    return { kind: 'person', id: `sync:${e.provider}`, name: PROVIDER_INFO[e.provider].label };
  }

  /** The parent's id in the tracker, when it's linked there too. */
  private parentThere(issue: Issue, provider: SyncProvider): string | undefined {
    const parent = issue.parent ? this.deps.board.get(issue.parent) : undefined;
    return parent?.link?.provider === provider ? parent.link.id : undefined;
  }

  private fields(issue: Issue, provider: SyncProvider): IssueFields {
    return fieldsOf(issue, this.parentThere(issue, provider));
  }

  /** An issue new there becomes a task here (its parent comes with the merge after). */
  private bringOver(projectId: string, e: Entry, remote: RemoteIssue): void {
    const by = this.actor(e);
    const issue = this.deps.board.create(
      {
        projectId,
        title: remote.title.trim() || 'Untitled task',
        status: remote.status,
        priority: remote.priority,
        labels: remote.labels,
        ...(remote.estimate ? { estimate: Math.max(1, Math.round(remote.estimate)) } : {}),
        ...(remote.due ? { due: remote.due } : {}),
        brief: markdownToBrief(remote.description),
      },
      by,
      'sync',
    );
    // Its parent isn't known here yet: the merge brings it in.
    this.deps.board.setLink(issue.id, { provider: e.provider, id: remote.id, key: remote.key, url: remote.url, local: printsOf(this.fields(issue, e.provider)), remote: { ...printsOf(remote), parent: '' } }, `linked this to ${PROVIDER_INFO[e.provider].label} ${remote.key}`);
  }

  /** Tasks here to send over: made since connecting (or open ones from before, when asked), parents first. */
  private toSend(projectId: string, e: Entry): Issue[] {
    const board = this.deps.board;
    const ready = board.list().filter((i) => i.projectId === projectId && !i.link && !isArchived(i) && !i.drafting && (i.createdAt >= e.connectedAt || (e.pushExisting && isOpen(i.status))));
    const depth = (i: Issue): number => {
      let n = 0;
      for (let at = i.parent; at && n < 50; n++) at = board.get(at)?.parent;
      return n;
    };
    return ready.sort((a, b) => depth(a) - depth(b) || a.number - b.number);
  }

  private async send(provider: Provider, e: Entry, issue: Issue, counts: { created: number }): Promise<void> {
    const fresh = this.deps.board.get(issue.id);
    if (!fresh || fresh.link) return;
    const fields = this.fields(fresh, e.provider);
    const remote = await provider.create(e.teamId, fields);
    const now = this.deps.board.get(issue.id);
    if (!now) return;
    this.deps.board.setLink(now.id, { provider: e.provider, id: remote.id, key: remote.key, url: remote.url, local: printsOf(fields), remote: printsOf(remote) }, `linked this to ${PROVIDER_INFO[e.provider].label} ${remote.key}`);
    counts.created++;
  }

  /**
   * One linked task and its issue there (`remote` undefined: unchanged there since the last sync):
   * each field goes the way it changed, the newer side winning when both changed it.
   */
  private async merge(provider: Provider, e: Entry, issue: Issue, remote: RemoteIssue | undefined, counts: { pulled: number; pushed: number }): Promise<void> {
    const link = issue.link!;
    const local = printsOf(this.fields(issue, e.provider));
    const there = remote ? printsOf(remote) : link.remote;
    const toHere: SyncedField[] = [];
    const toThere: SyncedField[] = [];
    for (const f of SYNCED) {
      const changedHere = local[f] !== link.local[f];
      const changedThere = there[f] !== link.remote[f];
      // Both sides already say the same: nothing to send either way (the link catches up below).
      if (local[f] === there[f]) continue;
      if (changedThere && (!changedHere || (remote && remote.updatedAt >= issue.updatedAt))) toHere.push(f);
      else if (changedHere) toThere.push(f);
    }
    if (remote && toHere.length) {
      this.apply(issue, remote, toHere, e);
      counts.pulled++;
    }
    let after = remote;
    if (toThere.length) {
      const all = this.fields(this.deps.board.need(issue.id), e.provider);
      const patch = Object.fromEntries(toThere.map((f) => [f, all[f]])) as Partial<IssueFields>;
      after = await provider.update(e.teamId, link.id, patch);
      counts.pushed++;
    }
    if (!toHere.length && !toThere.length && !remote) return;
    const now = this.deps.board.get(issue.id);
    if (!now?.link) return;
    // Agreed again: both sides as they are now.
    const prints = { local: printsOf(this.fields(now, e.provider)), remote: after ? printsOf(after) : link.remote };
    if (sameLink(now.link, { ...now.link, ...prints, ...(after ? { key: after.key, url: after.url } : {}) })) return;
    this.deps.board.setLink(now.id, { ...now.link, ...prints, ...(after ? { key: after.key, url: after.url } : {}) });
  }

  /** The tracker's side of some fields, written here as the tracker (it shows in the activity). */
  private apply(issue: Issue, remote: RemoteIssue, fields: readonly SyncedField[], e: Entry): void {
    const board = this.deps.board;
    const by = this.actor(e);
    const patch: { -readonly [K in keyof IssuePatch]: IssuePatch[K] } = {};
    for (const f of fields) {
      if (f === 'title' && remote.title.trim()) patch.title = remote.title;
      if (f === 'status') patch.status = remote.status;
      if (f === 'priority') patch.priority = remote.priority;
      if (f === 'labels') patch.labels = remote.labels;
      if (f === 'estimate') patch.estimate = remote.estimate ? Math.min(100, Math.max(1, Math.round(remote.estimate))) : null;
      if (f === 'due') patch.due = remote.due ?? null;
    }
    if (Object.keys(patch).length) board.update(issue.id, patch, by);
    if (fields.includes('parent')) {
      const parent = remote.parent ? this.byRemote(issue.projectId, e.provider, remote.parent) : undefined;
      try {
        board.update(issue.id, { parent: parent?.id ?? null }, by);
      } catch {
        // A loop, or another project's: the parent stays as it is here.
      }
    }
    if (fields.includes('description')) {
      const brief = markdownToBrief(remote.description);
      for (const s of BRIEF_SECTIONS) {
        if ((brief[s] ?? '') !== (board.need(issue.id).brief[s] ?? '')) board.editBrief(issue.id, s, brief[s] ?? '', by, { reason: `changed in ${PROVIDER_INFO[e.provider].label}` });
      }
    }
  }

  // ------------------------------------------------------------------ autosync

  /** Autosync: every minute, and a few seconds after a change here to a project that syncs. */
  start(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.autoMs ?? AUTO_MS);
    this.timer.unref?.();
    this.off = this.deps.store.onAction((a) => this.onAction(a));
    // Soon after starting: catch up on what changed while Beluga was closed.
    const first = setTimeout(() => void this.tick(), 5_000);
    first.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.off?.();
    for (const t of this.soon.values()) clearTimeout(t);
    this.soon.clear();
  }

  /** Every project due for a sync (autosync on, and not waiting for a new key). */
  async tick(): Promise<void> {
    for (const [id, e] of Object.entries(this.data.projects)) {
      if (!e.auto || e.error?.code === 'auth' || this.running.has(id)) continue;
      await this.sync(id).catch(() => undefined);
    }
  }

  private onAction(a: Action): void {
    if (a.type !== 'board_issue') return;
    const issue = a.issue;
    const e = this.data.projects[issue.projectId];
    if (!e?.auto || e.error?.code === 'auth' || this.running.has(issue.projectId)) return;
    if (!this.wantsSync(issue, e)) return;
    clearTimeout(this.soon.get(issue.projectId));
    const t = setTimeout(() => {
      this.soon.delete(issue.projectId);
      void this.sync(issue.projectId).catch(() => undefined);
    }, this.deps.soonMs ?? SOON_MS);
    t.unref?.();
    this.soon.set(issue.projectId, t);
  }

  /** A change here the tracker doesn't have yet. */
  private wantsSync(issue: Issue, e: Entry): boolean {
    if (isArchived(issue) || issue.drafting) return false;
    if (!issue.link) return issue.createdAt >= e.connectedAt || (e.pushExisting && isOpen(issue.status));
    const local = printsOf(this.fields(issue, e.provider));
    return SYNCED.some((f) => local[f] !== issue.link!.local[f]);
  }

  /** Every sync running now has finished (tests). */
  async settled(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  /** The error codes that need you (a new key) rather than time. */
  static needsYou(code: SyncErrorCode | undefined): boolean {
    return code === 'auth';
  }
}

function sameLink(a: NonNullable<Issue['link']>, b: NonNullable<Issue['link']>): boolean {
  return a.key === b.key && a.url === b.url && SYNCED.every((f) => a.local[f] === b.local[f] && a.remote[f] === b.remote[f]);
}

const services = new WeakMap<object, TaskSync>();

export const attachSync = (session: object, service: TaskSync): void => void services.set(session, service);
export const detachSync = (session: object): void => void services.delete(session);

/** The session's task sync, or a clear error where there's none. */
export function syncOf(session: object): TaskSync {
  const service = services.get(session);
  if (!service) throw new Error('Syncing tasks needs the Beluga app (its daemon).');
  return service;
}
