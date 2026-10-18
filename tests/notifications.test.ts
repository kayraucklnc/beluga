import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store, initialState, reduce, type Action, type DomainState } from '../src/core/store.js';
import { AttentionRegistry } from '../src/core/attention.js';
import { ClientStore } from '../src/client/client-store.js';
import { attentionOf, initialScreen } from '../src/client/screen.js';
import { type DesktopNote, Notifier, combine, desktopAllowed, detectNotices, enabled } from '../src/core/notify.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import { parseArgs } from '../src/ipc/api.js';
import type { Session } from '../src/core/session.js';
import { NotifySettings } from '../src/shared/settings-schema.js';
import { dndActive, dndFor, dndLabel, nextDnd } from '../src/shared/quiet.js';
import { FrontTracker } from '../src/ui/tty/front.js';
import { badgeCount, filterNotices, groupNotices, noticeAgo, noticeLook, noticeTarget } from '../src/ui/notice-models.js';
import type { PeerInfo } from '../src/protocol.js';
import type { Project } from '../src/workspaces/types.js';
import type { Notice } from '../src/core/work-store.js';

const me: PeerInfo = { peerId: 'me', name: 'kay', agent: true, shares: [] };
const bob: PeerInfo = { peerId: 'b', name: 'bob', agent: true, shares: [] };
const cat: PeerInfo = { peerId: 'c', name: 'cat', agent: false, shares: [] };

const project: Project = {
  id: 'p1',
  name: 'app',
  root: '/tmp/app',
  base: 'main',
  workspaces: [{ id: 'w1', projectId: 'p1', projectRoot: '/tmp/app', name: 'add-auth', path: '/tmp/app-w1', kind: 'worktree', createdAt: 0, external: false }],
};

const apply = (s: DomainState, ...actions: Action[]): DomainState => actions.reduce(reduce, s);
const base = (peers: PeerInfo[] = [me, bob, cat]): DomainState =>
  apply(initialState('room'), { type: 'status', status: 'connected' }, { type: 'peers', peers }, { type: 'welcome', self: me }, { type: 'projects', projects: [project] });
const chat = (id: string, from: string, text: string, opts: { channel?: string; byAgent?: boolean; ts?: number } = {}): Action => ({
  type: 'chat',
  id,
  from,
  text,
  ts: opts.ts ?? 10,
  byAgent: opts.byAgent ?? false,
  ...(opts.channel ? { channel: opts.channel } : {}),
});
const run = (event: 'started' | 'sub' | 'done', text = '', channel = 'ws:w1'): Action => ({ type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'me', event, text, ts: 1, channel });
const notify = (patch: Partial<NotifySettings>): Action => ({ type: 'prefs', prefs: { notify: { ...NotifySettings.parse({}), ...patch } } });

// ---------------------------------------------------------------- the inbox: read, unread, clear

describe('inbox reducer', () => {
  const three = (): DomainState =>
    apply(
      initialState('r'),
      { type: 'notice_add', notice: { kind: 'done', title: 'one', body: '' } },
      { type: 'notice_add', notice: { kind: 'done', title: 'two', body: '', channel: 'ws:w1' } },
      { type: 'notice_add', notice: { kind: 'people', tag: 'joined', title: 'three', body: '' } },
    );

  it('clears one notice by id, or all of them', () => {
    const s = three();
    expect(apply(s, { type: 'notice_clear', id: 2 }).inbox.map((n) => n.title)).toEqual(['three', 'one']);
    expect(apply(s, { type: 'notice_clear' }).inbox).toEqual([]);
  });

  it('leaves the state alone when there is nothing to clear', () => {
    const s = three();
    expect(reduce(s, { type: 'notice_clear', id: 99 }).inbox).toBe(s.inbox);
    const empty = initialState('r');
    expect(reduce(empty, { type: 'notice_clear' }).inbox).toBe(empty.inbox);
  });

  it('marks one unread again, and only a read one', () => {
    const s = apply(three(), { type: 'notice_read' });
    const back = reduce(s, { type: 'notice_unread', id: 1 });
    expect(back.inbox.map((n) => n.read)).toEqual([true, true, false]);
    expect(reduce(back, { type: 'notice_unread', id: 1 }).inbox).toBe(back.inbox);
    expect(reduce(back, { type: 'notice_unread', id: 42 }).inbox).toBe(back.inbox);
  });

  it('keeps the tag a notice was added with', () => {
    expect(three().inbox[0]).toMatchObject({ kind: 'people', tag: 'joined', read: false });
  });
});

