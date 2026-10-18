import type { AppState } from '@klaud/core/store.js';
import { activityOf } from '@klaud/ui/workspace-models.js';
import { worktreeOrigin } from '@klaud/workspaces/origin.js';
import type { Project, Workspace } from '@klaud/workspaces/types.js';
import { tokensOf } from '@klaud/workspaces/usage-days.js';

/** What the breakdown is ordered by. */
export type SortKey = 'size' | 'tokens' | 'recent';

/** Projects take a colour slot in sidebar order (1–8); the rest share "other". Chats stay neutral. */
export const COLOR_SLOTS = 8;
export type ColorSlot = number | 'other' | 'chats';

export interface WsRow {
  readonly ws: Workspace;
  readonly project: Project;
  /** Bytes on disk; undefined until measured. */
  readonly disk: number | undefined;
  readonly tokens: number;
  readonly cost: number;
  readonly runs: number;
  readonly lastActive: number;
  /** A worktree of yours (its folder can be archived to free space). */
  readonly archivable: boolean;
}

/** Folders Claude Code's sub-agents left behind in a project, counted as one line. */
export interface AgentLeftovers {
  readonly count: number;
  readonly disk: number;
  /** How many have no uncommitted work (only those are cleaned up). */
  readonly clean: number;
}

export interface ProjectRow {
  readonly project: Project;
  readonly slot: ColorSlot;
  /** Worktree bytes (the main folder is the project itself, so it isn't counted). */
  readonly disk: number;
  readonly tokens: number;
  readonly cost: number;
  readonly lastActive: number;
  readonly rows: readonly WsRow[];
  readonly agents?: AgentLeftovers;
}

export type CleanupReason = 'merged' | 'nothing_new' | 'idle' | 'agents';

/** Something safe to put away for its space: a worktree, or a project's sub-agent leftovers. */
export interface Cleanup {
  readonly key: string;
  readonly reason: CleanupReason;
  readonly project: Project;
  readonly slot: ColorSlot;
  readonly disk: number;
  readonly ws?: Workspace;
  readonly agents?: AgentLeftovers;
}

const DAY = 86_400_000;
/** A clean worktree nobody touched for this long is worth putting away. */
export const IDLE_AFTER = 14 * DAY;

/** When something last happened in a workspace (Claude, a message, or its creation). */
export function lastActiveOf(state: AppState, ws: Workspace): number {
  return Math.max(activityOf(state.log, `ws:${ws.id}`).lastTs ?? 0, ws.usage?.lastAt ?? 0, ws.createdAt ?? 0);
}

const shown = (w: Workspace): boolean => !w.archived && worktreeOrigin(w) !== 'agent';
const isAgent = (w: Workspace): boolean => !w.archived && worktreeOrigin(w) === 'agent';
/** Folders that are space you could get back: worktrees and stand-alone chat folders. */
const counted = (w: Workspace): boolean => w.kind === 'worktree' || (w.kind === 'chat' && !w.projectRoot);

function slotOf(projects: readonly Project[], p: Project): ColorSlot {
  if (!p.root) return 'chats';
  const i = projects.filter((x) => x.root).indexOf(p);
  return i >= 0 && i < COLOR_SLOTS ? i + 1 : 'other';
}

function wsRow(state: AppState, project: Project, ws: Workspace): WsRow {
  return {
    ws,
    project,
    disk: state.disk[ws.id],
    tokens: tokensOf(ws.usage),
    cost: ws.usage?.cost ?? 0,
    runs: ws.usage?.runs ?? 0,
    lastActive: lastActiveOf(state, ws),
    archivable: ws.kind === 'worktree' && !ws.external,
  };
}

function agentsOf(state: AppState, p: Project): AgentLeftovers | undefined {
  const list = p.workspaces.filter(isAgent);
  if (!list.length) return undefined;
  return { count: list.length, disk: list.reduce((n, w) => n + (state.disk[w.id] ?? 0), 0), clean: list.filter((w) => w.status?.changed === 0).length };
}

