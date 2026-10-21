import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { Store, initialState } from '../src/core/store.js';
import type { BodyOf } from '../src/protocol.js';
import { COMPACT_INSTRUCTIONS } from '../src/shared/context-usage.js';
import { MockContext, mockSummary, seedMockContext } from '../src/agent/mock-context.js';
import { createMockBackend } from '../src/agent/mock.js';
import { isCompactItem } from '../packages/mac/src/chat/context-model.js';
import { waitFor } from './helpers.js';

const ME = 'me';
const pct = (p: number) => JSON.stringify({ used: p * 2_000, window: 200_000 });

/**
 * A pretend Claude: each prompt runs one script step — report this much context, then answer.
 * `hold` keeps a run going until released (to send things while Claude works).
 */
function backend(script: { fill?: number[]; compactTo?: number; failCompact?: boolean } = {}) {
  const prompts: string[] = [];
  const inputs: AgentRunInput[] = [];
  const fill = [...(script.fill ?? [])];
  let release: (() => void) | undefined;
  const holds: Array<Promise<void>> = [];
  const agent: AgentBackend = {
    async run(input) {
      prompts.push(input.prompt);
      inputs.push(input);
      if (input.prompt.startsWith('/compact')) {
        if (script.failCompact) throw new Error('compaction failed');
        input.onEvent('compact', JSON.stringify({ pre: 170_000, post: script.compactTo ?? 20_000, trigger: 'manual', summary: 'kept the plan' }));
        return '';
      }
      const hold = holds.shift();
      if (hold) await hold;
      const next = fill.shift();
      if (next !== undefined) input.onEvent('context', pct(next));
      return 'done';
    },
  };
  return {
    agent,
    prompts,
    inputs,
    /** The next normal run waits until `go()`. */
    holdNext: () => {
      holds.push(new Promise<void>((r) => (release = r)));
      return () => release?.();
    },
  };
}

function host(agent: AgentBackend, prefs: { autoCompact?: boolean; autoCompactAt?: number } = {}) {
  const store = new Store(initialState('room', 'auto'));
  // Auto-compact is off by default; these tests are about it on unless they say otherwise.
  store.dispatch({ type: 'prefs', prefs: { autoCompact: true, ...prefs } });
  const toasts: string[] = [];
  // Events go to yourself, as the room would deliver them.
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
    toast: (text) => void toasts.push(text),
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
  });
  let n = 0;
  const ask = (prompt: string): Promise<void> => h.onAgentRequest(ME, { kind: 'agent_request', requestId: `r${++n}`, prompt, viaAgent: false, channel: 'room', urgent: false, plan: false });
  return { h, store, ask, toasts };
}

const dividers = (store: Store) => store.getState().log.filter(isCompactItem);
const cards = (store: Store) => store.getState().log.filter((l) => l.type === 'agent');

describe('auto-compact', () => {
  it('compacts in the background when a run ends past the threshold, between turns', async () => {
    const b = backend({ fill: [88] });
    const { h, store, ask } = host(b.agent);
    await ask('build the thing');
    await waitFor(() => dividers(store)[0]?.compact.state === 'done');
    expect(b.prompts).toEqual(['build the thing', `/compact ${COMPACT_INSTRUCTIONS}`]);
    expect(dividers(store)[0]!.compact).toMatchObject({ state: 'done', trigger: 'auto', pre: 170_000, post: 20_000, summary: 'kept the plan' });
    expect(store.getState().context.room).toMatchObject({ used: 20_000 });
    // Compacting isn't a message: no card for it, only the divider.
    expect(cards(store)).toHaveLength(1);
    await h.idle('room');
  });

  it('leaves a conversation under the threshold alone, and does nothing when turned off', async () => {
    const under = backend({ fill: [84] });
    const a = host(under.agent);
    await a.ask('hello');
    await waitFor(() => cards(a.store)[0]?.type === 'agent' && cards(a.store)[0]!.status === 'done');
    await a.h.idle('room');
    expect(under.prompts).toEqual(['hello']);

    const off = backend({ fill: [99] });
    const b = host(off.agent, { autoCompact: false });
    await b.ask('hello');
    await b.h.idle('room');
    await waitFor(() => cards(b.store)[0]?.type === 'agent' && cards(b.store)[0]!.status === 'done');
    expect(off.prompts).toEqual(['hello']);
    expect(dividers(b.store)).toHaveLength(0);
  });

  it('follows the threshold you set', async () => {
    const b = backend({ fill: [72] });
    const { h, store, ask } = host(b.agent, { autoCompactAt: 70 });
    await ask('hello');
    await waitFor(() => dividers(store)[0]?.compact.state === 'done');
    await h.idle('room');
    expect(b.prompts[1]).toMatch(/^\/compact /);
  });

  it('compacts before the next message goes when the conversation is already past it', async () => {
    const b = backend({ fill: [40] });
    const { h, store, ask } = host(b.agent);
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'seed', requester: ME, event: 'context', text: pct(91), ts: 1, channel: 'room' });
    await ask('next task');
    await waitFor(() => b.prompts.length === 2);
    await h.idle('room');
    expect(b.prompts[0]).toMatch(/^\/compact /);
    expect(b.prompts[1]).toBe('next task');
  });

  it('doesn’t loop when the summary is still big: it tries again only after Claude has run', async () => {
    const b = backend({ fill: [95, 96], compactTo: 180_000 });
    const { h, store, ask } = host(b.agent);
    await ask('one');
    await waitFor(() => dividers(store).length === 1 && dividers(store)[0]!.compact.state === 'done');
    await h.idle('room');
    expect(b.prompts.filter((p) => p.startsWith('/compact'))).toHaveLength(1);
    await ask('two');
    await waitFor(() => dividers(store).length === 2 && dividers(store)[1]!.compact.state === 'done');
    await h.idle('room');
    expect(b.prompts.map((p) => (p.startsWith('/compact') ? 'compact' : p))).toEqual(['one', 'compact', 'two', 'compact']);
  });

  it('tells Claude Code the same threshold for its own compaction, and nothing when off', async () => {
    const on = backend();
    const a = host(on.agent, { autoCompactAt: 78 });
    await a.ask('hi');
    await a.h.idle('room');
    expect(on.inputs[0]!.autoCompactAt).toBe(78);
    const off = backend();
    const b = host(off.agent, { autoCompact: false });
    await b.ask('hi');
    await b.h.idle('room');
    expect(off.inputs[0]!.autoCompactAt).toBeUndefined();
  });
});

