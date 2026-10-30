import type { DashboardTileView, DashboardView, SentinelPageView, SentinelRunView, SentinelSummary, SentinelsView, Topic, WidgetTileView, WidgetsView } from '../protocol';
/**
 * The demo Mac's numbers and dashboards (1.22, docs/sentinel.md §10), as src/core/sentinel/demo.ts
 * seeds the Mac's: Stripe revenue, YouTube subscribers, Site speed and Last job run (paused, its
 * database isn't there) keep a week of numbers, drawn on two dashboards, Revenue and Ops. Tiles are
 * worked out as src/companion/views.ts `tileView` does (with src/core/sentinel/metrics.ts's words:
 * "$3,412", "+$232 (+7.3%)"), so the demo can't drift from what a Mac sends.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Better = 'up' | 'down' | 'none';
type Compare = 'previous' | 'day' | 'week' | 'month';
const COMPARE: readonly Compare[] = ['previous', 'day', 'week', 'month'];
type Cell = string | number | boolean | null;

interface Point {
  at: number;
  value: number;
  runId: string;
}
interface Metric {
  sentinelId: string;
  name: string;
  label: string;
  unit: string;
  better: Better;
  points: Point[];
  columns?: string[];
  rows?: Record<string, Cell>[];
  rowsAt?: number;
}
type Ref = readonly [sentinelId: string, metric: string];
interface Tile {
  id: string;
  kind: 'number' | 'chart' | 'table' | 'output' | 'text' | 'divider';
  width: 1 | 2 | 3;
  /** An output tile's latest export, as the Mac works it out (1.23). */
  output?: DashboardTileView['output'];
  title?: string;
  metric?: Ref;
  metrics?: Ref[];
  chart?: 'line' | 'area' | 'bar';
  compare?: Compare;
  sentinelId?: string;
}
interface Dashboard {
  id: string;
  name: string;
  compare: Compare;
  tiles: Tile[];
}

/** A run as the demo's sentinel pages keep it (its report's text for sentinel.runGet). */
export interface NumberRun extends SentinelRunView {
  text?: string;
}
export interface NumberSentinel {
  summary: Omit<SentinelSummary, 'last' | 'live'>;
  steps: SentinelPageView['steps'];
  runs: NumberRun[];
}

export interface DemoNumbers {
  sentinels: NumberSentinel[];
  metrics: Metric[];
  dashboards: Dashboard[];
  /** A Refresh going, by dashboard. */
  refreshing: Record<string, { done: number; total: number; sentinelId?: string }>;
}

