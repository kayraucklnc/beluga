import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Dashboard, type Tile } from '../src/core/sentinel/dashboard-model.js';
import { NO_SENTINEL, type MetricSeries, type RunSummary, type Sentinel, type SentinelState } from '../src/core/sentinel/model.js';
import { keepWidgetSnapshot, plainText, tintOf, widgetSnapshot } from '../src/core/sentinel/widgets.js';
import { Store, initialState } from '../src/core/store.js';
import { waitFor } from './helpers.js';

/** Board tiles as macOS widgets (BLG-309): the snapshot the widget reads, in words, and the file kept in step. */

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 21, 9);

const sentinel = (over: Partial<Sentinel> & Pick<Sentinel, 'id' | 'name'>): Sentinel => ({
  icon: 'coin',
  trigger: { kind: 'schedule', every: 'day', at: '08:00', missed: 'catch-up' },
  steps: [{ id: 'ask', kind: 'claude', name: 'Add it up', prompt: 'x', where: 'project' }],
  access: 'look',
  limits: { minutes: 30, pauseAfter: 3 },
  notify: 'mac',
  paused: false,
  failures: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const revenue: MetricSeries = {
  sentinelId: 'sn_s',
  name: 'revenue',
  label: 'Revenue',
  unit: 'currency:USD',
  better: 'up',
  kind: 'number',
  points: Array.from({ length: 8 }, (_, i) => ({ at: T0 + i * DAY, value: 3000 + i * 50, runId: `r${i}` })),
};
const byDay: MetricSeries = { ...revenue, name: 'by-day', label: 'Signups by day', unit: 'count', kind: 'series', series: [{ x: 'Mon', y: 18 }, { x: 'Tue', y: 22 }, { x: 'Wed', y: 30 }] };

const tiles: Tile[] = [
  { id: 'h', kind: 'divider', title: 'This week', width: 6 },
  { id: 'n', kind: 'number', metric: { sentinelId: 'sn_s', metric: 'revenue' }, width: 1 },
  { id: 's', kind: 'series', metric: { sentinelId: 'sn_s', metric: 'by-day' }, width: 3 },
  { id: 'o', kind: 'output', step: { sentinelId: 'sn_s', stepId: 'ask' }, width: 3, title: 'This morning' },
  { id: 'x', kind: 'text', sentinelId: 'sn_s', width: 2 },
  { id: 'g', kind: 'number', metric: { sentinelId: 'sn_gone', metric: 'revenue' }, width: 1 },
];
const board: Dashboard = { id: 'd1', name: 'Overview', compare: 'previous', tiles, createdAt: 0, updatedAt: 0 };
const run: RunSummary = { id: 'r9', sentinelId: 'sn_s', by: 'schedule', trigger: { kind: 'schedule', summary: '' }, state: 'done', startedAt: T0, endedAt: T0 + 60_000, headline: '$3,350 yesterday', steps: [], tasks: [] };

const state = (over: Partial<SentinelState> = {}): SentinelState => ({
  ...NO_SENTINEL,
  enabled: true,
  items: [sentinel({ id: 'sn_s', name: 'Stripe revenue', projectId: 'p1' })],
  runs: [run],
  dashboards: [board],
  metrics: { sn_s: { revenue, 'by-day': byDay } },
  outputs: { sn_s: { ask: { text: '# Yesterday\n\n**$3,350** from [Stripe](https://stripe.com), 6 new subscriptions.\n\n- one refund', format: 'markdown', at: T0, runId: 'r9' } } },
  ...over,
});

describe('the widgets’ snapshot', () => {
  const snap = widgetSnapshot(state(), (id) => (id === 'p1' ? { name: 'bob-api', icon: 'icons/p1.png' } : undefined));
  const by = (id: string) => snap.tiles.find((t) => t.id === `d1/${id}`)!;

  it('every tile but headings, each opening its board on that tile', () => {
    expect(snap.tiles.map((t) => t.id)).toEqual(['d1/n', 'd1/s', 'd1/o', 'd1/x', 'd1/g']);
    expect(by('n').url).toBe('beluga://board/d1?tile=n');
    expect(by('n').board).toBe('Overview');
  });

  it('a number in words: its value, its change and which way is good, its points', () => {
    expect(by('n')).toMatchObject({ kind: 'number', title: 'Revenue', value: '$3,350', change: expect.stringContaining('+$50'), tone: 'good', vs: 'vs the run before', project: 'bob-api', icon: 'icons/p1.png' });
    expect(by('n').points).toHaveLength(8);
    expect(by('n').tint).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('a kept array as a chart with its first and last labels; an output and a headline as plain text', () => {
    expect(by('s')).toMatchObject({ kind: 'chart', points: [18, 22, 30], from: 'Mon', to: 'Wed', value: '30' });
    expect(by('o').text).toBe('Yesterday\n\n$3,350 from Stripe, 6 new subscriptions.\n\n· one refund');
    expect(by('x')).toMatchObject({ kind: 'text', title: 'Stripe revenue', text: '$3,350 yesterday' });
  });

  it('a tile whose sentinel is gone says so', () => {
    expect(by('g').note).toBe('gone');
  });

  it('plain text is short, and a tint is the letter tile’s hue', () => {
    expect(plainText('x'.repeat(700)).length).toBe(600);
    expect(tintOf('bob-api')).toBe(tintOf('bob-api'));
    expect(tintOf('bob-api')).not.toBe(tintOf('landing'));
  });
});

describe('the snapshot file', () => {
  it('is written a moment after what a tile shows changes, and not again when nothing did', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-widgets-'));
    const store = new Store(initialState('room'));
    store.dispatch({ type: 'sentinel_init', state: state() } as never);
    const stop = keepWidgetSnapshot(store, dir, () => undefined, 10);
    const file = path.join(dir, 'tiles.json');
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes('$3,350'));
    const first = JSON.parse(readFileSync(file, 'utf8')) as { version: number; tiles: unknown[] };
    expect(first.version).toBe(1);
    expect(first.tiles).toHaveLength(5);
    stop();
  });
});