describe('Compact now', () => {
  it('waits for Claude’s current turn to end (never in the middle of a tool call), once even if asked twice', async () => {
    const b = backend({ fill: [30] });
    const { h, store, ask, toasts } = host(b.agent);
    const go = b.holdNext();
    void ask('long task');
    await waitFor(() => b.prompts.length === 1);
    h.compact('room', 'keep the API decisions');
    h.compact('room');
    expect(toasts.at(-1)).toMatch(/when it finishes/);
    await new Promise((r) => setTimeout(r, 30));
    expect(b.prompts).toEqual(['long task']);
    go();
    await waitFor(() => dividers(store)[0]?.compact.state === 'done');
    await h.idle('room');
    expect(b.prompts).toEqual(['long task', '/compact keep the API decisions']);
    expect(dividers(store)[0]!.compact.trigger).toBe('manual');
  });

  it('says the compaction didn’t finish when it fails, and the conversation goes on', async () => {
    const b = backend({ failCompact: true });
    const { h, store } = host(b.agent);
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'seed', requester: ME, event: 'context', text: pct(50), ts: 1, channel: 'room' });
    h.compact('room');
    await waitFor(() => dividers(store)[0]?.compact.state === 'failed');
    await h.idle('room');
    expect(store.getState().context.room).toEqual({ used: 100_000, window: 200_000 });
  });

  it('stops quietly with the conversation: no "taken out of the queue" card for a waiting compaction', async () => {
    const b = backend();
    const { h, store, ask } = host(b.agent);
    const go = b.holdNext();
    void ask('long task');
    await waitFor(() => b.prompts.length === 1);
    h.compact('room');
    expect(h.stopRun('room')).toMatchObject({ stopped: true, returned: [] });
    go();
    await h.idle('room');
    expect(store.getState().log.filter((l) => l.type === 'agent' && /Taken out/.test(l.text))).toHaveLength(0);
  });
});

describe('the demo’s Claude', () => {
  const input = (prompt: string, cwd: string, events: Array<[string, string]>): AgentRunInput => ({
    prompt,
    requesterName: 'kay',
    viaAgent: false,
    context: [],
    scope: 'full',
    signal: new AbortController().signal,
    place: { cwd, additionalDirectories: [], autoEdit: true, onSession: () => undefined },
    onEvent: (kind, text) => void events.push([kind, text]),
    onFileTouched: () => undefined,
    canUseTool: async () => true,
  });

  it('fills the window as it works and compacts it with a summary, per conversation', async () => {
    const events: Array<[string, string]> = [];
    seedMockContext('/demo/full', 166_000);
    const agent = createMockBackend({} as never, 0.01);
    await agent.run(input('look around', '/demo/full', events));
    const used = events.filter(([k]) => k === 'context').map(([, t]) => (JSON.parse(t) as { used: number }).used);
    expect(used.length).toBeGreaterThan(1); // live, while it works
    expect(used).toEqual([...used].sort((a, b) => a - b));
    expect(used.at(-1)).toBeGreaterThan(166_000);
    await agent.run(input('/compact keep the deploy steps', '/demo/full', events));
    const compact = JSON.parse(events.find(([k]) => k === 'compact')![1]) as { pre: number; post: number; summary: string };
    expect(compact.pre).toBe(used.at(-1));
    expect(compact.post).toBeLessThan(compact.pre / 4);
    expect(compact.summary).toMatch(/Open tasks/);
    expect(compact.summary).toMatch(/keep the deploy steps/);
    // Another conversation keeps its own numbers.
    const other = new MockContext();
    const e2: Array<[string, string]> = [];
    expect(other.grow(input('x', '/demo/other', e2))).toBe(25_500);
    expect(mockSummary(COMPACT_INSTRUCTIONS)).not.toMatch(/Kept in focus/);
  });
});
