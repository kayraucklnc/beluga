import type { DomainState } from '@beluga/core/store.js';
import { planMilestonesOnly, planOfChannel } from '@beluga/core/notify.js';
import { type NoticeTarget, noticeTarget } from '@beluga/ui/notice-models.js';
import type { Actions } from './actions.js';

/** Where a notification goes in this window: the shared places, a conversation with friends, or a plan (at one of its tasks). */
export type MacNoticeTarget = NoticeTarget | { readonly kind: 'conversation'; readonly id: string } | { readonly kind: 'plan'; readonly id: string; readonly task?: string };

/**
 * The place a notice is about (a conversation with a friend or a group is this window's own). A
 * plan's task or home opens the plan there, while plans speak for their tasks (Settings › Notifications).
 */
export function macNoticeTarget(state: Pick<DomainState, 'projects' | 'shared' | 'network' | 'plans' | 'board' | 'prefs'>, channel: string | undefined, plan?: { readonly id: string; readonly task?: string }): MacNoticeTarget | undefined {
  if (plan && state.plans.plans.some((p) => p.id === plan.id)) return { kind: 'plan', ...plan };
  const place = planMilestonesOnly(state.prefs.notify) ? planOfChannel(state, channel) : undefined;
  if (place && place.plan.status !== 'draft' && (place.issue || place.plan.status === 'active')) return { kind: 'plan', id: place.plan.id, ...(place.task ? { task: place.task } : {}) };
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
  else if (target.kind === 'plan') actions.run({ type: 'view', view: { kind: 'plan', id: target.id, ...(target.task ? { task: target.task } : {}) } });
  else if (target.kind === 'room') actions.run({ type: 'view', view: { kind: 'room' } });
  else if (target.kind === 'assistant') actions.run({ type: 'view', view: { kind: 'assistant' } });
  else if (target.kind === 'shared') actions.run({ type: 'open_shared', owner: target.owner, id: target.id, tab: 'chat' });
  else actions.run({ type: 'open_ws', id: target.id });
}

/** A desktop notification was clicked (the app shell or the browser says so with this event). */
export const NOTIFICATION_TAP = 'beluga:notification-tap';
