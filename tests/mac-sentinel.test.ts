import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PRESETS,
  LATER,
  MAC_SCOPE,
  byWords,
  chatPlaceOf,
  countsOf,
  dotStrip,
  duplicateStep,
  durationText,
  filterSentinels,
  footLine,
  groupSentinels,
  iconOf,
  moveStep,
  nextText,
  rowOf,
  runLine,
  runsFolderOf,
  sharedModel,
  sidebarLine,
  stepChoices,
  toggleDay,
  triggerChoices,
  triggerOfKind,
  whenText,
  withEvery,
  withModel,
  anyRunning,
} from '../packages/mac/src/sentinel/sentinel-model.js';
import { panelFits } from '../packages/mac/src/lib/panel-model.js';
import { dockCount, isSentinelOwned, projectTally, unreadEntries } from '../packages/mac/src/layout/attention-model.js';
import { initialAppState, reduceApp } from '../src/client/screen.js';
import type { Action, AppState } from '../src/core/store.js';
import type { Notice } from '../src/core/work-store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { NO_SENTINEL, type RunSummary, type Sentinel, type SentinelState, type Step } from '../src/core/sentinel/model.js';

/** Sentinel on the Mac, its plain parts: rows, groups, the sidebar's line, times, the schedule's controls, step edits. */

const at = (y: number, m: number, d: number, hh: number, mm = 0): number => new Date(y, m - 1, d, hh, mm).getTime();
const NOW = at(2026, 10, 23, 9, 30); // a Friday

