import { useSyncExternalStore } from 'react';

/**
 * The sheets and alerts of friends and groups (one open at a time), opened from the sidebar,
 * menus, the palette, the menu bar and klaud:// links.
 */
export type NetSheet =
  /** Add Friend: invite someone, or use a code or link (`accept`: one that came in a link). */
  | { readonly kind: 'add_friend'; readonly accept?: string }
  /** Join a group from its invite link. */
  | { readonly kind: 'join_group'; readonly accept: string }
  /** A new group: a name and friends to start it with. */
  | { readonly kind: 'new_group'; readonly with?: readonly string[] }
  /** Add friends to a group you run. */
  | { readonly kind: 'add_people'; readonly groupId: string }
  | { readonly kind: 'remove_friend'; readonly peerId: string }
  | { readonly kind: 'leave_group'; readonly groupId: string }
  | { readonly kind: 'remove_member'; readonly groupId: string; readonly peerId: string }
  /** Your status with a note and how long it lasts. */
  | { readonly kind: 'status' }
  /** A group's info (members, invite link, requests), beside the conversation's header. */
  | { readonly kind: 'group_info'; readonly groupId: string };

let current: NetSheet | undefined;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const l of [...listeners]) l();
};

export function openNet(sheet: NetSheet): void {
  current = sheet;
  emit();
}

export function closeNet(): void {
  if (!current) return;
  current = undefined;
  emit();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const useNetSheet = (): NetSheet | undefined => useSyncExternalStore(subscribe, () => current);

/** "Add Friend…" from anywhere (the File menu, the palette, a link). */
export const ADD_FRIEND_EVENT = 'klaud:add-friend';
