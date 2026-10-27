import type { Compare } from './metrics.js';
import type { MetricSeries, SentinelState } from './model.js';

/**
 * Dashboards (docs/sentinel.md §10): your own selection of tiles from any sentinel, in a grid of
 * six columns. The types, and the pure part every screen shares: what a tile draws from, whether its
 * sentinel is paused or gone, the first dashboard made for you, where a dragged tile lands, and a
 * dashboard as Markdown. Tiles name a sentinel and a metric, never a source: no secrets in a tile.
 * Browser-safe.
 */

export const TILE_KINDS = ['number', 'chart', 'table', 'text', 'divider'] as const;
export type TileKind = (typeof TILE_KINDS)[number];
export const CHART_TILE_KINDS = ['line', 'area', 'bar'] as const;
export type ChartTileKind = (typeof CHART_TILE_KINDS)[number];
export const TILE_WIDTHS = [1, 2, 3] as const;
export type TileWidth = (typeof TILE_WIDTHS)[number];
export const GRID_COLUMNS = 6;

/** A sentinel's metric, by their ids. */
export interface MetricRef {
  readonly sentinelId: string;
  readonly metric: string;
}

export interface Tile {
  readonly id: string;
  readonly kind: TileKind;
  /** Columns of the six (a divider spans them all). */
  readonly width: TileWidth;
  /** Its own title (a divider's words; the metric's label when none). */
  readonly title?: string;
  /** A number's or a table's metric. */
  readonly metric?: MetricRef;
  /** A chart's metrics (one or several, over time). */
  readonly metrics?: readonly MetricRef[];
  readonly chart?: ChartTileKind;
  /** A text tile's sentinel: its last run's headline, or its report. */
  readonly sentinelId?: string;
  readonly text?: 'headline' | 'report';
  /** Its own compare, pinned (none: the dashboard's). */
  readonly compare?: Compare;
}

