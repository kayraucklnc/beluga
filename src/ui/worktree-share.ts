import type { WsRole } from '../protocol.js';
import type { AppState } from '../core/store.js';

/**
 * Who a worktree's Share sheet lists (BLG-340): your friends, who get it over the Beluga network
 * with nobody in a room, and anyone in your room who isn't a friend. Each with what they have here.
 */

export type ShareAccess = WsRole | 'none';

export interface WorktreeShareRow {
  readonly peerId: string;
  readonly name: string;
  readonly access: ShareAccess;
  /** How a change reaches them: over your friends' network, or through the room you're both in. */
  readonly via: 'network' | 'room';
  /** They have the whole project (every worktree), not just this one. */
  readonly wholeProject: boolean;
  readonly guest?: boolean;
}

type ShareState = Pick<AppState, 'peers' | 'self' | 'members' | 'network' | 'projectShares' | 'projects'>;

/** What a friend has of this worktree through a project grant. */
function grantFor(state: ShareState, projectId: string | undefined, wsId: string, peerId: string): { role: WsRole; whole: boolean } | undefined {
  const g = projectId ? state.projectShares[projectId]?.[peerId] : undefined;
  if (!g || (g.only && !g.only.includes(wsId))) return undefined;
  return { role: g.role, whole: !g.only };
}

export function worktreeShareRows(state: ShareState, wsId: string): WorktreeShareRow[] {
  const projectId = state.projects.find((p) => p.workspaces.some((w) => w.id === wsId))?.id;
  const members = state.members[wsId] ?? {};
  const selfId = state.self?.peerId;
  const network = state.network.enabled;
  const rows: WorktreeShareRow[] = [];
  for (const f of state.network.friends) {
    if (f.peerId === selfId) continue;
    const grant = grantFor(state, projectId, wsId, f.peerId);
    const room = members[f.peerId];
    // A friend already in it through the room stays on the room's way until they're removed.
    const via = room || !network ? 'room' : 'network';
    rows.push({ peerId: f.peerId, name: f.name, access: room ?? grant?.role ?? 'none', via, wholeProject: !room && Boolean(grant?.whole) });
  }
  for (const p of state.peers) {
    if (p.peerId === selfId || rows.some((r) => r.peerId === p.peerId)) continue;
    rows.push({ peerId: p.peerId, name: p.name, access: members[p.peerId] ?? 'none', via: 'room', wholeProject: false, ...(p.guest ? { guest: true } : {}) });
  }
  return rows;
}

/** What one row's line under the name says. */
export function shareRowDetail(row: WorktreeShareRow, inRoom: boolean): string {
  if (row.access === 'contribute') return row.wholeProject ? 'Works with your Claude across the whole project' : 'Chats and asks your Claude here';
  if (row.access === 'view') return row.wholeProject ? 'Follows the whole project, read-only' : 'Follows along, read-only';
  if (row.guest) return 'Guest';
  return inRoom ? 'In your room, not in this worktree' : 'Not in this worktree';
}
