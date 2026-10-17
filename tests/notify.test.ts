import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store, initialState, reduce, type Action, type AppState } from '../src/core/store.js';
import { Notifier, detectNotices, enabled, placeName, type NoticeEvent } from '../src/core/notify.js';
import { pickRoute, plan, type RouteEnv } from '../src/core/desktop-notify.js';
import type { PeerInfo } from '../src/protocol.js';
import type { Project } from '../src/workspaces/types.js';
import type { PendingQuestion, SharedWorkspace } from '../src/core/collab-store.js';

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

const apply = (s: AppState, ...actions: Action[]): AppState => actions.reduce(reduce, s);
const base = (): AppState =>
  apply(initialState('room'), { type: 'peers', peers: [me, bob] }, { type: 'welcome', self: me }, { type: 'projects', projects: [project] });

const ev = (owner: string, requester: string, event: 'started' | 'text' | 'done' | 'error' | 'denied', text = '', channel = 'ws:w1'): Action => ({
  type: 'agent_event',
  owner,
  requestId: 'r1',
  requester,
  event,
  text,
  ts: 1,
  channel,
});

const question = (qid: string, kind: 'plan' | 'question', channel = 'ws:w1'): PendingQuestion => ({
  qid,
  requestId: 'r1',
  owner: 'me',
  channel,
  picked: {},
  question: kind === 'plan' ? { kind: 'plan', plan: 'do it' } : { kind: 'question', questions: [{ question: '**Which** db?\nmore', header: '', options: [], multiSelect: false }] },
});

const sharedWs = (role: 'view' | 'contribute', owner = 'b'): SharedWorkspace => ({ owner, id: 'sw1', name: 'api-fix', project: 'api', role, share: 'api' });

describe('placeName', () => {
  it('names the room, workspaces, shared workspaces, and unknowns', () => {
    const solo = apply(initialState('room'), { type: 'peers', peers: [me] });
    expect(placeName(solo, 'room')).toBe('your chat');
    expect(placeName(base(), 'room')).toBe('the group chat');
    expect(placeName(base(), 'ws:w1')).toBe('add-auth');
    const s = apply(base(), { type: 'shared_add', ws: sharedWs('view') });
    expect(placeName(s, 'ws:sw1')).toBe('api-fix');
    expect(placeName(base(), 'ws:nope')).toBe('a workspace');
  });
});

describe('detectNotices: runs', () => {
  it('returns nothing when nothing changed', () => {
    const s = base();
    expect(detectNotices(s, s)).toEqual([]);
  });

  it('announces your Claude finishing with the first meaningful line', () => {
    const running = apply(base(), ev('me', 'me', 'started'));
    const done = apply(running, ev('me', 'me', 'done', '\n# **All** tests pass\nsecond line'));
    expect(detectNotices(running, done)).toEqual([{ kind: 'done', title: 'Claude finished in add-auth', body: 'All tests pass', channel: 'ws:w1' }]);
  });

  it('uses "Done" for an empty final text and truncates long lines', () => {
    const running = apply(base(), ev('me', 'me', 'started'));
    expect(detectNotices(running, apply(running, ev('me', 'me', 'done', '')))[0]?.body).toBe('Done');
    const long = 'x'.repeat(200);
    const body = detectNotices(running, apply(running, ev('me', 'me', 'done', long)))[0]?.body ?? '';
    expect(body).toHaveLength(140);
    expect(body.endsWith('…')).toBe(true);
  });

  it("announces a friend's Claude working for you, but not for someone else", () => {
    const withCat = apply(base(), { type: 'peers', peers: [me, bob, cat] });
    const forMe = apply(withCat, ev('b', 'me', 'started', '', 'room'));
    expect(detectNotices(forMe, apply(forMe, ev('b', 'me', 'done', 'ok', 'room')))).toEqual([
      { kind: 'done', title: "bob's Claude finished in the group chat", body: 'ok', channel: 'room' },
    ]);
    const forCat = apply(withCat, ev('b', 'c', 'started', '', 'room'));
    expect(detectNotices(forCat, apply(forCat, ev('b', 'c', 'done', 'ok', 'room')))).toEqual([]);
  });

  it('reports errors and denials as problems', () => {
    const running = apply(base(), ev('me', 'me', 'started'));
    expect(detectNotices(running, apply(running, ev('me', 'me', 'error', 'API overloaded')))).toEqual([
      { kind: 'problems', title: 'Claude stopped in add-auth', body: 'API overloaded', channel: 'ws:w1' },
    ]);
    expect(detectNotices(running, apply(running, ev('me', 'me', 'denied', '')))[0]).toMatchObject({ kind: 'problems', body: 'denied' });
  });

  it('ignores quiet errors you caused yourself', () => {
    const running = apply(base(), ev('me', 'me', 'started'));
    for (const text of ['Interrupted by a newer message', 'Cancelled by owner', 'Stopped by owner.']) {
      expect(detectNotices(running, apply(running, ev('me', 'me', 'error', text)))).toEqual([]);
    }
  });

  it('ignores runs that were already final or are new in this step', () => {
    const done = apply(base(), ev('me', 'me', 'started'), ev('me', 'me', 'done', 'a'));
    // Already final before: a repeated done is not announced again.
    expect(detectNotices(done, apply(done, ev('me', 'me', 'done', 'b')))).toEqual([]);
    // A run that appears already-final (e.g. loaded history) is not announced.
    const s = base();
    expect(detectNotices(s, apply(s, ev('me', 'me', 'done', 'x')))).toEqual([]);
    // Still running: nothing.
    const running = apply(s, ev('me', 'me', 'started'));
    expect(detectNotices(running, apply(running, ev('me', 'me', 'text', 'thinking')))).toEqual([]);
  });

  it('ignores chat-only log changes', () => {
    const s = base();
    expect(detectNotices(s, apply(s, { type: 'chat', id: 'c1', from: 'b', text: 'hi', ts: 1, byAgent: false }))).toEqual([]);
  });
});