const byKey: Record<SortKey, (a: { disk?: number; tokens: number; lastActive: number }, b: { disk?: number; tokens: number; lastActive: number }) => number> = {
  size: (a, b) => (b.disk ?? 0) - (a.disk ?? 0) || b.tokens - a.tokens,
  tokens: (a, b) => b.tokens - a.tokens || (b.disk ?? 0) - (a.disk ?? 0),
  recent: (a, b) => b.lastActive - a.lastActive,
};

/** Every project with its workspaces, totals and colour, ordered by `sort` (the main folder stays first). */
export function projectRows(state: AppState, sort: SortKey): ProjectRow[] {
  const rows = state.projects.map((p): ProjectRow => {
    const list = p.workspaces.filter(shown).map((w) => wsRow(state, p, w));
    const agents = agentsOf(state, p);
    const main = list.filter((r) => r.ws.kind === 'main');
    const rest = list.filter((r) => r.ws.kind !== 'main').sort(byKey[sort]);
    return {
      project: p,
      slot: slotOf(state.projects, p),
      disk: list.filter((r) => counted(r.ws)).reduce((n, r) => n + (r.disk ?? 0), 0) + (agents?.disk ?? 0),
      // Tokens and cost count archived workspaces too: they were spent.
      tokens: p.workspaces.reduce((n, w) => n + tokensOf(w.usage), 0),
      cost: p.workspaces.reduce((n, w) => n + (w.usage?.cost ?? 0), 0),
      lastActive: Math.max(0, ...list.map((r) => r.lastActive)),
      rows: [...main, ...rest],
      ...(agents ? { agents } : {}),
    };
  });
  return rows.filter((r) => r.rows.length || r.agents).sort(byKey[sort]);
}

/**
 * Worktrees you can put away without losing anything (no uncommitted changes): merged, with
 * nothing on their branch, or idle for two weeks; and sub-agent leftovers. Biggest first.
 */
export function cleanups(state: AppState, rows: readonly ProjectRow[], now: number): Cleanup[] {
  const out: Cleanup[] = [];
  for (const pr of rows) {
    for (const r of pr.rows) {
      const st = r.ws.status;
      if (!r.archivable || !st || st.changed > 0) continue;
      const reason: CleanupReason | undefined = state.prs[r.ws.id]?.state === 'MERGED' ? 'merged' : st.ahead === 0 && now - r.lastActive > DAY ? 'nothing_new' : now - r.lastActive > IDLE_AFTER ? 'idle' : undefined;
      if (reason) out.push({ key: r.ws.id, reason, project: pr.project, slot: pr.slot, disk: r.disk ?? 0, ws: r.ws });
    }
    if (pr.agents?.clean) out.push({ key: `agents:${pr.project.id}`, reason: 'agents', project: pr.project, slot: pr.slot, disk: pr.agents.disk, agents: pr.agents });
  }
  return out.sort((a, b) => b.disk - a.disk);
}

// ---------------------------------------------------------------- formatting

/** "$0.25", "$14", "<$0.01". */
export function formatCost(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

/** "35k tokens"-style compact counts: 950, 35k, 1.2M. */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** "just now", "12 min ago", "3 h ago", "yesterday", "5 d ago", "3 wk ago". */
export function ago(ts: number, now: number): string {
  const m = Math.round((now - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  return d < 14 ? `${d} d ago` : `${Math.round(d / 7)} wk ago`;
}

/** When a plan window resets: "3:10 PM" today, else "Thu 9 AM". */
export function resetsAt(ts: number, now: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });
  return ts - now < DAY && d.getDate() === new Date(now).getDate() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

export const REASON: Record<CleanupReason, string> = {
  merged: 'Merged',
  nothing_new: 'Nothing new on its branch',
  idle: 'Idle two weeks',
  agents: 'Left by sub-agents',
};
