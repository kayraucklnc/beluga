import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost, EXIT_GRACE_MS } from '../src/core/agent-host.js';
import { ShareService } from '../src/core/shares.js';
import { type LogItem, Store, initialState, settleRun } from '../src/core/store.js';
import { WorkspaceController } from '../src/core/workspace-controller.js';
import type { BodyOf } from '../src/protocol.js';
import { activityOf } from '../src/ui/workspace-models.js';
import { workingCount } from '../packages/mac/src/layout/attention-model.js';
import { decodeFailure } from '../src/shared/run-failure.js';
import { waitFor } from './helpers.js';

/**
 * Nothing shows as running when no Claude runs: a run saved mid-way (crash, quit) loads as
 * interrupted, quitting settles what it stopped, and a Claude Code that exits without ending its
 * turn closes its run out.
 */

const ME = 'me';
type AgentItem = Extract<LogItem, { type: 'agent' }>;

const agentItem = (id: string, status: AgentItem['status'], extra: Partial<AgentItem> = {}): AgentItem => ({
  id,
  type: 'agent',
  channel: 'ws:w1',
  subagents: [],
  requestId: id,
  owner: ME,
  ownerName: 'Me',
  requesterName: 'Me',
  status,
  text: '',
  steps: [],
  ts: 1_000,
  ...extra,
});

describe('settleRun', () => {
  it('a card still saying it runs becomes interrupted, ended at its last sign of life', () => {
    const run = settleRun(agentItem('a', 'started', { lastAt: 5_000, subagents: [{ id: 's', title: 'look', steps: [], status: 'running' }] })) as AgentItem;
    expect(run.status).toBe('interrupted');
    expect(run.endTs).toBe(5_000);
    expect(run.subagents[0]!.status).toBe('done');
    expect((settleRun(agentItem('q', 'queued')) as AgentItem).status).toBe('interrupted');
    expect((settleRun(agentItem('w', 'awaiting_approval')) as AgentItem).status).toBe('interrupted');
  });

  it('leaves finished runs and other items alone', () => {
    const done = agentItem('d', 'done', { endTs: 9 });
    expect(settleRun(done)).toBe(done);
    const chat: LogItem = { id: 'c', type: 'chat', channel: 'room', from: ME, name: 'Me', text: 'hi', ts: 1, byAgent: false };
    expect(settleRun(chat)).toBe(chat);
  });

  it('runs_interrupted settles only your own runs, and changes nothing when none run', () => {
    const store = new Store(initialState('room', 'auto'));
    store.dispatch({ type: 'history', channel: 'ws:w1', items: [agentItem('mine', 'started'), agentItem('theirs', 'started', { owner: 'bob' }), agentItem('old', 'done')] });
    store.dispatch({ type: 'runs_interrupted', owner: ME });
    const status = (id: string) => (store.getState().log.find((l) => l.id === id) as AgentItem).status;
    expect([status('mine'), status('theirs'), status('old')]).toEqual(['interrupted', 'started', 'done']);
    const before = store.getState();
    store.dispatch({ type: 'runs_interrupted', owner: ME });
    expect(store.getState()).toBe(before);
  });
});

describe('loading a saved conversation', () => {
  function controller(saved: LogItem[]) {
    const store = new Store(initialState('room', 'auto'));
    const manager = { find: (id: string) => ({ id }), loadHistory: () => saved, list: [] };
    const ctl = new WorkspaceController({ manager: manager as never, store, shares: new ShareService([]), selfId: () => ME, toast: () => undefined, intend: () => undefined, askClaude: () => undefined });
    return { store, ctl };
  }

  it('a run saved mid-way (no live run here) loads as interrupted: the sidebar shows nothing running', () => {
    const { store, ctl } = controller([agentItem('a', 'done'), agentItem('b', 'started'), agentItem('c', 'queued')]);
    ctl.ensureLoaded('w1');
    const log = store.getState().log;
    expect(log.map((l) => (l as AgentItem).status)).toEqual(['done', 'interrupted', 'interrupted']);
    expect(activityOf(log, 'ws:w1').running).toBe(false);
    ctl.stop();
  });

  it('a run live in this session keeps its live card', () => {
    const { store, ctl } = controller([agentItem('b', 'started')]);
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'b', requester: ME, event: 'tool', text: 'Read a.ts', ts: 2_000, channel: 'ws:w1', itemId: 'b' });
    ctl.ensureLoaded('w1');
    const log = store.getState().log;
    expect((log[0] as AgentItem).status).toBe('started');
    expect((log[0] as AgentItem).steps).toEqual(['Read a.ts']);
    expect(activityOf(log, 'ws:w1').running).toBe(true);
    ctl.stop();
  });
});

