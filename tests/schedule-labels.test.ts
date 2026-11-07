import { describe, expect, it } from 'vitest';
import type { ScheduleView } from '../src/core/schedule/model.js';
import { ScheduleInputSchema, type ScheduleWhen } from '../src/core/schedule/schema.js';
import { initialState, type AppState } from '../src/core/store.js';
import { MAC_CHATS, chatMarks, dueWords, draftOf, runWords, sentLine, draftProblem, inputOf, isDirty, newDraft, nextIn, rowStatus, scheduleChannel, scheduleLine, scheduleProblem, statusTone, whenLabel, type RowStatus, type TimeWords } from '../packages/mac/src/schedule/schedule-model.js';

const NOW = new Date(2026, 10, 7, 18, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const words: TimeWords = { time: (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), date: (ms) => new Date(ms).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) };

const view = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  id: 's1',
  channel: 'ws:w1',
  title: 'Check',
  prompt: 'Look at it',
  when: { kind: 'schedule', every: 'day', at: '21:00' },
  missed: 'catch-up',
  ifBusy: 'hold',
  context: 'continue',
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
  failures: 0,
  status: 'never',
  next: NOW + 3 * HOUR,
  ...over,
});

describe('a row’s line', () => {
  it('says when and how long until the next run', () => {
    expect(scheduleLine(view(), NOW, words)).toBe('Every day at 21:00 · next in 3 h');
  });

  it('says what it does instead of a next time while it runs, waits or is paused', () => {
    expect(scheduleLine(view({ status: 'running', next: undefined as never }), NOW, words)).toBe('Every day at 21:00 · running now');
    expect(scheduleLine(view({ status: 'waiting', pending: { due: NOW, slots: 1, missed: 0 } }), NOW, words)).toBe('Every day at 21:00 · waiting for the chat');
    const { next: _next, ...noNext } = view();
    expect(scheduleLine({ ...noNext, enabled: false, pausedReason: 'Paused by you' }, NOW, words)).toBe('Every day at 21:00 · paused');
  });

  it('calls a once schedule that ran done', () => {
    const { next: _next, ...noNext } = view({ when: { kind: 'once', at: NOW - HOUR } });
    expect(scheduleLine({ ...noNext, enabled: false, last: 'ok', status: 'ok' }, NOW, words)).toMatch(/^Once on 7 Nov at 17:00 · done$/);
  });
});

describe('when', () => {
  it('reads each kind in the given time format', () => {
    expect(whenLabel({ kind: 'interval', minutes: 1 }, words)).toBe('Every minute');
    expect(whenLabel({ kind: 'interval', minutes: 45 }, words)).toBe('Every 45 minutes');
    expect(whenLabel({ kind: 'schedule', every: 'week', at: '07:05', days: [1, 3] }, words)).toBe('Every week on Mon, Wed at 07:05');
    expect(whenLabel({ kind: 'schedule', every: 'hours', at: '00:00', hours: 3 }, words)).toBe('Every 3 hours');
    const twelve: TimeWords = { ...words, time: (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) };
    expect(whenLabel({ kind: 'schedule', every: 'day', at: '21:00' }, twelve)).toMatch(/^Every day at 9:00\sPM$/);
  });

  it('counts down in minutes, hours, then days', () => {
    expect(nextIn(NOW - 1, NOW)).toBe('due now');
    expect(nextIn(NOW + 30_000, NOW)).toBe('next in 1 min');
    expect(nextIn(NOW + 12 * MIN, NOW)).toBe('next in 12 min');
    expect(nextIn(NOW + 3 * HOUR, NOW)).toBe('next in 3 h');
    expect(nextIn(NOW + 72 * HOUR, NOW)).toBe('next in 3 days');
  });
});

describe('the status dot', () => {
  it('has its own tone for never, waiting, running, ok and failed; paused and interrupted warn', () => {
    const tones = (['never', 'waiting', 'running', 'ok', 'failed', 'paused'] as RowStatus[]).map(statusTone);
    expect(new Set(tones).size).toBe(6);
    expect(statusTone('interrupted')).toBe('warn');
  });

  it('shows paused, except during a run and for a once schedule that finished', () => {
    expect(rowStatus(view({ enabled: false, status: 'ok', last: 'ok' }))).toBe('paused');
    expect(rowStatus(view({ enabled: false, status: 'running' }))).toBe('running');
    expect(rowStatus(view({ enabled: false, status: 'ok', last: 'ok', when: { kind: 'once', at: NOW } }))).toBe('ok');
    expect(rowStatus(view({ enabled: false, status: 'failed', last: 'failed', pausedReason: 'This chat was archived', when: { kind: 'once', at: NOW } }))).toBe('paused');
  });
});

