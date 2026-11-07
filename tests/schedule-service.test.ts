import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInstructions } from '../src/agent/run-instructions.js';
import { clock as clockText } from '../src/core/schedule/model.js';
import { scheduleStatus } from '../src/core/schedule/model.js';
import { encodeFailure } from '../src/shared/run-failure.js';
import { waitFor } from './helpers.js';
import { harness, type Harness } from './schedule-fakes.js';

const MIN = 60_000;
const EVERY_MINUTE = { title: 'Check', prompt: 'Look at it', when: { kind: 'interval', minutes: 1 } } as const;

let h: Harness;

beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

/** The fake agent's next runs wait until the test lets them go. */
function holdRuns() {
  const releases: Array<(text: string) => void> = [];
  h.script.run = (input) =>
    new Promise<string>((resolve, reject) => {
      releases.push(resolve);
      input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  return { release: (text = 'ok') => releases.shift()?.(text), answerNext: () => (h.script.run = async () => 'done') };
}

const idle = (channel: string) => waitFor(() => !h.session.host.busyIn(channel), 4000);

describe('a schedule in a chat', () => {
  it('runs a 1-minute schedule twice in one session, with a line and no user message', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);

    h.clock.now += MIN;
    s.tick();
    await waitFor(() => s.get(made.id)?.last === 'ok', 4000);
    await idle(channel);
    h.clock.now += 2 * MIN;
    s.tick();
    await waitFor(() => h.runs.length === 2 && !s.get(made.id)?.running, 4000);

    expect(h.runs.map((r) => r.place?.resume)).toEqual([undefined, 'session-1']);
    expect(h.runs[0]!.prompt).toBe('Look at it');
    expect(h.lines(channel).filter((l) => l.startsWith('Scheduled run · Check · due'))).toHaveLength(2);
    expect(h.store.getState().log.filter((l) => l.channel === channel && l.type === 'chat')).toEqual([]);
    const mark = h.store.getState().log.find((l) => l.channel === channel && l.type === 'system' && l.schedule);
    expect(mark).toMatchObject({ schedule: { id: made.id, title: 'Check', prompt: 'Look at it' } });
  });

  it('tells the agent in a brief that a schedule started the turn', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    s.create(channel, EVERY_MINUTE);
    h.clock.now += MIN;
    s.tick();
    await waitFor(() => h.runs.length === 1, 4000);
    expect(h.runs[0]!.scheduleBrief).toMatch(/A schedule started this turn/);
    expect(h.runs[0]!.scheduleBrief).toMatch(/one line/);
    expect(h.runs[0]!.scheduleBrief).toContain(`due at ${clockText(h.clock.now)}`);
    expect(runInstructions(h.runs[0]!, 'kay')).toContain('A schedule started this turn');
  });

  it('merges a busy lane\'s slots into one run after idle, adding no lane item', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    const held = holdRuns();
    h.session.askOwnClaude('busy work', channel);
    await waitFor(() => h.runs.length === 1, 4000);

    for (let i = 0; i < 5; i++) {
      h.clock.now += MIN;
      s.tick();
    }
    expect(s.get(made.id)?.pending?.slots).toBe(5);
    expect(scheduleStatus(s.get(made.id)!)).toBe('waiting');

    held.answerNext();
    held.release();
    await idle(channel);
    expect(h.runs).toHaveLength(1);
    s.tick();
    await waitFor(() => h.runs.length === 2 && s.get(made.id)?.last === 'ok', 4000);
    await idle(channel);
    s.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.runs).toHaveLength(2);
    expect(h.lines(channel).some((l) => l.endsWith('merged 5 slots'))).toBe(true);
    expect(h.store.getState().log.find((l) => l.type === 'system' && l.schedule?.id === made.id)).toMatchObject({ schedule: { slots: 5, missed: 0 } });
  });

  it('lets a user message sent during a pending occurrence run first', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    s.create(channel, EVERY_MINUTE);
    const held = holdRuns();
    h.session.askOwnClaude('first', channel);
    await waitFor(() => h.runs.length === 1, 4000);
    h.clock.now += MIN;
    s.tick();
    h.session.askOwnClaude('second', channel);
    await new Promise((r) => setTimeout(r, 20));
    s.tick();
    held.answerNext();
    held.release();
    await waitFor(() => h.runs.length === 2, 4000);
    await idle(channel);
    expect(h.runs[1]!.prompt).toBe('second');
    s.tick();
    await waitFor(() => h.runs.length === 3, 4000);
    expect(h.runs[2]!.prompt).toBe('Look at it');
  });

  it('runs two due schedules of one chat in order', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const a = s.create(channel, { ...EVERY_MINUTE, title: 'A', prompt: 'do A', when: { kind: 'interval', minutes: 2 } });
    const b = s.create(channel, { ...EVERY_MINUTE, title: 'B', prompt: 'do B', when: { kind: 'interval', minutes: 3 } });
    const held = holdRuns();
    h.session.askOwnClaude('busy', channel);
    await waitFor(() => h.runs.length === 1, 4000);
    h.clock.now += 3 * MIN;
    s.tick();
    expect(s.get(a.id)?.pending).toBeDefined();
    expect(s.get(b.id)?.pending).toBeDefined();
    held.answerNext();
    held.release();
    await idle(channel);
    s.tick();
    await waitFor(() => s.get(a.id)?.last === 'ok', 4000);
    await idle(channel);
    expect(s.get(b.id)?.running).toBeUndefined();
    s.tick();
    await waitFor(() => s.get(b.id)?.last === 'ok', 4000);
    expect(h.runs.slice(1).map((r) => r.prompt)).toEqual(['do A', 'do B']);
  });
});

