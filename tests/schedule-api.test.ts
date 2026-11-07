import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '../src/core/commands.js';
import { loadSettings, Settings } from '../src/core/settings.js';
import { PHONE } from '../src/companion/coverage.js';
import { RunFailedError } from '../src/shared/run-failure.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import { suggest } from '../src/ui/suggest.js';
import { waitFor } from './helpers.js';
import { harness, type Harness } from './schedule-fakes.js';

const MIN = 60_000;
const EVERY_MINUTE = { title: 'Check', prompt: 'Look at it', when: { kind: 'interval', minutes: 1 } };

let h: Harness;

beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const call = (method: keyof typeof HANDLERS, ...args: unknown[]): unknown => (HANDLERS[method] as (...a: unknown[]) => unknown)(h.session, ...args);
const hold = (): void => {
  h.script.run = (input) => new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
};

describe('the off switch', () => {
  it('leaves /schedule to the agent, as it was before the feature', { timeout: 20_000 }, async () => {
    h.launch(false);
    const channel = await h.chat();
    const prompts: string[] = [];
    h.script.run = async (input) => {
      prompts.push(input.prompt);
      return 'done';
    };
    runCommand(h.session, 'schedule', ['daily', 'report'], channel, '/schedule daily report');
    await waitFor(() => prompts.length === 1);
    expect(prompts[0]).toContain('/schedule daily report');
  });

  it('refuses every method with a clear message', { timeout: 20_000 }, async () => {
    h.launch(false);
    const channel = await h.chat();
    for (const [method, ...args] of [['schedule.list', channel], ['schedule.create', channel, EVERY_MINUTE], ['schedule.update', 'x', {}], ['schedule.setEnabled', 'x', true], ['schedule.runNow', 'x'], ['schedule.remove', 'x']] as const) {
      expect(() => call(method, ...args)).toThrow(/Schedules are off/);
    }
  });
});

describe('what the screens see', () => {
  it('keeps the shared state in step with every change, with status and next time', { timeout: 20_000 }, async () => {
    h.launch();
    const channel = await h.chat();
    expect(h.store.getState().schedules).toEqual([]);
    const made = call('schedule.create', channel, EVERY_MINUTE) as { id: string };
    expect(h.store.getState().schedules).toMatchObject([{ id: made.id, channel, status: 'never', next: h.clock.now + MIN }]);
    call('schedule.setEnabled', made.id, false);
    expect(h.store.getState().schedules).toMatchObject([{ id: made.id, enabled: false, pausedReason: 'Paused by you' }]);
    expect(h.store.getState().schedules[0]).not.toHaveProperty('next');
    call('schedule.remove', made.id);
    expect(h.store.getState().schedules).toEqual([]);
  });

  it('shows saved schedules as soon as the service starts', { timeout: 20_000 }, async () => {
    h.launch();
    const channel = await h.chat();
    call('schedule.create', channel, EVERY_MINUTE);
    h.stopService();
    h.store.dispatch({ type: 'schedules', items: [] });
    h.launch();
    expect(h.store.getState().schedules).toMatchObject([{ channel, title: 'Check' }]);
  });

  it('shows only the readable words of a failed run, in the line and the row', { timeout: 20_000 }, async () => {
    h.launch();
    const channel = await h.chat();
    h.script.run = () => Promise.reject(new RunFailedError({ kind: 'signed_out', detail: 'Not logged in' }));
    const made = call('schedule.create', channel, EVERY_MINUTE) as { id: string };
    for (let i = 0; i < 3; i++) {
      call('schedule.runNow', made.id);
      await waitFor(() => (h.store.getState().schedules[0]?.failures ?? 0) === i + 1 || !h.store.getState().schedules[0]?.running);
      await waitFor(() => !h.store.getState().schedules[0]?.running);
    }
    const line = h.store.getState().log.find((l) => l.type === 'system' && l.schedule?.paused) as { text: string };
    expect(line.text).toContain('signed in');
    expect(line.text).not.toContain('klaud-failure');
    expect(h.store.getState().schedules[0]?.lastError).not.toContain('klaud-failure');
  });

  it('marks the line that says failures paused it, so it can offer Resume', { timeout: 20_000 }, async () => {
    h.launch();
    const channel = await h.chat();
    h.script.run = () => Promise.reject(new Error('No network'));
    const made = call('schedule.create', channel, EVERY_MINUTE) as { id: string };
    for (let i = 0; i < 3; i++) {
      call('schedule.runNow', made.id);
      await waitFor(() => (h.store.getState().schedules[0]?.failures ?? 0) === i + 1);
    }
    const line = h.store.getState().log.find((l) => l.type === 'system' && l.schedule?.paused);
    expect(line).toMatchObject({ channel, level: 'warn', schedule: { id: made.id, title: 'Check', paused: true } });
  });

  it('carries the setting chatSchedules as a pref', () => {
    expect(h.store.getState().prefs.chatSchedules).toBe(true);
    h.session.setPrefs({ chatSchedules: false });
    expect(h.store.getState().prefs.chatSchedules).toBe(false);
  });

  it('has schedules on in a new install, and the switch turns them off', () => {
    expect(Settings.parse({}).chatSchedules).toBe(true);
    const schedules = h.launch();
    expect(schedules.isOn()).toBe(true);
    h.session.setPrefs({ chatSchedules: false });
    expect(loadSettings().chatSchedules).toBe(false);
    expect(schedules.isOn()).toBe(false);
    expect(() => call('schedule.list')).toThrow('Schedules are off');
  });
});