describe('the sidebar mark', () => {
  it('shows for a schedule that is on, muted when all are paused, and not for a finished once schedule', () => {
    const on = view({ id: 'a', channel: 'ws:one' });
    const paused = view({ id: 'b', channel: 'ws:one', enabled: false, pausedReason: 'Paused by you' });
    const alone = view({ id: 'c', channel: 'ws:two', enabled: false, pausedReason: 'Paused by you' });
    const done = view({ id: 'd', channel: 'ws:three', enabled: false, last: 'ok', status: 'ok', when: { kind: 'once', at: NOW } });
    const map = chatMarks([paused, on, alone, done]);
    expect(map['ws:one']).toMatchObject({ paused: false, item: { id: 'a' } });
    expect(map['ws:two']).toMatchObject({ paused: true });
    expect(map['ws:three']).toBeUndefined();
  });

  it('gathers Your Mac’s chats on its one row, and makes one map per list', () => {
    const items = [view({ channel: 'mac:assistant:x' })];
    expect(chatMarks(items)[MAC_CHATS]).toMatchObject({ paused: false });
    expect(chatMarks(items)).toBe(chatMarks(items));
  });
});

describe('the run line', () => {
  it('says when it was due, in the time format', () => {
    expect(dueWords(new Date(2026, 10, 7, 21, 0).getTime(), words)).toBe('due 21:00');
  });
});

describe('the run line’s words', () => {
  const due = new Date(2026, 10, 7, 21, 0).getTime();

  it('adds the counts after the due time', () => {
    expect(runWords({ due, slots: 3, missed: 0 }, words)).toEqual(['due 21:00', 'merged 3 slots']);
    expect(runWords({ due, slots: 1, missed: 2 }, words)).toEqual(['due 21:00', 'missed 2 runs while this computer was off']);
    expect(runWords({ due, slots: 3, missed: 2 }, words)).toEqual(['due 21:00', 'merged 3 slots', 'missed 2 runs while this computer was off']);
  });

  it('shows only the due time for a plain run, and for an old saved line with no counts', () => {
    expect(runWords({ due, slots: 1, missed: 0 }, words)).toEqual(['due 21:00']);
    expect(runWords({ due }, words)).toEqual(['due 21:00']);
  });
});

describe('the reason', () => {
  it('shows why it failed or paused, and stays quiet for your own pause', () => {
    expect(scheduleProblem(view({ last: 'failed', lastError: 'No network' }))).toBe('No network');
    expect(scheduleProblem(view({ enabled: false, pausedReason: 'This chat was archived' }))).toBe('This chat was archived');
    expect(scheduleProblem(view({ enabled: false, pausedReason: 'Paused after 3 failed runs in a row', last: 'failed', lastError: 'No network' }))).toBe('Paused after 3 failed runs in a row. The last one: No network');
    expect(scheduleProblem(view({ enabled: false, pausedReason: 'Paused by you' }))).toBeUndefined();
    expect(scheduleProblem(view({ last: 'ok' }))).toBeUndefined();
  });
});

describe('which chat can have one', () => {
  const state = (over: Pick<AppState, 'view'>, on = true): AppState => {
    const base = initialState('room');
    const project = { id: 'p', name: 'p', root: '/p', workspaces: [{ id: 'w', kind: 'worktree', name: 'w' }, { id: 'm', kind: 'main', name: 'm' }, { id: 'a', kind: 'chat', name: 'a', archived: true }, { id: 'c', kind: 'chat', name: 'c' }] };
    return { ...base, prefs: { ...base.prefs, chatSchedules: on }, projects: [project] as unknown as AppState['projects'], ...over } as AppState;
  };

  it('is a worktree, a project chat or a Your Mac chat, while the setting is on', () => {
    expect(scheduleChannel(state({ view: { kind: 'workspace', id: 'w' } as AppState['view'] }))).toBe('ws:w');
    expect(scheduleChannel(state({ view: { kind: 'workspace', id: 'c' } as AppState['view'] }))).toBe('ws:c');
    expect(scheduleChannel(state({ view: { kind: 'assistant', chat: 'x' } }))).toMatch(/^mac:assistant/);
    expect(scheduleChannel(state({ view: { kind: 'assistant' } }))).toMatch(/^mac:assistant/);
    expect(scheduleChannel(state({ view: { kind: 'workspace', id: 'w' } as AppState['view'] }, false))).toBeUndefined();
  });

  it('is not a main folder, an archived chat or the room', () => {
    expect(scheduleChannel(state({ view: { kind: 'workspace', id: 'm' } as AppState['view'] }))).toBeUndefined();
    expect(scheduleChannel(state({ view: { kind: 'workspace', id: 'a' } as AppState['view'] }))).toBeUndefined();
    expect(scheduleChannel(state({ view: { kind: 'room' } }))).toBeUndefined();
  });
});

