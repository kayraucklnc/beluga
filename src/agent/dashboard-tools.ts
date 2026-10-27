import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { DashboardTools } from './types.js';

/**
 * Dashboards and numbers as Claude's tools (server `beluga_dashboard`, docs/sentinel.md §10), in
 * your own runs only: the numbers sentinels keep (metric_list, metric_read, so "what were
 * subscribers a month ago" works in any chat), your dashboards and their tiles, and inside a
 * sentinel's run, sentinel_measure to keep a number it found.
 */

export const DASHBOARD_TOOL_NAMES = ['sentinel_measure', 'dashboard_list', 'dashboard_create', 'dashboard_add_tile', 'dashboard_update_tile', 'dashboard_remove_tile', 'metric_list', 'metric_read'].map((n) => `mcp__beluga_dashboard__${n}`);

const dashboard = z.string().min(1).max(80).describe('The dashboard’s id (dashboard_list) or its name');
const sentinel = z.string().min(1).max(80).describe('The sentinel’s id or name');
const metric = z.string().min(1).max(80).describe('The metric’s name (metric_list), like subscribers');
const compare = z.enum(['previous', 'day', 'week', 'month']);

const TILE = {
  width: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('Columns of six: a number 1, a chart or table 2 or 3'),
  title: z.string().max(80).optional().describe('Its own title (a divider’s words); the metric’s label when none'),
  sentinel: sentinel.optional().describe('A number’s, table’s or text tile’s sentinel'),
  metric: metric.optional().describe('A number’s or table’s metric'),
  metrics: z.array(z.object({ sentinel, metric })).max(8).optional().describe('A chart’s metrics, one or several'),
  chart: z.enum(['line', 'area', 'bar']).optional(),
  text: z.enum(['headline', 'report']).optional().describe('A text tile: the sentinel’s last headline, or its last report'),
  compare: compare.optional().describe('Pin this tile’s compare; none follows the dashboard’s'),
};

function guarded(fn: () => string): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    return Promise.resolve({ content: [{ type: 'text', text: fn() }] });
  } catch (err) {
    return Promise.resolve({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
  }
}

export function createDashboardToolDefs(d: DashboardTools) {
  const measure = d.measure;
  return [
    ...(measure
      ? [
          tool(
            'sentinel_measure',
            'Keep a number this sentinel run found ("the channel has 1,204 subscribers"): its name (subscribers), the value, and its unit (count, currency:USD, percent, ms, bytes, plain). The run’s Keep the numbers step keeps it with the run’s time; it shows on the sentinel’s page and dashboards, compared with the past. Only real numbers you looked up, never a guess.',
            { name: z.string().min(1).max(60), value: z.union([z.number(), z.string().max(40)]), unit: z.string().max(20).optional(), label: z.string().max(80).optional() },
            (a) => guarded(() => measure(a.name, a.value, a.unit, a.label)),
          ),
        ]
      : []),
    tool('dashboard_list', 'The user’s dashboards, each with its tiles (their ids, what each shows, how wide) and what it compares with.', {}, () => guarded(() => d.list())),
    tool('dashboard_create', 'Make a new, empty dashboard (a tab on the Dashboard page), then add tiles to it.', { name: z.string().trim().min(1).max(60) }, (a) => guarded(() => d.create(a.name))),
    tool(
      'dashboard_add_tile',
      'Add a tile to a dashboard: kind number (a sentinel’s metric: its value, change and sparkline), chart (metrics over time), table (a rows metric), text (a sentinel’s last headline or report) or divider (a title). Tiles name a sentinel and a metric only, never a query or a key.',
      { dashboard, kind: z.enum(['number', 'chart', 'table', 'text', 'divider']), ...TILE },
      ({ dashboard: ref, ...t }) => guarded(() => d.addTile(ref, t)),
    ),
    tool(
      'dashboard_update_tile',
      'Change a tile: only the fields given change (compare: null follows the dashboard’s again).',
      { dashboard, tile: z.string().min(1).max(40).describe('The tile’s id (dashboard_list)'), ...TILE, compare: compare.nullable().optional() },
      ({ dashboard: ref, tile: tileId, ...patch }) => guarded(() => d.updateTile(ref, tileId, patch)),
    ),
    tool('dashboard_remove_tile', 'Take a tile off a dashboard (the number stays kept).', { dashboard, tile: z.string().min(1).max(40) }, (a) => guarded(() => d.removeTile(a.dashboard, a.tile))),
    tool('metric_list', 'Every number the user’s sentinels keep: by sentinel, each metric’s name, label, unit, which way is good and its last value.', {}, () => guarded(() => d.metricList())),
    tool(
      'metric_read',
      'A metric’s points over time (two years at most), oldest first: to answer "what were subscribers a month ago" or to see a trend.',
      { sentinel, name: metric, since: z.string().max(40).optional().describe('From when: a date (2026-09-01) or a time back (7d, 4w, 3 months); none: all of it') },
      (a) => guarded(() => d.metricRead(a.sentinel, a.name, a.since)),
    ),
  ];
}

export function createDashboardTools(d: DashboardTools) {
  return createSdkMcpServer({ name: 'beluga_dashboard', version: '0.1.0', tools: createDashboardToolDefs(d) });
}
