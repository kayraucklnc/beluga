import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DASHBOARD_TOOL_NAMES, createDashboardToolDefs } from '../src/agent/dashboard-tools.js';
import { decideTool } from '../src/agent/policy.js';
import { autoTiles, dashboardMarkdown, dashboardSentinels, gridLanding, moveTile, tileState } from '../src/core/sentinel/dashboard-model.js';
import { Dashboards } from '../src/core/sentinel/dashboards.js';
import { MetricFiles } from '../src/core/sentinel/metric-files.js';
import { baselineOf, changeText, deltaOf, formatMetric, measureFrom, pickPath, prunePoints, readOutput, thenOf, toNumber } from '../src/core/sentinel/metrics.js';
import { type MetricPoint, type Sentinel, POINTS_IN_STATE, claudeWidened, stepSentence } from '../src/core/sentinel/model.js';
import { attachSentinel } from '../src/core/sentinel/registry.js';
import { StepInputSchema } from '../src/core/sentinel/schema.js';
import { sinceOf } from '../src/core/sentinel/sentinels.js';
import type { Session } from '../src/core/session.js';
import { API, parseArgs } from '../src/ipc/api.js';
import { DASHBOARD_HANDLERS } from '../src/ipc/dashboard-handlers.js';
import { SENTINEL_HANDLERS } from '../src/ipc/sentinel-handlers.js';
import { PHONE } from '../src/companion/coverage.js';
import { fakeShell, setup, until } from './sentinel-fakes.js';

/** Numbers and dashboards (docs/sentinel.md §10): reading, picking, comparing, keeping, the tools and the API. */

const DAY = 24 * 60 * 60_000;
const pts = (values: ReadonlyArray<readonly [number, number]>): MetricPoint[] => values.map(([at, value], i) => ({ at, value, runId: `r${i}` }));

