import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput, FollowUp, LiveStatus, Steer } from '../src/agent/types.js';
import { AgentHost, READS_AFTER_STEP, planSteer } from '../src/core/agent-host.js';
import { Store, initialState } from '../src/core/store.js';
import type { BodyOf } from '../src/protocol.js';
import { STEERED_IN } from '../src/shared/claude-notices.js';
import { waitFor } from './helpers.js';

const ME = 'me';
const MIN = 60_000;

/**
 * A pretend Claude. "slow" runs until finished (or stopped), offering a steer whose status the
 * test sets; anything else answers at once. `wedged`: a stopped run never ends (a dead process).
 */
function backend(opts: { wedged?: boolean; interrupts?: boolean; process?: boolean; hold?: Promise<void> } = {}) {
  const prompts: string[] = [];
  const steered: FollowUp[] = [];
  const interrupts: Array<{ followUp: FollowUp; note: string }> = [];
  /** What happened, in order: runs starting, and Claude Code processes killed. */
  const timeline: string[] = [];
  const live: { status: LiveStatus; finish?: () => void; procAlive: boolean } = { status: { lastEventAt: Date.now(), between: false }, procAlive: true };
  const agent: AgentBackend = {
    async run(input: AgentRunInput) {
      prompts.push(input.prompt);
      timeline.push(`run ${input.prompt}`);
      if (input.prompt !== 'slow') return `did ${input.prompt}`;
      if (opts.process)
        input.onProcess?.({
          pid: 4242,
          alive: () => live.procAlive,
          kill: async () => {
            timeline.push('killed slow');
            live.procAlive = false;
          },
        });
      return new Promise<string>((resolve, reject) => {
        input.signal.addEventListener('abort', () => (opts.wedged ? undefined : reject(new Error('aborted'))));
        const steer: Steer = Object.assign(
          (f: FollowUp) => {
            steered.push(f);
            return true;
          },
          {
            status: () => live.status,
            interrupt: async (followUp: FollowUp, note: string) => {
              interrupts.push({ followUp, note });
              await opts.hold;
              if (opts.interrupts === false) return false;
              // The interrupted turn ends saying why; the message's turn follows at once.
              input.onEvent('text', note);
              followUp.onStart?.();
              followUp.onDone(`read ${followUp.prompt}`);
              return true;
            },
          },
        );
        input.onSteer?.(steer);
        live.finish = () => {
          input.onSteer?.(undefined);
          resolve('slow done');
        };
      });
    },
  };
  return { agent, prompts, steered, interrupts, live, timeline };
}

function host(agent: AgentBackend) {
  const store = new Store(initialState('room', 'auto'));
  const toasts: string[] = [];
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
  const ask = (requestId: string, prompt: string, urgent = false, from = ME): Promise<void> =>
    h.onAgentRequest(from, { kind: 'agent_request', requestId, prompt, viaAgent: false, channel: 'room', urgent, plan: false });
  const card = (requestId: string) => store.getState().log.find((l) => l.type === 'agent' && l.requestId === requestId) as Extract<ReturnType<Store['getState']>['log'][number], { type: 'agent' }> | undefined;
  return { h, store, ask, card, toasts };
}

/** Claude working on "slow" (r1), with "later" (r2) queued behind it. */
async function busy(b: ReturnType<typeof backend>) {
  const t = host(b.agent);
  await t.ask('r1', 'slow');
  await waitFor(() => Boolean(b.live.finish));
  await t.ask('r2', 'later');
  await waitFor(() => t.card('r2')?.status === 'queued');
  return t;
}

