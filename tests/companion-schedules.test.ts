import { describe, expect, it } from 'vitest';
import { PHONE } from '../src/companion/coverage.js';
import { ConvView, type Topic } from '../src/companion/protocol.js';
import { convView } from '../src/companion/views.js';
import { runExtras, type ScheduleView } from '../src/core/schedule/model.js';
import { initialState, reduce, type AppState, type DomainState } from '../src/core/store.js';

/** BLG-97: a chat's schedules on the phone, read from the daemon's state. */

const CHANNEL = 'ws:w1';
const TOPIC = `conv:${CHANNEL}` as Topic;
const ctx = { refs: { output: () => undefined }, mac: { name: 'Mac', version: '1' } };
const row = (over: Partial<ScheduleView> = {}): ScheduleView => ({ id: 's1', channel: CHANNEL, title: 'Check', prompt: 'Look at it', when: { kind: 'interval', minutes: 5 }, missed: 'catch-up', ifBusy: 'hold', context: 'continue', enabled: true, createdAt: 1, updatedAt: 1, failures: 0, status: 'never', next: 5000, ...over });
const stateWith = (patch: Partial<AppState> & { prefsOn?: boolean }): DomainState => {
  const { prefsOn = true, ...rest } = patch;
  const base = initialState('test', 'ask');
  return { ...base, prefs: { ...base.prefs, chatSchedules: prefsOn }, ...rest } as DomainState;
};
const view = (state: DomainState): ConvView => ConvView.parse(convView(state, ctx as never, TOPIC));

describe('the phone may', () => {
  it('list, run and pause, and only the Mac makes, edits or removes', () => {
    for (const m of ['schedule.list', 'schedule.setEnabled', 'schedule.runNow'] as const) expect(PHONE[m]).toBe('phone');
    for (const m of ['schedule.create', 'schedule.update', 'schedule.remove'] as const) expect(PHONE[m]).toBe('mac');
  });
});

describe('a conversation’s schedules', () => {
  it('lists your own with its words, next time and why it stopped', () => {
    const c = view(stateWith({ schedules: [row(), row({ id: 's2', enabled: false, status: 'failed', last: 'failed', lastError: 'It broke', pausedReason: 'Failed three times', next: undefined as never })] }));
    expect(c.schedules?.owner).toBeUndefined();
    expect(c.schedules?.items[0]).toEqual({ id: 's1', title: 'Check', prompt: 'Look at it', sentence: 'Every 5 minutes', status: 'never', enabled: true, next: 5000 });
    expect(c.schedules?.items[1]).toMatchObject({ status: 'paused', enabled: false, problem: 'Failed three times. The last one: It broke' });
  });

  it('has no field with no schedule here, or with the setting off, as an older Mac', () => {
    expect(view(stateWith({ schedules: [row({ channel: 'ws:other' })] }))).not.toHaveProperty('schedules');
    expect(view(stateWith({ prefsOn: false, schedules: [row()] }))).not.toHaveProperty('schedules');
    expect(ConvView.safeParse({ topic: TOPIC, title: 'A', turns: [], more: false, needsYou: [], canSend: true, working: false }).success).toBe(true);
  });

  it('shows a shared chat’s list read-only under its owner, whatever your setting says', () => {
    const c = view(
      stateWith({
        prefsOn: false,
        peers: [{ peerId: 'kay', name: 'Kay', shares: [], agent: true }] as never,
        shared: [{ owner: 'kay', id: 'w1', name: 'A chat', project: 'p', role: 'view', share: 's' }],
        sharedSchedules: { w1: [{ id: 's1', title: 'Check', prompt: 'Look', sentence: 'Every day at 09:00', status: 'paused', enabled: false, pausedReason: 'This chat was archived' }] },
      }),
    );
    expect(c.schedules?.owner).toBe('Kay');
    expect(c.schedules?.items).toEqual([{ id: 's1', title: 'Check', prompt: 'Look', sentence: 'Every day at 09:00', status: 'paused', enabled: false, problem: 'This chat was archived' }]);
  });
});

describe('a run line', () => {
  const lineState = (schedule: object, level: 'info' | 'warn' = 'info'): DomainState => {
    const s = stateWith({});
    return reduce(s as AppState, { type: 'system', text: 'Schedule · Check · due 21:00', level, channel: CHANNEL, schedule } as never) as DomainState;
  };

  it('comes as a quiet line, not a message, with the counts of the Mac’s own function', () => {
    const mark = { id: 's1', title: 'Check', prompt: 'Look', due: 1000, slots: 3, missed: 2 };
    const [turn] = view(lineState(mark)).turns;
    expect(turn).toMatchObject({ who: 'system', scheduled: { title: 'Check', prompt: 'Look', due: 1000, extras: runExtras(mark) } });
    expect(turn?.scheduled?.extras).toEqual(['merged 3 slots', 'missed 2 runs while this computer was off']);
  });

  it('says when failures paused it', () => {
    const [turn] = view(lineState({ id: 's1', title: 'Check', prompt: 'Look', due: 1000, paused: true }, 'warn')).turns;
    expect(turn?.scheduled).toMatchObject({ paused: true, extras: [] });
  });
});
