import type { DomainState } from '@klaud/core/store.js';
import { type NoticeTarget, noticeTarget } from '@klaud/ui/notice-models.js';
import type { Actions } from './actions.js';

/** Where a notification goes in this window: the shared places, or a conversation with friends. */
export type MacNoticeTarget = NoticeTarget | { readonly kind: 'conversation'; readonly id: string };

/** The place a notice is about (a conversation with a friend or a group is this window's own). */
export function macNoticeTarget(state: Pick<DomainState, 'projects' | 'shared' | 'network'>, channel: string | undefined): MacNoticeTarget | undefined {
  if (channel?.startsWith('dm:') || channel?.startsWith('group:')) {
    const id = channel.slice(channel.indexOf(':') + 1);
    const known = channel.startsWith('dm:') ? state.network.friends.some((f) => f.peerId === id) : state.network.groups.some((g) => g.id === id);
    return known ? { kind: 'conversation', id: channel } : undefined;
  }
  return noticeTarget(state, channel);
}

/** Go where a notification is about: the room, one of your workspaces, one shared with you, or a conversation with friends. */
export function openNoticeTarget(actions: Actions, target: MacNoticeTarget, go?: (id: string) => void): void {
  if (target.kind === 'conversation') go?.(target.id);
  else if (target.kind === 'room') actions.run({ type: 'view', view: { kind: 'room' } });
  else if (target.kind === 'shared') actions.run({ type: 'open_shared', owner: target.owner, id: target.id, tab: 'chat' });
  else actions.run({ type: 'open_ws', id: target.id });
}

/** A desktop notification was clicked (the app shell or the browser says so with this event). */
export const NOTIFICATION_TAP = 'klaud:notification-tap';
