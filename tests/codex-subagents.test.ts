import { describe, expect, it } from 'vitest';
import { CODEX_CAPABILITIES } from '../src/agent/runtime/codex/index.js';
import { createCodexBackend } from '../src/agent/runtime/codex/runner.js';
import { SUB_AGENTS } from '../src/agent/runtime/codex/scripted.js';
import { CodexSubAgents, subAgentTitle } from '../src/agent/runtime/codex/subagents.js';
import type { AgentRunInput, FollowUp, SubAgentEvent } from '../src/agent/types.js';
import type { StepRecord } from '../src/shared/steps.js';
import { type Action, type LogItem, initialState, reduce } from '../src/core/store.js';
import type { AgentEventKind } from '../src/protocol.js';
import { FakeCodex } from './fake-codex.js';
import { room } from './runtime-conformance.js';

/** BLG-519: Codex's own sub-agents (multi_agent) as Beluga's sub-agents, the way Claude's show. */

const cwd = process.cwd();

type Run = AgentRunInput & { events: Array<[string, string]>; steps: Map<string, StepRecord>; subs: () => SubAgentEvent[]; controller: AbortController };

function input(prompt: string, extra: Partial<AgentRunInput> = {}): Run {
  const events: Array<[string, string]> = [];
  const steps = new Map<string, StepRecord>();
  const controller = new AbortController();
  return {
    prompt,
    requesterName: 'kay',
    viaAgent: false,
    context: [],
    scope: 'full',
    signal: controller.signal,
    controller,
    onEvent: (k, t) => void events.push([k, t]),
    onStep: (r) => void steps.set(r.id, r),
    onFileTouched: () => undefined,
    canUseTool: async () => true,
    events,
    steps,
    subs: () => events.filter(([k]) => k === 'sub').map(([, t]) => JSON.parse(t) as SubAgentEvent),
    ...extra,
  };
}

const backend = (codex: FakeCodex) => createCodexBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: codex.connect });
const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("Codex's multi-agent: on for your runs, off for friends'", () => {
  it('your own run turns it on; a friend’s task keeps it off (the trust table’s “your Codex tools”)', async () => {
    const own = new FakeCodex();
    await backend(own).run(input('hello'));
    expect((own.sent('thread/start')[0]!.config as Record<string, unknown>)['features.multi_agent']).toBe(true);

    const friend = new FakeCodex();
    await backend(friend).run(input('hello', { viaAgent: true, vetTool: () => undefined, scope: 'folder' }));
    expect((friend.sent('thread/start')[0]!.config as Record<string, unknown>)['features.multi_agent']).toBe(false);
  });

  it('says it has sub-agents and background agents', () => {
    expect(CODEX_CAPABILITIES.hasSubagents).toBe(true);
    expect(CODEX_CAPABILITIES.hasBackgroundAgents).toBe(true);
  });
});

