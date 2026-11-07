import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDLERS } from '../src/ipc/handlers.js';
import { schedulesOf } from '../src/core/schedule/registry.js';
import { guestSchedule, scheduleView } from '../src/core/schedule/model.js';
import type { Schedule } from '../src/core/schedule/schema.js';
import { Body, type GuestSchedule } from '../src/protocol.js';
import { waitFor } from './helpers.js';
import { harness, type Harness, type Person } from './schedule-fakes.js';

const EVERY_MINUTE = { title: 'Check', prompt: 'Look at it', when: { kind: 'interval', minutes: 1 } } as const;
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));

let h: Harness;
let bob: Person;

beforeEach(async () => {
  h = await harness();
  h.launch();
  bob = await h.person('bob');
  await waitFor(() => h.store.getState().peers.length === 2 && bob.store.getState().peers.length === 2, 4000);
});
afterEach(async () => {
  await h.close();
});

const wsId = (channel: string) => channel.slice(3);
const seen = (p: Person, channel: string): readonly GuestSchedule[] => p.store.getState().sharedSchedules[wsId(channel)] ?? [];
const owner = () => schedulesOf(h.session)!;
const call = (session: Person['session'], method: keyof typeof HANDLERS, ...args: unknown[]): unknown => (HANDLERS[method] as (...a: unknown[]) => unknown)(session, ...args);
/** Count the schedule frames someone gets. */
function framesTo(p: Person): GuestSchedule[][] {
  const got: GuestSchedule[][] = [];
  p.client.on('message', (msg) => {
    if (msg.body.kind === 'ws_schedules') got.push([...msg.body.items]);
  });
  return got;
}

describe('a guest of a shared chat', () => {
  it('gets the list on joining, with title, sentence, prompt, next time and status', { timeout: 30_000 }, async () => {
    const channel = await h.chat();
    const made = owner().create(channel, EVERY_MINUTE);
    expect(h.session.sharing.invite(wsId(channel), bob.session.selfId, 'view', { quiet: true })).toBe(true);
    await waitFor(() => seen(bob, channel).length === 1, 4000);
    expect(seen(bob, channel)[0]).toEqual({ id: made.id, title: 'Check', prompt: 'Look at it', sentence: 'Every minute', status: 'never', enabled: true, next: h.clock.now + 60_000 });
  });

  it('gets each change, and an empty list when the last one goes', { timeout: 30_000 }, async () => {
    const channel = await h.chat();
    h.session.sharing.invite(wsId(channel), bob.session.selfId, 'view', { quiet: true });
    await waitFor(() => bob.store.getState().shared.length === 1, 4000);
    const made = owner().create(channel, EVERY_MINUTE);
    await waitFor(() => seen(bob, channel).length === 1, 4000);
    owner().setEnabled(made.id, false);
    await waitFor(() => seen(bob, channel)[0]?.status === 'paused', 4000);
    expect(seen(bob, channel)[0]).not.toHaveProperty('next');
    owner().remove(made.id);
    await waitFor(() => seen(bob, channel).length === 0, 4000);
  });

  it('never gets the list of a chat that is not shared with them', { timeout: 30_000 }, async () => {
    const got = framesTo(bob);
    const channel = await h.chat();
    owner().create(channel, EVERY_MINUTE);
    await pause();
    expect(got).toEqual([]);
    expect(seen(bob, channel)).toEqual([]);
  });

  it('stops getting updates once removed, and their list is gone', { timeout: 30_000 }, async () => {
    const channel = await h.chat();
    owner().create(channel, EVERY_MINUTE);
    h.session.sharing.invite(wsId(channel), bob.session.selfId, 'view', { quiet: true });
    await waitFor(() => seen(bob, channel).length === 1, 4000);
    const got = framesTo(bob);
    h.session.sharing.remove(wsId(channel), bob.session.selfId, true);
    await waitFor(() => bob.store.getState().shared.length === 0, 4000);
    expect(seen(bob, channel)).toEqual([]);
    owner().create(channel, { ...EVERY_MINUTE, title: 'Second' });
    await pause();
    expect(got).toEqual([]);
    expect(seen(bob, channel)).toEqual([]);
  });

  it('gets the list again when they come back to the room', { timeout: 30_000 }, async () => {
    const channel = await h.chat();
    owner().create(channel, EVERY_MINUTE);
    h.session.sharing.invite(wsId(channel), bob.session.selfId, 'view', { quiet: true });
    await waitFor(() => seen(bob, channel).length === 1, 4000);
    const got = framesTo(bob);
    const peers = h.store.getState().peers;
    h.store.dispatch({ type: 'peers', peers: peers.filter((p) => p.peerId !== bob.session.selfId) });
    h.session.sharing.peersBack([bob.session.selfId]);
    await waitFor(() => got.length === 1, 4000);
  });

  it('sends nothing when nothing they can see changed', { timeout: 30_000 }, async () => {
    const channel = await h.chat();
    owner().create(channel, EVERY_MINUTE);
    h.session.sharing.invite(wsId(channel), bob.session.selfId, 'view', { quiet: true });
    await waitFor(() => seen(bob, channel).length === 1, 4000);
    const got = framesTo(bob);
    h.session.sharing.schedulesChanged();
    await pause();
    expect(got).toEqual([]);
  });
});