describe('a restart', () => {
  it('still runs a pending occurrence, once', { timeout: 20_000 }, async () => {
    let s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    const held = holdRuns();
    h.session.askOwnClaude('busy', channel);
    await waitFor(() => h.runs.length === 1, 4000);
    h.clock.now += MIN;
    s.tick();
    expect(s.get(made.id)?.pending).toBeDefined();
    held.answerNext();
    held.release();
    await idle(channel);

    s = h.launch();
    expect(s.get(made.id)?.pending).toBeDefined();
    s.tick();
    s.tick();
    await waitFor(() => s.get(made.id)?.last === 'ok', 4000);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.runs.filter((r) => r.prompt === 'Look at it')).toHaveLength(1);
  });

  it('calls a run active at the stop interrupted, with a line, and does not count it', { timeout: 20_000 }, async () => {
    let s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    const held = holdRuns();
    h.clock.now += MIN;
    s.tick();
    await waitFor(() => h.runs.length === 1, 4000);

    s = h.launch();
    held.answerNext();
    held.release();
    await idle(channel);
    s.tick();
    const after = s.get(made.id)!;
    expect(after.failures).toBe(0);
    expect(h.lines(channel).some((l) => /interrupted/.test(l))).toBe(true);
    // Its next run comes as usual: the interrupted one isn't started again by the restart.
    expect(after.last === 'interrupted' || after.running !== undefined).toBe(true);
  });
});

describe('the off switch', () => {
  it('ticks nothing while chatSchedules is off', { timeout: 20_000 }, async () => {
    let s = h.launch(true);
    const channel = await h.chat();
    s.create(channel, EVERY_MINUTE);
    s = h.launch(false);
    h.clock.now += 10 * MIN;
    s.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.runs).toHaveLength(0);
    expect(h.lines(channel)).toEqual([]);
  });
});

describe('missed runs', () => {
  const hourly = { title: 'Hourly', prompt: 'p', when: { kind: 'schedule', every: 'hours', at: '00:00', hours: 1 } } as const;

  it('catches up once and says how many it missed', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    s.create(channel, hourly);
    h.clock.now += 6 * 60 * MIN + 10 * MIN;
    s.tick();
    await waitFor(() => h.runs.length === 1, 4000);
    expect(h.lines(channel).some((l) => l.endsWith('missed 6 runs while this computer was off'))).toBe(true);
  });

  it('writes the skip line and runs nothing on skip', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    s.create(channel, { ...hourly, missed: 'skip' });
    h.clock.now += 6 * 60 * MIN + 10 * MIN;
    s.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.runs).toHaveLength(0);
    const at = clockText(h.clock.now - 10 * MIN);
    expect(h.lines(channel)).toContain(`Schedule · Hourly · skipped the run at ${at}`);
  });

  it('writes one line for a busy slot on ifBusy skip', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, { ...EVERY_MINUTE, ifBusy: 'skip' });
    const held = holdRuns();
    h.session.askOwnClaude('busy', channel);
    await waitFor(() => h.runs.length === 1, 4000);
    h.clock.now += MIN;
    s.tick();
    expect(s.get(made.id)?.pending).toBeUndefined();
    expect(h.lines(channel)).toContain(`Schedule · Check · skipped the run at ${clockText(h.clock.now)} because this chat was busy`);
    held.answerNext();
    held.release();
  });
});

describe('a run that ends badly', () => {
  it('cancels a hung run at the time limit and shows failed', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    holdRuns();
    h.clock.now += MIN;
    s.tick();
    await waitFor(() => h.runs.length === 1, 4000);
    h.clock.now += 61 * MIN;
    s.tick();
    await waitFor(() => s.get(made.id)?.last === 'failed', 6000);
    expect(s.get(made.id)?.lastError).toMatch(/60-minute/);
    expect(scheduleStatus(s.get(made.id)!)).toBe('failed');
    expect(h.lines(channel).some((l) => /60-minute/.test(l))).toBe(true);
  });

  it('pauses after three failures, with a line and a notice', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    const notify = vi.spyOn(h.session.notifier, 'notify');
    h.script.run = async () => {
      throw new Error('boom');
    };
    for (let i = 1; i <= 3; i++) {
      h.clock.now += MIN;
      s.tick();
      await waitFor(() => s.get(made.id)?.failures === i, 4000);
      await idle(channel);
    }
    expect(s.get(made.id)).toMatchObject({ enabled: false, last: 'failed' });
    expect(h.lines(channel).some((l) => /Paused after 3 failed runs/.test(l))).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'problems', channel, title: expect.stringMatching(/Check.*paused/i) }));
    h.clock.now += 10 * MIN;
    s.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.runs).toHaveLength(3);
  });

  it('does not count a usage limit', { timeout: 20_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    h.script.run = async () => {
      throw new Error(encodeFailure({ kind: 'usage_limit', detail: 'You hit your limit' }));
    };
    h.clock.now += MIN;
    s.tick();
    await waitFor(() => s.get(made.id)?.last === 'failed', 4000);
    expect(s.get(made.id)?.failures).toBe(0);
    expect(s.get(made.id)?.enabled).toBe(true);
  });
});
