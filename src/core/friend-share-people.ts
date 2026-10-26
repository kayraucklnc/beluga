import type { DomainState } from './store.js';

/**
 * Who's in something shared with friends over the network and how they're doing, as the network
 * last heard: online, away (or Do Not Disturb), offline, or on a Beluga that can't link with
 * yours ("needs an update"). Someone who isn't your friend (in a friend's worktree with you) is
 * `unknown`: only their friends' Macs hear how they are. The Mac's headers and message box and the phone's views read it.
 * Browser-safe.
 */
export type PersonState = 'online' | 'away' | 'offline' | 'update' | 'unknown';

export interface PersonPresence {
  readonly state: PersonState;
  /** "online", "away", "offline", "needs an update", or that it isn't known. */
  readonly label: string;
}

const LABEL: Record<PersonState, string> = { online: 'online', away: 'away', offline: 'offline', update: 'needs an update', unknown: 'not your friend, so not known' };

type PresenceState = Pick<DomainState, 'network' | 'peers'>;

export function presenceOf(state: PresenceState, peerId: string): PersonPresence {
  const friend = state.network.friends.find((f) => f.peerId === peerId);
  const inRoom = state.peers.some((p) => p.peerId === peerId);
  const s: PersonState = friend?.update ? 'update' : friend?.online ? (friend.presence.state === 'away' || friend.presence.state === 'dnd' ? 'away' : 'online') : inRoom ? 'online' : friend ? 'offline' : 'unknown';
  return { state: s, label: LABEL[s] };
}

/** Someone in a worktree, for its header: who, how they're doing, and whether it's its owner. */
export interface PersonHere extends PersonPresence {
  readonly peerId: string;
  readonly name: string;
  readonly owner: boolean;
  readonly role?: 'contribute' | 'view';
}

type HereState = Pick<DomainState, 'network' | 'peers' | 'shared' | 'roster' | 'members' | 'selfId' | 'self' | 'sharedProjects'>;

const nameOf = (state: HereState, id: string): string =>
  state.network.friends.find((f) => f.peerId === id)?.name ?? state.peers.find((p) => p.peerId === id)?.name ?? state.sharedProjects.flatMap((p) => p.members).find((m) => m.peerId === id)?.name ?? 'someone';

/**
 * Everyone in a worktree shared over the network besides you: its owner first, then the others it's
 * shared with. Your own worktree: the friends you shared it with. Empty when it isn't shared that way.
 */
export function peopleHere(state: HereState, wsId: string): PersonHere[] {
  const me = state.selfId || state.self?.peerId;
  const shared = state.shared.find((w) => w.id === wsId && w.via === 'mesh');
  if (shared) {
    const others = (state.roster[wsId] ?? []).filter((m) => m.peerId !== me && m.peerId !== shared.owner);
    return [
      { peerId: shared.owner, name: nameOf(state, shared.owner), owner: true, ...presenceOf(state, shared.owner) },
      ...others.map((m) => ({ peerId: m.peerId, name: nameOf(state, m.peerId), owner: false, role: m.role, ...presenceOf(state, m.peerId) })),
    ];
  }
  return Object.entries(state.members[wsId] ?? {})
    .filter(([peerId]) => state.network.friends.some((f) => f.peerId === peerId))
    .map(([peerId, role]) => ({ peerId, name: nameOf(state, peerId), owner: false, role, ...presenceOf(state, peerId) }));
}

/** What the message box says while a friend's worktree can't hear you (undefined when it can). */
export function waitingNote(state: HereState, wsId: string): string | undefined {
  const shared = state.shared.find((w) => w.id === wsId && w.via === 'mesh');
  if (!shared || shared.role !== 'contribute') return undefined;
  const owner = presenceOf(state, shared.owner);
  const who = nameOf(state, shared.owner);
  if (owner.state === 'offline') return `${who}'s Mac is offline: your message goes when it's back`;
  if (owner.state === 'update') return `${who}'s Beluga needs an update: your message goes once it can reach it`;
  return undefined;
}
