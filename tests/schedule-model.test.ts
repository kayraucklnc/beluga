import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyDecision,
  applyEnd,
  checkWhen,
  decide,
  newSchedule,
  nextDue,
  nextTime,
  overLimit,
  pauseSchedule,
  resumeSchedule,
  runExtras,
  runLine,
  scheduleStatus,
  skipLine,
  RUN_LIMIT_MS,
  type Decision,
} from '../src/core/schedule/model.js';
import { ScheduleInputSchema, ScheduleWhenSchema, type Schedule, type ScheduleWhen } from '../src/core/schedule/schema.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 7, 12, 0);
const IDLE = { busy: false };
const BUSY = { busy: true };
const TZ = 'UTC';

function make(when: ScheduleWhen, over: Partial<Schedule> = {}): Schedule {
  return { ...newSchedule({ id: 's1', channel: 'ws:p/w', title: 'Check', prompt: 'Look', when }, T0), ...over };
}

/** One tick: decide and apply. */
function tick(s: Schedule, lane: { busy: boolean }, now: number): { s: Schedule; d: Decision } {
  const d = decide(s, lane, now, { tz: TZ });
  return { s: applyDecision(s, d, now), d };
}

describe('nextDue', () => {
  it('counts an interval from the end of the last run', () => {
    expect(nextDue({ kind: 'interval', minutes: 10 }, T0, T0 + 3 * MIN)).toBe(T0 + 10 * MIN);
  });

  it('gives a once schedule its time, and no time after it ran', () => {
    const at = T0 + 60 * MIN;
    expect(nextDue({ kind: 'once', at }, undefined, T0)).toBe(at);
    expect(nextDue({ kind: 'once', at }, at, at + MIN)).toBeUndefined();
  });

  it('asks the clock for slots', () => {
    const when: ScheduleWhen = { kind: 'schedule', every: 'day', at: '21:00' };
    expect(nextDue(when, T0, T0, { tz: TZ })).toBe(Date.UTC(2026, 10, 7, 21, 0));
  });

  it('follows the clock through a skipped DST hour', () => {
    // New York skips 02:00–03:00 on 8 March 2026: as the clock's own test says, 2:30 runs at 3:30 EDT.
    const when: ScheduleWhen = { kind: 'schedule', every: 'day', at: '02:30' };
    const before = Date.UTC(2026, 2, 8, 0, 0);
    expect(nextDue(when, before, before, { tz: 'America/New_York' })).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });
});

describe('checkWhen', () => {
  it('refuses a once time in the past, with a reason', () => {
    expect(checkWhen({ kind: 'once', at: T0 - MIN }, T0)).toMatch(/past/i);
    expect(checkWhen({ kind: 'once', at: T0 + MIN }, T0)).toBeUndefined();
  });

  it('accepts intervals and slots', () => {
    expect(checkWhen({ kind: 'interval', minutes: 1 }, T0)).toBeUndefined();
    expect(checkWhen({ kind: 'schedule', every: 'day', at: '07:00' }, T0)).toBeUndefined();
  });
});

describe('schema', () => {
  it('refuses an interval under one minute', () => {
    expect(ScheduleWhenSchema.safeParse({ kind: 'interval', minutes: 0 }).success).toBe(false);
    expect(ScheduleWhenSchema.safeParse({ kind: 'interval', minutes: 1 }).success).toBe(true);
  });

  it('gives new schedules the defaults', () => {
    const input = ScheduleInputSchema.parse({ title: 't', prompt: 'p', when: { kind: 'interval', minutes: 5 } });
    expect(input).toMatchObject({ missed: 'catch-up', ifBusy: 'hold', context: 'continue' });
  });
});