describe('create', () => {
  it('returns a schedule with its status and next time', { timeout: 20_000 }, async () => {
    h.launch();
    const channel = await h.chat();
    expect(call('schedule.create', channel, EVERY_MINUTE)).toMatchObject({ title: 'Check', channel, status: 'never', next: h.clock.now + MIN });
    expect(call('schedule.list', channel)).toHaveLength(1);
  });

  it('refuses a past once time, a bad channel and an eleventh schedule with a message to act on', { timeout: 20_000 }, async () => {
    h.launch();
    const channel = await h.chat();
    expect(() => call('schedule.create', channel, { ...EVERY_MINUTE, when: { kind: 'once', at: h.clock.now - MIN } })).toThrow(/past. Pick a time/);
    expect(() => call('schedule.create', 'dm:someone', EVERY_MINUTE)).toThrow(/saved session/);
    for (let i = 0; i < 10; i++) call('schedule.create', channel, EVERY_MINUTE);
    expect(() => call('schedule.create', channel, EVERY_MINUTE)).toThrow(/10 schedules.*Remove one/);
  });

  it('refuses a chat someone shared with you', { timeout: 20_000 }, async () => {
    h.launch();
    h.store.dispatch({ type: 'shared_add', ws: { owner: 'them', id: 'theirs', name: 'Theirs', project: 'p', role: 'contribute', share: 's' } as never });
    expect(() => call('schedule.create', 'ws:theirs', EVERY_MINUTE)).toThrow(/owner/);
  });
});

describe('update', () => {
  it('keeps the new values and one next time when it races a finishing run', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    let finish: (t: string) => void = () => undefined;
    h.script.run = () => new Promise((resolve) => (finish = resolve));
    h.clock.now += MIN;
    s.tick();
    await waitFor(() => h.runs.length === 1, 4000);

    call('schedule.update', made.id, { title: 'New', when: { kind: 'interval', minutes: 30 } });
    h.clock.now += MIN;
    finish('done');
    await waitFor(() => s.get(made.id)?.last === 'ok', 4000);
    expect(s.get(made.id)).toMatchObject({ title: 'New', when: { minutes: 30 } });
    expect(call('schedule.list', channel)).toMatchObject([{ next: h.clock.now + 30 * MIN }]);
  });

  it('does not change what the patch leaves out, and refuses a past once time', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, { ...EVERY_MINUTE, ifBusy: 'skip', missed: 'skip' });
    call('schedule.update', made.id, { title: 'New' });
    expect(s.get(made.id)).toMatchObject({ title: 'New', ifBusy: 'skip', missed: 'skip', prompt: 'Look at it' });
    expect(() => call('schedule.update', made.id, { when: { kind: 'once', at: h.clock.now - 1 } })).toThrow(/past/);
    expect(() => call('schedule.update', 'nope', { title: 'x' })).toThrow(/not here/);
  });
});

