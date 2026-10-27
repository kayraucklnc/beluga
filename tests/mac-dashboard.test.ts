import { describe, expect, it } from 'vitest';
import { readView } from '../src/shared/view-spec.js';
import type { Dashboard } from '../src/core/sentinel/dashboard-model.js';
import { NO_SENTINEL, type MetricSeries, type SentinelState } from '../src/core/sentinel/model.js';
import { COMPARE_CHOICES, chartRows, chartViewOf, dashboardLine, metricChoices, metricsOf, numberWords, refreshLine, tableViewOf, tileCaption, tileNote, tileWords } from '../packages/mac/src/sentinel/numbers-model.js';

/** Numbers on the Mac (docs/sentinel.md §10): a number tile's words, charts and tables as the chat's views, Add a Tile's list, the sidebar's line. */

const DAY = 86_400_000;
const T = new Date(2026, 9, 27, 8).getTime();

const revenue: MetricSeries = {
  sentinelId: 'sn_s',
  name: 'revenue',
  label: 'Revenue',
  unit: 'currency:USD',
  better: 'up',
  kind: 'number',
  points: [
    { at: T - 7 * DAY, value: 2810, runId: 'r0' },
    { at: T - DAY, value: 3180, runId: 'r6' },
    { at: T, value: 3412, runId: 'r7' },
  ],
};
const failed: MetricSeries = { ...revenue, name: 'failed', label: 'Failed payments', unit: 'count', better: 'down', points: [{ at: T - DAY, value: 3, runId: 'r6' }, { at: T, value: 1, runId: 'r7' }] };
const speed: MetricSeries = { ...revenue, sentinelId: 'sn_p', name: 'home', label: 'Home page', unit: 'ms', better: 'down', points: [{ at: T, value: 372, runId: 'p1' }] };
const jobs: MetricSeries = { ...revenue, sentinelId: 'sn_j', name: 'jobs', label: 'Last jobs', kind: 'rows', better: 'none', points: [{ at: T, value: 2, runId: 'j1' }], rows: [{ who: 'lena', job: 'deploy' }, { who: 'bob', job: 'tests' }], columns: ['who', 'job'] };

const sentinel = (id: string, name: string, extra: { projectId?: string; paused?: boolean } = {}) =>
  ({ id, name, icon: 'coin', trigger: { kind: 'manual' }, steps: [], access: 'look', limits: { minutes: 30, pauseAfter: 3 }, notify: 'off', paused: false, failures: 0, createdAt: 0, updatedAt: 0, ...extra }) as SentinelState['items'][number];

const state: SentinelState = {
  ...NO_SENTINEL,
  enabled: true,
  items: [sentinel('sn_s', 'Stripe revenue', { projectId: 'api' }), sentinel('sn_p', 'Site speed', { projectId: 'land' }), sentinel('sn_j', 'Last job run', { projectId: 'api', paused: true })],
  metrics: { sn_s: { revenue, failed }, sn_p: { home: speed }, sn_j: { jobs } },
  runs: [{ id: 'r7', sentinelId: 'sn_s', by: 'schedule', trigger: { kind: 'schedule', summary: '' }, state: 'done', startedAt: T, endedAt: T + 1000, headline: '$3,412 yesterday', steps: [], tasks: [] }],
};

const board: Dashboard = {
  id: 'db',
  name: 'Revenue',
  compare: 'previous',
  tiles: [
    { id: 'a', kind: 'number', width: 1, metric: { sentinelId: 'sn_s', metric: 'revenue' }, compare: 'week' },
    { id: 'b', kind: 'number', width: 1, metric: { sentinelId: 'sn_s', metric: 'failed' } },
    { id: 'c', kind: 'chart', width: 3, metrics: [{ sentinelId: 'sn_s', metric: 'revenue' }, { sentinelId: 'sn_p', metric: 'home' }] },
    { id: 'd', kind: 'table', width: 3, metric: { sentinelId: 'sn_j', metric: 'jobs' } },
    { id: 'e', kind: 'text', width: 2, sentinelId: 'sn_s' },
    { id: 'f', kind: 'divider', width: 3, title: 'Money' },
    { id: 'g', kind: 'number', width: 1, metric: { sentinelId: 'sn_gone', metric: 'x' } },
  ],
  createdAt: 0,
  updatedAt: 0,
};