describe('inbox API', () => {
  const session = (): Session => ({ store: new Store(apply(initialState('r'), { type: 'notice_add', notice: { kind: 'done', title: 'a', body: '' } }, { type: 'notice_add', notice: { kind: 'done', title: 'b', body: '' } })) }) as unknown as Session;

  it('clears one, or all, and marks one unread', () => {
    const s = session();
    HANDLERS['inbox.clear'](s, ...parseArgs('inbox.clear', [{ id: 2 }]));
    expect(s.store.getState().inbox.map((n) => n.title)).toEqual(['a']);
    HANDLERS['inbox.read'](s, ...parseArgs('inbox.read', [{ id: 1 }]));
    HANDLERS['inbox.unread'](s, ...parseArgs('inbox.unread', [1]));
    expect(s.store.getState().inbox[0]?.read).toBe(false);
    HANDLERS['inbox.clear'](s, ...parseArgs('inbox.clear', []));
    expect(s.store.getState().inbox).toEqual([]);
  });

  it('refuses bad arguments', () => {
    expect(() => parseArgs('inbox.clear', [{ id: 'x' }])).toThrow(/inbox.clear/);
    expect(() => parseArgs('inbox.unread', [])).toThrow(/inbox.unread/);
  });
});

// ---------------------------------------------------------------- what is worth a notice

describe('detectNotices: mentions and messages', () => {
  it('announces someone mentioning you by name, anywhere in the message', () => {
    const s = base();
    expect(detectNotices(s, apply(s, chat('c1', 'b', 'nice work @KAY, can you look?')))).toEqual([
      { kind: 'mentions', tag: 'mention', title: 'bob mentioned you in the group chat', body: 'nice work @KAY, can you look?', channel: 'room' },
    ]);
    expect(detectNotices(s, apply(s, chat('c2', 'b', '@kay', { channel: 'ws:w1' })))[0]).toMatchObject({ title: 'bob mentioned you in add-auth', channel: 'ws:w1' });
  });

  it('ignores names that only start like yours, e-mail addresses, and plain chat', () => {
    const s = base();
    for (const text of ['@kayla hi', 'mail me at x@kay.dev', 'kay, hi', 'hi all']) expect(detectNotices(s, apply(s, chat('c1', 'b', text)))).toEqual([]);
  });

  it('treats the room as a direct message when it is just the two of you', () => {
    const s = base([me, bob]);
    expect(detectNotices(s, apply(s, chat('c1', 'b', 'got a sec?')))).toEqual([{ kind: 'mentions', tag: 'message', title: 'bob wrote to you', body: 'got a sec?', channel: 'room' }]);
    // Not in a workspace's conversation, and not with more people around.
    expect(detectNotices(s, apply(s, chat('c2', 'b', 'hm', { channel: 'ws:w1' })))).toEqual([]);
  });

  it('ignores your own messages, Claude speaking, history arriving, and before you are in', () => {
    const s = base([me, bob]);
    expect(detectNotices(s, apply(s, chat('c1', 'me', 'hi @kay')))).toEqual([]);
    expect(detectNotices(s, apply(s, chat('c1', 'b', '@kay done', { byAgent: true })))).toEqual([]);
    const burst = apply(s, chat('h1', 'b', '@kay 1'), chat('h2', 'b', '@kay 2'), chat('h3', 'b', '@kay 3'), chat('h4', 'b', '@kay 4'));
    expect(detectNotices(s, burst)).toEqual([]);
    const notIn = apply(initialState('room'), { type: 'peers', peers: [me, bob] });
    expect(detectNotices(notIn, apply(notIn, chat('c1', 'b', '@kay')))).toEqual([]);
  });
});

