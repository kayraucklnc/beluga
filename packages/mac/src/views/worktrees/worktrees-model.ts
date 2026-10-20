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
  /** Bytes on disk, when measured. */
  readonly size?: number;
  readonly archiving?: ArchivePhase;
}

export type WorktreeFilter = 'all' | 'done' | 'agents' | 'orphaned' | 'outside';

export const FILTERS: ReadonlyArray<{ readonly id: WorktreeFilter; readonly label: string; readonly hint: string }> = [
  { id: 'all', label: 'All', hint: 'Every worktree in your projects' },
  { id: 'done', label: 'Done', hint: 'Merged, or nothing in them that isn’t in main yet' },
  { id: 'agents', label: 'Sub-agents', hint: 'Worktrees Claude Code’s sub-agents made for themselves' },
  { id: 'orphaned', label: 'Orphaned', hint: 'Sub-agent worktrees whose conversation is gone' },
  { id: 'outside', label: 'Made Outside Klaud', hint: 'By sub-agents, other apps, scripts or by hand' },
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
        return { ws, project, madeBy: madeBy(state, ws, origins.get(ws.path)), work: work(state, ws), ...(size !== undefined ? { size } : {}), ...(archiving ? { archiving } : {}) };
      }),
  );
  return rows.sort((a, b) => (b.size ?? -1) - (a.size ?? -1) || a.ws.name.localeCompare(b.ws.name));
}

/** The rows a filter (and a project, when one is picked) shows. */
export function filterRows(rows: readonly WorktreeRow[], filter: WorktreeFilter, projectId?: string): WorktreeRow[] {
  return rows.filter((r) => {
    if (projectId && r.project.id !== projectId) return false;
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