describe('decide', () => {
  it('does nothing before the time, and says when', () => {
    const d = decide(make({ kind: 'interval', minutes: 10 }), IDLE, T0 + MIN, { tz: TZ });
    expect(d).toEqual({ kind: 'nothing', at: T0 + 10 * MIN });
  });

  it('does nothing while paused', () => {
    expect(decide(make({ kind: 'interval', minutes: 1 }, { enabled: false }), IDLE, T0 + 9 * MIN, { tz: TZ }).kind).toBe('nothing');
  });

  it('runs a due slot on an idle lane', () => {
    const d = decide(make({ kind: 'interval', minutes: 1 }), IDLE, T0 + MIN, { tz: TZ });
    expect(d).toMatchObject({ kind: 'run', due: T0 + MIN, slots: 1, missed: 0 });
  });

  it('holds on a busy lane, merges later slots, then runs once', () => {
    let s = make({ kind: 'interval', minutes: 1 });
    const kinds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = tick(s, BUSY, T0 + i * MIN);
      s = r.s;
      kinds.push(r.d.kind);
    }
    expect(kinds).toEqual(['hold', 'merge', 'merge', 'merge', 'merge']);
    expect(s.pending).toMatchObject({ due: T0 + MIN, slots: 5 });
    expect(scheduleStatus(s)).toBe('waiting');

    const r = tick(s, IDLE, T0 + 5 * MIN + 10_000);
    expect(r.d).toMatchObject({ kind: 'run', due: T0 + MIN, slots: 5 });
    expect(r.s.pending).toBeUndefined();
    expect(r.s.running).toMatchObject({ due: T0 + MIN, slots: 5 });
    expect(scheduleStatus(r.s)).toBe('running');

    // Started: a second idle tick sees nothing to do.
    expect(decide(r.s, IDLE, T0 + 5 * MIN + 20_000, { tz: TZ }).kind).toBe('nothing');
  });

  it('skips a busy slot when ifBusy says so', () => {
    const d = decide(make({ kind: 'interval', minutes: 1 }, { ifBusy: 'skip' }), BUSY, T0 + MIN, { tz: TZ });
    expect(d).toMatchObject({ kind: 'skip', why: 'busy', slot: T0 + MIN });
  });

  it('never drops a once schedule for being busy', () => {
    const at = T0 + MIN;
    expect(decide(make({ kind: 'once', at }, { ifBusy: 'skip' }), BUSY, at, { tz: TZ }).kind).toBe('hold');
  });

  it('merges a slot that passes during the schedule\'s own run', () => {
    let s = make({ kind: 'schedule', every: 'hours', at: '00:00', hours: 1 });
    const start = Date.UTC(2026, 10, 7, 13, 0);
    s = tick(s, IDLE, start).s;
    expect(s.running).toBeDefined();
    const r = tick(s, BUSY, Date.UTC(2026, 10, 7, 14, 0));
    expect(r.d.kind).toBe('hold');
    const end = applyEnd(r.s, { kind: 'ok' }, Date.UTC(2026, 10, 7, 14, 1));
    expect(end.pending).toMatchObject({ due: Date.UTC(2026, 10, 7, 14, 0) });
    expect(decide(end, IDLE, Date.UTC(2026, 10, 7, 14, 2), { tz: TZ }).kind).toBe('run');
  });

  it('does not count an interval while its run is active', () => {
    const s = tick(make({ kind: 'interval', minutes: 1 }), IDLE, T0 + MIN).s;
    expect(decide(s, BUSY, T0 + 9 * MIN, { tz: TZ }).kind).toBe('nothing');
  });

  describe('computer off', () => {
    const hourly: ScheduleWhen = { kind: 'schedule', every: 'hours', at: '00:00', hours: 1 };

    it('catches up once and counts the missed slots', () => {
      const s = make(hourly);
      const d = decide(s, IDLE, T0 + 6 * 60 * MIN + 10 * MIN, { tz: TZ });
      expect(d).toMatchObject({ kind: 'run', missed: 6, slots: 1, late: true });
    });

    it('skips when missed says skip', () => {
      const s = make(hourly, { missed: 'skip' });
      const r = tick(s, IDLE, T0 + 6 * 60 * MIN + 10 * MIN);
      expect(r.d).toMatchObject({ kind: 'skip', why: 'missed', slot: T0 + 6 * 60 * MIN });
      expect(decide(r.s, IDLE, T0 + 6 * 60 * MIN + 11 * MIN, { tz: TZ }).kind).toBe('nothing');
    });

    it('always runs a slot less than five minutes late, even on skip', () => {
      const s = make(hourly, { missed: 'skip' });
      expect(decide(s, IDLE, T0 + 60 * MIN + 4 * MIN, { tz: TZ })).toMatchObject({ kind: 'run', late: false, missed: 0 });
    });

    it('treats a long-missed interval the same way', () => {
      const every10: ScheduleWhen = { kind: 'interval', minutes: 10 };
      expect(decide(make(every10), IDLE, T0 + 65 * MIN, { tz: TZ })).toMatchObject({ kind: 'run', missed: 6, late: true });
      const r = tick(make(every10, { missed: 'skip' }), IDLE, T0 + 65 * MIN);
      expect(r.d).toMatchObject({ kind: 'skip', why: 'missed', slot: T0 + 60 * MIN });
      expect(nextTime(r.s, T0 + 65 * MIN, { tz: TZ })).toBe(T0 + 70 * MIN);
    });

    it('runs a once schedule late, even on skip', () => {
      const at = T0 + MIN;
      const d = decide(make({ kind: 'once', at }, { missed: 'skip' }), IDLE, at + 600 * MIN, { tz: TZ });
      expect(d).toMatchObject({ kind: 'run', due: at, late: true, missed: 1 });
    });

    it('keeps a pending occurrence over a restart, and merges what passed meanwhile', () => {
      let s = tick(make({ kind: 'interval', minutes: 1 }), BUSY, T0 + MIN).s;
      s = JSON.parse(JSON.stringify(s)) as Schedule;
      const d = decide(s, IDLE, T0 + 2 * MIN, { tz: TZ });
      expect(d).toMatchObject({ kind: 'run', due: T0 + MIN, slots: 2 });
    });
  });
});