describe('runNow', () => {
  it('runs a paused schedule and leaves it paused', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    s.setEnabled(made.id, false);
    call('schedule.runNow', made.id);
    await waitFor(() => s.get(made.id)?.last === 'ok', 4000);
    expect(h.runs).toHaveLength(1);
    expect(s.get(made.id)?.enabled).toBe(false);
  });

  it('refuses while a run is active, with the reason', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    hold();
    call('schedule.runNow', made.id);
    expect(() => call('schedule.runNow', made.id)).toThrow(/already running/);
  });

  it('waits its turn on a busy chat when on, and refuses when paused', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    hold();
    h.session.askOwnClaude('busy', channel);
    await waitFor(() => h.runs.length === 1, 4000);
    call('schedule.runNow', made.id);
    expect(s.get(made.id)?.pending).toBeDefined();
    s.setEnabled(made.id, false);
    expect(() => call('schedule.runNow', made.id)).toThrow(/busy/);
  });
});

describe('remove and setEnabled', () => {
  it('removes, pauses and resumes', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    expect(call('schedule.setEnabled', made.id, false)).toMatchObject({ enabled: false, status: 'never' });
    expect(call('schedule.setEnabled', made.id, true)).toMatchObject({ enabled: true });
    call('schedule.remove', made.id);
    expect(s.get(made.id)).toBeUndefined();
  });
});

describe('/schedule', () => {
  const run = (channel: string, ...args: string[]) => runCommand(h.session, 'schedule', args, channel);

  it('lists, pauses, resumes, runs and removes by title', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const a = s.create(channel, { ...EVERY_MINUTE, title: 'Morning check' });
    const b = s.create(channel, { ...EVERY_MINUTE, title: 'Evening check' });

    run(channel);
    expect(h.lines(channel).some((l) => l.includes('Morning check') && l.includes('Evening check') && l.includes('Every minute'))).toBe(true);

    run(channel, 'pause', 'morning', 'check');
    expect(s.get(a.id)?.enabled).toBe(false);
    expect(s.get(b.id)?.enabled).toBe(true);
    run(channel, 'resume', 'Morning');
    expect(s.get(a.id)?.enabled).toBe(true);
    run(channel, 'run', 'Morning');
    await waitFor(() => s.get(a.id)?.last === 'ok', 4000);
    run(channel, 'remove', 'Evening');
    expect(s.get(b.id)).toBeUndefined();
    // Only one left: no title needed.
    run(channel, 'pause');
    expect(s.get(a.id)?.enabled).toBe(false);
  });

  it('asks which one when a title is missing or matches several, and changes nothing', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const a = s.create(channel, { ...EVERY_MINUTE, title: 'Morning check' });
    const b = s.create(channel, { ...EVERY_MINUTE, title: 'Evening check' });
    run(channel, 'pause');
    run(channel, 'pause', 'check');
    run(channel, 'pause', 'nothing like it');
    expect(s.get(a.id)?.enabled).toBe(true);
    expect(s.get(b.id)?.enabled).toBe(true);
  });

  it('changes no schedule while the feature is off', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const a = s.create(channel, EVERY_MINUTE);
    const off = h.launch(false);
    run(channel, 'pause');
    expect(off.get(a.id)?.enabled).toBe(true);
  });
});

describe('the surfaces', () => {
  it('classifies what the phone may do, and the rest as Mac only', () => {
    for (const m of ['schedule.list', 'schedule.setEnabled', 'schedule.runNow'] as const) expect(PHONE[m]).toBe('phone');
    for (const m of ['schedule.create', 'schedule.update', 'schedule.remove'] as const) expect(PHONE[m]).toBe('mac');
  });

  it('suggests the forms of /schedule', () => {
    const ctx = { peers: [], selfId: 'me' };
    expect(suggest('/schedule p', ctx).map((s) => s.value)).toEqual(['/schedule pause ']);
    expect(suggest('/sched', ctx).map((s) => s.value)).toContain('/schedule ');
    // Return on the command alone sends it, instead of picking "pause".
    expect(suggest('/schedule ', ctx)[0]).toMatchObject({ value: '/schedule', enter: 'submit' });
  });
});