describe('the editor’s form', () => {
  const filled = { ...newDraft(NOW), title: ' Check ', prompt: ' Look ' };

  it('says what is missing', () => {
    expect(draftProblem(newDraft(NOW), NOW)).toMatch(/name/);
    expect(draftProblem({ ...newDraft(NOW), title: 'x' }, NOW)).toMatch(/agent should do/);
    expect(draftProblem(filled, NOW)).toBeUndefined();
    expect(draftProblem({ ...filled, whenKind: 'interval', minutes: '0' }, NOW)).toMatch(/whole number/);
    expect(draftProblem({ ...filled, whenKind: 'interval', minutes: '1.5' }, NOW)).toMatch(/whole number/);
    expect(draftProblem({ ...filled, whenKind: 'once', onceAt: '' }, NOW)).toMatch(/date/);
    expect(draftProblem({ ...filled, whenKind: 'once', onceAt: '2020-01-01T10:00' }, NOW)).toMatch(/past/);
  });

  it('makes what the API takes, for each kind', () => {
    const parse = (d: typeof filled) => ScheduleInputSchema.parse(inputOf(d));
    expect(parse(filled)).toMatchObject({ title: 'Check', prompt: 'Look', when: { kind: 'schedule', every: 'day', at: '07:00' }, context: 'continue', enabled: true });
    expect(inputOf(filled)?.when).not.toHaveProperty('missed');
    expect(parse({ ...filled, whenKind: 'interval', minutes: '15' }).when).toEqual({ kind: 'interval', minutes: 15 });
    expect(parse({ ...filled, whenKind: 'once', onceAt: '2030-01-02T10:30' }).when).toEqual({ kind: 'once', at: new Date(2030, 0, 2, 10, 30).getTime() });
  });

  it('goes back and forth with a saved schedule without becoming dirty', () => {
    const kinds: ScheduleWhen[] = [{ kind: 'schedule', every: 'week', at: '21:00', days: [1] }, { kind: 'interval', minutes: 15 }, { kind: 'once', at: new Date(2030, 0, 2, 10, 30).getTime() }];
    for (const when of kinds) {
      const saved = draftOf(view({ when, ifBusy: 'skip', context: 'fresh', missed: 'skip' }), NOW);
      expect(inputOf(saved)).toMatchObject({ when, ifBusy: 'skip', context: 'fresh', missed: 'skip' });
      expect(isDirty(draftOf(view({ when, ifBusy: 'skip', context: 'fresh', missed: 'skip' }), NOW), saved)).toBe(false);
      expect(isDirty({ ...saved, title: 'New' }, saved)).toBe(true);
    }
  });
});

describe('a guest row', () => {
  const guest = { id: 's1', title: 'Check', prompt: 'Look', sentence: 'Every day at 21:00', enabled: true } as const;

  it('says the owner’s words for when, then what comes next', () => {
    expect(sentLine({ ...guest, status: 'ok', next: NOW + 3 * HOUR }, NOW)).toBe('Every day at 21:00 · next in 3 h');
    expect(sentLine({ ...guest, status: 'running' }, NOW)).toBe('Every day at 21:00 · running now');
    expect(sentLine({ ...guest, status: 'waiting' }, NOW)).toBe('Every day at 21:00 · waiting for the chat');
    expect(sentLine({ ...guest, status: 'paused', enabled: false }, NOW)).toBe('Every day at 21:00 · paused');
    expect(sentLine({ ...guest, status: 'ok', enabled: false }, NOW)).toBe('Every day at 21:00 · done');
  });
});
