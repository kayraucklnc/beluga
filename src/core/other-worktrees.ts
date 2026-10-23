import { rmSync } from 'node:fs';
import type { ConversationSummary } from '../agent/transcript.js';
import type { WorktreeCreator } from '../agent/worktree-creators.js';
import type { ConductorWorkspace } from '../workspaces/conductor.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import { type OriginInfo, type WorktreeSource, describeOrigin, sourceFromPath } from '../workspaces/origin.js';
import { type StaleReason, type WorktreeFacts, bornAt, removeWorktreeKeepingBranch, staleReason, staleText, touchedAt, worktreeFacts } from '../workspaces/others.js';
import type { Project, Workspace } from '../workspaces/types.js';

/**
 * Worktrees Beluga didn't make (Conductor's, Claude Code's, a script's): who made them, what's
 * in them, and tidying them away. Nothing is removed without being asked for, by id, and a
 * removal never deletes a branch.
 */

/** Reads other tools' data (Claude Code transcripts, Conductor's database). Omitted in the demo and tests. */
export interface OtherTools {
  conversations(dir: string): Promise<readonly ConversationSummary[]>;
  conductor(): Promise<readonly ConductorWorkspace[]>;
  creators(paths: readonly string[], since: number): Promise<ReadonlyMap<string, WorktreeCreator>>;
}

export interface WorktreeInfo extends WorktreeFacts {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly base: string;
  readonly origin: OriginInfo;
  readonly stale?: StaleReason;
  readonly staleText?: string;
  readonly conductor?: ConductorWorkspace;
  readonly creator?: WorktreeCreator;
  /** Claude Code conversations that ran in this folder, newest first. */
  readonly conversations: readonly ConversationSummary[];
}

export interface StaleWorktree {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly source: WorktreeSource;
  readonly reason: StaleReason;
  readonly reasonText: string;
}

export interface OtherDeps {
  readonly manager: WorkspaceManager;
  /** Re-scan and publish projects after something was removed. */
  readonly refresh: () => Promise<void>;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  readonly tools?: OtherTools;
}

