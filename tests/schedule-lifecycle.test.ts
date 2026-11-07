import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchAssistant } from '../src/core/assistant/launch.js';
import { assistantOf } from '../src/core/assistant/registry.js';
import { assistantChannel } from '../src/shared/assistant.js';
import { waitFor } from './helpers.js';
import { harness, type Harness } from './schedule-fakes.js';

const MIN = 60_000;
const EVERY_MINUTE = { title: 'Check', prompt: 'Look at it', when: { kind: 'interval', minutes: 1 } } as const;
const FRIEND = { peerId: 'friend-1', name: 'mia', shares: [], agent: true };

let h: Harness;

beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const wsId = (channel: string) => channel.slice(3);
const pause = () => new Promise((r) => setTimeout(r, 50));

describe('archive and restore', () => {
  it('archive pauses with a visible reason, and restore keeps it paused', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);

    await h.session.workspaces!.archive(wsId(channel));
    expect(s.get(made.id)).toMatchObject({ enabled: false, pausedReason: expect.stringMatching(/archived/i) });
    expect(h.lines(channel).some((l) => /Check.*archived/i.test(l))).toBe(true);

    await h.session.workspaces!.restore(wsId(channel));
    h.clock.now += 5 * MIN;
    s.tick();
    await pause();
    expect(s.get(made.id)?.enabled).toBe(false);
    expect(h.runs).toHaveLength(0);
  });

  it('sees no run after an archive that comes during a fire', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    h.script.run = (input) =>
      new Promise<string>((_, reject) => {
        if (input.signal.aborted) reject(new Error('aborted'));
        input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    h.clock.now += MIN;
    s.tick();
    expect(s.get(made.id)?.running).toBeDefined();
    await h.session.workspaces!.archive(wsId(channel));

    const started = h.runs.length;
    await waitFor(() => !h.session.host.busyIn(channel), 4000);
    expect(s.get(made.id)).toMatchObject({ enabled: false });
    await waitFor(() => !s.get(made.id)?.running, 4000);
    expect(s.get(made.id)?.failures).toBe(0);
    h.clock.now += 5 * MIN;
    s.tick();
    await pause();
    expect(h.runs).toHaveLength(started);
    expect(h.session.host.runningIn(channel)).toBe(false);
  });
});

describe('delete', () => {
  it('removes the schedules of a deleted chat', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    s.create(channel, EVERY_MINUTE);
    await h.session.workspaces!.remove(wsId(channel), { quiet: true });
    expect(s.list(channel)).toEqual([]);
  });

  it('removes the schedules of a removed project', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    s.create(channel, EVERY_MINUTE);
    const project = h.manager.list.find((p) => p.root)!;
    await h.session.workspaces!.removeProject(project.id);
    expect(s.list(channel)).toEqual([]);
  });

  it('removes a schedule whose chat no longer exists, at the tick, without a retry', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    await h.manager.remove(wsId(channel));
    h.clock.now += MIN;
    s.tick();
    await pause();
    expect(s.get(made.id)).toBeUndefined();
    expect(h.runs).toHaveLength(0);
  });

  it('removes the schedules of a deleted Your Mac chat', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const stop = launchAssistant({ session: h.session, store: h.store, demo: true });
    try {
      const mac = assistantOf(h.session)!;
      const chatId = mac.newChat();
      const channel = assistantChannel(chatId);
      s.create(channel, EVERY_MINUTE);
      expect(s.list(channel)).toHaveLength(1);
      await mac.deleteChat(chatId);
      expect(s.list(channel)).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe('clear', () => {
  it('keeps the schedule, and a later run starts a new session', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    h.clock.now += MIN;
    s.tick();
    await waitFor(() => s.get(made.id)?.last === 'ok', 4000);
    await waitFor(() => !h.session.host.busyIn(channel), 4000);

    h.session.clearChat(channel, { fresh: true });
    expect(s.get(made.id)).toBeDefined();
    h.clock.now += 2 * MIN;
    s.tick();
    await waitFor(() => h.runs.length === 2, 4000);
    expect(h.runs[1]!.place?.resume).toBeUndefined();
  });
});

describe('members', () => {
  function friendHere(): void {
    h.store.dispatch({ type: 'peers', peers: [...h.store.getState().peers, FRIEND as never] });
  }

  it('a contributor pauses every schedule of the chat before the invite goes out', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const a = s.create(channel, EVERY_MINUTE);
    const b = s.create(channel, { ...EVERY_MINUTE, title: 'Other' });
    friendHere();
    const whenSent: boolean[] = [];
    const send = h.session.send.bind(h.session);
    vi.spyOn(h.session, 'send').mockImplementation((body, opts) => {
      if (body.kind === 'ws_invite') whenSent.push(s.get(a.id)?.enabled === false && s.get(b.id)?.enabled === false);
      return send(body, opts);
    });

    expect(h.session.sharing.invite(wsId(channel), FRIEND.peerId, 'contribute', { quiet: true })).toBe(true);
    expect(whenSent).toEqual([true]);
    expect(s.get(a.id)?.pausedReason).toMatch(/contribute/i);
    expect(h.lines(channel).filter((l) => /contribute/i.test(l))).toHaveLength(2);

    expect(() => s.setEnabled(a.id, true)).toThrow(/contribute/i);
    expect(() => s.create(channel, EVERY_MINUTE)).toThrow(/contribute/i);

    h.session.sharing.remove(wsId(channel), FRIEND.peerId, true);
    expect(s.get(a.id)?.enabled).toBe(false);
    expect(s.setEnabled(a.id, true).enabled).toBe(true);
    expect(s.get(a.id)?.pausedReason).toBeUndefined();
  });

  it('a viewer changes nothing', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const a = s.create(channel, EVERY_MINUTE);
    friendHere();
    expect(h.session.sharing.invite(wsId(channel), FRIEND.peerId, 'view', { quiet: true })).toBe(true);
    expect(s.get(a.id)?.enabled).toBe(true);
    expect(s.create(channel, EVERY_MINUTE).enabled).toBe(true);
  });

  it('a contributor who got in another way is caught at fire time', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const a = s.create(channel, EVERY_MINUTE);
    h.stopService();
    h.store.dispatch({ type: 'member_set', id: wsId(channel), peerId: FRIEND.peerId, role: 'contribute' });
    const again = h.launch();
    expect(again.get(a.id)?.enabled).toBe(true);
    h.clock.now += MIN;
    again.tick();
    await pause();
    expect(again.get(a.id)?.enabled).toBe(false);
    expect(h.runs).toHaveLength(0);
  });
});

describe('which chats', () => {
  it('refuses the chats that keep no session, with why', { timeout: 30_000 }, async () => {
    const s = h.launch();
    expect(() => s.create('room', EVERY_MINUTE)).toThrow(/saved session/);
    expect(() => s.create('dm:abc', EVERY_MINUTE)).toThrow(/saved session/);
    const main = h.manager.list.find((p) => p.root)!.workspaces.find((w) => w.kind === 'main');
    expect(() => s.create(`ws:${main!.id}`, EVERY_MINUTE)).toThrow(/main folder/i);
  });

  it('refuses a plan home chat', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    h.store.dispatch({ type: 'plan_put', plan: { id: 'p1', home: channel, status: 'draft' } as never });
    expect(() => s.create(channel, EVERY_MINUTE)).toThrow(/plan/i);
  });
});