describe('numbers on the Mac', () => {
  it('a number tile: value, change, its tone by which way is good, what it is compared with, the sparkline', () => {
    expect(numberWords(revenue, 'previous')).toEqual({ label: 'Revenue', value: '$3,412', change: '+$232 (+7.3%)', tone: 'good', vs: 'vs the run before', trend: [2810, 3180, 3412], runId: 'r7', at: T });
    expect(numberWords(revenue, 'week')).toMatchObject({ change: '+$602 (+21.4%)', vs: 'vs last week' });
    expect(numberWords(failed, 'previous')).toMatchObject({ value: '1', change: '−2 (−66.7%)', tone: 'good' });
    // Nothing a month back: it says so; the first number says that.
    expect(numberWords(failed, 'month')).toMatchObject({ tone: 'none', vs: 'nothing from last month' });
    expect(numberWords(speed, 'previous')).toMatchObject({ value: '372 ms', vs: 'its first number' });
    expect(numberWords(speed, 'previous').unit).toBeUndefined();
    expect(COMPARE_CHOICES.map((c) => c.label)).toEqual(['Previous', 'Yesterday', 'Last week', 'Last month']);
  });

  it('a sentinel’s numbers and tables; charts and tables as the chat’s views (a row per time, with its run)', () => {
    expect(metricsOf(state, 'sn_s').numbers.map((m) => m.name)).toEqual(['revenue', 'failed']);
    expect(metricsOf(state, 'sn_j')).toMatchObject({ numbers: [], tables: [{ name: 'jobs' }] });
    const { rows, keys } = chartRows([revenue, speed]);
    expect(keys).toEqual([{ key: 'm0', label: 'Revenue' }, { key: 'm1', label: 'Home page' }]);
    expect(rows.at(-1)).toEqual({ at: new Date(T).toISOString(), m0: 3412, run0: 'r7', runId: 'r7', m1: 372, run1: 'p1' });
    const chart = readView(chartViewOf([revenue], 'area', 200));
    expect(chart.ok && { type: chart.view.type, chart: chart.view.chart, x: chart.view.x, rows: chart.view.rows.length, height: chart.view.height, currency: chart.view.columns[1]?.currency }).toEqual({ type: 'chart', chart: 'area', x: 'at', rows: 3, height: 200, currency: 'USD' });
    const table = readView(tableViewOf(jobs, 4));
    expect(table.ok && { rows: table.view.rows.length, pageSize: table.view.pageSize, search: table.view.search, columns: table.view.columns.map((c) => c.key) }).toEqual({ rows: 2, pageSize: 4, search: false, columns: ['who', 'job'] });
  });

  it('a tile’s caption and quiet state, its words (Copy as Markdown), and Refresh’s line', () => {
    expect(tileCaption(state, board.tiles[0]!)).toEqual({ title: 'Revenue', from: 'Stripe revenue', state: 'ok' });
    expect(tileCaption(state, board.tiles[3]!)).toEqual({ title: 'Last jobs', from: 'Last job run', state: 'paused' });
    expect(tileCaption(state, board.tiles[6]!)).toEqual({ title: 'x', state: 'gone' });
    expect([tileNote('ok'), tileNote('paused'), tileNote('gone'), tileNote('waiting')]).toEqual([undefined, 'paused', 'gone', 'waiting for its first run']);
    expect(tileWords(state, board, board.tiles[0]!)).toEqual({ title: 'Revenue', value: '$3,412', change: '+$602 (+21.4%) vs last week' });
    expect(tileWords(state, board, board.tiles[2]!)).toEqual({ title: 'Revenue and Home page', value: 'Revenue $3,412, Home page 372 ms' });
    expect(tileWords(state, board, board.tiles[3]!)).toEqual({ title: 'Last jobs', value: '2 rows' });
    expect(tileWords(state, board, board.tiles[4]!)).toEqual({ title: 'Stripe revenue', text: '$3,412 yesterday' });
    expect([refreshLine({ done: 0, total: 3 }), refreshLine({ done: 2, total: 3 }), refreshLine(undefined)]).toEqual(['Fetching… 1 of 3', 'Fetching… 3 of 3', undefined]);
  });

  it('Add a Tile lists every metric by project and sentinel, with its last value and whether it’s on the dashboard', () => {
    const names: Record<string, string> = { api: 'bob-api', land: 'landing' };
    expect(metricChoices(state, (id) => (id ? names[id]! : 'Your Mac'), board).map((c) => [c.project, c.sentinel, c.label, c.value, c.onIt])).toEqual([
      ['bob-api', 'Last job run', 'Last jobs', '2 rows', true],
      ['bob-api', 'Stripe revenue', 'Revenue', '$3,412', true],
      ['bob-api', 'Stripe revenue', 'Failed payments', '1', true],
      ['landing', 'Site speed', 'Home page', '372 ms', true],
    ]);
  });

  it('the sidebar’s Dashboard line', () => {
    expect(dashboardLine({ metrics: {} })).toBe('No numbers yet');
    expect(dashboardLine({ metrics: {}, dashboards: [board] })).toBe('Waiting for the first number');
    expect(dashboardLine(state)).toBe('4 numbers');
    expect(dashboardLine({ ...state, dashboards: [board, { ...board, id: 'db2' }] })).toBe('4 numbers · 2 dashboards');
    expect(dashboardLine({ ...state, refreshing: { db: { done: 1, total: 2 } } })).toBe('Fetching… 2 of 2');
  });
});
