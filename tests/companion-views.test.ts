import { describe, expect, it } from 'vitest';
import { RefTable } from '../src/companion/files.js';
import { ChatsView, ChatView, ConvView, HomeView, PeopleView, PlansView, PlanView, type Topic, WorkView, viewSchema } from '../src/companion/protocol.js';
import { type ViewContext, convTurns, homeView, needsYou, viewOf } from '../src/companion/views.js';
import { type Action, type DomainState, Store, initialState } from '../src/core/store.js';
import type { Plan } from '../src/core/plans/model.js';

/**
 * What the phone sees of a Mac in a known state: every view checked against its zod schema, and
 * snapshotted so a change to what the phone shows shows up in review (docs/companion.md,
 * "Staying in step"). There is no pure demo-state builder, so the state is built here the way the
 * daemon builds it: by dispatching actions.
 */

const ME = 'me0000000000000000000000000000me';
const BOB = 'bob00000000000000000000000000bob';
const ZOE = 'zoe00000000000000000000000000zoe';
const GROUP = 'c'.repeat(32);
const T0 = 1_760_000_000_000;

function workspace(id: string, name: string, root: string) {
  return { id, projectRoot: root, projectId: 'p1', name, path: `${root}/.worktrees/${id}`, kind: 'worktree', createdAt: T0, external: false };
}

const plan: Plan = {
  id: 'pl_auth',
  projectId: 'p1',
  home: 'ws:w1',
  status: 'draft',
  draft: {
    title: 'Add auth',
    goal: 'Protect the payment routes',
    milestones: [{ id: 'm1', title: 'Sessions', criteria: ['Logged-out users get 401'], tasks: [{ id: 't1', title: 'requireUser middleware', acceptance: ['tests pass'], blockedBy: [] }] }],
  },
  draftRev: 3,
  autonomy: 'gated',
  maxParallel: 2,
  testsAt: 'milestone',
  paused: false,
  runs: {},
  activity: [],
  createdAt: T0,
  updatedAt: T0 + 50,
} as unknown as Plan;

