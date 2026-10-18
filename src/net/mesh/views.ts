/**
 * What the klaud network looks like to a screen: people, groups, messages and invitations.
 * Plain data only (no keys, no secrets): this is what goes into the shared state.
 * Browser-safe: types only.
 */

export type PresenceState = 'online' | 'away' | 'dnd' | 'offline';

/** A status you set: shown to your friends and the people in your groups. */
export interface Presence {
  readonly state: PresenceState;
  /** A short note ("at lunch"). */
  readonly note?: string;
  /** When it goes back to online by itself (ms since epoch). */
  readonly until?: number;
}

/** Someone you know on the network (a friend or someone in one of your groups). */
export interface PersonView {
  readonly peerId: string;
  readonly name: string;
  /** Connected right now (and not appearing offline). */
  readonly online: boolean;
  readonly presence: Presence;
  /** How you're connected: straight to their Mac, or through another member's Mac (still end-to-end encrypted). */
  readonly via?: 'direct' | 'relay';
}

/** One message in a conversation with a friend (`dm:<peerId>`) or in a group (`group:<id>`). */
export interface MessageView {
  readonly id: string;
  readonly conversation: string;
  readonly from: string;
  readonly name: string;
  readonly text: string;
  readonly ts: number;
  readonly mine: boolean;
  /**
   * Your direct messages: waiting (in your outbox until they're online), delivered, or expired.
   * Group messages that can't be read (no key for them yet) are 'locked'.
   */
  readonly status?: 'waiting' | 'delivered' | 'expired' | 'locked';
}

export interface FriendView extends PersonView {
  readonly addedAt: number;
  readonly unread: number;
  readonly last?: MessageView;
}

export interface MemberView extends PersonView {
  readonly admin: boolean;
  /** You (so a screen can say "you"). */
  readonly self: boolean;
}

/** Someone who used a group invite link and waits for an admin. */
export interface JoinRequestView {
  readonly peerId: string;
  readonly name: string;
  readonly ts: number;
}

export interface GroupView {
  readonly id: string;
  readonly name: string;
  readonly members: readonly MemberView[];
  /** You're an admin (you can add and remove people). */
  readonly admin: boolean;
  /** You're in it (false once you left or were removed: the history stays, read-only). */
  readonly active: boolean;
  readonly unread: number;
  readonly last?: MessageView;
  readonly requests: readonly JoinRequestView[];
  readonly createdAt: number;
}

/** An invitation you made: a link and a short code, either one works. */
export interface InvitationView {
  readonly id: string;
  readonly kind: 'friend' | 'group';
  readonly groupId?: string;
  /** e.g. K7QM-4XPA */
  readonly code: string;
  /** klaud://add#… or klaud://join#… */
  readonly link: string;
  readonly expiresAt: number;
  readonly uses: number;
}

/** A group you asked to join and that hasn't let you in yet. */
export interface PendingJoinView {
  readonly groupId: string;
  readonly name: string;
  readonly since: number;
}

export interface NetworkSelf {
  readonly peerId: string;
  readonly name: string;
  /** What you chose (others see "offline" while you appear offline). */
  readonly presence: Presence;
  readonly appearOffline: boolean;
}

/** Everything about the network except the messages (they're kept per conversation). */
export interface NetworkSummary {
  /** The network is turned on (settings `network: true` or KLAUD_NETWORK=1). */
  readonly enabled: boolean;
  readonly self?: NetworkSelf;
  readonly friends: readonly FriendView[];
  readonly groups: readonly GroupView[];
  readonly invitations: readonly InvitationView[];
  readonly pendingJoins: readonly PendingJoinView[];
}

export interface NetworkState extends NetworkSummary {
  /** The latest messages per conversation (older ones: `network.dm.history` / `network.groups.history`). */
  readonly messages: Readonly<Record<string, readonly MessageView[]>>;
}

export const dmConversation = (peerId: string): string => `dm:${peerId}`;
export const groupConversation = (groupId: string): string => `group:${groupId}`;