const REVENUE = [2_810, 3_020, 2_950, 3_240, 3_105, 3_390, 3_180, 3_412];
const NEW_SUBS = [4, 6, 3, 7, 5, 8, 4, 6];
const FAILED = [3, 1, 2, 2, 0, 1, 3, 1];
const SUBSCRIBERS = [11_820, 11_904, 11_960, 12_045, 12_110, 12_188, 12_231, 12_304];
const VIEWS = [1_440_120, 1_446_300, 1_451_870, 1_458_020, 1_463_400, 1_469_950, 1_475_310, 1_482_210];
/** A job's log as a small page, and the nightly tests' artifacts as a zip (a kind the phone only describes). */
const jobLog = (job: string, line: string): string => `<html><body style="font: 16px -apple-system, sans-serif; padding: 16px"><h1 style="font-size: 20px">${job}</h1><pre>${line}</pre></body></html>`;
/** The documents the demo's Last jobs table holds, by ref (makeWorld offers them; the phone streams them). */
export const JOB_DOCS: ReadonlyArray<{ readonly ref: string; readonly name: string; readonly mime: string; readonly text?: string; readonly b64?: string }> = [
  { ref: 'out:demo-log-deploy-landing', name: 'deploy landing.html', mime: 'text/html', text: jobLog('deploy landing', 'Deployed landing in 48 s.') },
  { ref: 'out:demo-log-refund-backfill', name: 'refund webhooks backfill.html', mime: 'text/html', text: jobLog('refund webhooks backfill', 'Backfilled 212 refunds.') },
  { ref: 'out:demo-log-nightly-tests', name: 'nightly tests.html', mime: 'text/html', text: jobLog('nightly tests', 'FAIL tests/webhooks.test.ts › retries a webhook once') },
  { ref: 'out:demo-zip-nightly-tests', name: 'nightly tests.zip', mime: 'application/zip', b64: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==' },
];
const JOBS: Record<string, Cell>[] = [
  { who: 'lena@example.com', job: 'deploy landing', status: 'done', progress: 100, log: 'deploy landing.html', artifact: null, finished_at: '09:12' },
  { who: 'bob', job: 'refund webhooks backfill', status: 'done', progress: 100, log: 'refund webhooks backfill.html', artifact: null, finished_at: '08:55' },
  { who: 'ci', job: 'nightly tests', status: 'failed', progress: 62, log: 'nightly tests.html', artifact: 'nightly tests.zip', finished_at: '02:01' },
  { who: 'mia@example.com', job: 'export invoices', status: 'done', progress: 100, log: null, artifact: null, finished_at: 'yesterday 18:40' },
  { who: 'ci', job: 'image cache warm-up', status: 'done', progress: 100, log: null, artifact: null, finished_at: 'yesterday 17:05' },
  { who: 'bob', job: 'deploy bob-api', status: 'done', progress: 100, log: null, artifact: null, finished_at: 'yesterday 16:22' },
];
/** Last jobs' columns as its sentinel typed them (as src/core/sentinel/demo.ts types the Mac's). */
const JOB_TYPES: Readonly<Record<string, { readonly kind: string; readonly label: string; readonly max?: number; readonly button?: string }>> = {
  who: { kind: 'person', label: 'Who' },
  status: { kind: 'badge', label: 'Status' },
  progress: { kind: 'progress', label: 'Progress', max: 100 },
  log: { kind: 'html', label: 'Log', button: 'Open log' },
  artifact: { kind: 'file', label: 'Artifact' },
  finished_at: { kind: 'text', label: 'Finished' },
};

const usd = (n: number): string => `$${n.toLocaleString('en-US')}`;

export function makeNumbers(now = Date.now()): DemoNumbers {
  const run = (id: string, start: number, headline: string, text?: string): NumberRun => ({ id, by: 'schedule', state: 'done', headline, startedAt: start, endedAt: start + 40_000, ...(text ? { text } : {}) });
  const stripeRuns: NumberRun[] = [];
  const ytRuns: NumberRun[] = [];
  const revenue: Point[] = [];
  const subs: Point[] = [];
  const failed: Point[] = [];
  const subscribers: Point[] = [];
  const views: Point[] = [];
  REVENUE.forEach((value, i) => {
    const daysAgo = REVENUE.length - 1 - i;
    const start = now - daysAgo * DAY - 50 * MIN;
    const line = `${usd(value)} yesterday, ${NEW_SUBS[i]} new subscriptions, ${FAILED[i]} failed ${FAILED[i] === 1 ? 'payment' : 'payments'}`;
    const id = `run_stripe${i}`;
    stripeRuns.unshift(run(id, start, line, `${line}\n\n- ${14 + i} charges, the largest $348\n- ${FAILED[i]} declined ${FAILED[i] === 1 ? 'card' : 'cards'}, nothing disputed`));
    const at = start + 40_000;
    revenue.push({ at, value, runId: id });
    subs.push({ at, value: NEW_SUBS[i]!, runId: id });
    failed.push({ at, value: FAILED[i]!, runId: id });
    const ytStart = now - daysAgo * DAY - 35 * MIN;
    const ytId = `run_yt${i}`;
    ytRuns.unshift(run(ytId, ytStart, `Kept YouTube subscribers: ${SUBSCRIBERS[i]!.toLocaleString('en-US')} · Views: ${VIEWS[i]!.toLocaleString('en-US')}`));
    subscribers.push({ at: ytStart + 40_000, value: SUBSCRIBERS[i]!, runId: ytId });
    views.push({ at: ytStart + 40_000, value: VIEWS[i]!, runId: ytId });
  });
  // Every 3 hours for a week: about 380 ms, slower for a day after the deploy two days ago.
  const speedRuns: NumberRun[] = [];
  const home: Point[] = [];
  for (let k = 8 * 7; k >= 0; k--) {
    const start = now - k * 3 * HOUR - 20 * MIN;
    const slow = k >= 14 && k <= 20;
    const ms = k === 0 ? 380 : Math.round((slow ? 610 : 372) + Math.sin(k * 1.7) * (slow ? 40 : 26) + (k % 5) * 4);
    const id = `run_speed${k}`;
    speedRuns.unshift(run(id, start, `Kept Home page: ${ms} ms`));
    home.push({ at: start + 40_000, value: ms, runId: id });
  }
  const jobsAt = now - 18 * MIN;
  const jobsRun = run('run_jobs0', jobsAt, 'Kept Last jobs: 6 rows');

  const sentinels: NumberSentinel[] = [
    {
      summary: { id: 'sn_stripe', topic: 'sentinel:sn_stripe', name: 'Stripe revenue', icon: 'coin', projectId: 'beluga', project: 'beluga', sentence: 'Every day at 8:00', paused: false, nextAt: nextAt(now, 8) },
      steps: [
        { kind: 'http', name: 'Ask Stripe' },
        { kind: 'claude', name: 'Add it up' },
        { kind: 'measure', name: 'Keep the numbers' },
      ],
      runs: stripeRuns,
    },
    {
      summary: { id: 'sn_yt', topic: 'sentinel:sn_yt', name: 'YouTube subscribers', icon: 'play', sentence: 'Every day at 9:00', paused: false, nextAt: nextAt(now, 9) },
      steps: [
        { kind: 'http', name: 'Ask YouTube' },
        { kind: 'measure', name: 'Keep the numbers' },
      ],
      runs: ytRuns,
    },
    {
      summary: { id: 'sn_speed', topic: 'sentinel:sn_speed', name: 'Site speed', icon: 'gauge', projectId: 'pixel-weather', project: 'pixel-weather', sentence: 'Every 3 hours', paused: false, nextAt: now + 2 * HOUR + 40 * MIN },
      steps: [
        { kind: 'script', name: 'Time the home page' },
        { kind: 'measure', name: 'Keep the numbers' },
      ],
      runs: speedRuns.slice(0, 30),
    },
    {
      summary: { id: 'sn_jobs', topic: 'sentinel:sn_jobs', name: 'Last job run', icon: 'clock', projectId: 'beluga', project: 'beluga', sentence: 'Every hour', paused: true },
      steps: [{ kind: 'measure', name: 'Who ran what' }],
      runs: [jobsRun],
    },
  ];
  const metrics: Metric[] = [
    { sentinelId: 'sn_stripe', name: 'revenue', label: 'Revenue', unit: 'currency:USD', better: 'up', points: revenue },
    { sentinelId: 'sn_stripe', name: 'new-subscriptions', label: 'New subscriptions', unit: 'count', better: 'up', points: subs },
    { sentinelId: 'sn_stripe', name: 'failed-payments', label: 'Failed payments', unit: 'count', better: 'down', points: failed },
    { sentinelId: 'sn_yt', name: 'subscribers', label: 'YouTube subscribers', unit: 'count', better: 'up', points: subscribers },
    { sentinelId: 'sn_yt', name: 'views', label: 'Views', unit: 'count', better: 'up', points: views },
    { sentinelId: 'sn_speed', name: 'home', label: 'Home page', unit: 'ms', better: 'down', points: home },
    { sentinelId: 'sn_jobs', name: 'last-jobs', label: 'Last jobs', unit: 'count', better: 'none', points: [], columns: ['who', 'job', 'status', 'progress', 'log', 'artifact', 'finished_at'], rows: JOBS, rowsAt: jobsAt + 40_000 },
  ];
  let n = 0;
  const t = (tile: Omit<Tile, 'id' | 'width'> & { width?: Tile['width'] }): Tile => ({ id: `tile_${++n}`, width: tile.kind === 'number' ? 1 : 3, ...tile });
  const dashboards: Dashboard[] = [
    {
      id: 'db_revenue',
      name: 'Revenue',
      compare: 'previous',
      tiles: [
        t({ kind: 'number', metric: ['sn_stripe', 'revenue'] }),
        t({ kind: 'number', metric: ['sn_stripe', 'new-subscriptions'] }),
        t({ kind: 'number', metric: ['sn_stripe', 'failed-payments'] }),
        t({ kind: 'number', metric: ['sn_yt', 'subscribers'], compare: 'week' }),
        t({ kind: 'number', metric: ['sn_yt', 'views'] }),
        t({ kind: 'number', metric: ['sn_speed', 'home'], title: 'Site speed' }),
        t({ kind: 'chart', chart: 'area', metrics: [['sn_stripe', 'revenue']], title: 'Revenue this week' }),
        t({ kind: 'chart', chart: 'line', metrics: [['sn_yt', 'subscribers']] }),
        t({ kind: 'divider', title: 'What the agent said' }),
        t({ kind: 'output', sentinelId: 'sn_stripe', title: 'Add it up', output: { look: 'markdown', text: '$3,412 yesterday, 6 new subscriptions, 1 failed payment\n\n- 20 charges, the largest $348\n- 1 declined card, nothing disputed' } }),
        t({ kind: 'output', sentinelId: 'sn_yt', title: 'YouTube’s answer', output: { look: 'tree', text: JSON.stringify({ kind: 'youtube#channelListResponse', items: [{ id: 'UCdemo', statistics: { viewCount: '1482210', subscriberCount: '12304', videoCount: '213' } }] }, null, 2) } }),
        t({ kind: 'text', sentinelId: 'sn_stripe' }),
        t({ kind: 'table', metric: ['sn_jobs', 'last-jobs'] }),
      ],
    },
    {
      id: 'db_ops',
      name: 'Ops',
      compare: 'day',
      tiles: [
        t({ kind: 'number', metric: ['sn_speed', 'home'], title: 'Home page' }),
        t({ kind: 'number', metric: ['sn_stripe', 'failed-payments'] }),
        t({ kind: 'chart', chart: 'line', metrics: [['sn_speed', 'home']], title: 'Load time' }),
        t({ kind: 'table', metric: ['sn_jobs', 'last-jobs'] }),
      ],
    },
  ];
  return { sentinels, metrics, dashboards, refreshing: {} };
}

function nextAt(now: number, hh: number): number {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh).getTime();
  return today > now ? today : today + DAY;
}