const sentinel = (over: Partial<Sentinel> & Pick<Sentinel, 'id' | 'name'>): Sentinel => ({
  icon: 'calendar',
  trigger: { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' },
  steps: [],
  access: 'look',
  limits: { minutes: 30, pauseAfter: 3 },
  notify: 'mac',
  paused: false,
  failures: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const run = (over: Partial<RunSummary> & Pick<RunSummary, 'id' | 'sentinelId'>): RunSummary => ({
  by: 'schedule',
  trigger: { kind: 'schedule', summary: 'Every day at 7:00' },
  state: 'done',
  startedAt: at(2026, 10, 23, 7),
  endedAt: at(2026, 10, 23, 7, 2),
  headline: '3 commits landed',
  steps: [],
  tasks: [],
  ...over,
});

const brief = sentinel({ id: 'sn_brief', name: 'Morning brief', projectId: 'api', steps: [{ id: 'a', kind: 'claude', name: 'Read what changed', prompt: 'Brief', where: 'project' }, { id: 'b', kind: 'notify', name: 'Tell me', phone: true }] });
const nightly = sentinel({ id: 'sn_night', name: 'Nightly tests', projectId: 'api', paused: true, pausedWhy: 'Paused after 3 failures in a row', failures: 3 });
const mac = sentinel({ id: 'sn_mac', name: 'Disk check', trigger: { kind: 'manual' } });
const web = sentinel({ id: 'sn_web', name: 'Watch the web', projectId: 'landing' });

const state = (over: Partial<SentinelState> = {}): SentinelState => ({ ...NO_SENTINEL, enabled: true, items: [brief, nightly, mac, web], nextAt: { sn_brief: at(2026, 10, 24, 7), sn_web: at(2026, 10, 24, 6) }, ...over });

describe('Sentinel on the Mac', () => {
  it('counts, filters and scopes the list', () => {
    const items = state().items;
    expect(countsOf(items)).toEqual({ watching: 3, paused: 1, all: 4 });
    expect(filterSentinels(items, { show: 'paused' }).map((s) => s.id)).toEqual(['sn_night']);
    expect(filterSentinels(items, { show: 'watching', scope: 'api' }).map((s) => s.id)).toEqual(['sn_brief']);
    expect(filterSentinels(items, { show: 'all', scope: MAC_SCOPE }).map((s) => s.id)).toEqual(['sn_mac']);
    // The filter reads the name, the sentence and the steps.
    expect(filterSentinels(items, { show: 'all', query: 'tell me' }).map((s) => s.id)).toEqual(['sn_brief']);
    expect(filterSentinels(items, { show: 'all', query: 'press run' }).map((s) => s.id)).toEqual(['sn_mac']);
  });

  it('groups rows by project in the sidebar’s order, Your Mac last, names A to Z', () => {
    const groups = groupSentinels(state().items, [{ id: 'landing', name: 'landing' }, { id: 'api', name: 'bob-api' }]);
    expect(groups.map((g) => [g.name, g.items.map((s) => s.name)])).toEqual([
      ['landing', ['Watch the web']],
      ['bob-api', ['Morning brief', 'Nightly tests']],
      ['Your Mac', ['Disk check']],
    ]);
  });

  it('makes a row: the sentence, the last run, when it runs next', () => {
    const st = state({ runs: [run({ id: 'r1', sentinelId: 'sn_brief', startedAt: NOW - 2 * 3_600_000 })] });
    const row = rowOf(st, brief, NOW);
    expect(row.sentence).toBe('Every day at 7:00');
    expect(row.last).toMatchObject({ state: 'done', label: 'Done', tone: 'ok', headline: '3 commits landed', when: '2 h ago' });
    expect(row.next).toBe('next tomorrow 7:00');
    expect(row.steps.map((s) => s.kind)).toEqual(['claude', 'notify']);
    // Paused: no "next"; never run: no last.
    expect(rowOf(st, nightly, NOW).next).toBeUndefined();
    expect(rowOf(st, mac, NOW).last).toBeUndefined();
    // Running: live, and the headline says so until it has one.
    const going = state({ runs: [run({ id: 'r2', sentinelId: 'sn_web', state: 'running', headline: '', endedAt: undefined })] });
    expect(rowOf(going, web, NOW)).toMatchObject({ live: true, last: { headline: 'Running…', label: 'Running' } });
  });

  it('says the sidebar’s line: watching and the next run, a problem first, or nothing yet', () => {
    expect(sidebarLine(state())).toEqual({ text: 'Paused after 3 failures in a row', problem: true });
    const fine = state({ items: [brief, mac, web] });
    expect(sidebarLine(fine)).toEqual({ text: '3 watching · next at 6:00', problem: false });
    expect(sidebarLine({ ...NO_SENTINEL, enabled: true })).toEqual({ text: 'Nothing watching yet', problem: false });
    expect(sidebarLine({ ...NO_SENTINEL, enabled: true, items: [{ ...mac, paused: true }] }).text).toBe('Nothing watching · 1 paused');
    expect(anyRunning(state({ live: { r: { state: 'running' } } }))).toBe(true);
    expect(anyRunning(state({ live: { r: { state: 'needs-you' } } }))).toBe(false);
  });

  it('writes the foot', () => {
    const runs = [run({ id: 'r1', sentinelId: 'sn_brief', startedAt: NOW - 120_000 })];
    expect(footLine(state().items, runs, NOW)).toBe('3 watching · 1 paused · last run 2 min ago');
    expect(footLine([mac], [], NOW)).toBe('1 watching');
  });

  it('says times and durations', () => {
    expect(whenText(at(2026, 10, 23, 7), NOW)).toBe('Today 7:00');
    expect(whenText(at(2026, 10, 22, 2), NOW)).toBe('Yesterday 2:00');
    expect(whenText(at(2026, 10, 20, 2), NOW)).toBe('Tue 2:00');
    expect(whenText(at(2026, 10, 3, 2), NOW)).toBe('Oct 3 2:00');
    expect(nextText(at(2026, 10, 23, 17, 5), NOW)).toBe('17:05');
    expect(nextText(at(2026, 10, 26, 7), NOW)).toBe('Mon 7:00');
    expect(durationText(2_100)).toBe('2.1 s');
    expect(durationText(48_000)).toBe('48 s');
    expect(durationText(252_000)).toBe('4 min 12 s');
    expect(durationText(120_000)).toBe('2 min');
    expect(durationText(3_780_000)).toBe('1 h 3 min');
  });

  it('says who ran a run, and the run page’s line', () => {
    const st = state({ runs: [run({ id: 'r1', sentinelId: 'sn_night' })] });
    expect(byWords({ by: 'schedule', trigger: { kind: 'schedule', summary: '' } }, st)).toBe('schedule');
    expect(byWords({ by: 'phone', trigger: { kind: 'manual', summary: '' } }, st)).toBe('your phone');
    expect(byWords({ by: 'event', trigger: { kind: 'github', summary: 'GitHub #48' } }, st)).toBe('GitHub #48');
    expect(byWords({ by: 'after:r1', trigger: { kind: 'after', summary: '' } }, st)).toBe('after Nightly tests');
    expect(byWords({ by: 'after:gone', trigger: { kind: 'after', summary: '' } }, st)).toBe('after another sentinel');
    const r = run({ id: 'r9', sentinelId: 'sn_night', startedAt: at(2026, 10, 20, 2), endedAt: at(2026, 10, 20, 2) + 252_000 });
    expect(runLine(r, 'Nightly tests', st, NOW)).toBe('Nightly tests · ran by schedule · Tue 2:00 · 4 min 12 s');
  });

  it('draws the dot strip: the last 30, oldest first, in their tones', () => {
    const runs = Array.from({ length: 34 }, (_, i) => run({ id: `r${i}`, sentinelId: 'sn_brief', startedAt: i, state: i === 33 ? 'failed' : i === 32 ? 'skipped' : 'done' }));
    const dots = dotStrip([...runs].reverse());
    expect(dots).toHaveLength(30);
    expect(dots[0]!.id).toBe('r4');
    expect(dots.at(-1)).toMatchObject({ id: 'r33', tone: 'error' });
    expect(dots.at(-2)!.tone).toBe('muted');
  });

  it('finds where a run’s chat is, and the runs folder', () => {
    expect(chatPlaceOf('ws:wt-1')).toEqual({ kind: 'workspace', id: 'wt-1' });
    expect(chatPlaceOf('mac:assistant')).toEqual({ kind: 'assistant' });
    expect(chatPlaceOf('mac:assistant:k2')).toEqual({ kind: 'assistant', chat: 'k2' });
    expect(chatPlaceOf('room')).toBeUndefined();
    expect(runsFolderOf([{ report: '/Users/k/.beluga/sentinel/runs/run_1/report.md' }])).toBe('/Users/k/.beluga/sentinel/runs');
    expect(runsFolderOf([{}])).toBeUndefined();
  });

  it('changes a schedule: every, the weekday chips', () => {
    const day = { kind: 'schedule', every: 'day', at: '07:00', missed: 'skip' } as const;
    expect(withEvery(day, 'week')).toEqual({ kind: 'schedule', every: 'week', at: '07:00', missed: 'skip', days: [1] });
    expect(withEvery(day, 'month')).toMatchObject({ every: 'month', day: 1 });
    expect(withEvery({ ...day, every: 'week', days: [1, 3] }, 'hours')).toEqual({ kind: 'schedule', every: 'hours', at: '07:00', missed: 'skip', hours: 3 });
    expect(toggleDay([1], 3)).toEqual([1, 3]);
    expect(toggleDay([1, 3], 1)).toEqual([3]);
    // One day stays on; Sunday sorts last, as the chips show.
    expect(toggleDay([3], 3)).toEqual([3]);
    expect(toggleDay([1], 0)).toEqual([1, 0]);
  });

  it('offers only what this Beluga runs: the rest is shown for a later update, or refused by the access', () => {
    const triggers = triggerChoices();
    expect(triggers.filter((c) => !c.disabled).map((c) => c.value)).toEqual(['schedule', 'manual']);
    expect(triggers.find((c) => c.value === 'github')).toMatchObject({ disabled: true, description: LATER });
    expect(triggerOfKind('manual', { kind: 'schedule', every: 'day', at: '07:00', missed: 'skip' })).toEqual({ kind: 'manual' });
    expect(triggerOfKind('schedule', { kind: 'manual' })).toMatchObject({ kind: 'schedule', every: 'day' });
    expect(triggerOfKind('github', { kind: 'manual' })).toBeUndefined();
    const steps = stepChoices('look');
    expect(steps).toHaveLength(9);
    expect(steps.filter((c) => !c.disabled).map((c) => c.kind)).toEqual(['claude', 'script', 'notify']);
    expect(steps.find((c) => c.kind === 'merge')!.hint).toBe(LATER);
  });

  it('edits steps: move, duplicate, one model for every Claude step', () => {
    const steps: Step[] = [
      { id: 'a', kind: 'claude', name: 'Read', prompt: 'x', where: 'project', model: 'opus' },
      { id: 'b', kind: 'script', name: 'Test', command: 'npm test', cwd: 'project', timeoutSec: 120 },
      { id: 'c', kind: 'claude', name: 'Fix', prompt: 'y', where: 'worktree', model: 'opus' },
    ];
    expect(moveStep(steps, 0, 1).map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(moveStep(steps, 0, -1).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    const copy = duplicateStep(steps, 1);
    expect(copy).toHaveLength(4);
    expect(copy[2]).toMatchObject({ kind: 'script', name: 'Test copy' });
    expect('id' in copy[2]!).toBe(false);
    expect(sharedModel(steps)).toBe('opus');
    expect(sharedModel([steps[0]!, { ...(steps[2] as Extract<Step, { kind: 'claude' }>), model: 'haiku' }])).toBeUndefined();
    expect(sharedModel([steps[1]!])).toBe('');
    const plain = withModel(steps, '');
    expect(plain.some((s) => s.kind === 'claude' && 'model' in s)).toBe(false);
    expect(sharedModel(withModel(steps, 'sonnet'))).toBe('sonnet');
  });

  it('has the six Ask Claude presets, each a prompt that says when to stop or what to make', () => {
    expect(CLAUDE_PRESETS.map((p) => p.label)).toEqual(['Write a brief of what changed', 'Turn this into tasks', 'Investigate and fix it', 'Review the changes', 'Update dependencies and run the tests', 'Write release notes']);
    for (const p of CLAUDE_PRESETS) expect(p.prompt.length).toBeGreaterThan(80);
  });

  it('knows its icons, the shield for anything else', () => {
    expect(iconOf('calendar')).toBe('calendar');
    expect(iconOf('rocket')).toBe('sentinel');
    expect(iconOf(undefined)).toBe('sentinel');
  });

  it('takes the whole window: no right panel on the list, a sentinel’s page or a run', () => {
    expect(panelFits({ kind: 'sentinel' })).toBe(false);
    expect(panelFits({ kind: 'sentinel_page', id: 'sn_1' })).toBe(false);
    expect(panelFits({ kind: 'sentinel_run', runId: 'run_1' })).toBe(false);
    expect(panelFits({ kind: 'overview' })).toBe(true);
  });
});

describe('a sentinel run’s conversations in Unread and the Dock', () => {
  const ws = (id: string, kind: Workspace['kind']): Workspace => ({ id, projectRoot: '/p', name: id, path: `/wt/${id}`, kind, branch: `b/${id}`, base: 'origin/main', createdAt: 1, projectId: 'api', external: false, status: { changed: 0, ahead: 0, behind: 0 } });
  const api: Project = { id: 'api', name: 'bob-api', root: '/p', base: 'origin/main', workspaces: [ws('main', 'main'), ws('mine', 'worktree'), ws('brief-chat', 'chat')] };
  const apply = (s: AppState, ...actions: Action[]): AppState => actions.reduce<AppState>((st, a) => reduceApp(st, a), s);
  const done = (channel: string, requestId: string): Action => ({ type: 'agent_event', owner: 'me', requestId, requester: 'me', event: 'done', text: 'Brief written', ts: 5, channel });
  const notice = (ts: number, over: Partial<Notice>): Action => ({ type: 'notice_add', notice: { kind: 'done', title: 't', body: '', ...over } as Notice, ts }) as Action;
  const ask = (qid: string, channel: string): Action => ({
    type: 'question_add',
    question: { qid, requestId: 'r9', owner: 'me', channel, picked: {}, question: { kind: 'question', questions: [{ question: 'Which branch?', header: '', options: [], multiSelect: false }] } },
  });
  const sentinels = state({ runs: [run({ id: 'run_1', sentinelId: 'sn_brief', channel: 'ws:brief-chat', steps: [{ id: 'a', state: 'done', channel: 'ws:brief-chat' }] }), run({ id: 'run_2', sentinelId: 'sn_mac', channel: 'mac:assistant:c7' })] });
  const base = (): AppState =>
    apply(initialAppState('room'), { type: 'welcome', self: { peerId: 'me', name: 'kay', agent: true, shares: [] } }, { type: 'projects', projects: [api] }, { type: 'sentinel_init', state: sentinels }, { type: 'view', view: { kind: 'overview' } } as unknown as Action);

  it('a finished run’s chat is in neither Unread, the project’s tally nor the Dock', () => {
    const s = apply(base(), done('ws:brief-chat', 'r1'), done('ws:mine', 'r2'), done('mac:assistant:c7', 'r3'), notice(1, { channel: 'ws:brief-chat' }), notice(2, { channel: 'mac:assistant:c7', tag: 'sentinel' }));
    expect(s.unread['ws:brief-chat']).toBe(1);
    expect(isSentinelOwned(s, 'ws:brief-chat')).toBe(true);
    expect(isSentinelOwned(s, 'mac:assistant:c7')).toBe(true);
    expect(isSentinelOwned(s, 'ws:mine')).toBe(false);
    expect(unreadEntries(s).map((e) => e.channel)).toEqual(['ws:mine']);
    expect(projectTally(s, api).unread).toBe(1);
    expect(dockCount(s)).toBe(1);
  });

  it('one that needs you shows once, as the sentinel’s, and opens the run’s chat', () => {
    const s = apply(base(), done('ws:brief-chat', 'r1'), ask('q1', 'ws:brief-chat'), notice(1, { kind: 'needsYou', tag: 'question', ref: 'q1', channel: 'ws:brief-chat' }));
    const entries = unreadEntries(s);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e).toMatchObject({ kind: 'sentinel', channel: 'sentinel:sn_brief', name: 'Morning brief', at: 'ws:brief-chat', runId: 'run_1', signal: { level: 'needs', need: 'question', tip: 'Morning brief asks a question' } });
    // The question and its notice are that one entry.
    expect(dockCount(s)).toBe(1);
    // Answered: gone again.
    const answered = apply(s, { type: 'question_remove', qid: 'q1' });
    expect(unreadEntries(answered)).toEqual([]);
  });
});
