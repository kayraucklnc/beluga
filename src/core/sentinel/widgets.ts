import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../store.js';
import { readProjectIcon } from '../project-icons.js';
import { type Dashboard, type Tile, metricOf, tileCompare, tileMetrics, tileOutput, tileStateIn, tileTitle, TILE_STATE_WORDS } from './dashboard-model.js';
import { formatMetric, metricWords } from './metrics.js';
import type { SentinelState } from './model.js';

/**
 * Board tiles as macOS widgets (BLG-309). The daemon keeps a small snapshot of every tile in
 * ~/.beluga/widgets/tiles.json, already in words (the widget only reads and draws), and each
 * project's icon beside it. The widget is sandboxed and may read only that folder; Beluga's window
 * watches the file and asks macOS to redraw the widgets when it changes. Nothing else of ~/.beluga
 * is ever in it: a tile's words, never a source, a query or a key.
 */

export const WIDGETS_VERSION = 1;

export interface WidgetTile {
  /** "<dashboardId>/<tileId>". */
  readonly id: string;
  readonly board: string;
  readonly title: string;
  /** How the widget draws it: a number (value, change, sparkline), a chart, or text. */
  readonly kind: 'number' | 'chart' | 'text';
  readonly value?: string;
  readonly change?: string;
  /** Which way the change went, as good or bad (its colour). */
  readonly tone: 'good' | 'bad' | 'none';
  /** "vs last week". */
  readonly vs?: string;
  /** Its points, oldest first (at most 40). */
  readonly points?: readonly number[];
  /** Under a chart: the first and the last label ("Oct 21", "Oct 28" or the series' own). */
  readonly from?: string;
  readonly to?: string;
  readonly text?: string;
  /** "paused", "draft: turn it on", "gone", "waiting for its first run". */
  readonly note?: string;
  /** The project it comes from (none: Your Mac). */
  readonly project?: string;
  /** The project's icon, a file beside tiles.json ("icons/<id>.png"). */
  readonly icon?: string;
  /** Its tint (the hue its project's letter tile has), as #rrggbb. */
  readonly tint?: string;
  /** Opens the board on that tile. */
  readonly url: string;
  /** When what it shows came (ms). */
  readonly at?: number;
}

export interface WidgetSnapshot {
  readonly version: number;
  readonly tiles: readonly WidgetTile[];
}

/** The same calm hue a project's letter tile has (ProjectIcon's), as #rrggbb. */
export function tintOf(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return hslHex(h, 0.55, 0.55);
}

function hslHex(h: number, s: number, l: number): string {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number): string => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** Markdown as plain words for a widget: no marks, links as their text, short. */
export function plainText(md: string, max = 600): string {
  const text = md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '· ')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** At most `n` of them, the last always kept (a long series thinned evenly). */
function thin(values: readonly number[], n = 40): number[] {
  if (values.length <= n) return [...values];
  const step = (values.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => values[Math.round(i * step)]!);
}

const day = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/**
 * Every tile of every board as a widget shows it. `projectOf` names a sentinel's project and where
 * its icon is (none: Your Mac).
 */
export function widgetSnapshot(s: SentinelState, projectOf: (projectId: string | undefined) => { readonly name: string; readonly icon?: string } | undefined): WidgetSnapshot {
  const tiles: WidgetTile[] = [];
  for (const d of s.dashboards ?? []) for (const t of d.tiles) {
    const w = widgetTile(s, d, t, projectOf);
    if (w) tiles.push(w);
  }
  return { version: WIDGETS_VERSION, tiles };
}