describe('planSteer', () => {
  const now = 100 * MIN;
  it('steers into a short step, interrupts a long tool or a quiet run, restarts a dead one', () => {
    expect(planSteer(undefined, now)).toEqual({ kind: 'steer' });
    expect(planSteer({ tool: { label: 'Read src/a.ts', since: now - 5_000 }, lastEventAt: now - 5_000, between: false }, now)).toEqual({ kind: 'steer' });
    expect(planSteer({ tool: { label: 'npx playwright test', since: now - 12 * MIN }, lastEventAt: now - 12 * MIN, between: false }, now)).toEqual({
      kind: 'interrupt',
      note: 'Interrupted: npx playwright test (12m) to read your message',
    });
    expect(planSteer({ lastEventAt: now - 90_000, between: false }, now).kind).toBe('interrupt');
    expect(planSteer({ lastEventAt: now - 6 * MIN, between: false }, now).kind).toBe('restart');
    // Between turns (waiting on background agents), a message starts a turn at once.
    expect(planSteer({ lastEventAt: now - 30 * MIN, between: true }, now)).toEqual({ kind: 'steer' });
  });

  it('a run whose Claude Code is gone is dead, however recently it spoke', () => {
    expect(planSteer({ lastEventAt: now - 1_000, between: false, alive: false }, now).kind).toBe('restart');
    expect(planSteer({ lastEventAt: now - 1_000, between: true, alive: false }, now).kind).toBe('restart');
    expect(planSteer({ lastEventAt: now - 1_000, between: false, alive: true }, now).kind).toBe('steer');
  });

  it('a quiet spell spent thinking says so, and is never taken for dead', () => {
    expect(planSteer({ lastEventAt: now - 90_000, between: false, thinking: true }, now)).toEqual({ kind: 'interrupt', note: 'Interrupted: Claude was thinking for 2m; reading your message' });
    expect(planSteer({ lastEventAt: now - 90_000, between: false }, now)).toEqual({ kind: 'interrupt', note: 'Interrupted: Claude was quiet for 2m; reading your message' });
    expect(planSteer({ lastEventAt: now - 8 * MIN, between: false, thinking: true }, now).kind).toBe('interrupt');
  });
});

describe('Steer on a queued message', () => {
  it('during a long tool: interrupts it and the message is answered at once', async () => {
    const b = backend();
    const t = await busy(b);
    b.live.status = { tool: { label: 'npx playwright test', since: Date.now() - 12 * MIN }, lastEventAt: Date.now() - 12 * MIN, between: false };
    expect(t.h.promote('r2')).toBe(true);
    // Out of the queue at once, into the chat.
    expect(t.card('r2')?.status).not.toBe('queued');
    await waitFor(() => t.card('r2')?.status === 'done');
    expect(t.card('r2')?.text).toBe('read later');
    expect(b.interrupts.map((i) => i.note)).toEqual(['Interrupted: npx playwright test (12m) to read your message']);
    expect(t.card('r1')?.text).toContain('Interrupted: npx playwright test (12m) to read your message');
    expect(b.steered).toEqual([]);
    b.live.finish!();
    await t.h.idle('room');
    expect(b.prompts).toEqual(['slow']);
  });

  it('during a short step: steered in, and the card says Claude reads it after this step', async () => {
    const b = backend();
    const t = await busy(b);
    b.live.status = { tool: { label: 'Read src/a.ts', since: Date.now() - 2_000 }, lastEventAt: Date.now() - 2_000, between: false };
    expect(t.h.promote('r2')).toBe(true);
    expect(b.steered.map((f) => f.prompt)).toEqual(['later']);
    expect(b.interrupts).toEqual([]);
    expect(t.card('r2')).toMatchObject({ status: 'started', text: READS_AFTER_STEP });
    b.steered[0]!.onFolded?.();
    expect(t.card('r2')).toMatchObject({ status: 'done', text: STEERED_IN });
    b.live.finish!();
    await t.h.idle('room');
  });

  it('dead run: stops it and starts a fresh turn with the message', async () => {
    const b = backend();
    const t = await busy(b);
    b.live.status = { lastEventAt: Date.now() - 6 * MIN, between: false };
    expect(t.h.promote('r2')).toBe(true);
    await waitFor(() => t.card('r2')?.status === 'done');
    expect(t.card('r2')?.text).toBe('did later');
    expect(t.card('r1')).toMatchObject({ status: 'error' });
    expect(t.card('r1')?.text).toMatch(/gone quiet for 6m/);
    expect(b.prompts).toEqual(['slow', 'later']);
  });

  it('dead run that never ends when stopped: left behind, the message still runs', async () => {
    const b = backend({ wedged: true });
    const t = await busy(b);
    b.live.status = { lastEventAt: Date.now() - 6 * MIN, between: false };
    expect(t.h.promote('r2')).toBe(true);
    await waitFor(() => t.card('r2')?.status === 'done', 9_000);
    expect(b.prompts).toEqual(['slow', 'later']);
  }, 12_000);

  it('dead run with its Claude Code still running: killed before the message’s run starts', async () => {
    const b = backend({ wedged: true, process: true });
    const t = await busy(b);
    b.live.status = { lastEventAt: Date.now() - 6 * MIN, between: false };
    expect(t.h.promote('r2')).toBe(true);
    await waitFor(() => t.card('r2')?.status === 'done', 9_000);
    expect(b.timeline).toEqual(['run slow', 'killed slow', 'run later']);
  }, 12_000);

  it('a run whose Claude Code is gone: restarted at once, without waiting out the grace', async () => {
    const b = backend({ wedged: true, process: true });
    const t = await busy(b);
    b.live.procAlive = false;
    b.live.status = { lastEventAt: Date.now(), between: false, alive: false };
    expect(t.h.promote('r2')).toBe(true);
    await waitFor(() => t.card('r2')?.status === 'done', 1_000);
    expect(t.card('r1')?.text).toMatch(/ended without finishing/);
    expect(b.prompts).toEqual(['slow', 'later']);
  });

  it('interrupt failing: the message is not lost, it goes first and the run is stopped for it', async () => {
    const b = backend({ interrupts: false });
    const t = await busy(b);
    b.live.status = { tool: { label: 'npx playwright test', since: Date.now() - 12 * MIN }, lastEventAt: Date.now(), between: false };
    const seen: string[] = [];
    t.store.subscribe(() => {
      const status = t.card('r2')?.status;
      if (status && seen.at(-1) !== status) seen.push(status);
    });
    expect(t.h.promote('r2')).toBe(true);
    await waitFor(() => t.card('r2')?.status === 'done');
    // Back in line said so on its card before it ran.
    expect(seen).toEqual(['started', 'queued', 'started', 'done']);
    expect(t.card('r2')?.text).toBe('did later');
    expect(b.prompts).toEqual(['slow', 'later']);
    expect(t.toasts.some((x) => x.includes('didn’t stop when asked'))).toBe(true);
  });

  it('steered in but the run ends before reading it: back in line, then answered', async () => {
    const b = backend();
    const t = await busy(b);
    expect(t.h.promote('r2')).toBe(true);
    // The run ends without Claude reading it (as the runner fails what it hadn't got to).
    b.steered[0]!.onError('Claude finished before getting to this message');
    expect(t.card('r2')?.status).toBe('queued');
    expect(t.toasts.at(-1)).toMatch(/runs next/);
    b.live.finish!();
    await waitFor(() => t.card('r2')?.status === 'done');
    expect(t.card('r2')?.text).toBe('did later');
  });

  it('never a silent no-op: someone else’s message or one that already left says why', async () => {
    const b = backend();
    const t = await busy(b);
    await t.ask('r3', 'theirs', false, 'bob');
    expect(t.h.promote('r3')).toBe(false);
    expect(t.toasts.at(-1)).toMatch(/Only the person who sent a message can steer it/);
    expect(t.h.promote('nope')).toBe(false);
    expect(t.toasts.at(-1)).toMatch(/isn’t waiting any more/);
    b.live.finish!();
    await t.h.idle('room');
  });
});