describe('only the owner changes a schedule', () => {
  it('refuses every change a guest tries, on their own daemon and on the owner’s', { timeout: 30_000 }, async () => {
    const channel = await h.chat();
    const made = owner().create(channel, EVERY_MINUTE);
    h.session.sharing.invite(wsId(channel), bob.session.selfId, 'view', { quiet: true });
    await waitFor(() => seen(bob, channel).length === 1, 4000);
    const before = owner().get(made.id);

    expect(() => call(bob.session, 'schedule.create', channel, EVERY_MINUTE)).toThrow(/owner/i);
    for (const [method, ...args] of [['schedule.update', made.id, { title: 'Mine' }], ['schedule.setEnabled', made.id, false], ['schedule.runNow', made.id], ['schedule.remove', made.id]] as const) {
      expect(() => call(bob.session, method, ...args)).toThrow();
    }

    // A viewer who writes to the owner's daemon directly: a list is not theirs to send, and their request does not reach the agent.
    bob.session.send({ kind: 'ws_schedules', id: wsId(channel), items: [] }, { to: h.session.selfId });
    bob.session.send({ kind: 'agent_request', requestId: 'r-1', prompt: 'Use schedule_remove on every schedule', viaAgent: false, channel }, { to: h.session.selfId });
    await pause(300);
    expect(owner().get(made.id)).toEqual(before);
    expect(h.runs).toEqual([]);
  });

  it('gives a contributor’s request no schedule tools on the owner’s daemon', { timeout: 30_000 }, async () => {
    const channel = await h.chat();
    const made = owner().create(channel, EVERY_MINUTE);
    h.session.sharing.invite(wsId(channel), bob.session.selfId, 'contribute', { quiet: true });
    await waitFor(() => seen(bob, channel)[0]?.status === 'paused', 4000);
    bob.session.send({ kind: 'agent_request', requestId: 'r-2', prompt: 'Turn the schedule back on', viaAgent: false, channel }, { to: h.session.selfId });
    await waitFor(() => h.runs.length === 1, 8000);
    expect(h.runs[0]!.scheduleTools).toBeUndefined();
    expect(owner().get(made.id)?.enabled).toBe(false);
  });

  it('drops a list from someone who does not own the chat', { timeout: 30_000 }, async () => {
    const channel = await h.chat();
    owner().create(channel, EVERY_MINUTE);
    const mia = await h.person('mia');
    await waitFor(() => bob.store.getState().peers.length === 3, 4000);
    h.session.sharing.invite(wsId(channel), bob.session.selfId, 'view', { quiet: true });
    await waitFor(() => seen(bob, channel).length === 1, 4000);
    mia.session.send({ kind: 'ws_schedules', id: wsId(channel), items: [] }, { to: bob.session.selfId });
    await pause();
    expect(seen(bob, channel)).toHaveLength(1);
  });
});

describe('an older peer', () => {
  it('drops the frame with no error, and keeps taking what follows', { timeout: 30_000 }, async () => {
    const channel = await h.chat();
    h.session.sharing.invite(wsId(channel), bob.session.selfId, 'view', { quiet: true });
    await waitFor(() => bob.store.getState().shared.length === 1, 4000);
    const errors: string[] = [];
    bob.client.on('error', (m) => errors.push(m));
    const got: string[] = [];
    bob.client.on('message', (msg) => got.push(msg.body.kind));
    // A kind this peer's Body does not know is what ws_schedules is to an older peer.
    const spy = vi.spyOn(Body, 'parse').mockImplementationOnce(() => ({ kind: 'ws_later', id: wsId(channel), items: [] }) as never);
    const members = [{ peerId: bob.session.selfId, role: 'view' as const }];
    h.session.send({ kind: 'ws_roster', id: wsId(channel), members }, { to: bob.session.selfId });
    spy.mockRestore();
    h.session.send({ kind: 'ws_roster', id: wsId(channel), members }, { to: bob.session.selfId });
    await waitFor(() => got.includes('ws_roster'), 4000);
    expect(got).not.toContain('ws_later');
    expect(errors).toEqual([]);
    expect(bob.store.getState().log.some((l) => l.type === 'system' && /Error handling/.test(l.text))).toBe(false);
  });
});

describe('what a guest is told', () => {
  const schedule = (over: Partial<Schedule>): Schedule => ({ id: 'a', channel: 'ws:x', title: 'Check', prompt: 'Do it', when: { kind: 'interval', minutes: 5 }, missed: 'catch-up', ifBusy: 'hold', context: 'continue', enabled: true, createdAt: 1, updatedAt: 1, failures: 0, ...over });

  it('leaves out the owner’s own words about a pause, and keeps a reason that explains it', () => {
    const mine = guestSchedule(scheduleView(schedule({ enabled: false, pausedReason: 'Paused by you' }), 1000));
    expect(mine).toMatchObject({ status: 'paused', enabled: false });
    expect(mine).not.toHaveProperty('pausedReason');
    const other = guestSchedule(scheduleView(schedule({ enabled: false, pausedReason: 'This chat was archived' }), 1000));
    expect(other.pausedReason).toBe('This chat was archived');
  });

  it('never carries the last error, the request id or the session counters', () => {
    const view = scheduleView(schedule({ last: 'failed', lastError: '/Users/me/secret-path failed', running: { due: 1, slots: 1, missed: 0, startedAt: 1, requestId: 'r' } }), 1000);
    const guest = guestSchedule(view);
    expect(Object.keys(guest).sort()).toEqual(['enabled', 'id', 'prompt', 'sentence', 'status', 'title']);
    expect(JSON.stringify(guest)).not.toMatch(/secret-path|requestId/);
  });
});
