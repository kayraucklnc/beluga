import type { NoticeTarget } from '@klaud/ui/notice-models.js';
import type { Actions } from './actions.js';

/** Go where a notification is about: the room, one of your workspaces, or one shared with you. */
export function openNoticeTarget(actions: Actions, target: NoticeTarget): void {
  if (target.kind === 'room') actions.run({ type: 'view', view: { kind: 'room' } });
  else if (target.kind === 'shared') actions.run({ type: 'open_shared', owner: target.owner, id: target.id, tab: 'chat' });
  else actions.run({ type: 'open_ws', id: target.id });
}

/** A desktop notification was clicked (the app shell or the browser says so with this event). */
export const NOTIFICATION_TAP = 'klaud:notification-tap';