describe('applyEnd', () => {
  function started(when: ScheduleWhen = { kind: 'interval', minutes: 10 }, over: Partial<Schedule> = {}): Schedule {
    return tick(make(when, over), IDLE, T0 + 10 * MIN).s;
  }

  it('restarts an interval from the end of the run', () => {
    const end = T0 + 15 * MIN;
    const s = applyEnd(started(), { kind: 'ok' }, end);
    expect(s.running).toBeUndefined();
    expect(s.lastEnd).toBe(end);
    expect(scheduleStatus(s)).toBe('ok');
    expect(nextTime(s, end, { tz: TZ })).toBe(end + 10 * MIN);
  });

  it('turns a once schedule off after its run, whatever the end', () => {
    const at = T0 + 10 * MIN;
    for (const outcome of [{ kind: 'ok' }, { kind: 'failed', error: 'x' }, { kind: 'interrupted' }] as const) {
      const s = applyEnd(started({ kind: 'once', at }), outcome, at + MIN);
      expect(s.enabled).toBe(false);
      expect(nextTime(s, at + MIN, { tz: TZ })).toBeUndefined();
    }
  });

  it('pauses after three failures in a row, with a reason', () => {
    let s = started();
    for (let i = 1; i <= 3; i++) {
      s = applyEnd(s, { kind: 'failed', error: 'boom' }, T0 + 20 * MIN * i);
      expect(s.failures).toBe(i);
      expect(s.enabled).toBe(i < 3);
      s = i < 3 ? { ...s, running: { due: T0, startedAt: T0, slots: 1, missed: 0 } } : s;
    }
    expect(s.pausedReason).toMatch(/3 .*failed|failed .*3|three/i);
    expect(scheduleStatus(s)).toBe('failed');
  });

  it('a success clears the failure count', () => {
    const s = applyEnd({ ...started(), failures: 2 }, { kind: 'ok' }, T0 + 20 * MIN);
    expect(s.failures).toBe(0);
  });

  it('does not count a usage limit as a failure', () => {
    const s = applyEnd({ ...started(), failures: 2 }, { kind: 'failed', error: 'limit', usageLimit: true }, T0 + 20 * MIN);
    expect(s.failures).toBe(2);
    expect(s.enabled).toBe(true);
    expect(scheduleStatus(s)).toBe('failed');
  });

  it('does not count an interrupted run as a failure', () => {
    const s = applyEnd({ ...started(), failures: 2 }, { kind: 'interrupted' }, T0 + 20 * MIN);
    expect(s.failures).toBe(2);
    expect(s.enabled).toBe(true);
    expect(scheduleStatus(s)).toBe('interrupted');
  });

  it('applies to the values saved now, so a racing edit stays', () => {
    const edited = { ...started(), title: 'New', when: { kind: 'interval', minutes: 30 } as ScheduleWhen };
    const end = T0 + 15 * MIN;
    const s = applyEnd(edited, { kind: 'ok' }, end);
    expect(s.title).toBe('New');
    expect(nextTime(s, end, { tz: TZ })).toBe(end + 30 * MIN);
  });
});

