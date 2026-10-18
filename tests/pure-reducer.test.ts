import { describe, expect, it } from 'vitest';
import { type Action, initialState, reduceDomain, stampAction } from '../src/core/store.js';
import { intentAction } from '../src/core/intents.js';
import type { PeerInfo } from '../src/protocol.js';

const me: PeerInfo = { peerId: 'me', name: 'kay', shares: [], agent: true };
const bob: PeerInfo = { peerId: 'bob', name: 'bob', shares: [], agent: true };

const SCRIPT: readonly Action[] = [
  { type: 'welcome', self: me },
  { type: 'peers', peers: [me, bob] },
  { type: 'chat', id: 'c1', from: 'bob', text: 'hi', ts: 1, byAgent: false },
  { type: 'system', text: 'Joined' },
  { type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'bob', event: 'started', text: '', ts: 2 },
  { type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'bob', event: 'text', text: 'working', ts: 3 },
  { type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'bob', event: 'compact', text: JSON.stringify({ pre: 100_000, post: 20_000 }), ts: 4, channel: 'room' },
  { type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'bob', event: 'done', text: 'finished', ts: 5 },
  { type: 'notice_add', notice: { kind: 'done', title: 'Claude finished', body: 'finished' } },
];

describe('reduceDomain', () => {
  it('is pure for stamped actions: every client replaying them gets the same state', () => {
    const stamped = SCRIPT.map(stampAction);
    const replay = (): unknown => stamped.reduce(reduceDomain, initialState('room'));
    const a = replay();
    const b = replay();
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('stamps only what needs the clock or a counter, and only once', () => {
    const system = stampAction({ type: 'system', text: 'x' });
    expect(system).toMatchObject({ id: expect.any(String), ts: expect.any(Number) });
    expect(stampAction(system)).toBe(system);
    const chat: Action = { type: 'chat', id: 'c', from: 'me', text: 'x', ts: 1, byAgent: false };
    expect(stampAction(chat)).toBe(chat);
    const event = stampAction<Action>({ type: 'agent_event', owner: 'me', requestId: 'r', requester: 'me', event: 'started', text: '', ts: 1 });
    expect(event.type === 'agent_event' && event.itemId).toEqual(expect.any(String));
  });

  it('uses the stamps for the items it creates', () => {
    const s = [
      { type: 'system', text: 'hello', id: 's1', ts: 42 },
      { type: 'agent_event', owner: 'me', requestId: 'r', requester: 'me', event: 'started', text: '', ts: 7, itemId: 'a1' },
      { type: 'notice_add', notice: { kind: 'done', title: 't', body: 'b' }, ts: 9 },
    ].reduce((st, a) => reduceDomain(st, a as Action), initialState('room'));
    expect(s.log.map((l) => [l.id, l.ts])).toEqual([
      ['s1', 42],
      ['a1', 7],
    ]);
    expect(s.inbox[0]?.ts).toBe(9);
  });
});

describe('intents shown in the store', () => {
  it('navigates unless the screen already shows that kind of view', () => {
    expect(intentAction({ type: 'navigate', view: { kind: 'overview' } }, { kind: 'room' })).toEqual({ type: 'view', view: { kind: 'overview' } });
    const shared = { kind: 'shared', owner: 'bob', id: 'w', tab: 'chat' } as const;
    expect(intentAction({ type: 'navigate', view: shared, unless: 'shared' }, { ...shared, id: 'other' })).toBeUndefined();
  });

  it('closing a shared workspace that is showing goes back to the room', () => {
    const s0 = reduceDomain(initialState('room'), { type: 'view', view: { kind: 'shared', owner: 'bob', id: 'w', tab: 'chat' } });
    const s1 = reduceDomain(s0, intentAction({ type: 'close_tab', id: 'w' }, s0.view)!);
    expect(s1.view.kind).toBe('room');
  });
});