describe('the tray and the sidebar', () => {
  it('count working conversations the same way (a queued or approval-waiting run counts; an interrupted one does not)', () => {
    const store = new Store(initialState('room', 'auto'));
    store.dispatch({ type: 'identity', selfId: ME, isHost: true });
    store.dispatch({ type: 'history', channel: 'ws:a', items: [agentItem('1', 'started')] });
    store.dispatch({ type: 'history', channel: 'ws:b', items: [agentItem('2', 'awaiting_approval')] });
    store.dispatch({ type: 'history', channel: 'ws:c', items: [agentItem('3', 'interrupted')] });
    store.dispatch({ type: 'history', channel: 'ws:d', items: [agentItem('4', 'started', { owner: 'bob' })] });
    const st = store.getState();
    expect(workingCount(st)).toBe(2);
    const sidebar = ['ws:a', 'ws:b', 'ws:c'].filter((c) => activityOf(st.log, c).running);
    expect(sidebar).toEqual(['ws:a', 'ws:b']);
  });
});

/** A pretend Claude whose "slow" run never ends on its own; its Claude Code process can exit under it. */
function backend() {
  const live: { exit?: () => void; finish?: () => void; started: string[] } = { started: [] };
  const agent: AgentBackend = {
    async run(input: AgentRunInput) {
      live.started.push(input.prompt);
      if (input.prompt !== 'slow' && input.prompt !== 'wedged') return `did ${input.prompt}`;
      let alive = true;
      let exited!: () => void;
      const gone = new Promise<void>((r) => (exited = r));
      input.onProcess?.({ pid: 1, alive: () => alive, kill: async () => void ((alive = false), exited()), exited: gone });
      live.exit = () => ((alive = false), exited());
      return new Promise<string>((resolve, reject) => {
        if (input.prompt === 'slow') input.signal.addEventListener('abort', () => reject(new Error('aborted')));
        live.finish = () => resolve('slow done');
      });
    },
  };
  return { agent, live };
}

function host(agent: AgentBackend) {
  const store = new Store(initialState('room', 'auto'));
  const send = (body: { kind: string } & Record<string, unknown>): boolean => {
    if (body.kind !== 'agent_event') return true;
    const e = body as unknown as BodyOf<'agent_event'>;
    store.dispatch({ type: 'agent_event', owner: ME, requestId: e.requestId, requester: e.requester, event: e.event, text: e.text, ts: Date.now(), channel: e.channel });
    return true;
  };
  const h = new AgentHost({
    store,
    selfId: () => ME,
    send: send as never,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
  });
  const ask = (requestId: string, prompt: string): Promise<void> => h.onAgentRequest(ME, { kind: 'agent_request', requestId, prompt, viaAgent: false, channel: 'room', urgent: false, plan: false });
  const card = (requestId: string) => store.getState().log.find((l) => l.type === 'agent' && l.requestId === requestId) as AgentItem | undefined;
  return { h, store, ask, card };
}

describe('a Claude Code process that exits', () => {
  afterEach(() => vi.useRealTimers());

  it('without ending its turn: the run is closed out as a crash after a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'slow');
    await waitFor(() => Boolean(b.live.exit));
    expect(t.card('r1')?.status).toBe('started');
    b.live.exit!();
    await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS - 500);
    expect(t.card('r1')?.status).toBe('started');
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => t.card('r1')?.status === 'error');
    expect(decodeFailure(t.card('r1')!.text)?.kind).toBe('crash');
    expect(t.h.runningIn('room')).toBe(false);
  });

  it('as its run ends: the run ends the usual way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'slow');
    await waitFor(() => Boolean(b.live.finish));
    b.live.finish!();
    b.live.exit!();
    await waitFor(() => t.card('r1')?.status === 'done');
    await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS * 2);
    expect(t.card('r1')?.status).toBe('done');
  });
});

describe('quitting', () => {
  it('waits for stopped runs to end, and starts nothing that was waiting', async () => {
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'slow');
    await waitFor(() => Boolean(b.live.finish));
    await t.ask('r2', 'later');
    await waitFor(() => t.card('r2')?.status === 'queued');
    await t.h.abort();
    expect(t.card('r1')?.status).toBe('error');
    await new Promise((r) => setTimeout(r, 50));
    expect(b.live.started).toEqual(['slow']);
    // What's left (the queued message) the session settles before its last save.
    t.store.dispatch({ type: 'runs_interrupted', owner: ME });
    expect(t.card('r2')?.status).toBe('interrupted');
  });

  it("gives up waiting after a moment on a run that won't end", async () => {
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'wedged');
    await waitFor(() => Boolean(b.live.finish));
    const at = Date.now();
    await t.h.abort(100);
    expect(Date.now() - at).toBeLessThan(1_000);
    t.store.dispatch({ type: 'runs_interrupted', owner: ME });
    expect(t.card('r1')?.status).toBe('interrupted');
  });
});