// ---- src/core/sentinel/metrics.ts: compared to when, and in words

function thenOf(at: number, compare: Exclude<Compare, 'previous'>): number {
  if (compare === 'day') return at - DAY;
  if (compare === 'week') return at - 7 * DAY;
  const d = new Date(at);
  const target = new Date(d.getFullYear(), d.getMonth() - 1, 1, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return target.getTime();
}

function baselineOf(points: readonly Point[], compare: Compare): Point | undefined {
  const last = points.at(-1);
  if (!last) return undefined;
  if (compare === 'previous') return points.at(-2);
  // An hour's grace, as the Mac's: runs drift a little.
  const then = thenOf(last.at, compare) + 60 * 60_000;
  for (let i = points.length - 2; i >= 0; i--) if (points[i]!.at <= then) return points[i];
  return undefined;
}

interface Delta {
  value: number;
  change?: number;
  pct?: number;
  tone: 'good' | 'bad' | 'flat' | 'none';
}
function deltaOf(points: readonly Point[], compare: Compare, better: Better): Delta | undefined {
  const last = points.at(-1);
  if (!last) return undefined;
  const base = baselineOf(points, compare);
  if (!base) return { value: last.value, tone: 'none' };
  const change = last.value - base.value;
  const pct = base.value !== 0 ? (change / Math.abs(base.value)) * 100 : undefined;
  const tone = change === 0 ? 'flat' : better === 'none' ? 'none' : (change > 0) === (better === 'up') ? 'good' : 'bad';
  return { value: last.value, change, ...(pct !== undefined ? { pct } : {}), tone };
}

const grouped = (n: number, max = 2): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: max }).format(n);