describe('two steers in a row', () => {
  it('the second waits for the first one’s interrupt: answered in the order steered, no toast', async () => {
    let release!: () => void;
    const b = backend({ hold: new Promise<void>((r) => (release = r)) });
    const t = await busy(b);
    await t.ask('r3', 'after that');
    b.live.status = { tool: { label: 'npm test', since: Date.now() - 3 * MIN }, lastEventAt: Date.now() - 3 * MIN, between: false };
    expect(t.h.promote('r2')).toBe(true);
    expect(t.h.promote('r3')).toBe(true);
    // Only the first interrupts; the second hasn't hard-stopped the run.
    expect(b.interrupts.map((i) => i.followUp.prompt)).toEqual(['later']);
    // The run is in the first message's turn now: the second goes into it.
    b.live.status = { lastEventAt: Date.now(), between: false };
    release();
    await waitFor(() => b.steered.length === 1);
    expect(b.steered.map((f) => f.prompt)).toEqual(['after that']);
    expect(t.card('r2')?.status).toBe('done');
    expect(t.card('r3')?.text).toBe(READS_AFTER_STEP);
    expect(t.toasts.filter((x) => x.includes('didn’t stop'))).toEqual([]);
    b.live.finish!();
    await t.h.idle('room');
    expect(b.prompts).toEqual(['slow']);
  });

  it('the first interrupt failing: both go first in line, in the order steered', async () => {
    let release!: () => void;
    const b = backend({ interrupts: false, hold: new Promise<void>((r) => (release = r)) });
    const t = await busy(b);
    await t.ask('r3', 'after that');
    b.live.status = { tool: { label: 'npm test', since: Date.now() - 3 * MIN }, lastEventAt: Date.now(), between: false };
    t.h.promote('r3');
    t.h.promote('r2');
    release();
    await waitFor(() => t.card('r2')?.status === 'done' && t.card('r3')?.status === 'done');
    expect(b.prompts).toEqual(['slow', 'after that', 'later']);
    expect(t.toasts.filter((x) => x.includes('didn’t stop'))).toHaveLength(1);
  });
});