describe('detectNotices: needs you', () => {
  it('announces new approvals only', () => {
    const s0 = base();
    const s1 = apply(s0, { type: 'approval_add', approval: { id: 'a1', kind: 'tool', title: 'Run npm test?', detail: '`npm test`\nin /app' } });
    expect(detectNotices(s0, s1)).toEqual([{ kind: 'needsYou', title: 'Run npm test?', body: 'npm test' }]);
    const s2 = apply(s1, { type: 'approval_add', approval: { id: 'a2', kind: 'request', title: 'bob asks', detail: '' } });
    expect(detectNotices(s1, s2)).toEqual([{ kind: 'needsYou', title: 'bob asks', body: '' }]);
    expect(detectNotices(s2, apply(s2, { type: 'approval_remove', id: 'a1' }))).toEqual([]);
  });

  it('tells questions and plans apart', () => {
    const s0 = base();
    const s1 = apply(s0, { type: 'question_add', question: question('q1', 'question') });
    expect(detectNotices(s0, s1)).toEqual([{ kind: 'needsYou', title: 'Claude asks in add-auth', body: 'Which db?', channel: 'ws:w1' }]);
    const s2 = apply(s1, { type: 'question_add', question: question('q2', 'plan', 'room') });
    expect(detectNotices(s1, s2)).toEqual([
      { kind: 'needsYou', title: 'Claude has a plan for the group chat', body: 'Approve it, or say what to change', channel: 'room' },
    ]);
    expect(detectNotices(s2, apply(s2, { type: 'question_remove', qid: 'q1' }))).toEqual([]);
  });
});

describe('detectNotices: conflicts', () => {
  it('announces a new conflict once, listing up to three files', () => {
    const s0 = base();
    const s1 = apply(s0, { type: 'conflicts', id: 'w1', files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] });
    expect(detectNotices(s0, s1)).toEqual([
      { kind: 'problems', title: 'Merge conflict in add-auth', body: '4 file(s): a.ts, b.ts, c.ts', channel: 'ws:w1' },
    ]);
    // Still conflicted (different files): not announced again.
    expect(detectNotices(s1, apply(s1, { type: 'conflicts', id: 'w1', files: ['a.ts'] }))).toEqual([]);
    // Resolved: nothing.
    expect(detectNotices(s1, apply(s1, { type: 'conflicts', id: 'w1', files: [] }))).toEqual([]);
  });
});