function formatMetric(value: number, unit = 'count'): string {
  if (unit.startsWith('currency:')) {
    const cur = unit.slice('currency:'.length).toUpperCase();
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2, minimumFractionDigits: 0 }).format(value);
    } catch {
      return `${grouped(value)} ${cur}`;
    }
  }
  if (unit === 'percent') return `${grouped(value, 1)}%`;
  if (unit === 'ms') return Math.abs(value) >= 10_000 ? `${grouped(value / 1000, 0)} s` : Math.abs(value) >= 1000 ? `${grouped(value / 1000, 1)} s` : `${grouped(value, 0)} ms`;
  return grouped(value, Number.isInteger(value) ? 0 : 2);
}

function changeText(d: Delta | undefined, unit = 'count'): string | undefined {
  if (!d || d.change === undefined) return undefined;
  if (d.change === 0) return 'no change';
  const sign = d.change > 0 ? '+' : '−';
  const abs = formatMetric(Math.abs(d.change), unit === 'percent' ? 'plain' : unit);
  const amount = unit === 'percent' ? `${sign}${abs} pts` : `${sign}${abs}`;
  return d.pct !== undefined && unit !== 'percent' ? `${amount} (${sign}${grouped(Math.abs(d.pct), 1)}%)` : amount;
}

// ---- src/companion/views.ts: the tiles, the dashboard, Home's row