describe('the abort grace is only for steers', () => {
  it('Stop never leaves a run behind: the next message waits for it to end', async () => {
    const b = backend({ wedged: true, process: true });
    const t = await busy(b);
    t.h.stopRun('room');
    await t.ask('r3', 'next');
    await new Promise((r) => setTimeout(r, 5_500));
    // Its Claude Code was killed after the grace, but the run is waited for, not left behind.
    expect(b.timeline).toEqual(['run slow', 'killed slow']);
    expect(b.prompts).toEqual(['slow']);
    b.live.finish!();
    await waitFor(() => t.card('r3')?.status === 'done');
  }, 9_000);

  it('a run that ends normally is never killed', async () => {
    const b = backend({ process: true });
    const t = await busy(b);
    b.live.finish!();
    await waitFor(() => t.card('r2')?.status === 'done');
    expect(b.timeline).toEqual(['run slow', 'run later']);
  });
});

describe('urgent sends (⌥↩) behave the same', () => {
  it('interrupt a long tool and are answered at once', async () => {
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'slow');
    await waitFor(() => Boolean(b.live.finish));
    b.live.status = { tool: { label: 'npm test', since: Date.now() - 3 * MIN }, lastEventAt: Date.now(), between: false };
    await t.ask('r2', 'stop that', true);
    await waitFor(() => t.card('r2')?.status === 'done');
    expect(b.interrupts.map((i) => i.note)).toEqual(['Interrupted: npm test (3m) to read your message']);
    b.live.finish!();
    await t.h.idle('room');
  });

  it('steer into a short step, saying so', async () => {
    const b = backend();
    const t = host(b.agent);
    await t.ask('r1', 'slow');
    await waitFor(() => Boolean(b.live.finish));
    await t.ask('r2', 'use pnpm', true);
    expect(b.steered.map((f) => f.prompt)).toEqual(['use pnpm']);
    expect(t.toasts).toContain(READS_AFTER_STEP);
    b.live.finish!();
    await t.h.idle('room');
  });
});

describe('the watchdog taking over a run (KLD-37 on KLD-43’s stop)', () => {
  it('a wedged run is killed, never left beside the wake; queued and unread steered messages all come back, in order', async () => {
    const b = backend({ wedged: true, process: true });
    const t = await busy(b);
    await t.ask('r3', 'after that');
    // r2 is steered into the running turn (a short step), not read yet.
    b.live.status = { lastEventAt: Date.now(), between: false };
    expect(t.h.promote('r2')).toBe(true);
    expect(t.card('r2')?.text).toBe(READS_AFTER_STEP);
    const taking = t.h.takeOver('room');
    // The stopped run hands back what it hadn't read (as the runner fails it): back in line, not started.
    b.steered[0]!.onError('Claude’s run ended before it read this');
    const waited = await taking;
    expect(waited).toEqual(['later', 'after that']);
    // Killed before the wake could start: no second Claude in the folder, and nothing ran in between.
    expect(b.timeline).toEqual(['run slow', 'killed slow']);
    expect(t.card('r1')?.text).toBe('Stopped by Klaud to wake Claude');
    expect(t.card('r2')?.text).toBe('Sent along with Klaud’s wake-up');
    expect(t.card('r3')?.text).toBe('Sent along with Klaud’s wake-up');
    expect(t.h.runningIn('room')).toBe(false);
  }, 9_000);

  it('a steer still interrupting lands first; someone else’s request keeps its place and runs after', async () => {
    let release!: () => void;
    const b = backend({ hold: new Promise<void>((r) => (release = r)) });
    const t = await busy(b);
    await t.ask('r3', 'theirs', false, 'bob');
    b.live.status = { tool: { label: 'npm test', since: Date.now() - 3 * MIN }, lastEventAt: Date.now() - 3 * MIN, between: false };
    expect(t.h.promote('r2')).toBe(true);
    const taking = t.h.takeOver('room');
    release();
    const waited = await taking;
    // r2 was answered by its interrupt before the run stopped: nothing of it waits.
    expect(t.card('r2')?.text).toBe('read later');
    expect(waited).toEqual([]);
    await waitFor(() => t.card('r3')?.status === 'done');
    expect(b.prompts).toEqual(['slow', 'theirs']);
  });
});
