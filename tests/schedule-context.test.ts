import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import type { AgentRuntime } from '../src/protocol.js';
import { AgentHost } from '../src/core/agent-host.js';
import { launchAssistant } from '../src/core/assistant/launch.js';
import { assistantOf } from '../src/core/assistant/registry.js';
import { MAX_BLIND_RUNS } from '../src/core/schedule/model.js';
import type { Schedules } from '../src/core/schedule/service.js';
import { loadSettings } from '../src/core/settings.js';
import { Store, initialState } from '../src/core/store.js';
import { RunFailedError } from '../src/shared/run-failure.js';
import { assistantChannel } from '../src/shared/assistant.js';
import { COMPACT_INSTRUCTIONS, contextPct } from '../src/shared/context-usage.js';
import { waitFor } from './helpers.js';
import { harness, type Harness } from './schedule-fakes.js';

const MIN = 60_000;
const WINDOW = 200_000;
const THRESHOLD = 85;
const EVERY_MINUTE = { title: 'Check', prompt: 'Look at it', when: { kind: 'interval', minutes: 1 } } as const;

let h: Harness;

beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const isCompact = (r: AgentRunInput) => r.prompt.startsWith('/compact');
const turns = () => h.runs.filter((r) => !isCompact(r));

/** The next run of a schedule, to its end, with its chat idle again. */
async function runOnce(s: Schedules, id: string, channel: string): Promise<void> {
  h.clock.now += 2 * MIN;
  s.tick();
  await waitFor(() => !s.get(id)?.running && !h.session.host.busyIn(channel), 8000);
}

/** A fake agent whose context grows on each turn. Compacting takes it down to `compactTo`, and `fails` compactions throw first. */
function growingAgent(opts: { step?: number; compactTo?: number; fails?: number } = {}) {
  const state = { used: 0, startPcts: [] as number[], fails: opts.fails ?? 0 };
  h.script.run = async (input) => {
    if (isCompact(input)) {
      if (state.fails-- > 0) throw new Error('compaction failed');
      const pre = state.used;
      state.used = opts.compactTo ?? 20_000;
      input.onEvent('compact', JSON.stringify({ pre, post: state.used, trigger: 'manual', window: WINDOW }));
      return '';
    }
    state.startPcts.push(contextPct({ used: state.used, window: WINDOW }));
    state.used += opts.step ?? 30_000;
    input.onEvent('context', JSON.stringify({ used: state.used, window: WINDOW }));
    return 'done';
  };
  return state;
}

/** A chat on a runtime by its name. */
async function chatOn(runtime: string): Promise<string> {
  const channel = await h.chat();
  h.manager.setAgent(channel.slice(3), { runtime: runtime as AgentRuntime, label: runtime });
  return channel;
}

describe('compacting before a scheduled run', () => {
  it('keeps 200 scheduled turns under the threshold at each start, with Auto-compact off', { timeout: 180_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    const agent = growingAgent();

    for (let i = 0; i < 200; i++) await runOnce(s, made.id, channel);

    expect(turns()).toHaveLength(200);
    expect(Math.max(...agent.startPcts)).toBeLessThan(THRESHOLD);
    expect(h.runs.filter(isCompact).length).toBeGreaterThan(10);
    expect(h.store.getState().prefs.autoCompact).toBe(false);
    expect(loadSettings().autoCompact).toBe(false);
    expect(s.get(made.id)).toMatchObject({ failures: 0, enabled: true });
  });

  it('keeps the purpose of the schedule, its last result and its open items', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    growingAgent({ step: 180_000 });

    await runOnce(s, made.id, channel);
    await runOnce(s, made.id, channel);

    const prompt = h.runs.find(isCompact)!.prompt;
    expect(prompt).toContain(COMPACT_INSTRUCTIONS);
    expect(prompt).toContain('Look at it');
    expect(prompt).toContain('last run ended as ok');
    expect(prompt).toContain('open items');
    expect(h.runs.map(isCompact)).toEqual([false, true, false]);
  });

  it('covers a Your Mac chat, in its own place', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const stop = launchAssistant({ session: h.session, store: h.store, demo: true });
    try {
      const channel = assistantChannel(assistantOf(h.session)!.newChat());
      const made = s.create(channel, EVERY_MINUTE);
      growingAgent({ step: 180_000 });

      await runOnce(s, made.id, channel);
      await runOnce(s, made.id, channel);

      const compaction = h.runs.find(isCompact);
      expect(compaction?.place?.cwd).toBe(turns()[0]!.place?.cwd);
      expect(turns()).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it('goes on after one failed compaction, and pauses with the reason after two', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    growingAgent({ step: 180_000, fails: 2 });

    await runOnce(s, made.id, channel);
    await runOnce(s, made.id, channel);
    expect(turns()).toHaveLength(2);
    expect(s.get(made.id)).toMatchObject({ enabled: true, compactFailures: 1 });
    expect(h.lines(channel).some((l) => /compacting this chat failed\. This run goes on/.test(l))).toBe(true);

    await runOnce(s, made.id, channel);
    expect(turns()).toHaveLength(2);
    expect(s.get(made.id)).toMatchObject({ enabled: false, last: 'failed', pausedReason: expect.stringMatching(/Compacting this chat failed twice/) });
    expect(h.lines(channel).some((l) => /failed twice/.test(l))).toBe(true);
  });

  it('counts a summary still past the threshold as a failed compaction', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    growingAgent({ step: 180_000, compactTo: 190_000 });

    await runOnce(s, made.id, channel);
    await runOnce(s, made.id, channel);

    expect(s.get(made.id)?.compactFailures).toBe(1);
  });

  it('starts no run when the chat is archived during the compaction', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    const agent = growingAgent({ step: 180_000 });
    await runOnce(s, made.id, channel);
    const grown = h.script.run;
    h.script.run = (input) =>
      isCompact(input)
        ? new Promise<string>((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        : grown(input);

    h.clock.now += 2 * MIN;
    s.tick();
    await waitFor(() => h.runs.some(isCompact), 4000);
    await h.session.workspaces!.archive(channel.slice(3));

    await waitFor(() => !s.get(made.id)?.running, 4000);
    expect(turns()).toHaveLength(1);
    expect(s.get(made.id)).toMatchObject({ enabled: false, last: 'interrupted', failures: 0 });
    expect(agent.startPcts).toHaveLength(1);
  });
});