describe('Codex sub-agents on the card', () => {
  it('each sub-agent is a row (name, role and prompt), its steps, and its report; the lead’s answer stays its own', async () => {
    const codex = new FakeCodex();
    const run = input('spawn two helpers');
    const answer = await backend(codex).run(run);
    expect(answer).toBe('echo: spawn two helpers');
    // The sub-agents' words never become the lead's.
    expect(run.events.filter(([k]) => k === 'text').map(([, t]) => t)).toEqual(['echo: spawn two helpers']);

    const subs = run.subs();
    const starts = subs.filter((e) => e.phase === 'start');
    expect(starts.map((e) => e.title)).toEqual(['Darwin (explorer) · Find the tests that cover the login flow', 'Noether (worker) · Check the docs mention the --remember flag']);
    expect(starts.every((e) => e.kind === 'agent')).toBe(true);
    const [darwin, noether] = starts.map((e) => e.id);
    expect(subs.filter((e) => e.id === darwin && e.phase === 'step').map((e) => e.step)).toEqual(['Bash ls tests', 'Bash rg -n login tests']);
    // Noether has fewer steps: it's back first.
    expect(subs.filter((e) => e.phase === 'done')).toEqual([
      { id: noether, phase: 'done' },
      { id: darwin, phase: 'done' },
    ]);

    // The launch step (Claude's Agent call) carries its report; its own steps are tagged with it.
    const launch = run.steps.get(darwin!)!;
    expect(launch).toMatchObject({ tool: 'Agent', status: 'done', output: SUB_AGENTS[0].report });
    expect(launch.parent).toBeUndefined();
    const own = [...run.steps.values()].filter((s) => s.parent === darwin);
    expect(own.map((s) => [s.tool, s.status])).toEqual([
      ['Bash', 'done'],
      ['Bash', 'done'],
    ]);
    // Not the lead's steps: no 'tool' event for them, and the lead ran no command of its own here.
    expect(run.events.filter(([k]) => k === 'tool')).toEqual([]);
  });

  it('a run whose sub-agents still work after it answered stays open for them, then ends', async () => {
    const codex = new FakeCodex({ stepMs: 40 });
    let answered: string | undefined;
    const offers: Array<unknown> = [];
    let doneAtAnswer = 0;
    const run = input('spawn them in the background', {
      onAnswered: (a) => {
        answered = a;
        doneAtAnswer = run.subs().filter((e) => e.phase === 'done').length;
      },
      onFollowUps: (send) => void offers.push(send),
    });
    const answer = await backend(codex).run(run);
    expect(answered).toBe('echo: spawn them in the background');
    expect(doneAtAnswer).toBe(0);
    expect(answer).toBe('echo: spawn them in the background');
    // Both came back before the run ended, not cut off.
    expect(run.subs().filter((e) => e.phase === 'done')).toHaveLength(2);
    expect(run.subs().some((e) => e.failed)).toBe(false);
    // Follow-ups were taken while they worked, then not any more.
    expect(offers).toHaveLength(2);
    expect(typeof offers[0]).toBe('function');
    expect(offers[1]).toBeUndefined();
  });

  it('a message sent while its sub-agents work gets a turn of its own', async () => {
    const codex = new FakeCodex();
    let send: ((f: FollowUp) => boolean) | undefined;
    const run = input('spawn in the background and hold', { onFollowUps: (s) => void (send = s ?? send) });
    const running = backend(codex).run(run);
    await until(() => Boolean(send));
    let reply: string | undefined;
    expect(send!({ prompt: 'how is it going', requesterName: 'kay', viaAgent: false, context: [], onEvent: () => undefined, onDone: (t) => void (reply = t), onError: (e) => void (reply = `error: ${e}`) })).toBe(true);
    await until(() => reply !== undefined);
    expect(reply).toBe('echo: how is it going');
    run.controller.abort();
    await expect(running).rejects.toThrow(/aborted/);
  });

  it('Stop interrupts every sub-agent’s turn on its own thread, and they end as stopped', async () => {
    const codex = new FakeCodex();
    const run = input('spawn and hold');
    const running = backend(codex).run(run);
    await until(() => run.subs().filter((e) => e.phase === 'step').length === 2);
    run.controller.abort();
    await expect(running).rejects.toThrow(/aborted/);
    const kids = run.subs().filter((e) => e.phase === 'start').map((e) => e.id);
    const interrupted = codex.sent('turn/interrupt').map((p) => p.threadId);
    for (const kid of kids) expect(interrupted).toContain(kid);
    expect(run.subs().filter((e) => e.phase === 'done')).toEqual(kids.map((id) => ({ id, phase: 'done', failed: true })));
    for (const kid of kids) expect(run.steps.get(kid)).toMatchObject({ status: 'error', isError: true });
  });
});

describe('the card after the run', () => {
  it('a sub-agent stopped with the run stays stopped; one still running is done', () => {
    let s = initialState('room');
    const ev = (event: AgentEventKind, text: string): Action => ({ type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'me', event, text, ts: 1, channel: 'ws:w1' });
    for (const a of [ev('started', ''), ev('sub', JSON.stringify({ id: 'a', phase: 'start', title: 'A' })), ev('sub', JSON.stringify({ id: 'b', phase: 'start', title: 'B' })), ev('sub', JSON.stringify({ id: 'a', phase: 'done', failed: true })), ev('error', 'Stopped by you')]) s = reduce(s, a);
    const card = s.log.find((l) => l.type === 'agent') as Extract<LogItem, { type: 'agent' }>;
    expect(card.subagents.map((x) => [x.id, x.status])).toEqual([
      ['a', 'failed'],
      ['b', 'done'],
    ]);
  });
});

