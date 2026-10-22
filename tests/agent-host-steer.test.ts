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
function backend(opts: { wedged?: boolean; interrupts?: boolean } = {}) {
  const prompts: string[] = [];
  const steered: FollowUp[] = [];
  const interrupts: Array<{ followUp: FollowUp; note: string }> = [];
  const live: { status: LiveStatus; finish?: () => void } = { status: { lastEventAt: Date.now(), between: false } };
  const agent: AgentBackend = {
    async run(input: AgentRunInput) {
      prompts.push(input.prompt);
      if (input.prompt !== 'slow') return `did ${input.prompt}`;
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
  return { agent, prompts, steered, interrupts, live };
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

  it('interrupt failing: the message is not lost, it goes first and the run is stopped for it', async () => {
    const b = backend({ interrupts: false });
    const t = await busy(b);
    b.live.status = { tool: { label: 'npx playwright test', since: Date.now() - 12 * MIN }, lastEventAt: Date.now(), between: false };
    expect(t.h.promote('r2')).toBe(true);
    await waitFor(() => t.card('r2')?.status === 'done');
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