describe('the rules of each runtime', () => {
  it('leaves Codex to compact itself, with no refusal in the chat and no new session', { timeout: 60_000 }, async () => {
    const s = h.launch();
    const channel = await chatOn('codex');
    const made = s.create(channel, EVERY_MINUTE);
    growingAgent({ step: 180_000 });

    await runOnce(s, made.id, channel);
    await runOnce(s, made.id, channel);
    await runOnce(s, made.id, channel);

    expect(h.runs.filter(isCompact)).toEqual([]);
    expect(turns().map((r) => r.place?.resume)).toEqual([undefined, 'session-1', 'session-1']);
    expect(s.get(made.id)).toMatchObject({ failures: 0, enabled: true });
    expect(s.get(made.id)?.compactFailures ?? 0).toBe(0);
  });

  it('compacts OpenCode as it does Claude', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await chatOn('opencode');
    const made = s.create(channel, EVERY_MINUTE);
    growingAgent({ step: 180_000 });

    await runOnce(s, made.id, channel);
    await runOnce(s, made.id, channel);

    expect(h.runs.map(isCompact)).toEqual([false, true, false]);
  });

  it.each(['codex', 'local-llama'])('starts %s fresh after 50 runs when it reports no usage, with the carried chat and a line', { timeout: 120_000 }, async (runtime) => {
    const s = h.launch();
    const channel = await chatOn(runtime);
    const made = s.create(channel, EVERY_MINUTE);
    h.script.run = async () => 'the report';

    for (let i = 0; i < MAX_BLIND_RUNS; i++) await runOnce(s, made.id, channel);
    expect(h.runs.at(-1)!.place?.resume).toBe('session-1');
    expect(h.runs.at(-1)!.prompt).toBe('Look at it');
    expect(h.lines(channel).some((l) => /new session/.test(l))).toBe(false);

    await runOnce(s, made.id, channel);
    expect(h.runs.at(-1)!.place?.resume).toBeUndefined();
    expect(h.runs.at(-1)!.prompt).toMatch(/<conversation>[\s\S]*the report[\s\S]*<\/conversation>\s+Look at it$/);
    expect(h.lines(channel).filter((l) => /new session after 50 runs/.test(l))).toHaveLength(1);

    await runOnce(s, made.id, channel);
    expect(h.runs.at(-1)!.place?.resume).toBe(`session-${MAX_BLIND_RUNS + 1}`);
    expect(h.runs.at(-1)!.prompt).toBe('Look at it');
    expect(h.runs.filter(isCompact)).toEqual([]);
  });

  it('counts no blind runs while a runtime reports usage', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await chatOn('local-llama');
    const made = s.create(channel, EVERY_MINUTE);
    growingAgent({ step: 1000 });

    await runOnce(s, made.id, channel);
    await runOnce(s, made.id, channel);
    await runOnce(s, made.id, channel);

    expect(s.get(made.id)?.blindRuns).toBe(0);
  });
});

