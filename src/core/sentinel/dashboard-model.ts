import type { Compare } from './metrics.js';
import type { MetricSeries, OutputFormat, SentinelState, StepOutput, StepKind } from './model.js';

/**
 * Sentinel's dashboard (docs/sentinel.md §10): your own selection of tiles from any sentinel, in a
 * grid of six columns. The types, and the pure part every screen shares: what a tile draws from,
 * whether its sentinel is paused, a draft or gone, what a step's output is (Markdown, JSON, text),
 * the first dashboard made for you, where a dragged tile lands, and a dashboard as Markdown. Tiles
 * name a sentinel and a metric or a step, never a source: no secrets in a tile. Browser-safe.
 */

/** number · series (over time, or a kept array) · table · output (a step's export) · text · divider. */
export const TILE_KINDS = ['number', 'series', 'table', 'output', 'text', 'divider'] as const;
export type TileKind = (typeof TILE_KINDS)[number];
/** What a series tile was called before BLG-246 (read as `series`). */
export const LEGACY_TILE_KINDS: Readonly<Record<string, TileKind>> = { chart: 'series' };
export const CHART_TILE_KINDS = ['line', 'area', 'bar'] as const;
export type ChartTileKind = (typeof CHART_TILE_KINDS)[number];
export const TILE_WIDTHS = [1, 2, 3, 4, 6] as const;
export type TileWidth = (typeof TILE_WIDTHS)[number];
/** Normal, or tall (twice the room: a long report, a big chart). */
export const TILE_HEIGHTS = [1, 2] as const;
export type TileHeight = (typeof TILE_HEIGHTS)[number];
export const GRID_COLUMNS = 6;

/** A tile dragged by its corner to span `columns` (fractional) lands on the nearest width there is. */
export function snapWidth(columns: number): TileWidth {
  const c = Math.min(GRID_COLUMNS, Math.max(1, columns));
  return TILE_WIDTHS.reduce<TileWidth>((best, w) => (Math.abs(w - c) < Math.abs(best - c) ? w : best), 1);
}
/** How an output tile shows what the step said: as it reads (`auto`), Markdown, a JSON tree, a table, or plain text. */
export const OUTPUT_SHOWS = ['auto', 'markdown', 'tree', 'table', 'text'] as const;
export type OutputShow = (typeof OUTPUT_SHOWS)[number];
/** The steps an output tile can show: what Claude, a service or a script said. */
export const OUTPUT_STEP_KINDS: ReadonlySet<StepKind> = new Set(['claude', 'http', 'script']);

/** A sentinel's step, by their ids (an output tile's). */
export interface StepRef {
  readonly sentinelId: string;
  readonly stepId: string;
}

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
  /** Tall: twice the room. */
  readonly height?: TileHeight;
  /** Its own title (a divider's words; the metric's label when none). */
  readonly title?: string;
  /** A number's, table's or output's metric; a series tile's kept array (a `series` metric). */
  readonly metric?: MetricRef;
  /** A series tile's metrics over time (one or several). */
  readonly metrics?: readonly MetricRef[];
  readonly chart?: ChartTileKind;
  /** An output tile's step: its latest output. */
  readonly step?: StepRef;
  /** How an output tile shows it. */
  readonly show?: OutputShow;
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
export const DEFAULT_WIDTH: Readonly<Record<TileKind, TileWidth>> = { number: 1, series: 3, table: 3, output: 3, text: 2, divider: 6 };

export const TILE_INFO: Readonly<Record<TileKind, { readonly label: string; readonly hint: string }>> = {
  number: { label: 'A number', hint: 'Its value and its change against the last one, with a sparkline' },
  series: { label: 'A series', hint: 'Numbers over time, or an array a sentinel kept, as lines, areas or bars' },
  table: { label: 'A table', hint: 'The rows a sentinel kept last' },
  output: { label: 'An output', hint: 'A step’s latest export: what Claude wrote, or a service’s answer' },
  text: { label: 'Text', hint: 'A sentinel’s last headline or report' },
  divider: { label: 'A divider', hint: 'A title across the grid' },
};

export const WIDTH_WORDS: Readonly<Record<TileWidth, string>> = { 1: 'Narrow (1 of 6)', 2: 'Small (2 of 6)', 3: 'Half (3 of 6)', 4: 'Wide (4 of 6)', 6: 'Full width' };

/** The sentinels a tile draws from. */
export function tileSentinels(t: Tile): string[] {
  const ids = [...(t.metric ? [t.metric.sentinelId] : []), ...(t.metrics ?? []).map((m) => m.sentinelId), ...(t.sentinelId ? [t.sentinelId] : []), ...(t.step ? [t.step.sentinelId] : [])];
  return [...new Set(ids)];
}