function demoState(): DomainState {
  const store = new Store(initialState('kayra’s room'));
  const run = (a: Action): void => store.dispatch(a);
  run({ type: 'identity', selfId: ME, isHost: true, home: '/Users/k' });
  run({ type: 'welcome', self: { peerId: ME, name: 'kayra', shares: [], agent: true, usage: { plan: 'max', fiveHour: { pct: 12, resetsAt: T0 + 3_600_000 }, week: { pct: 38 }, updatedAt: T0 } } });
  run({ type: 'projects', projects: [{ id: 'p1', name: 'landing', root: '/Users/k/landing', base: 'main', workspaces: [workspace('w1', 'auth', '/Users/k/landing'), workspace('w2', 'tests', '/Users/k/landing')] }] as never });
  // ws:w1: you asked, Claude answered with code in it.
  run({ type: 'chat', id: 'c1', from: ME, text: 'How do we protect the payment routes?', ts: T0 + 1, byAgent: false, channel: 'ws:w1' });
  const ev = (event: Extract<Action, { type: 'agent_event' }>['event'], text: string, ts: number, channel: string, requestId: string): void =>
    run({ type: 'agent_event', owner: ME, requestId, requester: ME, event, text, ts, channel, itemId: `i-${requestId}` });
  ev('started', '', T0 + 2, 'ws:w1', 'r1');
  ev('tool', 'Read src/server.ts', T0 + 3, 'ws:w1', 'r1');
  ev('tool', 'Edit src/auth.ts', T0 + 4, 'ws:w1', 'r1');
  ev('text', 'Add a middleware:\n\n```ts\nexport function requireUser() {}\n```\n\nThen protect `/api/payments`.', T0 + 5, 'ws:w1', 'r1');
  ev('done', '', T0 + 6, 'ws:w1', 'r1');
  // ws:w2: Claude is running the tests, with a sub-agent at work.
  ev('started', '', T0 + 10, 'ws:w2', 'r2');
  ev('sub', JSON.stringify({ id: 'sa1', phase: 'start', title: 'Check the webhooks' }), T0 + 11, 'ws:w2', 'r2');
  ev('sub', JSON.stringify({ id: 'sa1', phase: 'step', step: 'Grep "retry"' }), T0 + 12, 'ws:w2', 'r2');
  ev('tool', 'Bash npm test -- --run', T0 + 13, 'ws:w2', 'r2');
  ev('progress', '137/215', T0 + 14, 'ws:w2', 'r2');
  // What waits for you.
  run({ type: 'approval_add', approval: { id: 'ap1', kind: 'tool', title: 'Run rm -rf dist?', detail: 'Bash rm -rf dist', askedAt: T0 + 15, timeoutMs: 60_000, channel: 'ws:w2' } });
  run({
    type: 'question_add',
    question: { qid: 'q1', requestId: 'r1', owner: ME, channel: 'ws:w1', picked: {}, question: { kind: 'question', questions: [{ question: 'Which session store?', header: 'Store', options: [{ label: 'Redis', description: 'fast' }, { label: 'Postgres', description: 'already there' }], multiSelect: false }] } },
  });
  run({
    type: 'gw_init',
    state: {
      enabled: true,
      note: '',
      rules: [],
      capabilities: initialState('x').gateway.capabilities,
      cards: { [BOB]: { trust: 'trusted', offers: ['screen', 'shell'], projects: [], claude: true, at: T0 } },
      tasks: [
        { id: 't_confirm000001', direction: 'sent', peerId: BOB, peerName: 'bob', kind: 'ask', ask: 'Can you review the landing page?', needs: [], by: 'agent', conversation: 'ws:w1', state: 'confirm', steps: [], createdAt: T0 + 20, updatedAt: T0 + 20 },
        {
          id: 't_screen000001',
          direction: 'sent',
          peerId: BOB,
          peerName: 'bob',
          kind: 'ask',
          ask: 'Take a screenshot of your desktop',
          summary: 'take a screenshot of your desktop',
          needs: ['screen'],
          by: 'person',
          state: 'done',
          steps: ['mcp__beluga__screenshot'],
          result: { status: 'done', summary: 'Here it is.', files: [{ name: 'desktop.png', size: 4096, path: '/Users/k/.beluga/tasks/files/t_screen000001/desktop.png', image: true }], log: [] },
          createdAt: T0 + 22,
          updatedAt: T0 + 24,
          startedAt: T0 + 23,
          endedAt: T0 + 24,
        },
        { id: 't_request00001', direction: 'received', peerId: BOB, peerName: 'bob', kind: 'run', ask: 'Run the e2e suite', summary: 'run the e2e suite', needs: ['shell'], by: 'person', state: 'awaiting_approval', steps: [], createdAt: T0 + 21, updatedAt: T0 + 21 },
      ],
    },
  });
  run({
    type: 'question_add',
    question: {
      qid: 'q2',
      requestId: 'r2',
      owner: ME,
      channel: 'ws:w2',
      picked: { 'Which browsers?': 'Chrome' },
      question: {
        kind: 'question',
        questions: [
          { question: 'Which browsers?', header: 'Browsers', options: [{ label: 'Chrome', description: '' }], multiSelect: false },
          { question: 'Which checks?', header: 'Checks', options: [{ label: 'Lint', description: '' }, { label: 'Types', description: '' }], multiSelect: true },
        ],
      },
    },
  });
  run({ type: 'plan_put', plan });
  // Someone at the door with a link, and someone asking to join a channel you run.
  run({ type: 'knock', knock: { peerId: ZOE, linkId: 'l1', ts: T0 + 41 }, show: true });
  // Friends and chats.
  const presence = { state: 'online' as const };
  run({
    type: 'net_summary',
    summary: {
      enabled: true,
      self: { peerId: ME, name: 'kayra', address: 'a'.repeat(64), presence, appearOffline: false } as never,
      friends: [{ peerId: BOB, name: 'bob', online: true, presence: { state: 'away', note: 'lunch' }, addedAt: T0, unread: 2, last: { id: 'm1abcdefgh', conversation: `dm:${BOB}`, from: BOB, name: 'bob', text: 'see\n```js\nx()\n```\nhere', ts: T0 + 30, mine: false } }],
      groups: [{ id: GROUP, name: 'team', members: [], admin: true, active: true, unread: 0, requests: [{ peerId: ZOE, name: 'zoe', ts: T0 + 42 }], createdAt: T0 }],
      invitations: [],
      pendingJoins: [],
    },
  });
  run({ type: 'net_message', message: { id: 'm1abcdefgh', conversation: `dm:${BOB}`, from: BOB, name: 'bob', text: 'see\n```js\nx()\n```\nhere', ts: T0 + 30, mine: false } });
  run({ type: 'net_message', message: { id: 'm2abcdefgh', conversation: `dm:${BOB}`, from: ME, name: 'kayra', text: 'on it', ts: T0 + 31, mine: true } });
  return store.getState();
}