export interface Dashboard {
  readonly id: string;
  readonly name: string;
  /** What every tile compares with, unless it pins its own. */
  readonly compare: Compare;
  readonly tiles: readonly Tile[];
  /** Made for you when the first number arrived (it changes like any other). */
  readonly auto?: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const MAX_DASHBOARDS = 30;
export const MAX_TILES = 60;

/** The width a new tile of a kind gets. */
export const DEFAULT_WIDTH: Readonly<Record<TileKind, TileWidth>> = { number: 1, chart: 3, table: 3, text: 2, divider: 3 };

export const TILE_INFO: Readonly<Record<TileKind, { readonly label: string; readonly hint: string }>> = {
  number: { label: 'A number', hint: 'Its value, its change, and a sparkline' },
  chart: { label: 'A chart', hint: 'One or several numbers over time' },
  table: { label: 'A table', hint: 'The rows a sentinel kept last' },
  text: { label: 'Text', hint: 'A sentinel’s last headline or report' },
  divider: { label: 'A divider', hint: 'A title across the grid' },
};

/** The sentinels a tile draws from. */
export function tileSentinels(t: Tile): string[] {
  const ids = [...(t.metric ? [t.metric.sentinelId] : []), ...(t.metrics ?? []).map((m) => m.sentinelId), ...(t.sentinelId ? [t.sentinelId] : [])];
  return [...new Set(ids)];
}

/** The sentinels a dashboard draws from, in the order its tiles first name them (Refresh runs them so). */
export function dashboardSentinels(d: Pick<Dashboard, 'tiles'>): string[] {
  return [...new Set(d.tiles.flatMap(tileSentinels))];
}

export type TileState = 'ok' | 'paused' | 'gone' | 'waiting';

/**
 * Whether a tile can draw: its sentinel gone (deleted) or paused (said quietly), or its metric not
 * kept yet (waiting for its first run). A divider is always fine.
 */
export function tileState(t: Tile, sentinels: ReadonlyArray<{ readonly id: string; readonly paused: boolean }>, has: (ref: MetricRef) => boolean): TileState {
  if (t.kind === 'divider') return 'ok';
  const ids = tileSentinels(t);
  if (!ids.length) return 'gone';
  const items = ids.map((id) => sentinels.find((s) => s.id === id));
  if (items.every((s) => !s)) return 'gone';
  if (items.every((s) => !s || s.paused)) return 'paused';
  const refs = t.kind === 'chart' ? (t.metrics ?? []) : t.metric ? [t.metric] : [];
  if (refs.length && !refs.some(has)) return 'waiting';
  return 'ok';
}

/** The quiet words a tile says when it can't draw. */
export const TILE_STATE_WORDS: Readonly<Record<Exclude<TileState, 'ok'>, string>> = { paused: 'paused', gone: 'gone', waiting: 'waiting for its first run' };

/** A tile's tiles moved: `id` to `index` (in the list without it). */
export function moveTile<T extends { readonly id: string }>(tiles: readonly T[], id: string, index: number): T[] {
  const t = tiles.find((x) => x.id === id);
  if (!t) return [...tiles];
  const rest = tiles.filter((x) => x.id !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, t);
  return rest;
}

/** A tile's place on screen while dragging. */
export interface TileBox {
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Where a tile dropped at (x, y) goes among the others (their boxes in order, the lifted one taken
 * out): before the first tile it's above or to the left of on its row, else after the last.
 */
export function gridLanding(x: number, y: number, boxes: readonly TileBox[]): number {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    if (y < b.top) return i;
    if (y <= b.bottom && x < b.left + (b.right - b.left) / 2) return i;
  }
  return boxes.length;
}

/** Metrics a dashboard can be made from: the sentinels' metrics in the state, in order. */
export interface MetricInfo {
  readonly sentinelId: string;
  readonly name: string;
  readonly kind: 'number' | 'rows';
}

/** The first dashboard's tiles: every number as a tile, then every table, the charts after (each sentinel's numbers together). */
export function autoTiles(metrics: readonly MetricInfo[], id: () => string): Tile[] {
  const numbers = metrics.filter((m) => m.kind === 'number');
  const tables = metrics.filter((m) => m.kind === 'rows');
  const bySentinel = [...new Set(numbers.map((m) => m.sentinelId))];
  return [
    ...numbers.map((m): Tile => ({ id: id(), kind: 'number', width: 1, metric: { sentinelId: m.sentinelId, metric: m.name } })),
    ...bySentinel.slice(0, 4).map((sid): Tile => ({ id: id(), kind: 'chart', width: 3, chart: 'line', metrics: numbers.filter((m) => m.sentinelId === sid).slice(0, 4).map((m) => ({ sentinelId: sid, metric: m.name })) })),
    ...tables.map((m): Tile => ({ id: id(), kind: 'table', width: 3, metric: { sentinelId: m.sentinelId, metric: m.name } })),
  ].slice(0, MAX_TILES);
}

/** What a dashboard says as Markdown (Copy as Markdown): each tile's words, numbers as a table. */
export function dashboardMarkdown(d: Dashboard, words: (t: Tile) => { readonly title: string; readonly value?: string; readonly change?: string; readonly text?: string }): string {
  const out: string[] = [`# ${d.name}`, ''];
  let table: string[] = [];
  const flush = (): void => {
    if (!table.length) return;
    out.push('| Number | Now | Change |', '|---|---|---|', ...table, '');
    table = [];
  };
  for (const t of d.tiles) {
    const w = words(t);
    if (t.kind === 'number') {
      table.push(`| ${cellText(w.title)} | ${cellText(w.value ?? '—')} | ${cellText(w.change ?? '')} |`);
      continue;
    }
    flush();
    if (t.kind === 'divider') out.push(`## ${w.title}`, '');
    else out.push(`**${w.title}**${w.value ? ` · ${w.value}` : ''}`, ...(w.text ? ['', w.text] : []), '');
  }
  flush();
  return `${out.join('\n').trim()}\n`;
}

const cellText = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

// ---------------------------------------------------------------- what a tile draws (every screen)

/** A metric of the state, by its ref. */
export const metricOf = (s: Pick<SentinelState, 'metrics'>, ref: MetricRef | undefined): MetricSeries | undefined => (ref ? s.metrics?.[ref.sentinelId]?.[ref.metric] : undefined);

/** The metrics a tile draws, as far as they're kept. */
export function tileMetrics(s: Pick<SentinelState, 'metrics'>, t: Tile): MetricSeries[] {
  const refs = t.kind === 'chart' ? (t.metrics ?? []) : t.metric ? [t.metric] : [];
  return refs.flatMap((r) => metricOf(s, r) ?? []);
}

/** What a tile is called: its own title, its metric's label (a chart's labels), its sentinel's name. */
export function tileTitle(s: Pick<SentinelState, 'metrics' | 'items'>, t: Tile): string {
  if (t.title) return t.title;
  if (t.kind === 'divider') return '';
  if (t.kind === 'text') return s.items.find((i) => i.id === t.sentinelId)?.name ?? 'A sentinel';
  const ms = tileMetrics(s, t);
  if (ms.length) return ms.map((m) => m.label).join(' and ');
  const ref = t.metric ?? t.metrics?.[0];
  return ref ? ref.metric : TILE_INFO[t.kind].label;
}

/** What a tile compares with: its own pinned compare, else the dashboard's. */
export const tileCompare = (d: Pick<Dashboard, 'compare'>, t: Tile): Compare => t.compare ?? d.compare;

/** A tile's state from the state slice. */
export const tileStateIn = (s: Pick<SentinelState, 'metrics' | 'items'>, t: Tile): TileState => tileState(t, s.items, (r) => Boolean(metricOf(s, r)));
