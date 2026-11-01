import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTO_CHATS_KEPT, MacAssistant } from '../src/core/assistant/assistant.js';
import { pretendSystem } from '../src/core/gateway/demo-system.js';
import { SentinelChats } from '../src/core/sentinel/chat.js';
import { DEFAULT_PREFS, Store, initialState, prefsFrom } from '../src/core/store.js';
import { Settings } from '../src/shared/settings-schema.js';
import { CHAT_LIMIT_DEFAULT, CHAT_LIMIT_NONE, chatFits, chatLimitMessage } from '../src/shared/chat-limit.js';
import { waitFor } from './helpers.js';

/** BLG-563: how many chats Your Mac and Sentinel keep is a setting, up to no limit, and the refusal says where. */

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-chat-limit-'));

function store(chatLimit?: number): Store {
  const s = new Store(initialState('room', 'auto'));
  s.dispatch({ type: 'identity', selfId: 'me', isHost: true, home: '/Users/k' });
  if (chatLimit !== undefined) s.dispatch({ type: 'prefs', prefs: { chatLimit } });
  return s;
}

const mac = (s: Store): MacAssistant => new MacAssistant({ store: s, dir: tmp(), selfId: () => 'me', system: pretendSystem(), claudeDir: tmp() });
const sentinel = (s: Store): SentinelChats => new SentinelChats({ store: s, dir: null, selfId: () => 'me', claudeDir: tmp() });

describe('the setting', () => {
  it('defaults to 30, keeps 0 as no limit, and falls back on nonsense', () => {
    expect(DEFAULT_PREFS.chatLimit).toBe(CHAT_LIMIT_DEFAULT);
    expect(Settings.parse({}).chatLimit).toBe(30);
    expect(Settings.parse({ chatLimit: 0 }).chatLimit).toBe(CHAT_LIMIT_NONE);
    expect(Settings.parse({ chatLimit: -4 }).chatLimit).toBe(30);
    expect(prefsFrom(Settings.parse({ chatLimit: 100 })).chatLimit).toBe(100);
  });

  it('fits: under the limit, never past it, always with no limit', () => {
    expect(chatFits(29, 30)).toBe(true);
    expect(chatFits(30, 30)).toBe(false);
    expect(chatFits(5000, CHAT_LIMIT_NONE)).toBe(true);
    expect(chatFits(30, undefined)).toBe(false);
  });

  it('the refusal says where to raise it', () => {
    expect(chatLimitMessage(30, 30, 'Your Mac chats')).toBe('30 Your Mac chats are open, your limit. Delete one you’re done with, or raise the limit in Settings › Agent › Open chats.');
    expect(chatLimitMessage(42, 10, 'Sentinel chats')).toContain('42 Sentinel chats are open and your limit is 10');
  });
});

describe.each([
  ['Your Mac', mac, 'Your Mac chats'],
  ['Sentinel', sentinel, 'Sentinel chats'],
] as const)('%s chats', (_name, make, what) => {
  it('stops at the limit, pointing to Settings', () => {
    const s = store(3);
    const chats = make(s);
    chats.newChat();
    chats.newChat();
    expect(() => chats.newChat()).toThrow(`3 ${what} are open, your limit. Delete one you’re done with, or raise the limit in Settings › Agent › Open chats.`);
  });

  it('a raised limit takes effect at once', () => {
    const s = store(2);
    const chats = make(s);
    chats.newChat();
    expect(() => chats.newChat()).toThrow(/Open chats/);
    s.dispatch({ type: 'prefs', prefs: { chatLimit: 4 } });
    chats.newChat();
    chats.newChat();
    expect(() => chats.newChat()).toThrow(/4 .* are open/);
  });

  it('no limit never refuses', () => {
    const chats = make(store(CHAT_LIMIT_NONE));
    for (let i = 0; i < 40; i++) chats.newChat();
  });
});

/**
 * BLG-568: an hourly sentinel working in Your Mac opened a chat each run; at the 30th every run
 * failed on the limit. Beluga's own chats don't count, don't take your tab, and only the newest few stay.
 */
describe('chats a sentinel opens in Your Mac', () => {
  it('are never refused by the limit, and your own + isn’t blocked by them', () => {
    const s = store(2);
    const m = mac(s);
    for (let i = 0; i < 5; i++) m.newChat({ auto: true });
    // Yours: the first chat and one more fit; the third doesn't.
    m.newChat();
    expect(() => m.newChat()).toThrow('2 Your Mac chats are open, your limit');
  });

  it('leave the tab you have open alone', () => {
    const m = mac(store());
    const yours = m.newChat();
    const auto = m.newChat({ auto: true });
    expect(m.chats().active).toBe(yours);
    expect(m.chats().chats.map((c) => c.id)).toContain(auto);
  });

  it('only the newest are kept; yours, the open one and one working now always stay', async () => {
    const s = store(CHAT_LIMIT_NONE);
    const m = mac(s);
    const yours = m.newChat();
    const first = m.newChat({ auto: true });
    const second = m.newChat({ auto: true });
    m.openChat(first);
    s.dispatch({ type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'me', event: 'started', text: '', ts: 1, channel: `mac:assistant:${second}`, itemId: 'i1' });
    const made = [first, second];
    for (let i = 0; i < AUTO_CHATS_KEPT + 3; i++) made.push(m.newChat({ auto: true }));
    await waitFor(() => m.chats().chats.length === 2 + AUTO_CHATS_KEPT);
    const ids = m.chats().chats.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['main', yours, first, second, ...made.slice(-(AUTO_CHATS_KEPT - 2))]));
    expect(ids).not.toContain(made[2]);
  });

  it('stay Beluga’s own across a restart', () => {
    const s = store(1);
    const dir = tmp();
    const make = (): MacAssistant => new MacAssistant({ store: s, dir, selfId: () => 'me', system: pretendSystem(), claudeDir: tmp() });
    const before = make();
    before.newChat({ auto: true });
    before.stop();
    // Read back, the auto chat still doesn't count: only the first chat takes your one place.
    expect(() => make().newChat()).toThrow('1 Your Mac chats are open, your limit');
    s.dispatch({ type: 'prefs', prefs: { chatLimit: 2 } });
    expect(() => make().newChat()).not.toThrow();
  });
});