const metricOf = (n: DemoNumbers, ref: Ref | undefined): Metric | undefined => (ref ? n.metrics.find((m) => m.sentinelId === ref[0] && m.name === ref[1]) : undefined);
const tileMetrics = (n: DemoNumbers, t: Tile): Metric[] => (t.kind === 'chart' ? (t.metrics ?? []) : t.metric ? [t.metric] : []).flatMap((r) => metricOf(n, r) ?? []);
const tileSentinel = (t: Tile): string | undefined => t.metric?.[0] ?? t.metrics?.[0]?.[0] ?? t.sentinelId;

function tileTitle(n: DemoNumbers, t: Tile, sentinels: readonly { summary: { id: string; name: string } }[]): string {
  if (t.title) return t.title;
  if (t.kind === 'divider') return '';
  if (t.kind === 'text') return sentinels.find((s) => s.summary.id === t.sentinelId)?.summary.name ?? 'A sentinel';
  const ms = tileMetrics(n, t);
  return ms.length ? ms.map((m) => m.label).join(' and ') : (t.metric ?? t.metrics?.[0])?.[1] ?? t.kind;
}

type Sentinels = readonly { summary: { id: string; name: string; topic: Topic; paused: boolean; projectId?: string; project?: string }; runs: readonly SentinelRunView[] }[];

function tileState(n: DemoNumbers, t: Tile, sentinels: Sentinels): DashboardTileView['state'] {
  if (t.kind === 'divider') return 'ok';
  const sid = tileSentinel(t);
  const s = sid ? sentinels.find((x) => x.summary.id === sid) : undefined;
  if (!s) return 'gone';
  if (s.summary.paused) return 'paused';
  const refs = t.kind === 'chart' ? (t.metrics ?? []) : t.metric ? [t.metric] : [];
  if (refs.length && !refs.some((r) => metricOf(n, r))) return 'waiting';
  return 'ok';
}

