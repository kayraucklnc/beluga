import type { AppState } from '../../../../src/core/store.js';
import { type InvitePlace, type InviteRoute, inviteRoute, parseInvite } from '../../../../src/shared/invite-route.js';
import { findWorkspace } from '../../../../src/ui/workspace-models.js';
import { conversationOf } from '../network/net-model.js';

/**
 * What `/invite` typed in the Mac's message boxes means where you are (BLG-203), as plain functions:
 * what's on screen, and where the friends named go (src/shared/invite-route.ts decides).
 */

/** What's on screen, for inviting. */
export function invitePlace(state: Pick<AppState, 'view' | 'projects' | 'network'>): InvitePlace {
  const v = state.view;
  if (v.kind === 'conversation') {
    const c = conversationOf(v.id);
    if (c?.kind === 'dm') {
      const f = state.network.friends.find((x) => x.peerId === c.peerId);
      return f ? { kind: 'dm', peerId: f.peerId, name: f.name } : { kind: 'none' };
    }
    if (c?.kind === 'group') {
      const g = state.network.groups.find((x) => x.id === c.groupId);
      return g ? { kind: 'group', groupId: g.id, name: g.name, members: g.members.map((m) => m.peerId), admin: g.admin, active: g.active } : { kind: 'none' };
    }
  }
  if (v.kind === 'workspace') {
    const ws = findWorkspace(state.projects, v.id);
    if (ws) return { kind: 'workspace', workspaceId: ws.id, projectId: ws.projectId, name: ws.name };
  }
  if (v.kind === 'project') {
    const p = state.projects.find((x) => x.id === v.id);
    if (p) return { kind: 'project', projectId: p.id, name: p.name };
  }
  return { kind: 'none' };
}

/** What `/invite …` typed here means; undefined when the words aren't /invite. */
export function inviteFor(text: string, state: Pick<AppState, 'view' | 'projects' | 'network'>): InviteRoute | undefined {
  const parsed = parseInvite(text);
  return parsed ? inviteRoute(invitePlace(state), parsed.names, state.network.friends) : undefined;
}