function context(): ViewContext {
  let n = 0;
  const refs = new RefTable(() => `ref${String(n++).padStart(5, '0')}`);
  return {
    refs,
    mac: { name: 'Kayra’s Mac', version: '0.6.2' },
    outputs: (channel) =>
      channel === 'ws:w2'
        ? [
            { path: '/Users/k/landing/.worktrees/w2/.beluga/scratch/shot.png', size: 2048, ts: T0 + 12, by: 'sa1', cwd: '/Users/k/landing/.worktrees/w2' },
            { path: '/Users/k/landing/.worktrees/w2/test-results/run.log', size: 300, ts: T0 + 13, cwd: '/Users/k/landing/.worktrees/w2' },
            // Source code never becomes an output.
            { path: '/Users/k/landing/.worktrees/w2/src/app.ts', size: 30, ts: T0 + 13, cwd: '/Users/k/landing/.worktrees/w2' },
          ]
        : [],
  };
}

const TOPICS: Topic[] = ['home', 'work', 'plans', 'chats', 'people', 'conv:ws:w1', 'conv:ws:w2', 'plan:pl_auth', `chat:dm:${BOB}`];

describe('the views of a known Mac', () => {
  const state = demoState();
  const ctx = context();

  it('match their schemas', () => {
    for (const topic of TOPICS) {
      const view = viewOf(state, ctx, topic);
      const parsed = viewSchema(topic).safeParse(view);
      expect(parsed.success ? 'ok' : `${topic}: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe('ok');
    }
  });

  it('home: you, your allowance, what needs you with its buttons, what runs, outputs', () => {
    const home = HomeView.parse(homeView(state, ctx));
    expect(home.usage).toEqual([{ provider: 'Claude Code', plan: 'max', windows: [{ label: '5 hours', pct: 12, resetsAt: T0 + 3_600_000 }, { label: 'Week', pct: 38 }], updatedAt: T0 }]);
    expect(home.needsYou.map((n) => n.id)).toEqual(['approval:ap1', 'confirm:t_confirm000001', 'request:t_request00001', 'knock:' + ZOE, 'join:' + GROUP + ':' + ZOE, 'plan:pl_auth:approve:3', 'question:q1', 'question:q2']);
    const knock = home.needsYou.find((n) => n.id.startsWith('knock:'))!;
    expect(knock.actions.map((a) => [a.method, a.args])).toEqual([
      ['invites.letIn', [ZOE]],
      ['invites.decline', [ZOE]],
    ]);
    expect(home.needsYou.find((n) => n.id.startsWith('join:'))!.actions.map((a) => [a.method, a.args])).toEqual([
      ['network.groups.approve', [GROUP, ZOE]],
      ['network.groups.decline', [GROUP, ZOE]],
    ]);
    // The second question of a prompt: several picks joined, sent with every answer so far.
    expect(home.needsYou.find((n) => n.id === 'question:q2')!.answer).toEqual({ method: 'questions.answer', args: ['q2', { kind: 'answers', answers: { 'Which browsers?': 'Chrome', 'Which checks?': '' } }], slot: [1, 'answers', 'Which checks?'], join: ', ', text: true, picks: true, label: 'Send' });
    const question = home.needsYou.find((n) => n.kind === 'question')!;
    expect(question.actions).toEqual([
      { label: 'Redis', tone: 'plain', method: 'questions.answer', args: ['q1', { kind: 'answers', answers: { 'Which session store?': 'Redis' } }] },
      { label: 'Postgres', tone: 'plain', method: 'questions.answer', args: ['q1', { kind: 'answers', answers: { 'Which session store?': 'Postgres' } }] },
      { label: 'Skip', tone: 'danger', method: 'questions.answer', args: ['q1', { kind: 'skip' }] },
    ]);
    // Both wait on you (an approval in w2, Claude's question in w1); w2's sub-agent is a dot.
    expect(home.running.filter((r) => !r.topic.startsWith('conv:task:')).map((r) => [r.topic, r.status, r.agents])).toEqual([
      ['conv:ws:w2', 'waiting', 1],
      ['conv:ws:w1', 'waiting', undefined],
    ]);
    expect(home.outputs.map((o) => o.name)).toEqual(['run.log', 'shot.png']);
    expect(home.unread).toEqual({ work: expect.any(Number), chats: 2 });
  });

  it('a conversation: code folded, steps in words, sub-agents with their outputs', () => {
    const w1 = ConvView.parse(viewOf(state, ctx, 'conv:ws:w1'));
    const answer = w1.turns.find((t) => t.who === 'claude')!;
    expect(answer.prose).toEqual({ text: 'Add a middleware:\n\n[[code:0]]\n\nThen protect `/api/payments`.', code: [{ lang: 'ts', lines: 1 }] });
    expect(w1.turns[0]).toMatchObject({ who: 'you', name: 'kayra' });
    const w2 = ConvView.parse(viewOf(state, ctx, 'conv:ws:w2'));
    const live = w2.turns.at(-1)!;
    expect(live).toMatchObject({ status: 'working', step: 'Ran npm test · 137/215' });
    expect(live.subagents?.[0]).toMatchObject({ id: 'sa1', title: 'Check the webhooks', status: 'running', steps: ['Searched for retry'] });
    expect(live.subagents?.[0]?.outputs.map((o) => o.name)).toEqual(['shot.png']);
    expect(live.outputs?.map((o) => o.name)).toEqual(['run.log']);
    expect(w2.needsYou.map((n) => n.id)).toEqual(['approval:ap1', 'question:q2']);
    expect(w2.working).toBe(true);
    expect(w2.canSend).toBe(true);
  });

  it('a file written after the last answer ended shows with that answer (not nowhere)', () => {
    const late: ViewContext = { ...context(), outputs: (channel) => (channel === 'ws:w1' ? [{ path: '/Users/k/landing/.beluga/scratch/after.png', size: 10, ts: T0 + 1_000_000, cwd: '/Users/k/landing' }] : []) };
    const w1 = ConvView.parse(viewOf(state, late, 'conv:ws:w1'));
    const answers = w1.turns.filter((t) => t.who === 'claude');
    expect(answers.at(-1)!.outputs?.map((o) => o.name)).toEqual(['after.png']);
    expect(answers.slice(0, -1).flatMap((t) => t.outputs ?? [])).toEqual([]);
  });

  it('a friend’s Claude you asked reads as a conversation with its files', () => {
    const conv = ConvView.parse(viewOf(state, ctx, 'conv:task:t_screen000001'));
    expect(conv.turns.map((t) => [t.who, t.name, t.prose.text, t.status])).toEqual([
      ['you', 'kayra', 'Take a screenshot of your desktop', undefined],
      ['friend', "bob's Claude", 'Here it is.', 'done'],
    ]);
    expect(conv.turns[1]!.outputs?.map((o) => [o.name, o.kind])).toEqual([['desktop.png', 'image']]);
    expect(conv.canSend).toBe(false);
    expect(WorkView.parse(viewOf(state, ctx, 'work')).projects.find((p) => p.id === 'asked')?.conversations.map((c) => c.topic)).toEqual(['conv:task:t_screen000001']);
  });

  it('a message steered in that Claude hasn’t read yet says so on your turn, not as a turn of Claude’s (BLG-54)', () => {
    const store = new Store(state);
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r9', requester: ME, event: 'started', text: '', ts: T0 + 20, channel: 'ws:w1' });
    store.dispatch({ type: 'chat', id: 'c9', from: ME, text: 'look at the retries first', ts: T0 + 21, byAgent: false, channel: 'ws:w1', request: 'r10', steer: true });
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r10', requester: ME, event: 'text', text: 'Claude reads this after its current step', ts: T0 + 21, channel: 'ws:w1' });
    const conv = ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1'));
    expect(conv.turns.slice(-2).map((t) => [t.who, t.prose.text, t.steer])).toEqual([
      ['claude', '', undefined],
      ['you', 'look at the retries first', { request: 'r10', waiting: 'next_step' }],
    ]);
    // Read: your turn reads as any other.
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r10', requester: ME, event: 'done', text: 'Claude read this while it worked; the answer above covers it.', ts: T0 + 22, channel: 'ws:w1' });
    expect(ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1')).turns.at(-1)).toMatchObject({ who: 'you', prose: { text: 'look at the retries first' } });
    expect(ConvView.parse(viewOf(store.getState(), ctx, 'conv:ws:w1')).turns.at(-1)?.steer).toBeUndefined();
  });

  it('pages back through older turns', () => {
    const { turns } = convTurns(state, ctx, 'ws:w1');
    const older = convTurns(state, ctx, 'ws:w1', { before: turns.at(-1)!.id, limit: 1 });
    expect(older.turns.map((t) => t.id)).toEqual([turns.at(-2)!.id]);
    expect(older.more).toBe(false);
  });

  it('plans, chats and people', () => {
    expect(PlansView.parse(viewOf(state, ctx, 'plans')).plans).toEqual([{ id: 'pl_auth', title: 'Add auth', state: 'draft', topic: 'plan:pl_auth', done: 0, total: 1 }]);
    const page = PlanView.parse(viewOf(state, ctx, 'plan:pl_auth'));
    expect(page.needsYou.find((n) => n.kind === 'decision')?.actions.map((a) => a.method)).toEqual(['plans.approve', 'plans.discard']);
    const chat = ChatView.parse(viewOf(state, ctx, `chat:dm:${BOB}`));
    // Whose Claude a message can ask: you, then them.
    expect(chat.members).toEqual([{ peerId: ME, name: 'kayra', me: true }, { peerId: BOB, name: 'bob' }]);
    expect(chat.messages.map((m) => [m.from, m.mine, m.text])).toEqual([
      ['bob', false, 'see\n[[code:0]]\nhere'],
      ['kayra', true, 'on it'],
    ]);
    expect(ChatsView.parse(viewOf(state, ctx, 'chats')).chats[0]).toMatchObject({ name: 'bob', kind: 'dm', unread: 2 });
    expect(PeopleView.parse(viewOf(state, ctx, 'people')).people[0]).toMatchObject({ name: 'bob', presence: 'away', note: 'lunch', offers: ['claude', 'screen', 'shell'] });
    expect(WorkView.parse(viewOf(state, ctx, 'work')).projects.find((p) => p.id === 'p1')?.conversations.map((c) => c.title)).toEqual(['tests', 'auth']);
  });

  it('every needs-you action is a call the phone may make', async () => {
    const { phoneMay } = await import('../src/companion/coverage.js');
    expect(needsYou(state).flatMap((n) => [...n.actions.map((a) => a.method), ...(n.answer ? [n.answer.method] : [])]).filter((m) => !phoneMay(m))).toEqual([]);
    // Nothing waits without a way to answer it from the phone.
    expect(needsYou(state).filter((n) => !n.actions.length && !n.answer)).toEqual([]);
  });

  it('snapshot', () => {
    const fresh = context();
    expect(Object.fromEntries(TOPICS.map((t) => [t, viewOf(state, fresh, t)]))).toMatchSnapshot();
  });
});