describe('CodexSubAgents, from the lead’s items alone', () => {
  const lead = 'lead-thread';
  const make = () => {
    const subs: SubAgentEvent[] = [];
    const steps = new Map<string, StepRecord>();
    const t = new CodexSubAgents(cwd, { onSub: (e) => void subs.push(e), onStep: (r) => void steps.set(r.id, r) });
    t.lead = lead;
    return { t, subs, steps };
  };
  const item = (method: string, it: object) => [method, { threadId: lead, turnId: 't1', item: it }] as const;
  const collab = (tool: string, extra: object) => ({ type: 'collabAgentToolCall', id: `c-${tool}`, tool, status: 'completed', senderThreadId: lead, receiverThreadIds: [], prompt: null, agentsStates: {}, ...extra });

  it('a spawn starts it and a wait’s states end it, with the message as its report (no sub-agent thread events needed)', () => {
    const { t, subs, steps } = make();
    expect(t.handle(...item('item/completed', collab('spawnAgent', { receiverThreadIds: ['kid'], prompt: 'Look around\nmore' })))).toBe(true);
    expect(t.busy).toBe(true);
    expect(t.handle(...item('item/completed', collab('wait', { receiverThreadIds: ['kid'], agentsStates: { kid: { status: 'completed', message: 'All good.' } } })))).toBe(true);
    expect(subs).toEqual([
      { id: 'kid', phase: 'start', title: 'Look around', kind: 'agent' },
      { id: 'kid', phase: 'done' },
    ]);
    expect(steps.get('kid')).toMatchObject({ tool: 'Agent', status: 'done', output: 'All good.' });
    expect(t.busy).toBe(false);
  });

  it('an errored or shut-down one ends failed; the lead’s other items stay the lead’s', () => {
    const { t, subs } = make();
    t.handle(...item('item/completed', collab('spawnAgent', { receiverThreadIds: ['kid'] })));
    expect(t.handle(...item('item/completed', { type: 'agentMessage', id: 'm', text: 'hi' }))).toBe(false);
    expect(t.handle('turn/completed', { threadId: lead, turn: { id: 't1', status: 'completed' } })).toBe(false);
    t.handle(...item('item/completed', collab('closeAgent', { agentsStates: { kid: { status: 'errored', message: null } } })));
    expect(subs.at(-1)).toEqual({ id: 'kid', phase: 'done', failed: true });
  });

  it('multi_agent_v2’s subAgentActivity starts and ends one too', () => {
    const { t, subs } = make();
    t.handle(...item('item/completed', { type: 'subAgentActivity', id: 'a1', kind: 'started', agentThreadId: 'kid', agentPath: '/root/reviewer' }));
    t.handle(...item('item/completed', { type: 'subAgentActivity', id: 'a2', kind: 'interrupted', agentThreadId: 'kid', agentPath: '/root/reviewer' }));
    expect(subs).toEqual([
      { id: 'kid', phase: 'start', title: 'reviewer', kind: 'agent' },
      { id: 'kid', phase: 'done', failed: true },
    ]);
  });

  it('notifications before the run’s thread is known are left alone; finish ends the ones still working', () => {
    const { t, subs } = make();
    t.lead = undefined;
    expect(t.handle('turn/started', { threadId: 'x', turn: { id: 'u' } })).toBe(false);
    t.lead = lead;
    t.handle('thread/started', { thread: { id: 'kid', parentThreadId: lead, agentNickname: 'Ada', agentRole: null } });
    t.handle('turn/started', { threadId: 'kid', turn: { id: 'u1' } });
    expect(t.running()).toEqual([{ threadId: 'kid', turnId: 'u1' }]);
    t.finish(true);
    expect(subs).toEqual([
      { id: 'kid', phase: 'start', title: 'Ada', kind: 'agent' },
      { id: 'kid', phase: 'done', failed: true },
    ]);
  });

  it('titles read like Claude’s “type · description”', () => {
    expect(subAgentTitle({ nickname: 'Darwin', role: 'explorer', prompt: 'Find it' })).toBe('Darwin (explorer) · Find it');
    expect(subAgentTitle({})).toBe('sub-agent');
  });
});