describe('detectNotices: background work', () => {
  const sub = (phase: 'start' | 'done', extra: object = {}): Action => run('sub', JSON.stringify({ id: 't1', phase, title: 'npm test --watch', kind: 'background', ...extra }));

  it('announces a background task ending while Claude works on', () => {
    const s1 = apply(base(), run('started'), sub('start'));
    expect(detectNotices(s1, apply(s1, sub('done')))).toEqual([
      { kind: 'background', tag: 'task', title: 'A background task finished in add-auth', body: 'npm test --watch', channel: 'ws:w1' },
    ]);
    expect(detectNotices(s1, apply(s1, sub('done', { failed: true })))[0]?.title).toBe('A background task failed in add-auth');
  });

  it("stays quiet when the run ends (its tasks end with it), and about sub-agents", () => {
    const s1 = apply(base(), run('started'), sub('start'));
    expect(detectNotices(s1, apply(s1, run('done', 'ok'))).map((e) => e.kind)).toEqual(['done']);
    const agent = apply(base(), run('started'), run('sub', JSON.stringify({ id: 'a1', phase: 'start', title: 'explore', kind: 'agent' })));
    expect(detectNotices(agent, apply(agent, run('sub', JSON.stringify({ id: 'a1', phase: 'done' }))))).toEqual([]);
  });

  it("announces a new worktree's setup finishing (failures are problems elsewhere)", () => {
    const s1 = apply(base(), { type: 'setup', id: 'w1', run: { status: 'running', command: 'npm install' } });
    expect(detectNotices(s1, apply(s1, { type: 'setup', id: 'w1', run: { status: 'done', command: 'npm install' } }))).toEqual([
      { kind: 'background', tag: 'task', title: 'add-auth is set up', body: 'npm install', channel: 'ws:w1' },
    ]);
    expect(detectNotices(s1, apply(s1, { type: 'setup', id: 'w1', run: { status: 'failed', command: 'npm install' } }))).toEqual([]);
  });
});

describe('enabled', () => {
  it('reads the new toggles, and treats a missing one as on', () => {
    const prefs = NotifySettings.parse({ mentions: false });
    expect(enabled(prefs, 'mentions')).toBe(false);
    expect(enabled(prefs, 'background')).toBe(true);
    expect(enabled({ ...prefs, background: undefined } as unknown as NotifySettings, 'background')).toBe(true);
  });

  it('old settings files get the new defaults', () => {
    expect(NotifySettings.parse({ desktop: false, done: false })).toMatchObject({ desktop: false, done: false, mentions: true, background: true, onlyAway: false, dnd: null });
  });
});

// ---------------------------------------------------------------- Do Not Disturb

describe('Do Not Disturb', () => {
  const at = (day: number, h: number, m = 0): number => new Date(2026, 9, day, h, m).getTime();

  it('lasts an hour, until tomorrow morning, or until you turn it off', () => {
    expect(dndFor('hour', at(18, 14))).toEqual({ until: at(18, 15) });
    expect(dndFor('tomorrow', at(18, 23, 30))).toEqual({ until: at(19, 8) });
    expect(dndFor('forever', at(18, 14))).toEqual({});
  });

  it('is on until its time, then off by itself', () => {
    const n = { dnd: { until: at(18, 15) } };
    expect(dndActive(n, at(18, 14, 59))).toBe(true);
    expect(dndActive(n, at(18, 15))).toBe(false);
    expect(dndActive({ dnd: {} }, at(30, 1))).toBe(true);
    expect(dndActive({ dnd: null }, at(18, 14))).toBe(false);
  });

  it('says how long', () => {
    expect(dndLabel({ dnd: { until: at(18, 15, 30) } }, at(18, 14))).toBe('until 15:30');
    expect(dndLabel({ dnd: { until: at(19, 8) } }, at(18, 22))).toBe('until tomorrow 08:00');
    expect(dndLabel({ dnd: {} }, at(18, 14))).toBe('until you turn it off');
    expect(dndLabel({ dnd: { until: at(18, 13) } }, at(18, 14))).toBe('');
  });

  it('each press in the terminal makes it last longer, then turns it off', () => {
    const now = at(18, 14);
    const one = nextDnd({ dnd: null }, now);
    expect(one).toEqual({ until: at(18, 15) });
    const two = nextDnd({ dnd: one }, now);
    expect(two).toEqual({ until: at(19, 8) });
    const three = nextDnd({ dnd: two }, now);
    expect(three).toEqual({});
    expect(nextDnd({ dnd: three }, now)).toBeNull();
    // Expired counts as off.
    expect(nextDnd({ dnd: { until: at(18, 13) } }, now)).toEqual({ until: at(18, 15) });
  });
});

