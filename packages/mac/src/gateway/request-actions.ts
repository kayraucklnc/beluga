import type { Approval } from '../../../../src/core/store.js';

/**
 * What a request's buttons outside the window do (the macOS notification, the menu-bar menu),
 * as data: the window (request-native.ts) carries it out. Nothing outside the window can approve
 * your own Claude's tool use (that's reviewed in the window), and "Always" from outside writes a
 * rule that lasts a week (the request sheet offers the other choices).
 */

/** A notification's button was pressed (or it was clicked): the app shell's "notification-request", or this in a browser. */
export const REQUEST_NOTIFICATION = 'klaud:request-notification';

export type RequestAction = 'review' | 'approve' | 'always' | 'decline';

/** "Always" pressed outside the window: this project, this command, for a week. */
export const ALWAYS_FROM_OUTSIDE = { answer: 'always', scope: 'this', command: 'this', expiry: 'week' } as const;

/** The buttons a notification gets: a friend's request (Approve / Always for a week / Decline), anything else Review only. */
export function notificationActions(n: { readonly approval?: string; readonly task?: string }): { actionTypeId?: string } {
  if (!n.approval) return {};
  return { actionTypeId: n.task ? 'klaud-request' : 'klaud-review' };
}

/** A friend's request (from someone else, about something they asked): it may be answered from outside the window. */
const answerableOutside = (a: Approval): boolean => a.kind === 'request' && Boolean(a.peer);

export type OutsideStep =
  | { readonly kind: 'review'; readonly task?: string }
  | { readonly kind: 'decide'; readonly task: string; readonly decision: { readonly answer: 'yes' | 'no' | 'always'; readonly scope: 'this'; readonly command: 'this'; readonly expiry: 'never' | 'week' } }
  | { readonly kind: 'answer'; readonly id: string; readonly answer: 'yes' | 'no' }
  | { readonly kind: 'gone' };

/** What a button pressed outside the window does with this approval. */
export function outsideStep(action: RequestAction, approval: Approval | undefined, task: string | undefined): OutsideStep {
  if (action === 'review') return { kind: 'review', ...((task ?? approval?.task) ? { task: (task ?? approval?.task)! } : {}) };
  if (!approval) return { kind: 'gone' };
  // Your own Claude's tools (and anything that isn't a friend's request) are only reviewed in the window.
  if (!answerableOutside(approval)) return { kind: 'review', ...(approval.task ? { task: approval.task } : {}) };
  if (approval.task) {
    const answer = action === 'approve' ? 'yes' : action === 'decline' ? 'no' : 'always';
    return { kind: 'decide', task: approval.task, decision: answer === 'always' ? ALWAYS_FROM_OUTSIDE : { answer, scope: 'this', command: 'this', expiry: 'never' } };
  }
  // A request that isn't a task (a command through the room): Always isn't offered outside.
  if (action === 'always') return { kind: 'review' };
  return { kind: 'answer', id: approval.id, answer: action === 'approve' ? 'yes' : 'no' };
}

/** A menu-bar item for a request ("req-yes:<approval id>"…), or undefined if it's someone else's. */
export function parseRequestMenuId(id: string): { action: RequestAction; approval: string } | undefined {
  const m = /^req-(yes|always|no|open):(.+)$/.exec(id);
  if (!m) return undefined;
  const action: RequestAction = m[1] === 'yes' ? 'approve' : m[1] === 'no' ? 'decline' : m[1] === 'open' ? 'review' : 'always';
  return { action, approval: m[2]! };
}

/** Requests waiting for you, as the menu-bar menu lists them (friends' requests, newest first). */
export function trayRequests(approvals: readonly Approval[]): Array<{ id: string; title: string; always: boolean }> {
  return approvals
    .filter(answerableOutside)
    .slice(-6)
    .reverse()
    .map((a) => ({ id: a.id, title: a.title.length > 64 ? `${a.title.slice(0, 63)}…` : a.title, always: Boolean(a.task) }));
}