function tileView(n: DemoNumbers, t: Tile, sentinels: Sentinels): DashboardTileView {
  const state = tileState(n, t, sentinels);
  const sid = tileSentinel(t);
  const sn = sid ? sentinels.find((x) => x.summary.id === sid) : undefined;
  const base: DashboardTileView = { id: t.id, kind: t.kind, width: t.width, title: tileTitle(n, t, sentinels), state, ...(sn ? { sentinel: sn.summary.name, topic: sn.summary.topic } : {}), ...(t.compare ? { pinned: t.compare } : {}) };
  if (state === 'gone') return base;
  const ms = tileMetrics(n, t);
  const m = ms[0];
  if (t.kind === 'number' && m) {
    const last = m.points.at(-1);
    const deltas = Object.fromEntries(
      COMPARE.map((c) => {
        const dl = deltaOf(m.points, c, m.better);
        const change = changeText(dl, m.unit);
        return [c, { ...(change ? { change } : {}), tone: dl?.tone ?? 'none' }];
      }),
    );
    return { ...base, ...(last ? { value: formatMetric(last.value, m.unit), at: Math.round(last.at), runId: last.runId } : {}), deltas, trend: m.points.slice(-30).map((p) => p.value) };
  }
  if (t.kind === 'chart' && m) return { ...base, chart: { kind: t.chart ?? 'line', unit: m.unit, series: ms.slice(0, 8).map((x) => ({ label: x.label, points: x.points.slice(-90).map((p) => [Math.round(p.at), p.value] as [number, number]) })) } };
  if (t.kind === 'table' && m?.rows) {
    const columns = (m.columns?.length ? m.columns : Object.keys(m.rows[0] ?? {})).slice(0, 20);
    const rows = m.rows.slice(0, 50);
    // Typed as the Mac sends them (1.29): each document's cell as a ref the phone streams.
    const jobs = m.sentinelId === 'sn_jobs';
    const typed = jobs
      ? columns.flatMap((c, col) => {
          const ty = JOB_TYPES[c];
          if (!ty) return [];
          const values = rows.map((r) => (typeof r[c] === 'string' && r[c] ? String(r[c]) : null));
          const docs = ty.kind === 'html' || ty.kind === 'file' ? values.map((v) => JOB_DOCS.find((d) => d.name === v)).map((d) => (d ? { ref: d.ref, name: d.name, mime: d.mime } : null)) : undefined;
          return [{ col, key: c, kind: ty.kind, values, ...(docs ? { docs } : {}), ...(ty.max !== undefined ? { max: ty.max } : {}), ...(ty.button ? { button: ty.button } : {}) }];
        })
      : undefined;
    const heading = (c: string): string => (jobs ? JOB_TYPES[c]?.label : undefined) ?? c;
    return { ...base, table: { columns: columns.map(heading), keys: columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)), total: m.rows.length, ...(typed?.length ? { typed, metric: { sentinelId: m.sentinelId, name: m.name } } : {}) }, ...(m.rowsAt ? { at: Math.round(m.rowsAt) } : {}) };
  }
  if (t.kind === 'output') return { ...base, ...(t.output ? { output: t.output } : {}) };
  if (t.kind === 'text' && sn) {
    const last = sn.runs.find((r) => r.endedAt !== undefined);
    return { ...base, ...(last ? { text: last.headline.split('\n')[0]!, runId: last.id, at: Math.round(last.endedAt ?? last.startedAt) } : {}) };
  }
  return base;
}

const topicOf = (id: string): Topic => `dashboard:${id}` as Topic;
const refs = (n: DemoNumbers): DashboardView['dashboards'] => n.dashboards.map((d) => ({ id: d.id, name: d.name, topic: topicOf(d.id) }));

export function dashboardView(n: DemoNumbers, sentinels: Sentinels, id: string): DashboardView | undefined {
  const d = n.dashboards.find((x) => x.id === id);
  if (!d) return undefined;
  const r = n.refreshing[d.id];
  const running = r?.sentinelId ? sentinels.find((s) => s.summary.id === r.sentinelId)?.summary.name : undefined;
  return {
    id: d.id,
    name: d.name,
    compare: d.compare,
    tiles: d.tiles.map((t) => tileView(n, t, sentinels)),
    ...(r ? { refreshing: { done: r.done, total: r.total, ...(running ? { sentinel: running } : {}) } } : {}),
    dashboards: refs(n),
  };
}

/** What `SentinelsView` adds (1.22): the dashboards, and Home's row of the first one's first three numbers. */
export function numbersOf(n: DemoNumbers, sentinels: Sentinels): Pick<SentinelsView, 'dashboards' | 'numbers'> {
  const d = n.dashboards[0];
  if (!d) return {};
  const items = d.tiles
    .filter((t) => t.kind === 'number' && tileState(n, t, sentinels) !== 'gone')
    .flatMap((t) => {
      const m = metricOf(n, t.metric);
      const delta = m ? deltaOf(m.points, t.compare ?? d.compare, m.better) : undefined;
      if (!m || !delta) return [];
      const change = changeText(delta, m.unit);
      return [{ label: tileTitle(n, t, sentinels), value: formatMetric(delta.value, m.unit), ...(change ? { change } : {}), tone: delta.tone }];
    })
    .slice(0, 3);
  return { dashboards: refs(n), ...(items.length ? { numbers: { dashboard: { id: d.id, name: d.name, topic: topicOf(d.id) }, items } } : {}) };
}

