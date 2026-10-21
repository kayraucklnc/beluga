import { describe, expect, it } from 'vitest';
import { channelSuggestions, mentionedAsk, mergeAsk } from '../packages/mac/src/network/chat-model.js';
import type { FriendView, MemberView, MessageView } from '../src/net/mesh/views.js';
import {
  acceptError,
  addableFriends,
  continues,
  conversationOf,
  dayLabel,
  expiryLabel,
  findInvitation,
  idleStep,
  membersLine,
  mergeMessages,
  openFriendInvitation,
  presenceFor,
  presenceLine,
  readCode,
  selfLine,
  shownState,
  sortFriends,
  sortMembers,
  timeLeft,
  totalUnread,
  untilOf,
} from '../packages/mac/src/network/net-model.js';

/** The Mac app's friends, groups and status screens: what they say and decide (packages/mac/src/network/net-model.ts). */

const id = (c: string): string => c.repeat(32);
const friend = (name: string, extra: Partial<FriendView> = {}): FriendView => ({ peerId: id(name[0]!), name, online: true, presence: { state: 'online' }, addedAt: 0, unread: 0, ...extra });
const member = (name: string, extra: Partial<MemberView> = {}): MemberView => ({ peerId: id(name[0]!), name, online: true, presence: { state: 'online' }, admin: false, self: false, ...extra });
const msg = (from: string, ts: number, extra: Partial<MessageView> = {}): MessageView => ({ id: `${from}${ts}`, conversation: 'dm:x', from, name: from, text: 'hi', ts, mine: false, ...extra });

describe('conversations', () => {
  it('reads dm:<peer> and group:<id>, and nothing else', () => {
    expect(conversationOf(`dm:${id('a')}`)).toEqual({ kind: 'dm', peerId: id('a') });
    expect(conversationOf(`group:${'f'.repeat(32)}`)).toEqual({ kind: 'group', groupId: 'f'.repeat(32) });
    expect(conversationOf('ws:w1')).toBeUndefined();
    expect(conversationOf('group:nope')).toBeUndefined();
  });

  it('runs messages together by author within a few minutes on one day', () => {
    expect(continues(msg('a', 0), msg('a', 60_000))).toBe(true);
    expect(continues(msg('a', 0), msg('b', 60_000))).toBe(false);
    expect(continues(msg('a', 0), msg('a', 10 * 60_000))).toBe(false);
    expect(continues(msg('a', 0, { status: 'locked' }), msg('a', 1))).toBe(false);
    expect(continues(undefined, msg('a', 0))).toBe(false);
  });

  it('merges earlier history with the latest messages once each', () => {
    const a = msg('a', 1);
    const b = msg('a', 2);
    const c = msg('a', 3);
    expect(mergeMessages([a, b], [b, c]).map((m) => m.ts)).toEqual([1, 2, 3]);
  });

  it('labels days like Messages', () => {
    const now = new Date(2026, 9, 18, 15).getTime();
    expect(dayLabel(now - 60_000, now)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 17, 23).getTime(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 0, 2).getTime(), now)).not.toMatch(/2026/);
    expect(dayLabel(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/);
  });
});

