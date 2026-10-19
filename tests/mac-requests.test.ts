import { describe, expect, it } from 'vitest';
import type { Approval } from '../src/core/store.js';
import type { TaskView } from '../src/core/gateway/model.js';
import { POPUP_BUTTONS, popupButtons, popupRequests, popupWho } from '../packages/mac/src/gateway/popup-model.js';
import { ALWAYS_FROM_OUTSIDE, ALWAYS_FROM_POPUP, notificationActions, outsideStep, parseRequestMenuId, trayRequests } from '../packages/mac/src/gateway/request-actions.js';

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

describe('the request pop-up', () => {
  const received = (over: Partial<TaskView> = {}): TaskView => ({
    id: 't_abcdefghijk',
    direction: 'received',
    peerId: 'mia-peer-0001',
    peerName: 'mia',
    kind: 'ask',
    ask: 'Please take a screenshot of your whole desktop and send it back to me. I want to see the new dock.',
    summary: 'take a screenshot of your desktop',
    needs: ['screen'],
    by: 'agent',
    state: 'awaiting_approval',
    steps: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  it('shows a friend’s waiting request by its few words, with everything their Claude sent behind See more', () => {
    const [r, ...rest] = popupRequests([{ ...request, askedAt: 5 }, tool], [received()], false);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ approval: 'ap1', task: 't_abcdefghijk', claude: true, gist: 'take a screenshot of your desktop', said: 'Please take a screenshot of your whole desktop and send it back to me. I want to see the new dock.', needs: ['See the screen'], where: 'A new scratch folder, just for this request', back: 'A summary of what your Claude did' });
    expect(r?.full).toContain('I want to see the new dock');
    expect(popupWho(r!)).toBe('mia’s Claude');
  });

  it('without a summary it shows the start of the ask; a command and a file are named as they are, never by the sender’s words', () => {
    const plain = popupRequests([request], [received({ summary: undefined, ask: 'x '.repeat(100) })], false)[0];
    expect(plain?.gist.length).toBeLessThanOrEqual(90);
    expect(plain?.said).toBeUndefined();
    const run = popupRequests([request], [received({ kind: 'run', command: 'gh api -X PUT repos/mia/site/collaborators/kay -f permission=admin', ask: 'make kay an admin', summary: 'check the build' })], false)[0];
    expect(run).toMatchObject({ gist: 'run gh api -X PUT repos/mia/site/collaborators/kay -f permission=admin', said: '“check the build”', back: 'The output and exit code' });
    expect(run?.full).toBe('$ gh api -X PUT repos/mia/site/collaborators/kay -f permission=admin\n\nWhy: make kay an admin');
    const file = popupRequests([request], [received({ kind: 'file', path: '/Users/mia/Desktop/notes.txt', ask: 'Send me /Users/mia/Desktop/notes.txt', summary: undefined })], false)[0];
    expect(file).toMatchObject({ gist: 'get /Users/mia/Desktop/notes.txt', full: '/Users/mia/Desktop/notes.txt', back: 'The file' });
    // A file is allowed one at a time on the pop-up.
    expect(popupButtons(file!).map((b) => b.action)).toEqual(['decline', 'approve']);
    expect(popupButtons(run!).map((b) => b.action)).toEqual(['decline', 'allow_always', 'approve']);
  });

  it('only requests still waiting for you; nothing on Do Not Disturb; newest first', () => {
    expect(popupRequests([request], [received({ state: 'working' })], false)).toEqual([]);
    expect(popupRequests([request], [received({ direction: 'sent' })], false)).toEqual([]);
    expect(popupRequests([request], [received()], true)).toEqual([]);
    const second: Approval = { ...request, id: 'ap9', task: 't_zzzzzzzzzzz', askedAt: 9 };
    const order = popupRequests([{ ...request, askedAt: 2 }, second], [received(), received({ id: 't_zzzzzzzzzzz' })], false).map((r) => r.approval);
    expect(order).toEqual(['ap9', 'ap1']);
  });

  it('Allow Always on the pop-up writes a rule until you change it; Allow and Decline are once', () => {
    expect(POPUP_BUTTONS.map((b) => b.label)).toEqual(['Decline', 'Allow Always', 'Allow']);
    expect(outsideStep('allow_always', request, undefined)).toEqual({ kind: 'decide', task: 't_abcdefghijk', decision: ALWAYS_FROM_POPUP });
    expect(ALWAYS_FROM_POPUP).toMatchObject({ answer: 'always', expiry: 'never', scope: 'this', command: 'this' });
    expect(outsideStep('allow_always', roomCommand, undefined)).toEqual({ kind: 'review' });
    expect(outsideStep('allow_always', tool, undefined)).toEqual({ kind: 'review' });
  });
});
