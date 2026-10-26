import type { AppState } from '@beluga/core/store.js';

/**
 * How someone in a shared project or worktree is doing, as the network last heard: online, away
 * (or Do Not Disturb), offline, or on a Beluga that can't link with yours ("needs an update").
 */
export type PersonState = 'online' | 'away' | 'offline' | 'update';

export interface PersonPresence {
  readonly state: PersonState;
  /** "online", "away", "offline", "needs an update". */
  readonly label: string;
}

const LABEL: Record<PersonState, string> = { online: 'online', away: 'away', offline: 'offline', update: 'needs an update' };

export function presenceOf(state: Pick<AppState, 'network' | 'peers'>, peerId: string): PersonPresence {
  const friend = state.network.friends.find((f) => f.peerId === peerId);
  const s: PersonState = friend?.update ? 'update' : friend?.online ? (friend.presence.state === 'away' || friend.presence.state === 'dnd' ? 'away' : 'online') : state.peers.some((p) => p.peerId === peerId) ? 'online' : 'offline';
  return { state: s, label: LABEL[s] };
}