describe('presence', () => {
  it('shows someone offline unless connected and visible', () => {
    expect(shownState({ online: false, presence: { state: 'away' } })).toBe('offline');
    expect(shownState({ online: true, presence: { state: 'dnd' } })).toBe('dnd');
    expect(shownState({ online: true, presence: { state: 'offline' } })).toBe('offline');
  });

  it('says the status with the note, but not an offline person’s note', () => {
    expect(presenceLine({ online: true, presence: { state: 'away', note: 'in a meeting' } })).toBe('Away · in a meeting');
    expect(presenceLine({ online: false, presence: { state: 'away', note: 'in a meeting' } })).toBe('Offline');
  });

  it('says your own choice, how long it lasts and your note', () => {
    const now = new Date(2026, 9, 18, 15, 0).getTime();
    expect(selfLine({ state: 'offline' }, now)).toBe('Appear Offline');
    expect(selfLine({ state: 'dnd', until: now + 30 * 60_000, note: 'focus' }, now)).toMatch(/^Do Not Disturb until 3:30\s?PM · focus$/);
    expect(selfLine({ state: 'dnd', until: untilOf('tomorrow', now)! }, now)).toMatch(/until tomorrow, 9:00\s?AM/);
  });

  it('builds a status: durations only for non-Online, notes trimmed', () => {
    const now = 1_000_000;
    expect(presenceFor('online', { note: '  hi ', duration: 'hour' }, now)).toEqual({ state: 'online', note: 'hi' });
    expect(presenceFor('dnd', { duration: 'hour' }, now)).toEqual({ state: 'dnd', until: now + 3_600_000 });
    expect(presenceFor('away', {}, now)).toEqual({ state: 'away' });
    expect(presenceFor('away', { note: 'x'.repeat(200) }, now).note).toHaveLength(140);
  });

  it('goes Away when idle (only from Online) and back when you return (only if it did that)', () => {
    const online = { state: 'online' as const };
    const away = { state: 'away' as const };
    expect(idleStep({ presence: online, idleMs: 11 * 60_000, autoAway: false })).toBe('away');
    expect(idleStep({ presence: online, idleMs: 60_000, autoAway: false })).toBeUndefined();
    expect(idleStep({ presence: { state: 'dnd' }, idleMs: 60 * 60_000, autoAway: false })).toBeUndefined();
    expect(idleStep({ presence: away, idleMs: 1_000, autoAway: true })).toBe('online');
    expect(idleStep({ presence: away, idleMs: 1_000, autoAway: false })).toBeUndefined();
    expect(idleStep({ presence: away, idleMs: 20 * 60_000, autoAway: true })).toBeUndefined();
  });
});

describe('invitations', () => {
  it('finds a link or a code in pasted text', () => {
    const secret = 'A'.repeat(22);
    expect(findInvitation(`hey, use klaud://add#${secret} tonight`)).toEqual({ text: `klaud://add#${secret}`, group: false });
    expect(findInvitation(`klaud://join#${secret}`)).toEqual({ text: `klaud://join#${secret}`, group: true });
    expect(findInvitation('klaud://add?code=K7QM-4XPA-R2TD')).toEqual({ text: 'klaud://add?code=K7QM-4XPA-R2TD', group: false });
    expect(findInvitation(' k7qm-4xpa-r2td ')).toEqual({ text: 'k7qm-4xpa-r2td', group: false });
    expect(findInvitation('hello there')).toBeUndefined();
    // A room invite (klaud://join/<invite>) isn't a network invitation.
    expect(findInvitation('klaud://join/https%3A%2F%2Fx#abc')).toBeUndefined();
  });

  it('reads codes the forgiving way', () => {
    expect(readCode('K7QM-4XPA-R2TD')).toBe('K7QM4XPAR2TD');
    expect(readCode('k7qm 4xpa r2td')).toBe('K7QM4XPAR2TD');
    expect(readCode('O1IL-0000-0000')).toBe('011100000000');
    expect(readCode('K7QM-4XPA-R2')).toBeUndefined();
    expect(readCode('UUUU-UUUU-UUUU')).toBeUndefined();
  });

  it('says how long an invitation lasts', () => {
    expect(expiryLabel(0, 1)).toBe('Expired');
    expect(expiryLabel(60_000, 0)).toBe('Expires in 1 minute');
    expect(expiryLabel(59 * 60_000, 0)).toBe('Expires in 59 minutes');
    expect(expiryLabel(24 * 3_600_000, 0)).toBe('Expires in 24 hours');
    expect(expiryLabel(7 * 24 * 3_600_000, 0)).toBe('Expires in 7 days');
    expect(timeLeft(3_600_000, 0)).toBe('1 hour');
    expect(timeLeft(0, 1)).toBe('no longer');
  });

  it('shows the newest unused friend invitation still open', () => {
    const inv = (n: string, expiresAt: number, extra: object = {}) => ({ id: n, kind: 'friend' as const, code: n, link: n, expiresAt, uses: 0, codeExpiresAt: expiresAt, codeLink: n, ...extra });
    expect(openFriendInvitation([inv('a', 10), inv('b', 20), inv('c', 30, { uses: 1 }), inv('d', 40, { kind: 'group' })], 5)?.id).toBe('b');
    expect(openFriendInvitation([inv('a', 10)], 11)).toBeUndefined();
  });

  it('turns accept errors into plain words', () => {
    expect(acceptError('Something went wrong: Nobody is waiting for that invitation.')).toMatch(/expired or was already used/);
    expect(acceptError("That's your own invitation")).toMatch(/your own invitation/);
    expect(acceptError('Pairing timed out')).toBe('Pairing timed out');
  });
});