function widgetTile(s: SentinelState, d: Dashboard, t: Tile, projectOf: (projectId: string | undefined) => { readonly name: string; readonly icon?: string } | undefined): WidgetTile | undefined {
  if (t.kind === 'divider') return undefined;
  const sid = t.metric?.sentinelId ?? t.metrics?.[0]?.sentinelId ?? t.sentinelId ?? t.step?.sentinelId;
  const item = sid ? s.items.find((i) => i.id === sid) : undefined;
  const p = item ? projectOf(item.projectId) : undefined;
  const state = tileStateIn(s, t);
  const base = {
    id: `${d.id}/${t.id}`,
    board: d.name,
    title: tileTitle(s, t),
    tone: 'none' as const,
    ...(state !== 'ok' ? { note: TILE_STATE_WORDS[state] } : {}),
    ...(p ? { project: p.name, tint: tintOf(p.name), ...(p.icon ? { icon: p.icon } : {}) } : {}),
    url: `beluga://board/${encodeURIComponent(d.id)}?tile=${encodeURIComponent(t.id)}`,
  };
  if (t.kind === 'number' || t.kind === 'series') {
    const m = t.kind === 'number' ? metricOf(s, t.metric) : tileMetrics(s, t)[0];
    if (!m) return { ...base, kind: t.kind === 'number' ? 'number' : 'chart' };
    if (m.kind === 'series' && m.series?.length) {
      const last = m.series.at(-1)!;
      return { ...base, kind: 'chart', value: formatMetric(last.y, m.unit), points: thin(m.series.map((x) => x.y)), from: m.series[0]!.x, to: last.x, ...(m.points.at(-1) ? { at: m.points.at(-1)!.at } : {}) };
    }
    const words = metricWords(m, tileCompare(d, t));
    const pts = m.points.slice(-40);
    return {
      ...base,
      kind: t.kind === 'number' ? 'number' : 'chart',
      ...(words.value ? { value: words.value } : {}),
      ...(words.change ? { change: words.change } : {}),
      tone: words.tone === 'good' ? 'good' : words.tone === 'bad' ? 'bad' : 'none',
      vs: words.vs,
      points: pts.map((x) => x.value),
      ...(pts.length ? { from: day(pts[0]!.at), to: day(pts.at(-1)!.at), at: pts.at(-1)!.at } : {}),
    };
  }
  if (t.kind === 'table') {
    const m = metricOf(s, t.metric);
    const rows = m?.rows ?? [];
    const lines = rows.slice(0, 8).map((r) => Object.values(r).slice(0, 3).map((v) => String(v ?? '')).join(' · '));
    return { ...base, kind: 'text', ...(rows.length ? { value: `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`, text: lines.join('\n') } : {}) };
  }
  if (t.kind === 'output') {
    const o = tileOutput(s, t);
    return { ...base, kind: 'text', ...(o ? { text: plainText(o.text), ...(o.at ? { at: o.at } : {}) } : {}) };
  }
  // A sentinel's last headline (the report stays in Beluga).
  const last = [...s.runs].reverse().find((r) => r.sentinelId === t.sentinelId && r.endedAt);
  return { ...base, kind: 'text', ...(last?.headline ? { text: last.headline, at: last.endedAt } : {}) };
}

// ---------------------------------------------------------------- keeping the file

/**
 * Keep ~/.beluga/widgets/tiles.json in step with the boards: written (atomically) a moment after
 * what a tile shows changes, never when nothing did. Project icons are copied beside it once each.
 * → stop.
 */
export function keepWidgetSnapshot(store: Store, dir: string, roots: (projectId: string) => string | undefined, wait = 2000): () => void {
  const icons = path.join(dir, 'icons');
  let last = '';
  let seen: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const copied = new Map<string, string | undefined>();
  const iconOf = (projectId: string): string | undefined => {
    if (copied.has(projectId)) return copied.get(projectId);
    const root = roots(projectId);
    const icon = root ? readProjectIcon(root) : undefined;
    const ext = icon?.mime === 'image/png' ? 'png' : icon?.mime === 'image/jpeg' ? 'jpg' : undefined;
    let rel: string | undefined;
    if (icon && ext) {
      try {
        mkdirSync(icons, { recursive: true });
        const name = `${projectId.replace(/[^\w.-]/g, '_')}.${ext}`;
        writeFileSync(path.join(icons, name), Buffer.from(icon.data, 'base64'));
        rel = `icons/${name}`;
      } catch {
        rel = undefined;
      }
    }
    copied.set(projectId, rel);
    return rel;
  };
  const write = (): void => {
    timer = undefined;
    const st = store.getState();
    const snap = widgetSnapshot(st.sentinel, (projectId) => {
      const p = projectId ? st.projects.find((x) => x.id === projectId) : undefined;
      if (!p) return undefined;
      const icon = iconOf(p.id);
      return { name: p.name, ...(icon ? { icon } : {}) };
    });
    const json = JSON.stringify(snap);
    if (json === last) return;
    last = json;
    try {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'tiles.json');
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, json, { mode: 0o644 });
      renameSync(tmp, file);
    } catch {
      // Not written: the widgets keep what they had, and the next change tries again.
      last = '';
    }
  };
  try {
    last = readFileSync(path.join(dir, 'tiles.json'), 'utf8');
  } catch {
    last = '';
  }
  const update = (): void => {
    const st = store.getState().sentinel;
    // Only what tiles draw from: the boards, the numbers, the outputs, the sentinels and their runs.
    const parts = [st.dashboards, st.metrics, st.outputs, st.items, st.runs];
    if (Array.isArray(seen) && parts.every((x, i) => x === (seen as unknown[])[i])) return;
    seen = parts;
    if (!timer) timer = setTimeout(write, wait);
    timer.unref?.();
  };
  update();
  const off = store.subscribe(update);
  return () => {
    off();
    if (timer) clearTimeout(timer);
  };
}
