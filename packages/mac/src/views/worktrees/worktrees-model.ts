import type { AgentOrigin } from '../../../../../src/core/claude-code/model.js';
import type { AppState } from '../../../../../src/core/store.js';
import type { ArchivePhase } from '../../../../../src/workspaces/archive.js';
import { worktreeOrigin } from '../../../../../src/workspaces/origin.js';
import type { Project, Workspace } from '../../../../../src/workspaces/types.js';

/**
 * The Worktrees page: every worktree in your projects in one list (Klaud's, sub-agents', those
 * made outside Klaud), who made it, whether its work is done, and the space it takes, so the
 * ones you're done with can be archived or cleaned in one go. Pure (tests/mac-worktrees.test.ts).
 */

export type MadeBy =
  | { readonly kind: 'klaud'; readonly label: string }
  | { readonly kind: 'outside'; readonly label: string }
  /** A sub-agent's: what it was asked, the conversation that started it (its workspace when Klaud has it), or that it's gone. */
  | { readonly kind: 'agent'; readonly label: string; readonly task?: string; readonly parentId?: string; readonly orphan?: true };

export interface WorktreeRow {
  readonly ws: Workspace;
  readonly project: Project;
  readonly madeBy: MadeBy;
  /** Its work is done (merged, or nothing that isn't in main yet), in words. */
  readonly work: { readonly done: boolean; readonly label: string };
  /** What's in it that isn't in main: commits ahead and uncommitted files (unknown until git was asked). */
  readonly left?: { readonly commits: number; readonly files: number };
  /** Archived: what was kept of yours, and whether it can come back (from its archive or its branch). */
  readonly archived?: { readonly keptBytes: number; readonly freedBytes: number; readonly at?: number; readonly restorable: boolean };
  /** Bytes on disk, when measured. */
  readonly size?: number;
  readonly archiving?: ArchivePhase;
}

export type WorktreeFilter = 'all' | 'done' | 'agents' | 'orphaned' | 'outside' | 'archived';

export const FILTERS: ReadonlyArray<{ readonly id: WorktreeFilter; readonly label: string; readonly hint: string }> = [
  { id: 'all', label: 'All', hint: 'Every worktree in your projects' },
  { id: 'done', label: 'Done', hint: 'Merged, or nothing in them that isn’t in main yet' },
  { id: 'agents', label: 'Sub-agents', hint: 'Worktrees Claude Code’s sub-agents made for themselves' },
  { id: 'orphaned', label: 'Orphaned', hint: 'Sub-agent worktrees whose conversation is gone' },
  { id: 'outside', label: 'Made Outside Klaud', hint: 'By sub-agents, other apps, scripts or by hand' },
  { id: 'archived', label: 'Archived', hint: 'Put away: restore them as they were, or delete them for good' },
];

type State = Pick<AppState, 'projects' | 'disk' | 'prs' | 'claudeCode' | 'archiving'>;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function madeBy(state: State, ws: Workspace, origin: AgentOrigin | undefined): MadeBy {
  const from = worktreeOrigin(ws);
  if (from === 'klaud') return { kind: 'klaud', label: 'Klaud' };
  if (from === 'external') return { kind: 'outside', label: 'Made outside Klaud' };
  if (!origin) return { kind: 'agent', label: 'Sub-agent, origin unknown', orphan: true };
  const parent = origin.workspaceId ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === origin.workspaceId && !w.archived) : undefined;
  const task = origin.description ? { task: origin.description } : {};
  if (parent) return { kind: 'agent', label: `Sub-agent of “${parent.kind === 'main' ? (origin.sessionTitle ?? parent.name) : parent.name}”`, ...task, parentId: parent.id };
  return { kind: 'agent', label: `Sub-agent of “${origin.sessionTitle ?? 'a Claude Code session'}” (gone)`, ...task, orphan: true };
}

function work(state: State, ws: Workspace): WorktreeRow['work'] {
  const changed = ws.status?.changed ?? 0;
  if (changed) return { done: false, label: plural(changed, 'uncommitted file') };
  const pr = state.prs[ws.id];
  if (pr?.state === 'MERGED') return { done: true, label: `Merged (#${pr.number})` };
  const ahead = ws.status?.ahead;
  if (ahead === 0) return { done: true, label: 'Nothing new' };
  if (ahead === undefined) return { done: false, label: 'Not checked yet' };
  return { done: false, label: `${plural(ahead, 'commit')} not in main` };
}