describe('lists', () => {
  it('orders friends by name, steadily', () => {
    expect(sortFriends([friend('mia'), friend('Bob'), friend('ann')]).map((f) => f.name)).toEqual(['ann', 'Bob', 'mia']);
  });

  it('says who is in a group', () => {
    expect(membersLine([member('bob'), member('mia'), member('kay', { self: true })])).toBe('bob, mia and you');
    expect(membersLine([member('kay', { self: true })])).toBe('you');
    expect(membersLine([member('ann'), member('bob'), member('cat'), member('dan'), member('kay', { self: true })])).toBe('ann, bob, cat and 2 others');
  });

  it('puts you, then admins, then everyone by name', () => {
    expect(sortMembers([member('zed'), member('amy'), member('bob', { admin: true }), member('kay', { self: true })]).map((m) => m.name)).toEqual(['kay', 'bob', 'amy', 'zed']);
  });

  it('offers only friends who are not in the group yet, and counts unread', () => {
    const group = { members: [member('bob')] };
    expect(addableFriends([friend('bob'), friend('mia')], group).map((f) => f.name)).toEqual(['mia']);
    expect(totalUnread({ friends: [friend('bob', { unread: 2 })], groups: [{ unread: 3, active: true }, { unread: 9, active: false }] as never })).toBe(5);
  });
});

describe('@ and / in a channel', () => {
  const people = [
    { peerId: 'p-mia', name: 'Mia' },
    { peerId: 'p-bob', name: 'Bob Stone' },
  ];

  it('lists your Claude, each member’s Claude, everyone’s, then the people', () => {
    const list = channelSuggestions('hi @', { people });
    expect(list.map((s) => s.label)).toEqual(['Claude (yours)', 'Mia’s Claude', 'Bob Stone’s Claude', 'Everyone’s Claude', 'Mia', 'Bob Stone']);
    expect(list.find((s) => s.label === 'Mia’s Claude')?.value).toBe('hi @claude:Mia ');
    expect(list.find((s) => s.label === 'Bob Stone')?.value).toBe('hi @BobStone ');
    expect(channelSuggestions('@cl', { people }).map((s) => s.label)).toEqual(['Claude (yours)', 'Mia’s Claude', 'Bob Stone’s Claude', 'Everyone’s Claude']);
    expect(channelSuggestions('@mi', { people }).map((s) => s.label)).toEqual(['Mia’s Claude', 'Mia']);
    // Alone: only your Claude.
    expect(channelSuggestions('@', { people: [] }).map((s) => s.label)).toEqual(['Claude (yours)']);
    expect(channelSuggestions('no mention', { people })).toEqual([]);
  });

  it('lists the channel’s commands for / at the start', () => {
    expect(channelSuggestions('/', { people }).map((s) => s.command)).toEqual(['claude', 'claudes', 'files']);
    expect(channelSuggestions('/', { people, admin: true }).map((s) => s.command)).toContain('add-people');
    expect(channelSuggestions('/', { people: [] }).map((s) => s.command)).toEqual(['claude', 'files']);
    expect(channelSuggestions('/f', { people }).map((s) => s.label)).toEqual(['/files']);
    expect(channelSuggestions('/files now', { people })).toEqual([]);
  });

  it('turns mentions into whose Claude is asked; plain @name is the person', () => {
    expect(mentionedAsk('@claude what’s up?', 'me', people)).toEqual(['me']);
    expect(mentionedAsk('hey @claude:mia, and @claude:BobStone.', 'me', people)).toEqual(['p-mia', 'p-bob']);
    expect(mentionedAsk('@claudes ship it?', 'me', people)).toBe('all');
    expect(mentionedAsk('@Mia lunch?', 'me', people)).toBeUndefined();
    expect(mentionedAsk('see `@claude` and\n```\n@claudes\n```', 'me', people)).toBeUndefined();
    expect(mentionedAsk('mail@claude.ai', 'me', people)).toBeUndefined();
  });

  it('merges the button with the mentions', () => {
    expect(mergeAsk(['me'], ['p-mia', 'me'])).toEqual(['me', 'p-mia']);
    expect(mergeAsk(undefined, 'all')).toBe('all');
    expect(mergeAsk(['me'], undefined)).toEqual(['me']);
    expect(mergeAsk(undefined, undefined)).toBeUndefined();
  });
});