describe('desktopAllowed', () => {
  const st = (patch: Partial<NotifySettings>, front: boolean): DomainState => apply(initialState('r'), notify(patch), { type: 'attention', attention: { shown: [], visible: [], files: false, front } });

  it('follows the desktop switch, Do Not Disturb and "only when klaud isn\'t in front"', () => {
    expect(desktopAllowed(st({}, true))).toBe(true);
    expect(desktopAllowed(st({ desktop: false }, false))).toBe(false);
    expect(desktopAllowed(st({ dnd: {} }, false))).toBe(false);
    expect(desktopAllowed(st({ dnd: { until: 5 } }, false), 10)).toBe(true);
    expect(desktopAllowed(st({ onlyAway: true }, true))).toBe(false);
    expect(desktopAllowed(st({ onlyAway: true }, false))).toBe(true);
  });
});

// ---------------------------------------------------------------- the Notifier with these settings

describe('Notifier settings', () => {
  let store: Store;
  let screen: ClientStore;
  let desktop: ReturnType<typeof vi.fn<(n: DesktopNote) => void>>;
  let notifier: Notifier;

  const start = (state: DomainState): void => {
    store = new Store(state);
    const attention = new AttentionRegistry(store);
    desktop = vi.fn<(n: DesktopNote) => void>();
    notifier = new Notifier({ store, desktop });
    screen = new ClientStore(store, (a) => attention.set('screen', a));
  };
  const finish = (requestId: string, channel = 'ws:w1'): void => {
    store.dispatch({ ...(run('started', '', channel) as Extract<Action, { type: 'agent_event' }>), requestId });
    store.dispatch({ ...(run('done', 'ok', channel) as Extract<Action, { type: 'agent_event' }>), requestId });
  };

  beforeEach(() => void vi.useFakeTimers({ now: new Date(2026, 9, 18, 14).getTime() }));
  afterEach(() => {
    notifier?.stop();
    vi.useRealTimers();
  });

  it('Do Not Disturb keeps the desktop quiet but fills the inbox, until it ends', () => {
    start(apply(base(), notify({ dnd: { until: Date.now() + 3_600_000 } })));
    finish('r1');
    vi.runAllTimers();
    expect(store.getState().inbox).toHaveLength(1);
    expect(desktop).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 3_600_000);
    finish('r2');
    vi.runAllTimers();
    expect(desktop).toHaveBeenCalledTimes(1);
  });

  it('"only when klaud isn\'t in front" waits until no screen is in front', () => {
    start(apply(base(), notify({ onlyAway: true })));
    screen.dispatch({ type: 'view', view: { kind: 'overview' } });
    finish('r1');
    vi.runAllTimers();
    expect(store.getState().inbox).toHaveLength(1);
    expect(desktop).not.toHaveBeenCalled();
    screen.dispatch({ type: 'away', away: true });
    finish('r2');
    vi.runAllTimers();
    expect(desktop).toHaveBeenCalledTimes(1);
  });

  it('a screen on the Overview shows no conversation, so the room is announced', () => {
    start(base());
    screen.dispatch({ type: 'view', view: { kind: 'overview' } });
    finish('r1', 'room');
    vi.runAllTimers();
    expect(store.getState().inbox).toMatchObject([{ channel: 'room' }]);
    expect(desktop).toHaveBeenCalledWith(expect.objectContaining({ channel: 'room' }));
  });

  it('a test notification shows whatever the settings say', () => {
    start(apply(base(), notify({ desktop: false, done: false, dnd: {} })));
    notifier.test();
    vi.runAllTimers();
    expect(desktop).toHaveBeenCalledWith({ title: 'Notifications work', body: expect.any(String), sound: true });
    expect(store.getState().inbox[0]).toMatchObject({ tag: 'test', read: false });
  });

  it('per-kind toggles cover mentions too', () => {
    start(apply(base(), notify({ mentions: false })));
    store.dispatch(chat('c1', 'b', '@kay look'));
    vi.runAllTimers();
    expect(store.getState().inbox).toEqual([]);
  });

  it('answering an approval reads its notice', () => {
    start(base());
    store.dispatch({ type: 'approval_add', approval: { id: 'a1', kind: 'tool', title: 'Run npm test?', detail: '' } });
    store.dispatch({ type: 'question_add', question: { qid: 'q1', requestId: 'r1', owner: 'me', channel: 'ws:w1', picked: {}, question: { kind: 'plan', plan: 'x' } } });
    expect(store.getState().inbox.map((n) => [n.ref, n.read])).toEqual([
      ['q1', false],
      ['a1', false],
    ]);
    store.dispatch({ type: 'approval_remove', id: 'a1' });
    expect(store.getState().inbox.map((n) => [n.ref, n.read])).toEqual([
      ['q1', false],
      ['a1', true],
    ]);
  });
});