const DAY = 86_400_000;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A worktree Beluga didn't make and hasn't talked in (listed after Beluga's own in the Mac sidebar). */
export const isOther = (w: Workspace): boolean => w.kind === 'worktree' && w.external && !w.archived;

export class OtherWorktrees {
  constructor(private readonly deps: OtherDeps) {}

  private project(projectId: string): Project | undefined {
    return this.deps.manager.list.find((p) => p.id === projectId);
  }

  private located(id: string): { ws: Workspace; project: Project } | undefined {
    const ws = this.deps.manager.find(id);
    const project = ws ? this.project(ws.projectId) : undefined;
    return ws && project && isOther(ws) ? { ws, project } : undefined;
  }

  private async conductorAt(dir: string): Promise<ConductorWorkspace | undefined> {
    const list = (await this.deps.tools?.conductor().catch(() => [])) ?? [];
    return list.find((c) => c.path === dir);
  }

  /** Folders of the workspaces Conductor still has open (not archived). */
  private async conductorLive(): Promise<ReadonlySet<string>> {
    const list = (await this.deps.tools?.conductor().catch(() => [])) ?? [];
    return new Set(list.filter((c) => c.state !== 'archived').map((c) => c.path));
  }

  /** The conversation Conductor has open in a folder, to continue that one first. */
  async preferredSession(dir: string): Promise<string | undefined> {
    return (await this.conductorAt(dir))?.sessionId;
  }

  /** Who made each of a project's other worktrees (by id). Conversations that made them are looked up too. */
  async origins(projectId: string): Promise<Record<string, OriginInfo>> {
    const project = this.project(projectId);
    if (!project) return {};
    const others = project.workspaces.filter(isOther);
    const conductor = (await this.deps.tools?.conductor().catch(() => [])) ?? [];
    const unknown = others.filter((w) => sourceFromPath(w.path) === 'other' && !conductor.some((c) => c.path === w.path));
    // A conversation can only have made one while it was still being written to: skip older transcripts.
    const born = await Promise.all(unknown.map((w) => bornAt(w.path)));
    const since = Math.min(...born.map((t) => t ?? Date.now() - 365 * DAY)) - DAY;
    const creators = unknown.length && this.deps.tools ? await this.deps.tools.creators(unknown.map((w) => w.path), since).catch(() => new Map()) : new Map<string, WorktreeCreator>();
    return Object.fromEntries(others.map((w) => [w.id, describeOrigin({ path: w.path, conductor: conductor.find((c) => c.path === w.path), creator: creators.get(w.path) })]));
  }

  /** When git last saw something happen in each of a project's other worktrees (by id): how the Mac sidebar orders them. */
  async activity(projectId: string): Promise<Record<string, number>> {
    const others = this.project(projectId)?.workspaces.filter(isOther) ?? [];
    const times = await Promise.all(others.map(async (w) => [w.id, await touchedAt(w.path)] as const));
    return Object.fromEntries(times.filter((t): t is readonly [string, number] => t[1] !== undefined));
  }

  /** Everything the info page shows about one other worktree. */
  async info(id: string): Promise<WorktreeInfo | undefined> {
    const at = this.located(id);
    if (!at) return undefined;
    const { ws, project } = at;
    const base = ws.base ?? project.base;
    const [facts, conductor, conversations] = await Promise.all([
      worktreeFacts(ws, base),
      this.conductorAt(ws.path),
      this.deps.tools?.conversations(ws.path).catch(() => []) ?? Promise.resolve([]),
    ]);
    const lookUpCreator = !conductor && sourceFromPath(ws.path) === 'other' && this.deps.tools;
    // A conversation can only have made it while it was still being written to.
    const since = (facts.createdAt ?? Date.now() - 365 * DAY) - DAY;
    const creator = lookUpCreator ? (await this.deps.tools!.creators([ws.path], since).catch(() => new Map())).get(ws.path) : undefined;
    // One Conductor still has open is archived there, not tidied away here.
    const stale = conductor && conductor.state !== 'archived' ? undefined : staleReason(facts);
    return {
      ...facts,
      id: ws.id,
      name: ws.name,
      path: ws.path,
      projectId: project.id,
      projectName: project.name,
      base,
      origin: describeOrigin({ path: ws.path, conductor, creator }),
      ...(stale ? { stale, staleText: staleText(stale, base) } : {}),
      ...(conductor ? { conductor } : {}),
      ...(creator ? { creator } : {}),
      conversations,
    };
  }

  /**
   * Remove one other worktree (its folder and git's record; the branch stays). With
   * uncommitted changes it refuses unless `force` (you confirmed losing them).
   */
  async remove(id: string, force = false): Promise<boolean> {
    const at = this.located(id);
    if (!at) {
      this.deps.toast('Only worktrees made outside Beluga can be removed here', 'warn');
      return false;
    }
    const { ws, project } = at;
    try {
      const facts = await worktreeFacts(ws, ws.base ?? project.base);
      if (facts.changed > 0 && !force) throw new Error(`${ws.name} has ${facts.changed} uncommitted file${facts.changed === 1 ? '' : 's'}. Remove it anyway to lose them.`);
      await removeWorktreeKeepingBranch(project.root, ws.path, force);
      rmSync(this.deps.manager.store.historyFile(ws.id), { force: true });
      await this.deps.refresh();
      this.deps.toast(`Removed ${ws.name}${ws.branch ? `. Its branch ${ws.branch} is kept` : ''}`, 'success');
      return true;
    } catch (err) {
      this.deps.toast(`Couldn't remove ${ws.name}: ${errorText(err)}`, 'error');
      return false;
    }
  }

  /** A project's other worktrees that can go without losing anything (optionally of one source). */
  async stale(projectId: string, source?: WorktreeSource): Promise<StaleWorktree[]> {
    const project = this.project(projectId);
    if (!project) return [];
    const origins = source ? await this.origins(projectId) : {};
    const live = await this.conductorLive();
    // Conductor still uses its live workspaces: those are archived in Conductor, not tidied away here.
    const list = project.workspaces.filter((w) => isOther(w) && !live.has(w.path) && (!source || (origins[w.id]?.source ?? sourceFromPath(w.path)) === source));
    const out: StaleWorktree[] = [];
    for (const w of list) {
      const base = w.base ?? project.base;
      const reason = staleReason(await worktreeFacts(w, base));
      if (reason) out.push({ id: w.id, name: w.name, path: w.path, source: origins[w.id]?.source ?? sourceFromPath(w.path), reason, reasonText: staleText(reason, base) });
    }
    return out;
  }

  /**
   * Remove the worktrees you ticked, if each is still safe to remove (checked again now:
   * one that got changes meanwhile is kept). Branches stay.
   */
  async cleanUp(projectId: string, ids: readonly string[]): Promise<{ removed: number; kept: number }> {
    const project = this.project(projectId);
    if (!project) return { removed: 0, kept: ids.length };
    let removed = 0;
    let kept = 0;
    const live = await this.conductorLive();
    for (const id of ids) {
      const ws = project.workspaces.find((w) => w.id === id && isOther(w) && !live.has(w.path));
      try {
        if (!ws || !staleReason(await worktreeFacts(ws, ws.base ?? project.base))) throw new Error('not stale');
        await removeWorktreeKeepingBranch(project.root, ws.path, false);
        rmSync(this.deps.manager.store.historyFile(ws.id), { force: true });
        removed++;
      } catch {
        kept++;
      }
    }
    await this.deps.refresh();
    this.deps.toast(`Removed ${removed} worktree${removed === 1 ? '' : 's'}${kept ? ` · kept ${kept} that changed or couldn’t be removed` : ''}. Branches are kept.`, removed ? 'success' : 'info');
    return { removed, kept };
  }
}
