import { describe, expect, it } from 'vitest';
import type { Approval } from '../src/core/store.js';
import { ALWAYS_FROM_OUTSIDE, notificationActions, outsideStep, parseRequestMenuId, trayRequests } from '../packages/mac/src/gateway/request-actions.js';

/** A friend's request outside the window (the notification, the menu bar): what each button may do. */

const request: Approval = { id: 'ap1', kind: 'request', title: "mia's Claude wants to: review", detail: '', peer: 'mia-peer-0001', task: 't_abcdefghijk' };
const roomCommand: Approval = { id: 'ap2', kind: 'request', title: 'bob wants to run a command', detail: '', peer: 'bob-peer-0001' };
const tool: Approval = { id: 'ap3', kind: 'tool', title: 'Your Claude wants to use Bash', detail: '' };

describe('buttons outside the window', () => {
  it('only a friend’s request gets Approve / Always / Decline on its notification; anything else only Review', () => {
    expect(notificationActions({ approval: 'ap1', task: 't_abcdefghijk' })).toEqual({ actionTypeId: 'klaud-request' });
    expect(notificationActions({ approval: 'ap3' })).toEqual({ actionTypeId: 'klaud-review' });
    expect(notificationActions({})).toEqual({});
  });

  it('your own Claude’s tools are never approved from outside: they open for review', () => {
    expect(outsideStep('approve', tool, undefined)).toEqual({ kind: 'review' });
    expect(outsideStep('decline', tool, undefined)).toEqual({ kind: 'review' });
  });

  it('Always from outside lasts a week (this project, this command); Approve and Decline are once', () => {
    expect(outsideStep('always', request, undefined)).toEqual({ kind: 'decide', task: 't_abcdefghijk', decision: ALWAYS_FROM_OUTSIDE });
    expect(ALWAYS_FROM_OUTSIDE).toMatchObject({ expiry: 'week', scope: 'this', command: 'this' });
    expect(outsideStep('approve', request, undefined)).toMatchObject({ kind: 'decide', decision: { answer: 'yes', expiry: 'never' } });
    expect(outsideStep('decline', roomCommand, undefined)).toEqual({ kind: 'answer', id: 'ap2', answer: 'no' });
    // A room command's Always isn't offered outside: it opens for review instead.
    expect(outsideStep('always', roomCommand, undefined)).toEqual({ kind: 'review' });
    expect(outsideStep('approve', undefined, undefined)).toEqual({ kind: 'gone' });
    expect(outsideStep('review', undefined, 't_abcdefghijk')).toEqual({ kind: 'review', task: 't_abcdefghijk' });
  });

  it('the menu bar lists friends’ requests only (Always only for tasks), newest first', () => {
    expect(trayRequests([request, tool, roomCommand])).toEqual([
      { id: 'ap2', title: 'bob wants to run a command', always: false },
      { id: 'ap1', title: "mia's Claude wants to: review", always: true },
    ]);
    expect(parseRequestMenuId('req-always:ap1')).toEqual({ action: 'always', approval: 'ap1' });
    expect(parseRequestMenuId('req-open:ap1')).toEqual({ action: 'review', approval: 'ap1' });
    expect(parseRequestMenuId('status-dnd')).toBeUndefined();
  });
});