/** The sentinels a dashboard draws from that are on, in its tiles' order (Refresh runs each, one at a time). */
export function dashboardSentinels(n: DemoNumbers, sentinels: Sentinels, id: string): string[] {
  const d = n.dashboards.find((x) => x.id === id);
  const ids = d ? d.tiles.flatMap((t) => (t.kind === 'divider' ? [] : [tileSentinel(t)])).filter((x): x is string => Boolean(x)) : [];
  return [...new Set(ids)].filter((sid) => sentinels.some((s) => s.summary.id === sid && !s.summary.paused));
}

const VS: Record<Compare, string> = { previous: 'vs the run before', day: 'vs yesterday', week: 'vs last week', month: 'vs last month' };
const day = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** A project's tint, as src/core/sentinel/widgets.ts `tintOf` works it out (its letter tile's hue). */
function tintOf(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = 0.55 * Math.min(0.55, 0.45);
  const f = (n: number): number => 0.55 - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number): string => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** 1.26 (BLG-361): every tile in words for the Home-screen widgets, as src/companion/views.ts `widgetsView` sends it. */
export function widgetsView(n: DemoNumbers, sentinels: Sentinels, iconOf: (projectId: string) => string | undefined): WidgetsView {
  const tiles: WidgetTileView[] = [];
  for (const d of n.dashboards)
    for (const t of d.tiles) {
      if (t.kind === 'divider') continue;
      const v = tileView(n, t, sentinels);
      const sid = tileSentinel(t);
      const sn = sid ? sentinels.find((x) => x.summary.id === sid) : undefined;
      const project = sn?.summary.project;
      const icon = sn?.summary.projectId ? iconOf(sn.summary.projectId) : undefined;
      const compare = t.compare ?? d.compare;
      const base = {
        id: `${d.id}/${t.id}`,
        dashboard: d.id,
        tile: t.id,
        board: d.name,
        title: v.title,
        tone: 'none',
        ...(v.state === 'paused' ? { note: 'paused' } : v.state === 'gone' ? { note: 'gone' } : {}),
        ...(project ? { project, tint: tintOf(project) } : {}),
        ...(icon ? { icon } : {}),
        ...(v.at ? { at: v.at } : {}),
      };
      if (t.kind === 'number') {
        const delta = v.deltas?.[compare];
        tiles.push({ ...base, kind: 'number', ...(v.value ? { value: v.value } : {}), ...(delta?.change ? { change: delta.change } : {}), tone: delta?.tone ?? 'none', vs: VS[compare], ...(v.trend ? { points: v.trend.slice(-40) } : {}) });
      } else if (t.kind === 'chart') {
        const pts = v.chart?.series[0]?.points.slice(-40) ?? [];
        tiles.push({ ...base, kind: 'chart', ...(pts.length ? { points: pts.map((p) => p[1]), from: day(pts[0]![0]), to: day(pts.at(-1)![0]), at: pts.at(-1)![0] } : {}) });
      } else if (t.kind === 'table') {
        const rows = v.table?.rows ?? [];
        tiles.push({ ...base, kind: 'text', ...(rows.length ? { value: `${v.table!.total} ${v.table!.total === 1 ? 'row' : 'rows'}`, text: rows.slice(0, 8).map((r) => r.slice(0, 3).map((c) => String(c ?? '')).join(' · ')).join('\n') } : {}) });
      } else {
        const text = v.output?.text ?? v.text;
        tiles.push({ ...base, kind: 'text', ...(text ? { text: text.replace(/[#*_`]/g, '').slice(0, 1000) } : {}) });
      }
    }
  return { tiles };
}