describe('combine', () => {
  it('goes to the one place a burst is about, else nowhere in particular', () => {
    expect(combine([{ kind: 'done', title: 'a', body: 'x', channel: 'room' }], false)).toEqual({ title: 'a', body: 'x', sound: false, channel: 'room' });
    expect(combine([{ kind: 'done', title: 'a', body: '', channel: 'room' }, { kind: 'done', title: 'b', body: '', channel: 'room' }], true)).toMatchObject({ title: '2 updates in klaud', channel: 'room' });
    expect(combine([{ kind: 'done', title: 'a', body: '', channel: 'room' }, { kind: 'pr', title: 'b', body: '' }], true)).not.toHaveProperty('channel');
  });
});

// ---------------------------------------------------------------- in front, and what's visible

describe('attention', () => {
  it('a screen shows a conversation only on a conversation, and is in front unless away', () => {
    expect(attentionOf({ ...initialScreen, view: { kind: 'room' } })).toEqual({ shown: ['room'], visible: ['room'], files: false, front: true });
    expect(attentionOf({ ...initialScreen, view: { kind: 'overview' } })).toEqual({ shown: [], visible: [], files: false, front: true });
    expect(attentionOf({ ...initialScreen, view: { kind: 'workspace', id: 'w1', tab: 'chat' }, away: true })).toEqual({ shown: ['ws:w1'], visible: [], files: false, front: false });
  });

  it('klaud is in front when any screen is', () => {
    const store = new Store(initialState('r'));
    const reg = new AttentionRegistry(store);
    reg.set('mac', { shown: ['room'], visible: [], files: false, front: false });
    expect(store.getState().attention.front).toBe(false);
    reg.set('tui', { shown: [], visible: [], files: false, front: true });
    expect(store.getState().attention.front).toBe(true);
    reg.remove('tui');
    expect(store.getState().attention).toMatchObject({ shown: ['room'], front: false });
  });
});

