import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardState, Issue } from '../src/core/board/model.js';
import type { BoardWork } from '../src/core/board/work.js';
import type { Plan } from '../src/core/plans/model.js';
import { PlanPilot, plansByChannel } from '../src/core/plans/pilot.js';
import type { Plans } from '../src/core/plans/plans.js';
import { Store, initialState } from '../src/core/store.js';
import { lagLine, watchEventLoop } from '../src/daemon/lag.js';

const plan = (id: string, home: string, issueIds: string[] = []): Plan =>
  ({ id, home, status: 'draft', body: { title: id, milestones: [{ id: 'm', title: 'm', tasks: issueIds.map((issueId, i) => ({ id: `t${i}`, title: issueId, issueId })) }] } }) as unknown as Plan;
const issue = (id: string, worktrees: string[]): Issue => ({ id, worktrees }) as unknown as Issue;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('which plans a conversation belongs to', () => {
  it('a plan’s home, and the worktrees of its tasks', () => {
    const plans = [plan('A', 'ws:homeA', ['i1']), plan('B', 'ws:homeB', ['i2'])];
    const board = { issues: [issue('i1', ['w1', 'w1b']), issue('i2', ['w2']), issue('loose', ['w3'])] } as unknown as BoardState;
    const map = plansByChannel(plans, board);
    expect([...(map.get('ws:homeA') ?? [])]).toEqual(['A']);
    expect([...(map.get('ws:w1') ?? [])]).toEqual(['A']);
    expect([...(map.get('ws:w1b') ?? [])]).toEqual(['A']);
    expect([...(map.get('ws:w2') ?? [])]).toEqual(['B']);
    expect(map.get('ws:w3')).toBeUndefined();
  });
});

describe('the plan pilot hears runs', () => {
  let pilot: PlanPilot | undefined;
  afterEach(() => {
    pilot?.stop();
    vi.restoreAllMocks();
  });

  function setup() {
    const store = new Store(initialState('room'));
    const plans = [plan('A', 'ws:homeA'), plan('B', 'ws:homeB')];
    const ticks: Array<string[] | 'all'> = [];
    vi.spyOn(PlanPilot.prototype, 'tick').mockImplementation((only?: ReadonlySet<string>) => void ticks.push(only ? [...only].sort() : 'all'));
    const fakePlans = { list: () => plans, need: (id: string) => plans.find((p) => p.id === id)! } as unknown as Plans;
    pilot = new PlanPilot({ store, plans: fakePlans, work: {} as BoardWork, askClaude: () => undefined, system: () => undefined, delayMs: 10, eventMs: 150 });
    let n = 0;
    const event = (channel: string): void => store.dispatch({ type: 'agent_event', owner: 'me', requestId: `r${n++}`, requester: 'me', event: 'started', text: '', ts: Date.now(), channel });
    return { store, ticks, event };
  }

  it('looks only at the plans whose conversations had events, and at none for other conversations', async () => {
    const t = setup();
    await wait(30);
    t.ticks.length = 0; // the first look, at start
    t.event('ws:somewhere-else');
    await wait(60);
    expect(t.ticks).toEqual([]);
    t.event('ws:homeB');
    await wait(200);
    expect(t.ticks).toEqual([['B']]);
  });

  it('a stream of events looks at most once per eventMs; anything else looks at every plan soon', async () => {
    const t = setup();
    await wait(30);
    t.ticks.length = 0;
    const began = Date.now();
    for (let i = 0; i < 30; i++) {
      t.event(i % 2 ? 'ws:homeA' : 'ws:homeB');
      await wait(5);
    }
    // Windows' timers tick every ~15 ms, so the same stream lasts three times longer there.
    const streamed = Date.now() - began;
    await wait(250);
    expect(t.ticks.length).toBeLessThanOrEqual(Math.floor(streamed / 150) + 1);
    expect(t.ticks.flat().filter((x) => x !== 'all').sort()).toEqual(expect.arrayContaining(['A', 'B']));
    t.ticks.length = 0;
    t.store.dispatch({ type: 'question_add', question: { id: 'q', channel: 'ws:x', from: 'me', name: 'me', text: '?', ts: 0, options: [] } } as never);
    await wait(40);
    expect(t.ticks).toEqual(['all']);
  });
});

describe('event-loop delay', () => {
  it('says p50 and p95 in milliseconds', () => {
    expect(lagLine({ p50: 1.234, p95: 12.5, max: 40 })).toBe('event loop delay: p50 1.2 ms, p95 12.5 ms, max 40.0 ms');
  });

  it('is logged every period', async () => {
    const lines: string[] = [];
    const stop = watchEventLoop((l) => void lines.push(l), 60);
    await wait(200);
    stop();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatch(/^event loop delay: p50 [\d.]+ ms, p95 [\d.]+ ms/);
  });

  it('reads how late the loop ran, not the sampling interval (an idle loop is near 0)', async () => {
    const lines: string[] = [];
    const stop = watchEventLoop((l) => void lines.push(l), 300);
    await wait(350);
    stop();
    const p50 = Number(/p50 ([\d.]+) ms/.exec(lines[0] ?? '')?.[1]);
    expect(p50).toBeLessThan(15);
  });
});