/** The metrics a tile reads (a series tile's over time, or the one it names). */
export const tileRefs = (t: Pick<Tile, 'kind' | 'metric' | 'metrics'>): readonly MetricRef[] => (t.kind === 'series' && t.metrics?.length ? t.metrics : t.metric ? [t.metric] : []);

/** Every step an output tile names, across dashboards (the daemon keeps their latest outputs). */
export function outputSteps(dashboards: readonly Pick<Dashboard, 'tiles'>[]): StepRef[] {
  const seen = new Map<string, StepRef>();
  for (const d of dashboards) for (const t of d.tiles) if (t.kind === 'output' && t.step) seen.set(`${t.step.sentinelId}/${t.step.stepId}`, t.step);
  return [...seen.values()];
}

/** The sentinels a dashboard draws from, in the order its tiles first name them (Refresh runs them so). */
export function dashboardSentinels(d: Pick<Dashboard, 'tiles'>): string[] {
  return [...new Set(d.tiles.flatMap(tileSentinels))];
}

export type TileState = 'ok' | 'paused' | 'draft' | 'gone' | 'waiting';

/**
 * Whether a tile can draw: its sentinel gone (deleted), a draft (made, never turned on and never
 * run: Add a Tile by description makes one), or paused (said quietly); or what it shows isn't kept
 * yet (waiting for its first run). A divider is always fine.
 */
export function tileState(
  t: Tile,
  sentinels: ReadonlyArray<{ readonly id: string; readonly paused: boolean; readonly steps?: ReadonlyArray<{ readonly id: string }> }>,
  has: (ref: MetricRef) => boolean,
  ran: (sentinelId: string) => boolean = () => true,
  hasOutput: (ref: StepRef) => boolean = () => true,
): TileState {
  if (t.kind === 'divider') return 'ok';
  const ids = tileSentinels(t);
  if (!ids.length) return 'gone';
  const items = ids.map((id) => sentinels.find((s) => s.id === id));
  if (items.every((s) => !s)) return 'gone';
  // An output tile whose step was taken out of its sentinel.
  const stepOf = t.step ? items[0] : undefined;
  if (t.step && stepOf?.steps && !stepOf.steps.some((st) => st.id === t.step!.stepId)) return 'gone';
  if (items.every((s) => !s || s.paused)) return items.some((s) => s && !ran(s.id)) ? 'draft' : 'paused';
  const refs = tileRefs(t);
  if (refs.length && !refs.some(has)) return 'waiting';
  if (t.kind === 'output' && t.step && !hasOutput(t.step)) return 'waiting';
  return 'ok';
}

/** The quiet words a tile says when it can't draw. */
export const TILE_STATE_WORDS: Readonly<Record<Exclude<TileState, 'ok'>, string>> = { paused: 'paused', draft: 'draft: turn it on', gone: 'gone', waiting: 'waiting for its first run' };

// ---------------------------------------------------------------- outputs (a step's export)

/** What a step's output is: a Claude step writes Markdown, a service answers JSON (or text), a script prints text or JSON. */
export function outputFormat(text: string, kind?: StepKind): OutputFormat {
  const t = text.trim();
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return 'json';
    } catch {
      // Not JSON after all.
    }
  }
  return kind === 'claude' ? 'markdown' : kind === 'http' || kind === 'script' ? 'text' : /(^|\n)(#{1,4} |[-*] |\d+\. )|\*\*|`/.test(t) ? 'markdown' : 'text';
}

/** JSON that reads as a table: a list of objects (or an object holding one, like `{ "data": [...] }`). */
export function outputRows(value: unknown): Array<Record<string, unknown>> | undefined {
  const isRows = (v: unknown): v is Array<Record<string, unknown>> => Array.isArray(v) && v.length > 0 && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
  if (isRows(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const inner = Object.values(value as Record<string, unknown>).find(isRows);
    if (inner) return inner;
  }
  return undefined;
}

/** How an output tile draws it: what it was asked to (`show`), else what it reads as. */
export function outputLook(o: { readonly text: string; readonly format: OutputFormat }, show: OutputShow = 'auto'): 'markdown' | 'tree' | 'table' | 'text' {
  let parsed: unknown;
  const json = o.format === 'json' || show === 'tree' || show === 'table';
  if (json) {
    try {
      parsed = JSON.parse(o.text);
    } catch {
      parsed = undefined;
    }
  }
  if (show === 'table') return parsed !== undefined && outputRows(parsed) ? 'table' : parsed !== undefined ? 'tree' : 'text';
  if (show === 'tree') return parsed !== undefined ? 'tree' : 'text';
  if (show === 'markdown' || show === 'text') return show;
  // A list of objects reads as a table; anything else as a tree (Show as › Table finds a list inside one).
  if (o.format === 'json') return parsed !== undefined && Array.isArray(parsed) && outputRows(parsed) ? 'table' : parsed !== undefined ? 'tree' : 'text';
  return o.format === 'markdown' ? 'markdown' : 'text';
}

/** What an output tile shows: the step's latest output (from the state), or an output metric's. */
export function tileOutput(s: Pick<SentinelState, 'metrics' | 'outputs'>, t: Tile): (StepOutput & { readonly from: 'step' | 'metric' }) | undefined {
  if (t.kind !== 'output') return undefined;
  if (t.step) {
    const o = s.outputs?.[t.step.sentinelId]?.[t.step.stepId];
    return o ? { ...o, from: 'step' } : undefined;
  }
  const m = metricOf(s, t.metric);
  if (!m?.output) return undefined;
  return { text: m.output.text, format: m.output.format, runId: m.rowsRunId ?? m.points.at(-1)?.runId ?? '', at: m.rowsAt ?? m.points.at(-1)?.at ?? 0, from: 'metric' };
}

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
  readonly kind: MetricSeries['kind'];
}

