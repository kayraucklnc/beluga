import { stripCode } from '../../../../../src/companion/strip';
import type { ConvView } from '../protocol';
import { type Row, type ViewQuery, pageOf } from '../../render';

/**
 * The demo's conversation that draws everything the Mac's chat draws (BLG-68): numbers as stats,
 * a live table from a "sqlite" source (its rows come from the demo Mac, paged, sorted, searched
 * and filtered by its controls), a chart, colors, a graph with a walkthrough, a Markdown table,
 * a code view, and inline elements in the words. The prose goes through the Mac's own stripCode,
 * so it's exactly what a real Mac sends.
 */

const MIN = 60_000;
const DB = '/Users/you/shop/shop.db';

const STATS = {
  type: 'stats',
  title: 'This week',
  items: [
    { label: 'Revenue', value: 48210, type: 'currency', delta: 12.4, trend: [31, 34, 33, 38, 41, 44, 48] },
    { label: 'Orders', value: 1204, delta: 8.1, trend: [140, 151, 160, 158, 172, 190, 233] },
    { label: 'Refund rate', value: 1.8, unit: '%', delta: -0.6, invert: true, trend: [2.6, 2.4, 2.5, 2.1, 2.0, 1.9, 1.8] },
    { label: 'p95 checkout', value: 412, unit: 'ms', delta: '+38ms', invert: true, status: 'warning', trend: [360, 370, 365, 380, 395, 401, 412] },
  ],
};

const TABLE = {
  type: 'table',
  title: 'Orders',
  summary: 'From shop.db, newest first',
  source: { kind: 'sqlite', path: DB, query: 'select id, customer, country, total, status, created_at from orders' },
  columns: [{ key: 'id', label: 'Order' }, { key: 'total', type: 'currency' }, { key: 'status', type: 'badge' }, { key: 'created_at', label: 'Placed', type: 'datetime' }],
  pageSize: 8,
  total: 240,
  initial: { sort: '-created_at' },
  controls: [
    { id: 'rank', type: 'buttons', options: [{ label: 'Newest' }, { label: 'Biggest', sort: '-total', top: 10 }, { label: 'Refunded', where: [{ key: 'status', value: 'refunded' }] }] },
    { id: 'country', type: 'select', column: 'country', options: [{ label: 'DE', value: 'DE' }, { label: 'US', value: 'US' }, { label: 'TR', value: 'TR' }] },
  ],
  actions: [{ label: 'Refunds only', source: { kind: 'sqlite', path: DB, query: "select id, customer, country, total, status, created_at from orders where status = 'refunded'" } }],
};

const CHART = {
  type: 'chart',
  title: 'Revenue and refunds',
  chart: 'area',
  x: 'day',
  y: [{ key: 'revenue', label: 'Revenue' }, { key: 'refunds', label: 'Refunds' }],
  columns: [{ key: 'revenue', type: 'currency' }, { key: 'refunds', type: 'currency' }],
  data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => ({ day, revenue: [5200, 6100, 5800, 6900, 7400, 8100, 8710][i], refunds: [140, 90, 160, 110, 120, 95, 130][i] })),
};

const BARS = {
  type: 'chart',
  title: 'Orders by country',
  chart: 'bar',
  data: [
    { country: 'Germany', orders: 412 },
    { country: 'United States', orders: 388 },
    { country: 'Türkiye', orders: 201 },
    { country: 'France', orders: 120 },
    { country: 'Japan', orders: 83 },
  ],
};

const DONUT = { type: 'chart', title: 'Payment methods', chart: 'donut', data: [{ method: 'Card', share: 61 }, { method: 'Apple Pay', share: 22 }, { method: 'PayPal', share: 12 }, { method: 'Bank', share: 5 }] };

const COLORS = { type: 'colors', title: 'Checkout palette', swatches: [{ value: '#2a78d6', name: 'Primary' }, { value: '#1baf7a', name: 'Success' }, { value: '#eda100', name: 'Warning' }, { value: '#e34948', name: 'Danger' }, { value: '#f6f6f7', name: 'Surface' }, { value: '#1d1d1f', name: 'Ink' }] };

const GRAPH = {
  title: 'How a payment flows',
  summary: 'From the app to the bank and back',
  direction: 'right',
  nodes: [
    { id: 'phone', type: 'client', label: 'Shop app', sublabel: 'React Native' },
    { id: 'edge', type: 'group', label: 'Our cloud' },
    { id: 'api', type: 'service', label: 'Checkout API', sublabel: 'Node · Fastify', group: 'edge', status: 'active', details: 'Takes the cart, makes a payment intent, and waits for the webhook before the order is paid.' },
    { id: 'db', type: 'database', label: 'Orders DB', sublabel: 'Postgres', group: 'edge', fields: [{ name: 'id', type: 'uuid', key: 'pk' }, { name: 'customer_id', type: 'uuid', key: 'fk' }, { name: 'total', type: 'numeric' }, { name: 'status', type: 'text' }] },
    { id: 'queue', type: 'queue', label: 'Webhooks', group: 'edge' },
    { id: 'stripe', type: 'external', label: 'Stripe', links: [{ label: 'Dashboard', href: 'https://dashboard.stripe.com' }] },
  ],
  edges: [
    { from: 'phone', to: 'api', label: 'pay', kind: 'call' },
    { from: 'api', to: 'stripe', label: 'intent', kind: 'call' },
    { from: 'stripe', to: 'queue', label: 'event', kind: 'async' },
    { from: 'queue', to: 'api', kind: 'async' },
    { from: 'api', to: 'db', label: 'paid', kind: 'data' },
  ],
  steps: [
    { title: '1. You pay', text: 'The app sends the cart to the Checkout API.', focus: ['phone', 'api'] },
    { title: '2. Stripe takes it', text: 'The API makes a payment intent; Stripe charges the card.', focus: ['api', 'stripe'] },
    { title: '3. The webhook comes back', text: 'Stripe tells us it worked; the API marks the order paid.', focus: ['stripe', 'queue', 'api', 'db'] },
  ],
};