describe('detectNotices: people', () => {
  it('stays quiet for the first peer list and before you are in', () => {
    const fresh = apply(initialState('room'), { type: 'welcome', self: me });
    expect(detectNotices(fresh, apply(fresh, { type: 'peers', peers: [me, bob] }))).toEqual([]);
    const noSelf = apply(initialState('room'), { type: 'peers', peers: [me] });
    expect(detectNotices(noSelf, apply(noSelf, { type: 'peers', peers: [me, bob] }))).toEqual([]);
  });

  it('announces people joining afterwards, with or without their Claude', () => {
    const s0 = base();
    const s1 = apply(s0, { type: 'peers', peers: [me, bob, cat] });
    expect(detectNotices(s0, s1)).toEqual([{ kind: 'people', title: 'cat joined', body: 'Say hi in the group chat', channel: 'room' }]);
    const dan: PeerInfo = { peerId: 'd', name: 'dan', agent: true, shares: [] };
    expect(detectNotices(s1, apply(s1, { type: 'peers', peers: [me, bob, cat, dan] }))[0]?.body).toBe('They brought their Claude');
    // Someone leaving is not news.
    expect(detectNotices(s1, apply(s1, { type: 'peers', peers: [me] }))).toEqual([]);
  });

  it('never announces yourself joining', () => {
    const solo = apply(initialState('room'), { type: 'welcome', self: me }, { type: 'peers', peers: [bob] });
    expect(detectNotices(solo, apply(solo, { type: 'peers', peers: [bob, me] }))).toEqual([]);
  });

  it('announces shared-workspace invites by role, once', () => {
    const s0 = base();
    const s1 = apply(s0, { type: 'shared_add', ws: sharedWs('contribute') });
    expect(detectNotices(s0, s1)).toEqual([
      { kind: 'people', title: 'bob invited you to api-fix', body: 'You can work there with their Claude', channel: 'ws:sw1' },
    ]);
    // Re-sent invite (role change) for the same workspace: not new.
    expect(detectNotices(s1, apply(s1, { type: 'shared_add', ws: sharedWs('view') }))).toEqual([]);
    const s2 = apply(s0, { type: 'shared_add', ws: sharedWs('view', 'zz') });
    expect(detectNotices(s0, s2)).toEqual([{ kind: 'people', title: 'Someone invited you to api-fix', body: 'You can follow along', channel: 'ws:sw1' }]);
  });
});

describe('enabled', () => {
  it('reads per-kind toggles', () => {
    const prefs = { ...initialState('room').prefs.notify, pr: false };
    expect(enabled(prefs, 'pr')).toBe(false);
    expect(enabled(prefs, 'done')).toBe(true);
  });
});

