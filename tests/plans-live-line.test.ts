import { describe, expect, it } from 'vitest';
import { liveFrom } from '../src/core/plans/progress.js';
import { pulseOf, pulseWords } from '../src/core/plans/watchdog.js';
import { type LogItem, Store, initialState } from '../src/core/store.js';

/** A task card's live line (KLD-55): what its Claude does now, from the run's events as the store keeps them. */

const channel = 'ws:task';
const T0 = 1_000_000;

function conversation() {
  const store = new Store(initialState('room'));
  const event = (requestId: string, kind: 'queued' | 'started' | 'tool' | 'text' | 'progress' | 'sub' | 'done', text: string, ts: number): void =>
    store.dispatch({ type: 'agent_event', owner: 'p-me', requestId, requester: 'p-me', event: kind, text, ts, channel });
  const live = () => liveFrom({ ...store.getState(), questions: [], approvals: [] });
  const pulse = () => pulseOf(live().run?.(channel), false, undefined);
  /** The card's line, `at` ms after the start. */
  const line = (at: number) => pulseWords(pulse(), T0 + at).sub;
  return { store, event, live, pulse, line };
}

describe('the live line says what Claude does now', () => {
  it('thinking before its first step, then the step, then thinking once the step returns', () => {
    const c = conversation();
    c.event('r1', 'started', '', T0);
    expect(c.line(3000)).toBe('Thinking · 3s');
    c.event('r1', 'tool', 'Read src/auth.ts', T0 + 5000);
    expect(c.line(7000)).toBe('Read src/auth.ts · 2s');
    // Its tools came back (the runner's empty progress): it thinks about what's next, not still "Read".
    c.event('r1', 'progress', '', T0 + 8000);
    expect(c.pulse()).toEqual({ kind: 'working', step: 'Thinking', since: T0 + 8000 });
    expect(c.line(10_000)).toBe('Thinking · 2s');
    // A new tool starts: its name at once, timed from then.
    c.event('r1', 'tool', 'Bash npm test', T0 + 12_000);
    expect(c.pulse()).toMatchObject({ kind: 'command', step: 'Running npm test', since: T0 + 12_000 });
  });

  it('writing once words follow the step, timed from the first words', () => {
    const c = conversation();
    c.event('r1', 'started', '', T0);
    c.event('r1', 'tool', 'Edit src/a.ts', T0 + 1000);
    c.event('r1', 'text', 'Done with a.ts.', T0 + 4000);
    expect(c.line(6000)).toBe('Writing · 2s');
    c.event('r1', 'text', 'Now b.ts.', T0 + 5000);
    expect(c.pulse()).toMatchObject({ step: 'Writing', since: T0 + 4000 });
    c.event('r1', 'tool', 'Edit src/b.ts', T0 + 7000);
    expect(c.line(8000)).toBe('Edit src/b.ts · 1s');
  });

  it("a command's count keeps it in the step; a sub-agent moving doesn't make it a new one", () => {
    const c = conversation();
    c.event('r1', 'started', '', T0);
    c.event('r1', 'tool', 'Bash npx playwright test', T0 + 1000);
    c.event('r1', 'progress', '137/215', T0 + 60_000);
    expect(c.pulse()).toMatchObject({ kind: 'command', step: 'Running npx playwright test', progress: '137/215', since: T0 + 1000 });
    c.event('r1', 'sub', JSON.stringify({ id: 's1', phase: 'start', title: 'explore' }), T0 + 61_000);
    expect(c.pulse()).toMatchObject({ kind: 'command', since: T0 + 1000 });
  });
});