describe("the context 'fresh'", () => {
  it('gives each run a new session, keeps all runs in the chat and carries the recent chat lines', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, { ...EVERY_MINUTE, context: 'fresh' });
    h.store.dispatch({ type: 'chat', id: randomUUID(), from: h.session.selfId, text: 'remember the blue one', ts: h.clock.now, byAgent: false, channel });

    await runOnce(s, made.id, channel);
    await runOnce(s, made.id, channel);
    await runOnce(s, made.id, channel);

    expect(h.runs.map((r) => r.place?.resume)).toEqual([undefined, undefined, undefined]);
    expect(h.runs[2]!.context.some((line) => line.includes('remember the blue one'))).toBe(true);
    expect(h.runs[0]!.scheduleBrief).toMatch(/starts a new session/);
    expect(h.lines(channel).filter((l) => l.startsWith('Scheduled run · Check'))).toHaveLength(3);
    expect(h.store.getState().log.filter((l) => l.channel === channel && l.type === 'agent' && l.status === 'done')).toHaveLength(3);
    expect(h.runs.filter(isCompact)).toEqual([]);
  });

  it('forgets the numbers as well, so a full chat does not compact', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, { ...EVERY_MINUTE, context: 'fresh' });
    growingAgent({ step: 190_000 });

    await runOnce(s, made.id, channel);
    await runOnce(s, made.id, channel);

    expect(h.runs.map(isCompact)).toEqual([false, false]);
  });
});

describe('the brief', () => {
  it('asks for a short report with no restated reports', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    await runOnce(s, made.id, channel);
    expect(h.runs[0]!.scheduleBrief).toMatch(/do not restate earlier reports/);
    expect(h.runs[0]!.scheduleBrief).toMatch(/continues the conversation/);
  });
});

describe('AgentHost.compactNow', () => {
  function bareHost(over: { agent?: AgentBackend; runtime?: string; driving?: boolean } = {}) {
    const store = new Store(initialState('room', 'auto'));
    const toasts: string[] = [];
    const host = new AgentHost({
      store,
      selfId: () => 'me',
      send: (() => true) as never,
      agent: () => over.agent,
      ...(over.runtime ? { agentRef: () => ({ runtime: over.runtime }) as never } : {}),
      ...(over.driving ? { terminalDriving: () => true } : {}),
      shares: {} as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
      people: {} as never,
      questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
      toast: (text) => void toasts.push(text),
      system: () => undefined,
      approvalTimeoutMs: () => 60_000,
      refreshUsage: async () => undefined,
    });
    return { host, toasts };
  }
  const compacts: AgentBackend = {
    run: async (input) => {
      input.onEvent('compact', JSON.stringify({ pre: 10, post: 1, trigger: 'manual' }));
      return '';
    },
  } as AgentBackend;

  it('says done when it compacted, and failed when it did not', async () => {
    expect(await bareHost({ agent: compacts }).host.compactNow('room')).toBe('done');
    const breaks = { run: async () => { throw new Error('no'); } } as unknown as AgentBackend;
    expect(await bareHost({ agent: breaks }).host.compactNow('room')).toBe('failed');
  });

  it('refuses with no agent, on a driving terminal and on Codex, with no toast', async () => {
    for (const over of [{}, { agent: compacts, driving: true }, { agent: compacts, runtime: 'codex' }]) {
      const { host, toasts } = bareHost(over);
      expect(await host.compactNow('room')).toBe('refused');
      expect(toasts).toEqual([]);
    }
  });

  it('refuses on a held lane, which never runs it', async () => {
    let n = 0;
    const agent = {
      run: async () => {
        if (++n === 1) {
          await new Promise((r) => setTimeout(r, 30));
          throw new RunFailedError({ kind: 'crash', detail: 'gone' });
        }
        return 'ok';
      },
    } as unknown as AgentBackend;
    const { host } = bareHost({ agent });
    const ask = (requestId: string) => host.onAgentRequest('me', { kind: 'agent_request', requestId, prompt: 'x', viaAgent: false, channel: 'room', urgent: false, plan: false });
    await ask('a');
    await ask('b');
    await waitFor(() => n === 1 && !host.runningIn('room'), 2000);
    expect(host.busyIn('room')).toBe(true);
    expect(await host.compactNow('room')).toBe('refused');
  });

  it('says refused when a stop takes it out of the queue or ends it', async () => {
    const hanging = { run: (input: AgentRunInput) => new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')))) } as unknown as AgentBackend;
    const { host } = bareHost({ agent: hanging });
    const first = host.compactNow('room');
    const second = host.compactNow('room');
    await waitFor(() => host.runningIn('room'), 2000);
    host.stopRun('room');
    expect(await first).toBe('refused');
    expect(await second).toBe('refused');
  });
});