/** The first dashboard's tiles: every number as a tile, then every table, the charts after (each sentinel's numbers together). */
export function autoTiles(metrics: readonly MetricInfo[], id: () => string): Tile[] {
  const numbers = metrics.filter((m) => m.kind === 'number');
  const tables = metrics.filter((m) => m.kind === 'rows');
  const bySentinel = [...new Set(numbers.map((m) => m.sentinelId))];
  return [
    ...numbers.map((m): Tile => ({ id: id(), kind: 'number', width: 1, metric: { sentinelId: m.sentinelId, metric: m.name } })),
    ...bySentinel.slice(0, 4).map((sid): Tile => ({ id: id(), kind: 'series', width: 3, chart: 'line', metrics: numbers.filter((m) => m.sentinelId === sid).slice(0, 4).map((m) => ({ sentinelId: sid, metric: m.name })) })),
    ...metrics.filter((m) => m.kind === 'series').map((m): Tile => ({ id: id(), kind: 'series', width: 3, chart: 'bar', metric: { sentinelId: m.sentinelId, metric: m.name } })),
    ...tables.map((m): Tile => ({ id: id(), kind: 'table', width: 3, metric: { sentinelId: m.sentinelId, metric: m.name } })),
    ...metrics.filter((m) => m.kind === 'output').map((m): Tile => ({ id: id(), kind: 'output', width: 3, metric: { sentinelId: m.sentinelId, metric: m.name } })),
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
  return tileRefs(t).flatMap((r) => metricOf(s, r) ?? []);
}

/** What a tile is called: its own title, its metric's label (a series' labels), its step's or sentinel's name. */
export function tileTitle(s: Pick<SentinelState, 'metrics' | 'items'>, t: Tile): string {
  if (t.title) return t.title;
  if (t.kind === 'divider') return '';
  if (t.kind === 'text') return s.items.find((i) => i.id === t.sentinelId)?.name ?? 'A sentinel';
  if (t.kind === 'output' && t.step) {
    const sn = s.items.find((i) => i.id === t.step!.sentinelId);
    const st = sn?.steps.find((x) => x.id === t.step!.stepId);
    return st ? `${st.name}` : (sn?.name ?? 'A step');
  }
  const ms = tileMetrics(s, t);
  if (ms.length) return ms.map((m) => m.label).join(' and ');
  const ref = t.metric ?? t.metrics?.[0];
  return ref ? ref.metric : TILE_INFO[t.kind].label;
}

/** What a tile compares with: its own pinned compare, else the dashboard's. */
export const tileCompare = (d: Pick<Dashboard, 'compare'>, t: Tile): Compare => t.compare ?? d.compare;

/** A tile's state from the state slice. */
export const tileStateIn = (s: Pick<SentinelState, 'metrics' | 'items'> & Partial<Pick<SentinelState, 'runs' | 'outputs'>>, t: Tile): TileState =>
  tileState(
    t,
    s.items,
    (r) => Boolean(metricOf(s, r)),
    // It ran: a run in the state, or something it kept (the state keeps a sentinel's last 30 runs only).
    (id) => !s.runs || s.runs.some((r) => r.sentinelId === id) || Boolean(s.metrics?.[id]),
    (r) => !s.outputs || Boolean(s.outputs[r.sentinelId]?.[r.stepId]),
  );

/** The sentinel a tile draws from (its metric's, its first metric's, its step's, or its own); none for a divider. */
export const tileSentinelOf = (tile: Pick<Tile, 'metric' | 'metrics' | 'sentinelId' | 'step'>): string | undefined => tile.metric?.sentinelId ?? tile.metrics?.[0]?.sentinelId ?? tile.sentinelId ?? tile.step?.sentinelId;
