import { describe, expect, it } from 'vitest';
import { RefTable } from '../src/companion/files.js';
import { macViewFor } from '../src/companion/open-on-mac.js';
import { COMPANION_PROTO, ConvView, HomeView, SINCE, Topic, WorkView } from '../src/companion/protocol.js';
import { PHONE } from '../src/companion/coverage.js';
import { PhoneCalls } from '../src/companion/calls.js';
import { type ViewContext, convTopic, homeView, viewOf, workView } from '../src/companion/views.js';
import { type Action, Store, channelOf, initialState, shownChannel } from '../src/core/store.js';
import { API } from '../src/ipc/api.js';
import { ASSISTANT_CHANNEL } from '../src/shared/assistant.js';

/**
 * "Your Mac" on the phone (BLG-47): its topic, its view (you can write in it, its outputs), Home's
 * entry, and that it isn't a project in Work. Asking in a project (BLG-69): a worktree, a plan or a
 * question. A project's own main conversation isn't listed (BLG-70).
 */

const ME = 'me';
const T0 = 1_760_000_000_000;
const worktree = (id: string, name: string, kind = 'worktree') => ({ id, projectRoot: '/p', projectId: 'p1', name, path: kind === 'main' ? '/p' : `/p/.w/${id}`, kind, createdAt: T0, external: false });

function state() {
  const store = new Store(initialState('room'));
  const run = (a: Action): void => store.dispatch(a);
  run({ type: 'identity', selfId: ME, isHost: true, home: '/Users/k' });
  run({ type: 'projects', projects: [{ id: 'p1', name: 'beluga', root: '/p', base: 'main', workspaces: [worktree('p1:main', 'beluga', 'main'), worktree('w1', 'login')] }] as never });
  run({ type: 'chat', id: 'c1', from: ME, text: 'What is using my CPU?', ts: T0, byAgent: false, channel: ASSISTANT_CHANNEL });
  run({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event: 'started', text: '', ts: T0 + 1, channel: ASSISTANT_CHANNEL, itemId: 'i1' });
  run({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event: 'tool', text: 'Bash ps -Ao pid,pcpu', ts: T0 + 2, channel: ASSISTANT_CHANNEL, itemId: 'i1' });
  return store;
}

const ctx = (): ViewContext => ({
  refs: new RefTable(() => 'ref00001'),
  mac: { name: 'Mac', version: '1' },
  outputs: (channel) => (channel === ASSISTANT_CHANNEL ? [{ path: '/Users/k/.beluga/assistant/work/.beluga/scratch/top.txt', size: 40, ts: T0 + 2, cwd: '/Users/k/.beluga/assistant/work' }] : []),
});

describe('Your Mac on the phone', () => {
  it('has its topic, gated on 1.5', () => {
    expect(convTopic(ASSISTANT_CHANNEL)).toBe('conv:mac:assistant');
    expect(Topic.safeParse('conv:mac:assistant').success).toBe(true);
    expect(SINCE.assistant).toBe(5);
    expect(COMPANION_PROTO.minor).toBeGreaterThanOrEqual(SINCE.assistant);
  });

  it('its conversation: you can write in it, it works live, its scratch files are its outputs', () => {
    const s = state().getState();
    const view = viewOf(s, ctx(), 'conv:mac:assistant') as ConvView;
    expect(ConvView.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ title: 'Your Mac', canSend: true, working: true });
    expect(view.outputs?.map((o) => o.name)).toEqual(['top.txt']);
    expect(view.turns.at(-1)?.live ?? view.turns.at(-1)?.step).toBeTruthy();
  });

  it('Home carries it for "Ask your Mac" (and as running while it works); Work doesn’t list it', () => {
    const s = state().getState();
    const home = homeView(s, ctx());
    expect(HomeView.safeParse(home).success).toBe(true);
    expect(home.assistant).toMatchObject({ topic: 'conv:mac:assistant', title: 'Your Mac', status: 'working' });
    expect(home.running.map((r) => r.topic)).toContain('conv:mac:assistant');
    const work = workView(s, ctx());
    expect(WorkView.safeParse(work).success).toBe(true);
    expect(work.projects.flatMap((p) => p.conversations.map((c) => c.topic))).not.toContain('conv:mac:assistant');
  });

  it('opens on the Mac as its sidebar row', () => {
    const s = state().getState();
    expect(macViewFor(s, { topic: 'conv:mac:assistant' })).toEqual({ kind: 'assistant' });
    expect(channelOf({ kind: 'assistant' })).toBe(ASSISTANT_CHANNEL);
    expect(shownChannel({ kind: 'assistant' })).toBe(ASSISTANT_CHANNEL);
  });
});

describe('a project’s main conversation (BLG-70)', () => {
  it('isn’t listed in Work, but still opens and shows on Home while it works', () => {
    const store = state();
    const s0 = store.getState();
    expect(workView(s0, ctx()).projects.flatMap((p) => p.conversations.map((c) => c.topic))).toEqual(['conv:ws:w1']);
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r2', requester: ME, event: 'started', text: '', ts: T0 + 5, channel: 'ws:p1:main', itemId: 'i2' });
    const s = store.getState();
    expect(homeView(s, ctx()).running.map((r) => r.topic)).toContain('conv:ws:p1:main');
    expect((viewOf(s, ctx(), 'conv:ws:p1:main') as ConvView).canSend).toBe(true);
    expect(workView(s, ctx()).projects.flatMap((p) => p.conversations.map((c) => c.topic))).toEqual(['conv:ws:w1']);
  });
});

describe('asking in a project from the phone (BLG-69)', () => {
  it('a new worktree (with plan mode) and a plan are the Mac’s own calls, on the phone’s list', () => {
    expect(PHONE['workspaces.startWorktree']).toBe('phone');
    expect(PHONE['plans.create']).toBe('phone');
    expect(Object.keys(PhoneCalls)).toEqual(expect.arrayContaining(['workspaces.startWorktree', 'plans.create', 'companion.ask']));
    expect(API['workspaces.startWorktree'].args.safeParse(['p1', 'Fix the login bug', { plan: true, quiet: true }]).success).toBe(true);
    expect(API['plans.create'].args.safeParse([{ projectId: 'p1', goal: 'Auth' }]).success).toBe(true);
    expect(SINCE.askModes).toBe(5);
  });
});