const CODE = { type: 'code', title: 'The retry rule', language: 'ts', filename: 'retry.ts', startLine: 12, highlight: [14], code: 'export function retryDelay(attempt: number): number {\n  // 1s, 2s, 4s… up to a minute\n  return Math.min(60_000, 1000 * 2 ** attempt);\n}' };

const fence = (tag: string, json: unknown): string => ['```' + tag, JSON.stringify(json, null, 1), '```'].join('\n');

const ANSWER = [
  'Here’s the payments dashboard. Revenue is `delta:+12%` on last week, refunds are under target `badge:passed`, and the month is at `progress:72%` of its goal.',
  '',
  fence('beluga-stats', STATS),
  '',
  'The orders, live from `shop.db` (tap a heading to sort, or try **Biggest**):',
  '',
  fence('beluga-view', TABLE),
  '',
  fence('beluga-chart', CHART),
  '',
  fence('beluga-chart', BARS),
  '',
  fence('beluga-chart', DONUT),
  '',
  'How a payment flows (tap a box for its details, or walk through it):',
  '',
  fence('beluga-graph', GRAPH),
  '',
  '| Region | Orders | Revenue | p95 |',
  '|---|---|---|---|',
  '| Europe | 612 | $24,180 | 380 ms |',
  '| Americas | 431 | $18,940 | 402 ms |',
  '| Asia | 161 | $5,090 | 455 ms |',
  '',
  'The palette I used for the new checkout: `colors:#2a78d6,#1baf7a,#eda100,#e34948`, primary `#2a78d6`.',
  '',
  fence('beluga-colors', COLORS),
  '',
  'The retry rule I changed:',
  '',
  fence('beluga-code', CODE),
  '',
  'Open the search with `kbd:cmd+shift+p`. Checkout p95 went `delta:+38ms bad`, trend `spark:360,370,365,380,395,401,412`. Last deploy `time:' + new Date(Date.now() - 3 * 3600_000).toISOString() + '`. It’s tracked in `task:BLG-39`.',
].join('\n');

export function dashboardConv(now: number): ConvView {
  return {
    topic: 'conv:shop.dashboard',
    title: 'Payments dashboard',
    project: 'shop',
    more: false,
    canSend: true,
    working: false,
    needsYou: [],
    turns: [
      { id: 'd1', who: 'you', name: 'You', ts: now - 20 * MIN, prose: { text: 'Show me the payments dashboard: this week’s numbers, the orders from shop.db, and how a payment flows.', code: [] } },
      { id: 'd2', who: 'claude', name: 'Claude', ts: now - 19 * MIN, endTs: now - 17 * MIN, status: 'done', steps: 9, prose: stripCode(ANSWER), trail: [{ tool: 'read', text: 'Read schema.sql' }, { tool: 'tool', text: 'Used show' }, { tool: 'tool', text: 'Used show' }, { tool: 'tool', text: 'Used show' }] },
    ],
  };
}

/** The demo's shop.db: 240 orders. */
const ORDERS: Row[] = Array.from({ length: 240 }, (_, i) => {
  const names = ['Mia Becker', 'Theo Grant', 'Ada Yılmaz', 'Sam Okafor', 'Lena Vogt', 'Kenji Mori', 'Clara Dubois', 'Omar Haddad'];
  const countries = ['DE', 'US', 'TR', 'US', 'DE', 'JP', 'FR', 'TR'];
  const statuses = ['paid', 'paid', 'paid', 'pending', 'paid', 'refunded', 'paid', 'failed'];
  return { id: 10_480 - i, customer: names[i % 8]!, country: countries[(i * 3) % 8]!, total: Math.round((19 + ((i * 37) % 280) + (i % 7) * 0.99) * 100) / 100, status: statuses[(i * 5) % 8]!, created_at: new Date(Date.UTC(2026, 9, 24, 12) - i * 47 * MIN).toISOString() };
});

/** What the demo Mac's sqlite source answers: the shared paging, sorting, search and conditions. */
export function demoRows(query: string, q: ViewQuery): { rows: Row[]; columns: string[]; total?: number; hasMore: boolean; at: number } {
  const base = /status = 'refunded'/.test(query) ? ORDERS.filter((r) => r.status === 'refunded') : ORDERS;
  const page = pageOf(base, q);
  return { rows: [...page.rows], columns: ['id', 'customer', 'country', 'total', 'status', 'created_at'], ...(page.total !== undefined ? { total: page.total } : {}), hasMore: page.hasMore, at: Date.now() };
}