/** Every live worktree in the projects, biggest first. */
export function worktreeRows(state: State): WorktreeRow[] {
  const origins = new Map(state.claudeCode.origins.map((o) => [o.path, o]));
  const rows = state.projects.flatMap((project) =>
    project.workspaces
      .filter((ws) => ws.kind === 'worktree' && !ws.archived)
      .map((ws): WorktreeRow => {
        const size = state.disk[ws.id];
        const archiving = state.archiving[ws.id];
        const left = ws.status ? { left: { commits: ws.status.ahead, files: ws.status.changed } } : {};
        return { ws, project, madeBy: madeBy(state, ws, origins.get(ws.path)), work: work(state, ws), ...left, ...(size !== undefined ? { size } : {}), ...(archiving ? { archiving } : {}) };
      }),
  );
  return rows.sort((a, b) => (b.size ?? -1) - (a.size ?? -1) || a.ws.name.localeCompare(b.ws.name));
}

/**
 * Archived worktrees, most recently archived first. One archived smartly comes back as it was
 * (from its archive); an older one from its branch; one with neither can't come back, only go.
 */
export function archivedRows(state: State): WorktreeRow[] {
  const rows = state.projects.flatMap((project) =>
    project.workspaces
      .filter((ws) => ws.kind === 'worktree' && ws.archived)
      .map((ws): WorktreeRow => {
        const a = ws.archive;
        const kept = a ? { keptBytes: a.keptBytes, freedBytes: a.freedBytes, at: a.at } : { keptBytes: 0, freedBytes: 0 };
        // Who made it still matters (deleting another tool's keeps its branch); not the sub-agent's conversation.
        const by = worktreeOrigin(ws);
        const made: MadeBy = by === 'klaud' ? { kind: 'klaud', label: 'Klaud' } : by === 'agent' ? { kind: 'agent', label: 'Sub-agent' } : { kind: 'outside', label: 'Made outside Klaud' };
        return { ws, project, madeBy: made, work: { done: true, label: 'Archived' }, archived: { ...kept, restorable: Boolean(a || ws.branch) } };
      }),
  );
  return rows.sort((a, b) => (b.archived?.at ?? b.ws.createdAt) - (a.archived?.at ?? a.ws.createdAt) || a.ws.name.localeCompare(b.ws.name));
}

/**
 * For an archived worktree: whether it can come back and how, and what deleting it for good
 * loses (its archive holds what was uncommitted, new or ignored of yours; Klaud's own branches go
 * too, another tool's stay).
 */
export function archivedText(r: WorktreeRow, format: (bytes: number) => string): { restore: string; remove: string } {
  const a = r.archived;
  if (!a) return { restore: '', remove: '' };
  const restore = !a.restorable ? 'Can’t come back: there’s no archive and no branch to make it from' : r.ws.archive ? 'Restore brings it back as it was, uncommitted work included' : `Restore makes it again from its branch ${r.ws.branch ?? ''}`.trim();
  const saved = r.ws.archive ? `its archive (uncommitted work and files of yours${a.keptBytes ? `, ${format(a.keptBytes)}` : ''})` : '';
  const branch = r.ws.branch && r.madeBy.kind === 'klaud' ? `its branch ${r.ws.branch} (commits only there)` : '';
  const lost = [saved, branch, 'its conversation'].filter(Boolean);
  return { restore, remove: `Deleting loses ${lost.length > 1 ? `${lost.slice(0, -1).join(', ')} and ${lost.at(-1)}` : lost[0]}.` };
}

/** The rows a filter (and a project, when one is picked) shows. */
export function filterRows(rows: readonly WorktreeRow[], filter: WorktreeFilter, projectId?: string): WorktreeRow[] {
  return rows.filter((r) => {
    if (projectId && r.project.id !== projectId) return false;
    // Archived ones show only under Archived (and only they do).
    if ((filter === 'archived') !== Boolean(r.archived)) return false;
    if (filter === 'done') return r.work.done;
    if (filter === 'agents') return r.madeBy.kind === 'agent';
    if (filter === 'orphaned') return r.madeBy.kind === 'agent' && Boolean(r.madeBy.orphan);
    if (filter === 'outside') return r.madeBy.kind !== 'klaud';
    return true;
  });
}

/** How many, how big, and how much of it is dependencies, builds and caches (of those looked at so far). */
export function totals(rows: readonly WorktreeRow[], rebuildable: Readonly<Record<string, number>>): { count: number; bytes: number; rebuildable: number; measured: number } {
  const known = rows.filter((r) => rebuildable[r.ws.id] !== undefined);
  return { count: rows.length, bytes: rows.reduce((n, r) => n + (r.size ?? 0), 0), rebuildable: known.reduce((n, r) => n + rebuildable[r.ws.id]!, 0), measured: known.length };
}
