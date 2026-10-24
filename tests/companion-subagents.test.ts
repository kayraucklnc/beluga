import { describe, expect, it } from 'vitest';
import { PhoneCalls } from '../src/companion/calls.js';
import { PHONE } from '../src/companion/coverage.js';
import { RefTable } from '../src/companion/files.js';
import { COMPANION_PROTO, ConvView, SINCE, SubAgentDetailView } from '../src/companion/protocol.js';
import { reportOf, subAgentDetail } from '../src/companion/sub-agent.js';
import { type ViewContext, viewOf } from '../src/companion/views.js';
import type { CcAgent, CcSteps } from '../src/core/claude-code/model.js';
import { type Action, type DomainState, Store, initialState } from '../src/core/store.js';
import { COMPANION_API } from '../src/ipc/companion-api.js';
import type { StepRecord } from '../src/shared/steps.js';

/**
 * Sub-agents on the phone (BLG-110): the conversation view says which run and how they're doing
 * (Claude Code's word wins when it still sees one working), and `companion.subAgent` opens one:
 * its activity in words and, once it ended, its report with code stripped.
 */

const ME = 'me0000000000000000000000000000me';
const T0 = 1_760_000_000_000;

function state(agents: CcAgent[], events: Array<[Extract<Action, { type: 'agent_event' }>['event'], string, number]>): DomainState {
  const store = new Store(initialState('room'));
  const run = (a: Action): void => store.dispatch(a);
  run({ type: 'identity', selfId: ME, isHost: true, home: '/Users/k' });
  run({ type: 'welcome', self: { peerId: ME, name: 'kayra', shares: [], agent: true } });
  run({
    type: 'projects',
    projects: [{ id: 'p1', name: 'landing', root: '/Users/k/landing', base: 'main', workspaces: [{ id: 'w1', projectRoot: '/Users/k/landing', projectId: 'p1', name: 'tests', path: '/Users/k/landing/.worktrees/w1', kind: 'worktree', createdAt: T0, external: false }] }] as never,
  });
  for (const [event, text, ts] of events) run({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event, text, ts, channel: 'ws:w1', itemId: 'i-r1' });
  run({ type: 'claude_code', sessions: [{ id: 'ccs1', title: 'tests', cwd: '/Users/k/landing/.worktrees/w1', projectId: 'p1', workspaceId: 'w1', status: 'working', lastAt: T0 + 20, steps: 9, own: true, agents }] });
  return store.getState();
}

const ctx = (): ViewContext => ({ refs: new RefTable(() => 'ref00001'), mac: { name: 'Mac', version: '1' } });

const sub = (id: string, phase: string, extra: object = {}) => JSON.stringify({ id, phase, ...extra });

const EVENTS: Array<[Extract<Action, { type: 'agent_event' }>['event'], string, number]> = [
  ['started', '', T0 + 1],
  ['sub', sub('call1', 'start', { title: 'general-purpose · Check the webhooks' }), T0 + 2],
  ['sub', sub('call1', 'step', { step: 'Grep "retry"' }), T0 + 3],
  ['sub', sub('call1', 'done'), T0 + 6],
  ['sub', sub('call2', 'start', { title: 'Explore · Look at the retry queue' }), T0 + 4],
  ['sub', sub('call2', 'step', { step: 'Read src/hooks/retry-queue.ts' }), T0 + 5],
  // The turn ends while call2 goes on in the background: the run counts every sub-agent done.
  ['done', 'Started two agents.', T0 + 7],
];

const AGENTS: CcAgent[] = [
  { id: 'ag1', toolUseId: 'call1', description: 'Check the webhooks', type: 'general-purpose', background: false, status: 'finished', startedAt: T0 + 2, endedAt: T0 + 6, lastAt: T0 + 6, steps: 1 },
  { id: 'ag2', toolUseId: 'call2', description: 'Look at the retry queue', type: 'Explore', background: true, status: 'running', startedAt: T0 + 4, lastAt: T0 + 20, step: 'Running npx vitest run tests/retry.test.ts', steps: 3 },
];

const record = (r: Partial<StepRecord> & Pick<StepRecord, 'id' | 'title'>): StepRecord => ({ kind: 'tool', status: 'done', startedAt: T0 + 3, ...r });

describe('sub-agents in the conversation view', () => {
  it('stays running while Claude Code sees it working, though its turn ended', () => {
    const view = ConvView.parse(viewOf(state(AGENTS, EVENTS), ctx(), 'conv:ws:w1'));
    const turn = view.turns.find((t) => t.who === 'claude')!;
    expect(turn.subagents?.map((a) => [a.id, a.status])).toEqual([
      ['call1', 'done'],
      ['call2', 'running'],
    ]);
    // Its live step in the phone's words (no command line), with when it started.
    expect(turn.subagents?.[1]).toMatchObject({ step: 'Running the tests', tool: 'test', startedAt: T0 + 4, type: 'Explore' });
    expect(turn.subagents?.[0]).toMatchObject({ endTs: T0 + 6 });
    expect(JSON.stringify(turn.subagents)).not.toMatch(/vitest|src\/hooks/);
  });

  it('a sub-agent Claude Code no longer sees working stays as its run said', () => {
    const view = ConvView.parse(viewOf(state([AGENTS[0]!, { ...AGENTS[1]!, status: 'finished', endedAt: T0 + 30 }], EVENTS), ctx(), 'conv:ws:w1'));
    expect(view.turns.find((t) => t.who === 'claude')!.subagents?.map((a) => a.status)).toEqual(['done', 'done']);
  });
});