describe('Notifier', () => {
  let store: Store;
  let desktop: ReturnType<typeof vi.fn<(n: { title: string; body: string; sound: boolean }) => void>>;
  let notifier: Notifier;

  const start = (state: AppState = base(), burstMs?: number): void => {
    store = new Store(state);
    desktop = vi.fn<(n: { title: string; body: string; sound: boolean }) => void>();
    notifier = new Notifier({ store, desktop, burstMs });
  };
  const finishRun = (requestId: string, channel: string, text = 'ok'): void => {
    store.dispatch({ ...(ev('me', 'me', 'started', '', channel) as Extract<Action, { type: 'agent_event' }>), requestId });
    store.dispatch({ ...(ev('me', 'me', 'done', text, channel) as Extract<Action, { type: 'agent_event' }>), requestId });
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    notifier?.stop();
    vi.useRealTimers();
  });

  it('adds to the inbox and raises one desktop notification', () => {
    start();
    finishRun('r1', 'ws:w1', 'shipped');
    expect(store.getState().inbox).toMatchObject([{ kind: 'done', title: 'Claude finished in add-auth', body: 'shipped', channel: 'ws:w1', read: false }]);
    expect(desktop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(desktop).toHaveBeenCalledTimes(1);
    expect(desktop).toHaveBeenCalledWith({ title: 'Claude finished in add-auth', body: 'shipped', sound: true });
  });

  it('stays quiet about the conversation you are looking at, unless away', () => {
    start(apply(base(), { type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } }));
    finishRun('r1', 'ws:w1');
    vi.runAllTimers();
    expect(store.getState().inbox).toEqual([]);
    expect(desktop).not.toHaveBeenCalled();

    store.dispatch({ type: 'away', away: true });
    finishRun('r2', 'ws:w1');
    vi.runAllTimers();
    expect(store.getState().inbox).toHaveLength(1);
    expect(desktop).toHaveBeenCalledTimes(1);
  });

  it('respects per-kind toggles and the desktop switch', () => {
    start(apply(base(), { type: 'prefs', prefs: { notify: { ...initialState('room').prefs.notify, done: false } } }));
    finishRun('r1', 'ws:w1');
    vi.runAllTimers();
    expect(store.getState().inbox).toEqual([]);

    store.dispatch({ type: 'prefs', prefs: { notify: { ...store.getState().prefs.notify, done: true, desktop: false } } });
    finishRun('r2', 'ws:w1');
    vi.runAllTimers();
    expect(store.getState().inbox).toHaveLength(1);
    expect(desktop).not.toHaveBeenCalled();
  });

  it('combines a burst into one desktop notification with a combined title', () => {
    start(apply(base(), { type: 'prefs', prefs: { notify: { ...initialState('room').prefs.notify, sound: false } } }));
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) finishRun(id, 'ws:w1', id);
    vi.advanceTimersByTime(0);
    expect(desktop).toHaveBeenCalledTimes(1);
    const arg = desktop.mock.calls[0]![0];
    expect(arg.title).toBe('5 updates in klaud');
    expect(arg.body.split(' · ')).toHaveLength(4);
    expect(arg.sound).toBe(false);
    expect(store.getState().inbox).toHaveLength(5);
  });

  it('waits out the burst window before the next desktop notification', () => {
    start(base(), 1000);
    finishRun('r1', 'ws:w1');
    vi.advanceTimersByTime(0);
    expect(desktop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    finishRun('r2', 'ws:w1');
    store.dispatch({ type: 'conflicts', id: 'w1', files: ['a.ts'] });
    vi.advanceTimersByTime(799);
    expect(desktop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(desktop).toHaveBeenCalledTimes(2);
    expect(desktop.mock.calls[1]![0]).toMatchObject({ title: '2 updates in klaud' });
  });

  it('marks notices read when you open their conversation or come back', () => {
    start();
    finishRun('r1', 'ws:w1');
    finishRun('r2', 'room');
    // r2 is about the room, which you are looking at.
    expect(store.getState().inbox).toHaveLength(1);
    store.dispatch({ type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    expect(store.getState().inbox[0]?.read).toBe(true);

    store.dispatch({ type: 'away', away: true });
    store.dispatch({ type: 'question_add', question: question('q1', 'question') });
    expect(store.getState().inbox[0]).toMatchObject({ channel: 'ws:w1', read: false });
    store.dispatch({ type: 'away', away: false });
    expect(store.getState().inbox[0]?.read).toBe(true);
  });

  it('does not mark notices read while away', () => {
    start();
    store.dispatch({ type: 'away', away: true });
    finishRun('r1', 'ws:w1');
    store.dispatch({ type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    expect(store.getState().inbox[0]?.read).toBe(false);
  });

  it('notify() raises a direct notice; notices without a channel always show', () => {
    start();
    const e: NoticeEvent = { kind: 'pr', title: 'PR #3 opened', body: 'add-auth' };
    notifier.notify(e);
    vi.runAllTimers();
    expect(store.getState().inbox[0]).toMatchObject({ kind: 'pr', title: 'PR #3 opened' });
    expect(desktop).toHaveBeenCalledWith({ title: 'PR #3 opened', body: 'add-auth', sound: true });
  });

  it('stops listening after stop()', () => {
    start();
    notifier.stop();
    finishRun('r1', 'ws:w1');
    vi.runAllTimers();
    expect(store.getState().inbox).toEqual([]);
    expect(desktop).not.toHaveBeenCalled();
  });
});

describe('pickRoute', () => {
  const env = (over: Partial<RouteEnv> & { vars?: NodeJS.ProcessEnv } = {}): RouteEnv => ({
    platform: over.platform ?? 'darwin',
    env: over.vars ?? {},
    hasTerminalNotifier: over.hasTerminalNotifier ?? false,
    hasNotifySend: over.hasNotifySend ?? false,
  });

  it('uses OSC 9 in iTerm, ghostty, and WezTerm (any case)', () => {
    for (const t of ['iTerm.app', 'ghostty', 'WezTerm']) expect(pickRoute(env({ vars: { TERM_PROGRAM: t }, hasTerminalNotifier: true }))).toBe('osc9');
  });

  it('uses OSC 99 in kitty', () => {
    expect(pickRoute(env({ vars: { KITTY_WINDOW_ID: '1' } }))).toBe('osc99');
    expect(pickRoute(env({ vars: { TERM_PROGRAM: 'kitty' }, platform: 'linux' }))).toBe('osc99');
  });

  it('uses terminal-notifier on macOS when installed, else osascript', () => {
    expect(pickRoute(env({ vars: { TERM_PROGRAM: 'Apple_Terminal' }, hasTerminalNotifier: true }))).toBe('terminal-notifier');
    expect(pickRoute(env({ vars: { TERM_PROGRAM: 'Apple_Terminal' } }))).toBe('osascript');
  });

  it('uses notify-send on Linux when present, else the bell', () => {
    expect(pickRoute(env({ platform: 'linux', hasNotifySend: true }))).toBe('notify-send');
    expect(pickRoute(env({ platform: 'linux' }))).toBe('bell');
    expect(pickRoute(env({ platform: 'win32', hasNotifySend: true, hasTerminalNotifier: true }))).toBe('bell');
  });
});

describe('plan', () => {
  const n = { title: 'Claude finished', body: 'All good', sound: true };

  it('writes OSC 9 with an optional bell', () => {
    expect(plan('osc9', n)).toEqual({ write: '\x1b]9;Claude finished: All good\x07\x07' });
    expect(plan('osc9', { ...n, sound: false })).toEqual({ write: '\x1b]9;Claude finished: All good\x07' });
  });

  it('writes OSC 99 title and body', () => {
    expect(plan('osc99', { ...n, sound: false })).toEqual({
      write: '\x1b]99;i=klaud:d=0;Claude finished\x1b\\\x1b]99;i=klaud:d=1:p=body;All good\x1b\\',
    });
    expect(plan('osc99', n).write?.endsWith('\x1b\\\x07')).toBe(true);
  });

  it('strips control characters and caps lengths so escapes cannot be injected', () => {
    const out = plan('osc9', { title: 'a\x1b]0;evil\x07b\nc', body: 'x'.repeat(500), sound: false }).write ?? '';
    expect(out).toBe(`\x1b]9;a ]0;evil b c: ${'x'.repeat(240)}\x07`);
    expect(plan('osc9', { title: 't'.repeat(300), body: '', sound: false }).write).toBe(`\x1b]9;${'t'.repeat(120)}: \x07`);
    expect(plan('osc9', { title: 'del\x7f', body: '', sound: false }).write).toContain('del ');
  });

  it('builds terminal-notifier args with sound and activation', () => {
    expect(plan('terminal-notifier', n, { __CFBundleIdentifier: 'com.googlecode.iterm2' })).toEqual({
      cmd: 'terminal-notifier',
      args: ['-title', 'klaud', '-subtitle', 'Claude finished', '-message', 'All good', '-group', 'klaud', '-sound', 'default', '-activate', 'com.googlecode.iterm2'],
    });
    expect(plan('terminal-notifier', { ...n, body: '', sound: false }, {})).toEqual({
      cmd: 'terminal-notifier',
      args: ['-title', 'klaud', '-subtitle', 'Claude finished', '-message', ' ', '-group', 'klaud'],
    });
  });

  it('builds an AppleScript with quotes and backslashes escaped', () => {
    const p = plan('osascript', { title: 'say "hi"', body: 'path C:\\x "q"', sound: true });
    expect(p.cmd).toBe('osascript');
    expect(p.args).toEqual(['-e', 'display notification "path C:\\\\x \\"q\\"" with title "klaud" subtitle "say \\"hi\\"" sound name "Glass"']);
    expect(plan('osascript', { title: 't', body: '', sound: false }).args).toEqual(['-e', 'display notification " " with title "klaud" subtitle "t"']);
  });

  it('builds notify-send args', () => {
    expect(plan('notify-send', n)).toEqual({ cmd: 'notify-send', args: ['-a', 'klaud', '--', 'Claude finished', 'All good'] });
    // A name that looks like an option can't become one.
    expect(plan('notify-send', { ...n, title: '--wait bob joined' }).args?.[3]).toBe('wait bob joined');
  });

  it('rings the bell only with sound on', () => {
    expect(plan('bell', n)).toEqual({ write: '\x07' });
    expect(plan('bell', { ...n, sound: false })).toEqual({ write: '' });
  });
});