const tmp: string[] = [];
const dirOf = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-numbers-'));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('reading what a step said', () => {
  it('a bare number, JSON, "name: value" lines, CSV, or text', () => {
    expect(readOutput('1204\n')).toBe(1204);
    expect(readOutput('  $3,400.50 ')).toBe(3400.5);
    expect(readOutput('{"items":[{"statistics":{"subscriberCount":"1204"}}]}')).toEqual({ items: [{ statistics: { subscriberCount: '1204' } }] });
    expect(readOutput('customers: 41\nrevenue = $3,400\nnote: fine')).toEqual({ customers: 41, revenue: 3400, note: 'fine' });
    expect(readOutput('name,count\njobs,12\nusers,30')).toEqual([{ name: 'jobs', count: 12 }, { name: 'users', count: 30 }]);
    expect(readOutput('all good today')).toBe('all good today');
    expect(readOutput('')).toBeUndefined();
  });

  it('numbers read kindly, and only numbers', () => {
    expect([toNumber('12.5%'), toNumber('340 ms'), toNumber('1 204'), toNumber('-3'), toNumber('€9'), toNumber(7)]).toEqual([12.5, 340, 1204, -3, 9, 7]);
    expect([toNumber('twelve'), toNumber(''), toNumber(true), toNumber(Number.NaN), toNumber('1.2.3')]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('paths: $., dots and [0], a leading rows on rows, a column of rows, names read kindly', () => {
    const yt = { items: [{ statistics: { subscriberCount: '1204' } }] };
    expect(pickPath(yt, '$.items[0].statistics.subscriberCount')).toBe('1204');
    const rows = [{ Customers: 41, who: 'Ata' }];
    expect(pickPath(rows, 'rows[0].Customers')).toBe(41);
    expect(pickPath(rows, 'customers')).toBe(41);
    expect(pickPath({ a: 1 }, '$.b.c')).toBeUndefined();
    expect(pickPath(5, '')).toBe(5);
  });

  it('measureFrom: named metrics (a missing one says so), rows kept to 200, every top-level number when none is named', () => {
    const got = measureFrom({ revenue: '3400', failed: 2 }, [{ name: 'revenue', unit: 'currency:USD' }, { name: 'failed-payments', pick: 'failed', better: 'down' }, { name: 'refunds' }]);
    expect(got.found).toEqual([{ name: 'revenue', unit: 'currency:USD', value: 3400 }, { name: 'failed-payments', better: 'down', value: 2 }]);
    expect(got.missing).toEqual(['refunds']);
    // A count query's one row and column is that number.
    expect(measureFrom([{ count: 41 }], [{ name: 'customers', pick: '' }]).found[0]).toMatchObject({ value: 41 });
    const many = Array.from({ length: 300 }, (_, i) => ({ who: `p${i}`, job: 'build' }));
    const rows = measureFrom(many, [{ name: 'last-jobs', kind: 'rows' }]).found[0]!;
    expect(rows.rows).toHaveLength(200);
    expect(rows.columns).toEqual(['who', 'job']);
    expect(measureFrom(many, [{ name: 'last-jobs', kind: 'rows' }], 5).found[0]!.rows).toHaveLength(5);
    expect(measureFrom({ subscriberCount: '1204', views: 9, title: 'x', live: true }, []).found).toEqual([
      { name: 'subscriber-count', label: 'Subscriber count', value: 1204 },
      { name: 'views', label: 'Views', value: 9 },
    ]);
    expect(measureFrom(42, []).found).toEqual([{ name: 'value', label: 'Value', value: 42 }]);
  });
});

describe('compared to when', () => {
  const now = new Date(2026, 9, 27, 7, 0).getTime();

  it('the run before, or the nearest point at or before then', () => {
    const p = pts([
      [now - 40 * DAY, 100],
      [now - 8 * DAY, 150],
      [now - 7 * DAY, 160],
      [now - 1 * DAY - 60_000, 190],
      [now - 2 * 60 * 60_000, 195],
      [now, 200],
    ]);
    expect(baselineOf(p, 'previous')?.value).toBe(195);
    expect(baselineOf(p, 'day')?.value).toBe(190);
    expect(baselineOf(p, 'week')?.value).toBe(160);
    expect(baselineOf(p, 'month')?.value).toBe(100);
    expect(baselineOf(p.slice(-1), 'previous')).toBeUndefined();
    expect(baselineOf(p.slice(-2), 'week')).toBeUndefined();
    // A run a few minutes late a week on still counts as a week ago.
    expect(baselineOf(pts([[now - 7 * DAY + 5 * 60_000, 1], [now, 2]]), 'week')?.value).toBe(1);
  });

  it('a month back is a calendar month (31 March → the end of February)', () => {
    const end = new Date(2026, 2, 31, 9, 0).getTime();
    expect(new Date(thenOf(end, 'month')).toDateString()).toBe(new Date(2026, 1, 28).toDateString());
    expect(thenOf(end, 'week')).toBe(end - 7 * DAY);
  });

  it('the tone goes by which way is good; no change is flat; none to compare is none', () => {
    const up = pts([
      [1, 10],
      [2, 12],
    ]);
    expect(deltaOf(up, 'previous', 'up')).toMatchObject({ value: 12, before: 10, change: 2, pct: 20, tone: 'good' });
    expect(deltaOf(up, 'previous', 'down')?.tone).toBe('bad');
    expect(deltaOf(up, 'previous', 'none')?.tone).toBe('none');
    expect(deltaOf(pts([[1, 5], [2, 5]]), 'previous', 'up')?.tone).toBe('flat');
    expect(deltaOf(pts([[1, 5]]), 'previous', 'up')).toEqual({ value: 5, tone: 'none' });
    expect(deltaOf([], 'previous', 'up')).toBeUndefined();
  });

  it('in words, with units', () => {
    expect(formatMetric(1204)).toBe('1,204');
    expect(formatMetric(3400, 'currency:USD')).toBe('$3,400');
    expect(formatMetric(12.5, 'currency:EUR')).toBe('€12.5');
    expect(formatMetric(42.25, 'percent')).toBe('42.3%');
    expect([formatMetric(340, 'ms'), formatMetric(1240, 'ms'), formatMetric(42_000, 'ms')]).toEqual(['340 ms', '1.2 s', '42 s']);
    expect(formatMetric(4.2 * 1024 * 1024, 'bytes')).toBe('4.2 MB');
    expect(changeText(deltaOf(pts([[1, 100], [2, 112]]), 'previous', 'up'), 'count')).toBe('+12 (+12%)');
    expect(changeText(deltaOf(pts([[1, 500], [2, 380]]), 'previous', 'down'), 'currency:USD')).toBe('−$120 (−24%)');
    expect(changeText(deltaOf(pts([[1, 40], [2, 42.5]]), 'previous', 'up'), 'percent')).toBe('+2.5 pts');
    expect(changeText(deltaOf(pts([[1, 3], [2, 3]]), 'previous', 'up'))).toBe('no change');
    expect(changeText(deltaOf(pts([[1, 3]]), 'previous', 'up'))).toBeUndefined();
  });
});

describe('the files', () => {
  it('prunePoints keeps two years and the newest 20 000', () => {
    const now = 1_000 * DAY;
    const lines = [{ at: now - 800 * DAY }, { at: now - 700 * DAY }, { at: now - DAY }];
    expect(prunePoints(lines, now)).toEqual(lines.slice(1));
    const many = Array.from({ length: 25 }, (_, i) => ({ at: now - (25 - i) * 1000 }));
    expect(prunePoints(many, now, 20)).toEqual(many.slice(5));
  });

  it('a line per run in <sentinel>/<name>.jsonl, read back (a torn line skipped), pruned once it grows past the limit, removed with its sentinel', () => {
    const dir = dirOf();
    let now = 10_000 * DAY;
    const files = new MetricFiles(dir, () => now);
    files.setMeta('sn_a', 'subscribers', { label: 'Subscribers', unit: 'count', better: 'up', kind: 'number' });
    files.append('sn_a', 'subscribers', { at: now - 800 * DAY, runId: 'r0', value: 1 });
    files.append('sn_a', 'subscribers', { at: now, runId: 'r1', value: 2 });
    const file = path.join(dir, 'sentinel', 'metrics', 'sn_a', 'subscribers.jsonl');
    // The old point made it due a prune at once: two years only.
    expect(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([{ at: now, runId: 'r1', value: 2 }]);
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"at": 12, "ru`);
    now += DAY;
    // Beluga closed while writing; the next start's first point goes on a line of its own.
    new MetricFiles(dir, () => now).append('sn_a', 'subscribers', { at: now, runId: 'r2', value: 3 });
    const again = new MetricFiles(dir, () => now);
    expect(again.read('sn_a', 'subscribers').map((l) => l.value)).toEqual([2, 3]);
    expect(again.read('sn_a', 'subscribers', now).map((l) => l.value)).toEqual([3]);
    expect(again.meta('sn_a').subscribers).toMatchObject({ label: 'Subscribers' });
    expect(again.list()).toEqual([{ sentinelId: 'sn_a', names: ['subscribers'] }]);
    again.remove('sn_a');
    expect(readdirSync(path.join(dir, 'sentinel', 'metrics'))).toEqual([]);
  });
});

const yt = { name: 'YouTube subscribers', trigger: { kind: 'manual' as const }, steps: [{ kind: 'script' as const, name: 'Ask YouTube', command: 'curl', cwd: 'home' as const, timeoutSec: 30 }, { kind: 'measure' as const, name: 'Keep the numbers', from: 'previous' as const, metrics: [{ name: 'subscribers', label: 'Subscribers', pick: '$.items[0].statistics.subscriberCount' }] }] };

describe('the measure step', () => {
  it('keeps the step before’s numbers with the run, in the state (the last 90), and makes the first dashboard', async () => {
    let n = 1000;
    const sh = fakeShell(() => ({ exitCode: 0, output: JSON.stringify({ items: [{ statistics: { subscriberCount: String(n) } }] }) }));
    const s = setup({ shell: sh.shell });
    const made = s.sentinels.create(yt);
    for (let i = 0; i < 92; i++) {
      n += 10;
      const run = s.sentinels.start(made.id, 'you');
      await until(() => s.sentinels.runGet(run.id).run.state === 'done');
    }
    const st = s.store.getState().sentinel;
    const m = st.metrics![made.id]!.subscribers!;
    expect(m).toMatchObject({ label: 'Subscribers', unit: 'count', better: 'up', kind: 'number' });
    expect(m.points).toHaveLength(POINTS_IN_STATE);
    expect(m.points.at(-1)!.value).toBe(1920);
    const last = s.sentinels.runsOf(made.id)[0]!;
    expect(m.points.at(-1)!.runId).toBe(last.id);
    expect(last.headline).toBe('Kept Subscribers: 1,920');
    // The whole history stays in the file (memory here), past what the state carries.
    expect(s.sentinels.metricRead(made.id, 'subscribers').lines).toHaveLength(92);
    // The first number made the first dashboard, once.
    expect(st.dashboards).toHaveLength(1);
    expect(st.dashboards![0]).toMatchObject({ name: 'Everything', auto: true, compare: 'previous' });
    expect(st.dashboards![0]!.tiles.map((t) => t.kind)).toEqual(['number', 'chart']);
    s.sentinels.dashboards.remove(st.dashboards![0]!.id);
    const again = s.sentinels.start(made.id, 'you');
    await until(() => s.sentinels.runGet(again.id).run.state === 'done');
    expect(s.store.getState().sentinel.dashboards).toEqual([]);
  });

  it('a name it can’t find fails the step, saying which (the rest is kept)', async () => {
    const sh = fakeShell(() => ({ exitCode: 0, output: 'customers: 41' }));
    const s = setup({ shell: sh.shell });
    const made = s.sentinels.create({ ...yt, steps: [yt.steps[0]!, { kind: 'measure', from: 'previous', metrics: [{ name: 'customers' }, { name: 'refunds' }] }] });
    const run = s.sentinels.start(made.id, 'you');
    await until(() => s.sentinels.runGet(run.id).run.state === 'failed');
    expect(s.sentinels.runGet(run.id).run.why).toBe('didn’t find refunds (the rest was kept)');
    expect(s.store.getState().sentinel.metrics![made.id]!.customers!.points.map((p) => p.value)).toEqual([41]);
  });

  it('from a source: the daemon runs it, and a query’s rows are kept as rows', async () => {
    const asked: unknown[] = [];
    const s = setup({
      fetchSource: async (source, cwd) => {
        asked.push({ source, cwd });
        return { rows: [{ who: 'Ata', job: 'deploy', at: '09:12' }, { who: 'Mia', job: 'tests', at: '08:40' }], columns: ['who', 'job', 'at'] };
      },
    });
    const made = s.sentinels.create({
      name: 'Last job run',
      projectId: 'api',
      trigger: { kind: 'manual' },
      steps: [{ kind: 'measure', name: 'Who ran what', from: 'source', source: { kind: 'postgres', env: 'DATABASE_URL', query: 'select who, job, at from jobs order by at desc limit 20' }, metrics: [{ name: 'last-jobs', label: 'Last jobs', kind: 'rows' }, { name: 'jobs', pick: '', label: 'Jobs today' }] }],
    });
    const run = s.sentinels.start(made.id, 'you');
    await until(() => !['running', 'queued'].includes(s.sentinels.runGet(run.id).run.state));
    expect(asked).toEqual([{ source: expect.objectContaining({ kind: 'postgres' }), cwd: '/code/bob-api' }]);
    const m = s.store.getState().sentinel.metrics![made.id]!;
    expect(m['last-jobs']).toMatchObject({ kind: 'rows', better: 'none', columns: ['who', 'job', 'at'], points: [{ value: 2 }] });
    expect(m['last-jobs']!.rows![0]).toEqual({ who: 'Ata', job: 'deploy', at: '09:12' });
    // "jobs" picks nothing numeric from many rows: it says so.
    expect(s.sentinels.runGet(run.id).run.why).toBe('didn’t find jobs (the rest was kept)');
  });

  it('from Claude: sentinel_measure inside the run, kept by the step after it with its units', async () => {
    const s = setup();
    const made = s.sentinels.create({
      name: 'Stripe revenue',
      projectId: 'api',
      trigger: { kind: 'manual' },
      steps: [
        { kind: 'claude', name: 'Look it up', where: 'project', prompt: 'Find yesterday’s revenue' },
        { kind: 'measure', name: 'Keep the numbers', from: 'claude', metrics: [{ name: 'revenue', unit: 'currency:USD', label: 'Revenue' }] },
      ],
    });
    const run = s.sentinels.start(made.id, 'you');
    await until(() => s.asked.length === 1);
    const forRun = s.sentinels.forRun(s.asked[0]!.channel, 'p-me')!;
    expect(forRun.brief).toMatch(/sentinel_measure\(name, value, unit\?\); it keeps revenue \(currency:USD\)/);
    const defs = createDashboardToolDefs(forRun.dashboard);
    expect(defs.map((d) => `mcp__beluga_dashboard__${d.name}`)).toEqual(DASHBOARD_TOOL_NAMES);
    const call = (name: string, args: unknown) => (defs.find((d) => d.name === name)!.handler as (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>)(args, {});
    expect((await call('sentinel_measure', { name: 'revenue', value: '$3,400' })).content[0]!.text).toBe('Noted Revenue = 3,400. The Keep the numbers step keeps it when you’re done.');
    expect(await call('sentinel_measure', { name: 'refunds', value: 'lots' })).toMatchObject({ isError: true });
    s.asked[0]!.answer('Revenue was $3,400 yesterday.');
    await until(() => s.sentinels.runGet(run.id).run.state === 'done');
    expect(s.store.getState().sentinel.metrics![made.id]!.revenue).toMatchObject({ unit: 'currency:USD', points: [{ value: 3400 }] });
    expect(s.sentinels.runGet(run.id).run.steps[1]!.output).toBe('Kept Revenue: $3,400');
  });

  it('in words, and a Claude change to a source pauses the sentinel', () => {
    const base = { id: 'm', name: 'Keep' } as const;
    expect(stepSentence({ ...base, kind: 'measure', from: 'previous', metrics: [{ name: 'subscribers', label: 'Subscribers' }] })).toBe('Keeps Subscribers from the step before');
    expect(stepSentence({ ...base, kind: 'measure', from: 'claude', metrics: [] })).toBe('Keeps the numbers Claude measures');
    expect(stepSentence({ ...base, kind: 'measure', from: 'source', source: { kind: 'sqlite', path: 'a.db', query: 'select 1' }, metrics: [] })).toBe('Keeps every number from a sqlite source');
    expect(StepInputSchema.parse({ kind: 'measure' })).toEqual({ kind: 'measure', from: 'previous', metrics: [] });
    expect(StepInputSchema.safeParse({ kind: 'measure', metrics: [{ name: 'Bad Name' }] }).success).toBe(false);
    const was = { access: 'look' as const, steps: [{ ...base, kind: 'measure' as const, from: 'previous' as const, metrics: [] }] } as Pick<Sentinel, 'steps' | 'access'>;
    expect(claudeWidened(was, { ...was, steps: [{ ...base, kind: 'measure', from: 'previous', metrics: [{ name: 'x' }] }] })).toBe(false);
    expect(claudeWidened(was, { ...was, steps: [{ ...base, kind: 'measure', from: 'source', source: { kind: 'command', command: 'curl x', format: 'auto' }, metrics: [] }] })).toBe(true);
  });
});

describe('dashboards', () => {
  it('make, rename, add (checked), change, move and remove tiles; saved in dashboards.json; the first made only once', () => {
    const dir = dirOf();
    let seen = 0;
    const d = new Dashboards(dir, () => 5, () => void seen++, 0);
    const made = d.autoMake([{ sentinelId: 'sn_a', name: 'subscribers', kind: 'number' }, { sentinelId: 'sn_b', name: 'last-jobs', kind: 'rows' }])!;
    expect(made.tiles.map((t) => [t.kind, t.width])).toEqual([
      ['number', 1],
      ['chart', 3],
      ['table', 3],
    ]);
    const ops = d.create('Ops');
    expect(() => d.addTile(ops.id, { kind: 'number' })).toThrow(/needs its metric/);
    const a = d.addTile('ops', { kind: 'number', metric: { sentinelId: 'sn_a', metric: 'subscribers' } }).tile;
    const b = d.addTile(ops.id, { kind: 'divider', title: 'Money', width: 1 }, 0).tile;
    expect(b.width).toBe(3);
    const c = d.addTile(ops.id, { kind: 'chart', metric: { sentinelId: 'sn_a', metric: 'subscribers' } }).tile;
    expect(c).toMatchObject({ chart: 'line', width: 3, metrics: [{ sentinelId: 'sn_a', metric: 'subscribers' }] });
    d.updateTile(ops.id, a.id, { width: 2, compare: 'week' });
    expect(d.get(ops.id)!.tiles.find((t) => t.id === a.id)).toMatchObject({ width: 2, compare: 'week' });
    d.updateTile(ops.id, a.id, { compare: null });
    expect(d.get(ops.id)!.tiles.find((t) => t.id === a.id)!.compare).toBeUndefined();
    d.moveTile(ops.id, c.id, 0);
    expect(d.get(ops.id)!.tiles.map((t) => t.id)).toEqual([c.id, b.id, a.id]);
    d.removeTile(ops.id, b.id);
    d.update(ops.id, { name: 'Operations', compare: 'month' });
    d.flush();
    const saved = JSON.parse(readFileSync(path.join(dir, 'dashboards.json'), 'utf8'));
    expect(saved).toMatchObject({ version: 1, made: true, dashboards: [{ name: 'Everything', auto: true }, { name: 'Operations', compare: 'month' }] });
    d.remove(made.id);
    d.remove(ops.id);
    d.flush();
    const again = new Dashboards(dir, () => 6, () => undefined, 0);
    expect(again.list()).toEqual([]);
    expect(again.autoMake([{ sentinelId: 'sn_a', name: 'subscribers', kind: 'number' }])).toBeUndefined();
    expect(seen).toBeGreaterThan(5);
  });

  it('a tile’s state: paused or gone quietly, waiting for its first run, fine', () => {
    const sentinels = [
      { id: 'on', paused: false },
      { id: 'off', paused: true },
    ];
    const has = (r: { sentinelId: string; metric: string }): boolean => r.metric === 'kept';
    const t = (sentinelId: string, metric = 'kept') => ({ id: 't', kind: 'number' as const, width: 1 as const, metric: { sentinelId, metric } });
    expect([tileState(t('on'), sentinels, has), tileState(t('off'), sentinels, has), tileState(t('nope'), sentinels, has), tileState(t('on', 'new'), sentinels, has)]).toEqual(['ok', 'paused', 'gone', 'waiting']);
    expect(tileState({ id: 'd', kind: 'divider', width: 3 }, [], has)).toBe('ok');
  });

  it('drag landing in the grid, moving, the sentinels in order, and Markdown', () => {
    const boxes = [
      { id: 'a', left: 0, top: 0, right: 100, bottom: 80 },
      { id: 'b', left: 110, top: 0, right: 210, bottom: 80 },
      { id: 'c', left: 0, top: 90, right: 210, bottom: 300 },
    ];
    expect([gridLanding(20, 40, boxes), gridLanding(180, 40, boxes), gridLanding(500, 40, boxes), gridLanding(10, 200, boxes), gridLanding(10, 400, boxes)]).toEqual([0, 2, 2, 2, 3]);
    expect(moveTile([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'a', 5).map((x) => x.id)).toEqual(['b', 'c', 'a']);
    const tiles = autoTiles([{ sentinelId: 's1', name: 'x', kind: 'number' }, { sentinelId: 's2', name: 'y', kind: 'number' }], (() => {
      let n = 0;
      return () => `t${++n}`;
    })());
    expect(dashboardSentinels({ tiles: [{ id: 'q', kind: 'text', width: 2, sentinelId: 's3' }, ...tiles] })).toEqual(['s3', 's1', 's2']);
    const md = dashboardMarkdown({ id: 'd', name: 'Revenue', compare: 'previous', tiles: [{ id: 'a', kind: 'divider', width: 3, title: 'Money' }, ...tiles.slice(0, 2)], createdAt: 0, updatedAt: 0 }, (t) => (t.kind === 'divider' ? { title: t.title! } : { title: `M|${t.id}`, value: '$3', change: '+1' }));
    expect(md).toBe('# Revenue\n\n## Money\n\n| Number | Now | Change |\n|---|---|---|\n| M\\|t1 | $3 | +1 |\n| M\\|t2 | $3 | +1 |\n');
  });

  it('Refresh runs each sentinel it draws from, one at a time, saying how far; paused ones stay as they are', async () => {
    const s = setup({ reply: () => 'ok' });
    const a = s.sentinels.create({ name: 'A', trigger: { kind: 'manual' }, steps: [{ kind: 'script', command: 'echo 1', cwd: 'home', timeoutSec: 5 }] });
    const b = s.sentinels.create({ name: 'B', trigger: { kind: 'manual' }, steps: [{ kind: 'script', command: 'echo 2', cwd: 'home', timeoutSec: 5 }] });
    const c = s.sentinels.create({ name: 'C', trigger: { kind: 'manual' }, steps: [] });
    for (const x of [a, b]) s.sentinels.pause(x.id, false);
    const d = s.sentinels.dashboards.create('Mine');
    for (const x of [b, a, c]) s.sentinels.dashboards.addTile(d.id, { kind: 'text', sentinelId: x.id });
    const seen: Array<{ done: number; total: number }> = [];
    const off = s.store.onAction((act) => void (act.type === 'sentinel_refresh' && act.refreshing && seen.push({ done: act.refreshing.done, total: act.refreshing.total })));
    expect(s.sentinels.refresh(d.id)).toEqual({ total: 2 });
    await until(() => !s.store.getState().sentinel.refreshing?.[d.id] && s.ran.length === 2);
    off();
    expect(s.ran.map((r) => r.command)).toEqual(['echo 2', 'echo 1']);
    expect(seen).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
    ]);
  });
});

describe('beluga_dashboard', () => {
  it('your own runs get the tools, never asking; sentinel_measure only inside a run', async () => {
    const s = setup();
    const forRun = s.sentinels.forRun('ws:else', 'p-me')!;
    const defs = createDashboardToolDefs(forRun.dashboard);
    expect(defs.map((d) => `mcp__beluga_dashboard__${d.name}`)).toEqual(DASHBOARD_TOOL_NAMES.slice(1));
    for (const name of DASHBOARD_TOOL_NAMES) expect(decideTool(name, {}, { cwd: '/tmp', roots: [], autoEdit: false })).toBe('allow');
    expect(s.sentinels.forRun('ws:else', 'p-friend')).toBeUndefined();
    expect(forRun.brief).toMatch(/metric_read\(sentinel, name, since\)/);
  });

  it('dashboard_create, add, update and remove tiles by name; metric_list and metric_read', async () => {
    const sh = fakeShell(() => ({ exitCode: 0, output: 'customers: 41\nrevenue: 3400' }));
    const s = setup({ shell: sh.shell });
    const made = s.sentinels.create({ name: 'Shop', trigger: { kind: 'manual' }, steps: [{ kind: 'script', command: 'x', cwd: 'home', timeoutSec: 5 }, { kind: 'measure', from: 'previous', metrics: [{ name: 'customers' }, { name: 'revenue', unit: 'currency:USD' }] }] });
    const run = s.sentinels.start(made.id, 'you');
    await until(() => s.sentinels.runGet(run.id).run.state === 'done');
    const defs = createDashboardToolDefs(s.sentinels.forRun('ws:else', 'p-me')!.dashboard);
    const call = async (name: string, args: unknown) => (await (defs.find((d) => d.name === name)!.handler as (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>)(args, {}));
    const text = async (name: string, args: unknown) => (await call(name, args)).content[0]!.text;
    expect(await text('metric_list', {})).toMatch(/^Shop \(id sn_\w+, paused, `sentinel:sn_\w+`\):\n {2}- customers: Customers · count, better up · last 41 on .+ · 1 recent points\n {2}- revenue: Revenue · currency:USD, better up · last \$3,400/);
    expect(await text('dashboard_create', { name: 'Money' })).toMatch(/^Made the dashboard “Money” \(id db_\w+\)/);
    expect(await text('dashboard_add_tile', { dashboard: 'Money', kind: 'number', sentinel: 'Shop', metric: 'Revenue', compare: 'week' })).toMatch(/^Added a number \(tile tl_\w+\) to “Money”; it has 1 tile now\.$/);
    expect(await text('dashboard_add_tile', { dashboard: 'Money', kind: 'chart', metrics: [{ sentinel: 'Shop', metric: 'customers' }, { sentinel: made.id, metric: 'revenue' }] })).toMatch(/2 tiles now/);
    expect(await call('dashboard_add_tile', { dashboard: 'Money', kind: 'number', sentinel: 'Nobody', metric: 'x' })).toMatchObject({ isError: true, content: [{ text: "There's no sentinel Nobody" }] });
    const money = s.store.getState().sentinel.dashboards!.find((d) => d.name === 'Money')!;
    expect(money.tiles[0]).toMatchObject({ kind: 'number', metric: { sentinelId: made.id, metric: 'revenue' }, compare: 'week' });
    expect(await text('dashboard_update_tile', { dashboard: money.id, tile: money.tiles[0]!.id, width: 2, compare: null })).toMatch(/^Changed tile/);
    expect(s.sentinels.dashboards.get(money.id)!.tiles[0]).toMatchObject({ width: 2, metric: { metric: 'revenue' } });
    expect(s.sentinels.dashboards.get(money.id)!.tiles[0]!.compare).toBeUndefined();
    expect(await text('dashboard_list', {})).toMatch(/Money \(id db_\w+\) · vs the run before · 2 tiles\n {2}- tl_\w+: a number Shop\/revenue, 2 wide\n {2}- tl_\w+: a chart Shop\/customers, Shop\/revenue, 3 wide/);
    expect(await text('dashboard_remove_tile', { dashboard: 'Money', tile: money.tiles[1]!.id })).toMatch(/^Removed tile/);
    expect(await text('metric_read', { sentinel: 'Shop', name: 'customers', since: '7d' })).toMatch(/^Customers: 1 point, oldest first\.\n\d{4}-\d\d-\d\d \d\d:\d\d {2}41$/);
    expect(await call('metric_read', { sentinel: 'Shop', name: 'customers', since: 'whenever' })).toMatchObject({ isError: true });
    expect(await call('metric_read', { sentinel: 'Shop', name: 'refunds' })).toMatchObject({ isError: true, content: [{ text: '“Shop” keeps no number called refunds (it keeps customers, revenue)' }] });
  });

  it('sinceOf reads dates and times back', () => {
    const now = new Date(2026, 9, 27).getTime();
    expect(sinceOf('7d', now)).toBe(new Date(2026, 9, 20).getTime());
    expect(new Date(sinceOf('3 months', now)!).getMonth()).toBe(6);
    expect(sinceOf('2026-09-01', now)).toBe(Date.parse('2026-09-01'));
    expect(sinceOf('soon', now)).toBeUndefined();
  });

  it('Describe it: a chat on Your Mac with the dashboard and the numbers as material, followed in the state', async () => {
    const s = setup();
    const d = s.sentinels.dashboards.create('Revenue');
    const { channel } = s.sentinels.dashboardAsk(d.id, 'subscribers and failed payments side by side');
    expect(s.store.getState().sentinel.dashboardAsks?.[d.id]).toMatchObject({ state: 'writing', channel });
    const forRun = s.sentinels.forRun(channel, 'p-me')!;
    expect(forRun.dashboard.building).toBe(d.id);
    expect(forRun.brief).toMatch(/You are building the user’s dashboard “Revenue”/);
    expect(() => s.sentinels.dashboardAsk(d.id, 'again')).toThrow(/already/);
    s.asked[0]!.answer('Added two numbers.');
    await until(() => s.store.getState().sentinel.dashboardAsks?.[d.id]?.state === 'done');
  });
});

describe('the dashboard.* API', () => {
  it('handlers reach the session’s dashboards; the phone may refresh and read numbers, the rest is the Mac’s', async () => {
    const s = setup();
    const session = {} as Session;
    attachSentinel(session, s.sentinels);
    const d = DASHBOARD_HANDLERS['dashboard.create'](session, 'Ops');
    const [, tile] = parseArgs('dashboard.addTile', [d.id, { kind: 'divider', title: 'Ops' }]);
    expect(DASHBOARD_HANDLERS['dashboard.addTile'](session, d.id, tile, undefined).tile.kind).toBe('divider');
    expect(DASHBOARD_HANDLERS['dashboard.refresh'](session, d.id)).toEqual({ total: 0 });
    expect(() => parseArgs('dashboard.addTile', [d.id, { kind: 'pie' }])).toThrow();
    expect(() => SENTINEL_HANDLERS['sentinel.metricRead'](session, 'nope', 'x', undefined)).toThrow("There's no sentinel nope");
    const methods = Object.keys(API).filter((m) => m.startsWith('dashboard.') || m === 'sentinel.metricRead');
    expect(methods.filter((m) => PHONE[m as keyof typeof PHONE] === 'phone').sort()).toEqual(['dashboard.refresh', 'sentinel.metricRead']);
  });

  it('a deleted sentinel’s numbers go with it; its tiles stay and say gone', async () => {
    const sh = fakeShell(() => ({ exitCode: 0, output: '7' }));
    const s = setup({ shell: sh.shell });
    const made = s.sentinels.create({ name: 'N', trigger: { kind: 'manual' }, steps: [{ kind: 'script', command: 'x', cwd: 'home', timeoutSec: 5 }, { kind: 'measure', from: 'previous', metrics: [] }] });
    const run = s.sentinels.start(made.id, 'you');
    await until(() => s.sentinels.runGet(run.id).run.state === 'done');
    s.sentinels.remove(made.id);
    const st = s.store.getState().sentinel;
    expect(st.metrics?.[made.id]).toBeUndefined();
    const tile = st.dashboards![0]!.tiles[0]!;
    expect(tileState(tile, st.items, () => false)).toBe('gone');
  });
});