describe('companion.subAgent', () => {
  const st = state(AGENTS, EVENTS);

  it('is the phone’s, typed, and new in 1.10', () => {
    expect(PHONE['companion.subAgent']).toBe('phone');
    expect(PhoneCalls['companion.subAgent'].result).toBe(SubAgentDetailView);
    expect(SINCE.subAgent).toBe(10);
    expect(COMPANION_PROTO.minor).toBeGreaterThanOrEqual(SINCE.subAgent);
    const args = COMPANION_API['companion.subAgent'].args;
    expect(args.safeParse(['conv:ws:w1', 'i-r1', 'call1']).success).toBe(true);
    expect(args.safeParse(['chat:dm:x', 'i-r1', 'call1']).success).toBe(false);
    expect(args.safeParse(['conv:ws:w1', '', 'call1']).success).toBe(false);
  });

  it('a finished sub-agent: its steps in words from the turn’s records, and its report with code stripped', () => {
    const records = [
      record({ id: 'call1', tool: 'Agent', title: 'Agent Check the webhooks', startedAt: T0 + 2 }),
      record({ id: 's1', tool: 'Grep', title: 'Grep "retry"', parent: 'call1', startedAt: T0 + 3 }),
      record({ id: 's2', tool: 'Bash', title: 'Bash npm test -- --run', parent: 'call1', startedAt: T0 + 4 }),
      record({ id: 's3', tool: 'TodoWrite', title: 'TodoWrite', parent: 'call1', startedAt: T0 + 5 }),
      record({ id: 's4', tool: 'Read', title: 'Read src/x.ts', parent: 'call2', startedAt: T0 + 5 }),
    ];
    const report = 'The webhooks retry **three times**.\n\n```ts\nretry(3)\n```\n\nagentId: ag1 (for resuming)\n<usage>total_tokens: 1200\ntool_uses: 2</usage>';
    const out = SubAgentDetailView.parse(
      subAgentDetail(st, { steps: () => ({ steps: records, version: 1 }), step: (_c, _i, id) => (id === 'call1' ? { ...records[0]!, output: report } : undefined) }, 'conv:ws:w1', 'i-r1', 'call1'),
    );
    expect(out.timeline).toEqual([
      { tool: 'search', text: 'Searched for retry', at: T0 + 3 },
      { tool: 'test', text: 'Ran the tests', at: T0 + 4 },
    ]);
    expect(out.count).toBe(2);
    expect(out.result).toEqual({ text: 'The webhooks retry **three times**.\n\n[[code:0]]', code: [{ lang: 'ts', lines: 1 }] });
    expect(JSON.stringify(out)).not.toMatch(/retry\(3\)|agentId|total_tokens|--run/);
  });

  it('a background one: no report while it works; its steps from Claude Code’s transcript', () => {
    const transcript: CcSteps = {
      steps: [
        { seq: 1, ts: T0 + 5, kind: 'tool', tool: 'Read', text: 'Reading src/hooks/retry-queue.ts' },
        { seq: 2, ts: T0 + 6, kind: 'text', text: 'Looking at the queue.' },
        { seq: 3, ts: T0 + 8, kind: 'tool', tool: 'Bash', text: 'Running npx vitest run tests/retry.test.ts', status: 'running' },
      ],
      more: false,
    };
    const launched = record({ id: 'call2', tool: 'Agent', title: 'Agent Look at the retry queue', output: 'Async agent launched successfully. agentId: ag2' });
    const src = { steps: () => ({ steps: [launched], version: 1 }), step: () => launched, ccSteps: (s: string, a: string) => (s === 'ccs1' && a === 'ag2' ? transcript : undefined) };
    const live = SubAgentDetailView.parse(subAgentDetail(st, src, 'conv:ws:w1', 'i-r1', 'call2'));
    expect(live.timeline).toEqual([
      { tool: 'read', text: 'Reading retry-queue.ts', at: T0 + 5 },
      { tool: 'test', text: 'Running the tests', at: T0 + 8 },
    ]);
    expect(live.count).toBe(3);
    expect(live.result).toBeUndefined();
    // Once it ends, its last words are its report (the launch's "Async agent launched" isn't).
    const ended = state([AGENTS[0]!, { ...AGENTS[1]!, status: 'finished', endedAt: T0 + 30 }], EVENTS);
    const done: CcSteps = { ...transcript, steps: [...transcript.steps.slice(0, 2), { ...transcript.steps[2]!, status: 'done' }, { seq: 4, ts: T0 + 29, kind: 'text', text: 'The queue drops jobs after 3 tries:\n\n```js\nmax = 3\n```' }] };
    const out = SubAgentDetailView.parse(subAgentDetail(ended, { ...src, ccSteps: () => done }, 'conv:ws:w1', 'i-r1', 'call2'));
    expect(out.result).toEqual({ text: 'The queue drops jobs after 3 tries:\n\n[[code:0]]', code: [{ lang: 'js', lines: 1 }] });
  });

  it('without details (no records, no watcher): the steps the run sent; unknown: missing', () => {
    const throws = () => {
      throw new Error('no watcher');
    };
    const out = SubAgentDetailView.parse(subAgentDetail(st, { ccSteps: throws }, 'conv:ws:w1', 'i-r1', 'call1'));
    expect(out).toEqual({ id: 'call1', timeline: [{ tool: 'search', text: 'Searched for retry' }], count: 1 });
    expect(subAgentDetail(st, {}, 'conv:ws:w1', 'i-r1', 'nope')).toEqual({ id: 'nope', timeline: [], missing: true });
  });

  it('reads a report without Claude Code’s trailer', () => {
    expect(reportOf('Done.\nagentId: a1b2 (for resuming to continue)\n<usage>total_tokens: 5\nduration_ms: 9</usage>')).toBe('Done.');
  });
});