describe('pause and resume', () => {
  it('clears the pending occurrence on pause', () => {
    const s = tick(make({ kind: 'interval', minutes: 1 }), BUSY, T0 + MIN).s;
    const p = pauseSchedule(s, 'Archived', T0 + 2 * MIN);
    expect(p).toMatchObject({ enabled: false, pausedReason: 'Archived' });
    expect(p.pending).toBeUndefined();
  });

  it('resume clears failures and does not catch up paused slots', () => {
    const s = pauseSchedule(make({ kind: 'interval', minutes: 1 }, { failures: 3 }), 'x', T0);
    const r = resumeSchedule(s, T0 + 600 * MIN);
    expect(r).toMatchObject({ enabled: true, failures: 0 });
    expect(r.pausedReason).toBeUndefined();
    expect(decide(r, IDLE, T0 + 600 * MIN, { tz: TZ }).kind).toBe('nothing');
    expect(nextTime(r, T0 + 600 * MIN, { tz: TZ })).toBe(T0 + 601 * MIN);
  });
});

describe('overLimit', () => {
  it('is true only past the time limit of an active run', () => {
    const s = tick(make({ kind: 'interval', minutes: 1 }), IDLE, T0 + MIN).s;
    expect(overLimit(s, T0 + MIN + RUN_LIMIT_MS)).toBe(false);
    expect(overLimit(s, T0 + MIN + RUN_LIMIT_MS + 1)).toBe(true);
    expect(overLimit(make({ kind: 'interval', minutes: 1 }), T0 + 9e9)).toBe(false);
  });
  it('is sixty minutes', () => {
    expect(RUN_LIMIT_MS).toBe(3_600_000);
  });
});

describe('lines', () => {
  const at = Date.UTC(2026, 10, 7, 21, 0);

  it('writes the plain run line', () => {
    expect(runLine('Check', { due: at, slots: 1, missed: 0 }, { tz: TZ })).toBe('Scheduled run · Check · due 21:00');
  });

  it('says how many slots merged', () => {
    expect(runLine('Check', { due: at, slots: 3, missed: 0 }, { tz: TZ })).toBe('Scheduled run · Check · due 21:00 · merged 3 slots');
  });

  it('says how many runs were missed', () => {
    expect(runLine('Check', { due: at, slots: 1, missed: 4 }, { tz: TZ })).toBe('Scheduled run · Check · due 21:00 · missed 4 runs while this computer was off');
    expect(runLine('Check', { due: at, slots: 1, missed: 1 }, { tz: TZ })).toBe('Scheduled run · Check · due 21:00 · missed 1 run while this computer was off');
  });

  it('names what a run stands for: merged, missed, both, or nothing for a plain run', () => {
    expect(runExtras({ slots: 3, missed: 0 })).toEqual(['merged 3 slots']);
    expect(runExtras({ slots: 1, missed: 1 })).toEqual(['missed 1 run while this computer was off']);
    expect(runExtras({ slots: 2, missed: 4 })).toEqual(['merged 2 slots', 'missed 4 runs while this computer was off']);
    expect(runExtras({ slots: 1, missed: 0 })).toEqual([]);
  });

  it('reads an old saved line, which has no counts, as a plain run', () => {
    expect(runExtras({})).toEqual([]);
  });

  it('writes the same words in the line itself', () => {
    expect(runLine('Check', { due: at, slots: 2, missed: 4 }, { tz: TZ })).toBe('Scheduled run · Check · due 21:00 · merged 2 slots · missed 4 runs while this computer was off');
  });

  it('writes the skip lines', () => {
    expect(skipLine('Check', { slot: at, why: 'missed' }, { tz: TZ })).toBe('Schedule · Check · skipped the run at 21:00');
    expect(skipLine('Check', { slot: at, why: 'busy' }, { tz: TZ })).toBe('Schedule · Check · skipped the run at 21:00 because this chat was busy');
  });
});

describe('the module', () => {
  it('imports no node: module', () => {
    for (const f of ['model.ts', 'schema.ts']) {
      expect(readFileSync(new URL(`../src/core/schedule/${f}`, import.meta.url), 'utf8')).not.toMatch(/from 'node:/);
    }
  });
});