describe('the live line with older peers and sub-agents (KLD-66)', () => {
  it("an older peer's run (no empty progress after a step) names the step, timed from when it last did something", () => {
    const c = conversation();
    c.event('r1', 'started', '', T0);
    c.event('r1', 'tool', 'Read src/auth.ts', T0 + 1000);
    expect(c.line(3000)).toBe('Read src/auth.ts · 2s');
    // A sub-agent of an earlier step reports after this step (no count, no sub-agent left open): not still this step's time.
    c.event('r1', 'sub', JSON.stringify({ id: 's0', phase: 'done' }), T0 + 9000);
    expect(c.pulse()).toEqual({ kind: 'working', step: 'Read src/auth.ts', since: T0 + 9000 });
    expect(c.line(10_000)).toBe('Read src/auth.ts · 1s');
  });

  it('a sub-agent still at work keeps the run in its step, not Thinking', () => {
    const c = conversation();
    c.event('r1', 'started', '', T0);
    c.event('r1', 'tool', 'Grep auth', T0 + 1000);
    c.event('r1', 'sub', JSON.stringify({ id: 's1', phase: 'start', title: 'explore' }), T0 + 1500);
    // An older runner says its tools returned while the sub-agent still runs.
    c.event('r1', 'progress', '', T0 + 3000);
    expect(c.pulse()).toEqual({ kind: 'working', step: 'Grep auth', since: T0 + 1000 });
    c.event('r1', 'sub', JSON.stringify({ id: 's1', phase: 'step', step: 'Read a.ts' }), T0 + 5000);
    expect(c.line(6000)).toBe('Grep auth · 5s');
    // The sub-agent is back: Claude thinks.
    c.event('r1', 'sub', JSON.stringify({ id: 's1', phase: 'done' }), T0 + 7000);
    c.event('r1', 'progress', '', T0 + 7000);
    expect(c.line(9000)).toBe('Thinking · 2s');
    // Words still say Writing with a sub-agent open.
    c.event('r1', 'sub', JSON.stringify({ id: 's2', phase: 'start', title: 'tests' }), T0 + 10_000);
    c.event('r1', 'text', 'Waiting for the tests agent.', T0 + 11_000);
    expect(c.pulse()).toMatchObject({ step: 'Writing', since: T0 + 11_000 });
  });
});

describe('liveFrom reads the newest run', () => {
  it('a newer run wins over an older one still marked running, wherever it sits in the log', () => {
    const c = conversation();
    c.event('r1', 'started', '', T0);
    c.event('r1', 'tool', 'Read old.ts', T0 + 1000);
    c.event('r2', 'started', '', T0 + 2000);
    c.event('r2', 'tool', 'Read new.ts', T0 + 3000);
    expect(c.live().run?.(channel)?.requestId).toBe('r2');
    expect(c.live().step?.(channel)).toBe('Read new.ts');
    // The older run moves again: it's the one doing something now.
    c.event('r1', 'tool', 'Read older.ts', T0 + 4000);
    expect(c.live().run?.(channel)?.requestId).toBe('r1');
  });

  it('a message queued behind the run is waiting, not the run', () => {
    const c = conversation();
    c.event('r1', 'started', '', T0);
    c.event('r1', 'tool', 'Bash npm test', T0 + 1000);
    c.event('q1', 'queued', 'FYI', T0 + 2000);
    expect(c.live().run?.(channel)?.requestId).toBe('r1');
    expect(c.live().waiting?.(channel)).toHaveLength(1);
  });

  it("live events count before the conversation's history is loaded, and loading it keeps them", () => {
    const c = conversation();
    c.event('r9', 'started', '', T0);
    c.event('r9', 'tool', 'Read live.ts', T0 + 1000);
    expect(c.live().run?.(channel)?.step).toBe('Read live.ts');
    // The saved history arrives later (the daemon merges the live items in after it): the live run is still the one shown.
    const live = c.store.getState().log.filter((l) => l.channel === channel);
    const saved = { id: 'p-me:r0', type: 'agent', requestId: 'r0', owner: 'p-me', ownerName: 'me', requesterName: 'me', status: 'done', text: 'old', steps: ['Read saved.ts'], subagents: [], channel, ts: T0 - 60_000, lastAt: T0 - 50_000 } as unknown as LogItem;
    c.store.dispatch({ type: 'history', channel, items: [saved, ...live] });
    expect(c.live().run?.(channel)?.requestId).toBe('r9');
    expect(c.line(2000)).toBe('Read live.ts · 1s');
  });
});