describe('FrontTracker', () => {
  it('a terminal without focus reports is away after a while unused, back on the next key', () => {
    let now = 0;
    const seen: boolean[] = [];
    const t = new FrontTracker((away) => seen.push(away), 1000, () => now);
    now = 999;
    t.tick();
    expect(seen).toEqual([]);
    now = 1000;
    t.tick();
    t.tick();
    expect(seen).toEqual([true]);
    t.input();
    expect(seen).toEqual([true, false]);
  });

  it('once a terminal reports focus, only its reports count', () => {
    let now = 0;
    const seen: boolean[] = [];
    const t = new FrontTracker((away) => seen.push(away), 1000, () => now);
    t.focus(false);
    t.input();
    expect(seen).toEqual([true]);
    t.focus(true);
    now = 10_000;
    t.tick();
    expect(seen).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------- how both screens show the inbox

describe('notice models', () => {
  const at = (day: number, h: number, m = 0): number => new Date(2026, 9, day, h, m).getTime();
  const notice = (id: number, over: Partial<Notice> = {}): Notice => ({ id, kind: 'done', title: `n${id}`, body: '', ts: at(18, 12), read: false, ...over });

  it('filters by unread, needs you and mentions', () => {
    const inbox = [notice(1), notice(2, { read: true }), notice(3, { kind: 'needsYou', tag: 'approval' }), notice(4, { kind: 'mentions' })];
    expect(filterNotices(inbox, 'all')).toBe(inbox);
    expect(filterNotices(inbox, 'unread').map((n) => n.id)).toEqual([1, 3, 4]);
    expect(filterNotices(inbox, 'needsYou').map((n) => n.id)).toEqual([3]);
    expect(filterNotices(inbox, 'mentions').map((n) => n.id)).toEqual([4]);
  });

  it('groups Today and Earlier at local midnight, newest first, skipping empty groups', () => {
    const now = at(18, 12);
    const groups = groupNotices([notice(1, { ts: at(17, 23, 59) }), notice(2, { ts: at(18, 0) }), notice(3, { ts: at(18, 11) })], now);
    expect(groups.map((g) => [g.label, g.notices.map((n) => n.id)])).toEqual([
      ['Today', [3, 2]],
      ['Earlier', [1]],
    ]);
    expect(groupNotices([notice(1)], now).map((g) => g.label)).toEqual(['Today']);
    expect(groupNotices([], now)).toEqual([]);
  });

  it('says how long ago in a few characters', () => {
    const now = at(18, 12);
    expect(noticeAgo(now - 20_000, now)).toBe('now');
    expect(noticeAgo(now - 5 * 60_000, now)).toBe('5m');
    expect(noticeAgo(at(18, 9), now)).toBe('3h');
    expect(noticeAgo(at(17, 20), now)).toBe('Yesterday');
    expect(noticeAgo(at(15, 20), now)).toBe('Thu');
    expect(noticeAgo(at(2, 20), now)).toBe('2 Oct');
  });

  it('looks like what happened', () => {
    expect(noticeLook({ kind: 'needsYou', tag: 'approval' })).toEqual({ look: 'approval', tone: 'warn' });
    expect(noticeLook({ kind: 'needsYou', tag: 'plan' })).toEqual({ look: 'plan', tone: 'warn' });
    expect(noticeLook({ kind: 'done' })).toEqual({ look: 'done', tone: 'claude' });
    expect(noticeLook({ kind: 'problems', tag: 'conflict' })).toEqual({ look: 'problem', tone: 'error' });
    expect(noticeLook({ kind: 'people', tag: 'left' })).toEqual({ look: 'left', tone: 'muted' });
    expect(noticeLook({ kind: 'mentions', tag: 'mention' })).toEqual({ look: 'mention', tone: 'info' });
    expect(noticeLook({ kind: 'pr' }).look).toBe('pr');
    expect(noticeLook({ kind: 'background' }).look).toBe('task');
  });

  it('goes to the room, your workspace, or one shared with you', () => {
    const s = apply(base(), { type: 'shared_add', ws: { owner: 'b', id: 'sw1', name: 'api-fix', project: 'api', role: 'view', share: 'api' } });
    expect(noticeTarget(s, 'room')).toEqual({ kind: 'room' });
    expect(noticeTarget(s, 'ws:w1')).toEqual({ kind: 'workspace', id: 'w1' });
    expect(noticeTarget(s, 'ws:sw1')).toEqual({ kind: 'shared', owner: 'b', id: 'sw1' });
    expect(noticeTarget(s, 'ws:gone')).toBeUndefined();
    expect(noticeTarget(s, undefined)).toBeUndefined();
  });

  it('the badge counts unread notices and what waits without one', () => {
    let s = apply(base(), { type: 'approval_add', approval: { id: 'a1', kind: 'tool', title: 't', detail: '' } });
    expect(badgeCount(s)).toBe(1);
    s = apply(s, { type: 'notice_add', notice: { kind: 'needsYou', tag: 'approval', ref: 'a1', title: 't', body: '' } }, { type: 'notice_add', notice: { kind: 'done', title: 'd', body: '' } });
    expect(badgeCount(s)).toBe(2);
    s = apply(s, { type: 'notice_read' });
    expect(badgeCount(s)).toBe(1);
  });
});
