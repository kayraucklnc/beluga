import type { Cell, Column, Row, View } from '../view-spec.js';
import { toDate } from './format.js';

/**
 * Gantt, heatmap and calendar views (docs/views.md), worked out from their rows: which columns say
 * what (given, or found by name and kind), the bars, cells and days to draw, and the colors of a
 * value. Pure: the Mac and the phone draw the same plan, each with its own pieces.
 */

const DAY = 86_400_000;

const findKey = (columns: readonly Column[], given: string | undefined, names: RegExp, ok: (c: Column) => boolean = () => true): string | undefined => {
  if (given && columns.some((c) => c.key === given)) return given;
  return columns.find((c) => names.test(c.key) && ok(c))?.key;
};
const isNum = (c: Column): boolean => c.type === 'number' || c.type === 'percent' || c.type === 'currency' || c.type === 'bytes';
const isDate = (c: Column): boolean => c.type === 'date' || c.type === 'datetime';
const num = (c: Cell | undefined): number | undefined => {
  if (typeof c === 'number') return Number.isFinite(c) ? c : undefined;
  if (typeof c === 'string' && c.trim()) {
    const n = Number(c.replace(/[%,\s]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof c === 'boolean') return c ? 1 : 0;
  return undefined;
};
const text = (c: Cell | undefined): string => (c === null || c === undefined ? '' : String(c));

// ---------------------------------------------------------------- gantt

export interface GanttBar {
  readonly label: string;
  readonly start: number;
  readonly end: number;
  /** 0–1. */
  readonly progress?: number;
  readonly status?: string;
  readonly milestone: boolean;
  readonly row: Row;
}
export interface GanttLane {
  readonly name: string;
  readonly bars: readonly GanttBar[];
}
export interface GanttTick {
  readonly t: number;
  readonly label: string;
}
export interface GanttPlan {
  readonly lanes: readonly GanttLane[];
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly GanttTick[];
  /** Today, when it falls inside. */
  readonly today?: number;
  /** Whether times of day matter (bars shorter than a day). */
  readonly hours: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Ticks along a time axis: hours, days, weeks or months, about `want` of them. */
export function timeTicks(min: number, max: number, want = 6): GanttTick[] {
  const span = Math.max(1, max - min);
  const steps: ReadonlyArray<readonly [number, (d: Date) => string]> = [
    [3_600_000, (d) => `${d.getHours()}:00`],
    [6 * 3_600_000, (d) => `${d.getHours()}:00`],
    [DAY, (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`],
    [7 * DAY, (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`],
    [14 * DAY, (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`],
  ];
  const step = steps.find(([s]) => span / s <= want * 1.6);
  const out: GanttTick[] = [];
  if (step) {
    const [s, f] = step;
    const first = new Date(min);
    if (s >= DAY) first.setHours(0, 0, 0, 0);
    else first.setMinutes(0, 0, 0);
    // Weeks start on Monday.
    if (s >= 7 * DAY) first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    for (let t = first.getTime(); t <= max && out.length < 60; t += s) if (t >= min) out.push({ t, label: f(new Date(t)) });
    return out;
  }
  // Months (or quarters for long spans).
  const months = span / (30 * DAY);
  const every = months <= want * 1.6 ? 1 : months <= want * 3.2 ? 2 : months <= want * 5 ? 3 : 6;
  const d = new Date(min);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() <= max && out.length < 60) {
    if (d.getTime() >= min && d.getMonth() % every === 0) out.push({ t: d.getTime(), label: d.getMonth() === 0 || !out.length ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : MONTHS[d.getMonth()]! });
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

export function planGantt(view: View, rows: readonly Row[], columns: readonly Column[], now = Date.now()): GanttPlan | undefined {
  const startKey = findKey(columns, view.start, /^(start|starts?_?at|from|begin|begins?|start_?date|since|opened)$/i) ?? columns.find(isDate)?.key;
  const endKey = findKey(columns, view.end, /^(end|ends?_?at|to|until|finish|finishes|due|due_?date|end_?date|deadline|closed)$/i) ?? columns.filter(isDate).find((c) => c.key !== startKey)?.key;
  const durKey = columns.find((c) => /^(days?|duration|weeks?|hours?)$/i.test(c.key))?.key;
  const labelKey = findKey(columns, view.label, /^(task|name|title|label|item|phase|step|milestone|issue)$/i) ?? columns.find((c) => c.type === 'text' && c.key !== startKey && c.key !== endKey)?.key;
  const groupKey = findKey(columns, view.group, /^(group|section|lane|team|owner|assignee|project|stream|category)$/i);
  const progressKey = findKey(columns, view.progress, /^(progress|percent|pct|complete|completion|done_?pct)$/i);
  const statusKey = columns.find((c) => /^(status|state)$/i.test(c.key))?.key;
  const milestoneKey = columns.find((c) => /^milestone$/i.test(c.key))?.key;
  if (!startKey) return undefined;
  const lanes = new Map<string, GanttBar[]>();
  let min = Infinity;
  let max = -Infinity;
  let hours = false;
  for (const r of rows) {
    const s = toDate(r[startKey] ?? null)?.getTime();
    if (s === undefined) continue;
    let e = endKey ? toDate(r[endKey] ?? null)?.getTime() : undefined;
    if (e === undefined && durKey) {
      const d = num(r[durKey]);
      const unit = /week/i.test(durKey) ? 7 * DAY : /hour/i.test(durKey) ? 3_600_000 : DAY;
      if (d !== undefined) e = s + d * unit;
    }
    // A date alone ends at the end of its day; nothing at all is a milestone.
    const endCell = endKey ? r[endKey] : undefined;
    if (e !== undefined && typeof endCell === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(endCell.trim())) e += DAY;
    const milestone = (milestoneKey ? r[milestoneKey] === true || r[milestoneKey] === 'true' : false) || e === undefined || e <= s;
    const end = milestone ? s : e!;
    if (end - s > 0 && end - s < DAY) hours = true;
    let p = progressKey ? num(r[progressKey]) : undefined;
    if (p !== undefined && p > 1) p /= 100;
    const status = statusKey ? text(r[statusKey]) : undefined;
    const lane = groupKey ? text(r[groupKey]) : '';
    const bar: GanttBar = { label: labelKey ? text(r[labelKey]) : '', start: s, end, ...(p !== undefined ? { progress: Math.max(0, Math.min(1, p)) } : {}), ...(status ? { status } : {}), milestone, row: r };
    const list = lanes.get(lane) ?? [];
    list.push(bar);
    lanes.set(lane, list);
    min = Math.min(min, s);
    max = Math.max(max, end);
  }
  if (!Number.isFinite(min)) return undefined;
  // A little room either side.
  const pad = Math.max((max - min) * 0.03, hours ? 1_800_000 : DAY / 2);
  const lo = min - pad;
  const hi = max + pad;
  return {
    lanes: [...lanes].map(([name, bars]) => ({ name, bars })),
    min: lo,
    max: hi,
    ticks: timeTicks(lo, hi),
    ...(view.today && now >= lo && now <= hi ? { today: now } : {}),
    hours,
  };
}

/** A bar's tone, from its status words. */
export function barTone(status: string | undefined): 'mint' | 'sky' | 'rose' | 'butter' | 'lavender' | 'neutral' {
  const s = (status ?? '').toLowerCase();
  if (/done|complete|shipped|merged|closed|finished/.test(s)) return 'mint';
  if (/active|progress|doing|current|running|open/.test(s)) return 'sky';
  if (/block|fail|late|overdue|crit|risk/.test(s)) return 'rose';
  if (/review|wait|pending|hold/.test(s)) return 'butter';
  if (/todo|planned|backlog|next|later/.test(s)) return 'neutral';
  return 'lavender';
}

/** Where a time falls along the axis, 0–1. */
export const along = (plan: Pick<GanttPlan, 'min' | 'max'>, t: number): number => (t - plan.min) / Math.max(1, plan.max - plan.min);

// ---------------------------------------------------------------- heatmap

export interface HeatPlan {
  readonly xs: readonly string[];
  readonly ys: readonly string[];
  /** cells[y][x]. */
  readonly cells: readonly (readonly (number | null)[])[];
  readonly min: number;
  readonly max: number;
  readonly valueColumn?: Column;
}

export function planHeatmap(view: View, rows: readonly Row[], columns: readonly Column[]): HeatPlan | undefined {
  const valueKey = findKey(columns, view.value, /^(value|count|n|total|amount|score|hits|errors|events|sum)$/i, isNum);
  const yGiven = view.series[0]?.key;
  const xKey = view.x && columns.some((c) => c.key === view.x) ? view.x : undefined;
  const yKey = yGiven && columns.some((c) => c.key === yGiven) ? yGiven : undefined;
  const cats = columns.filter((c) => !isNum(c) || c.key === xKey || c.key === yKey);
  let xs: string[] = [];
  let ys: string[] = [];
  const at = new Map<string, number>();
  if (valueKey) {
    // Long rows: {x, y, value}.
    const x = xKey ?? cats.find((c) => c.key !== valueKey && c.key !== yKey)?.key;
    const y = yKey ?? cats.find((c) => c.key !== valueKey && c.key !== x)?.key;
    if (!x || !y) return undefined;
    for (const r of rows) {
      const xv = text(r[x]);
      const yv = text(r[y]);
      if (!xs.includes(xv)) xs.push(xv);
      if (!ys.includes(yv)) ys.push(yv);
      const v = num(r[valueKey]);
      if (v !== undefined) at.set(`${yv}\0${xv}`, (at.get(`${yv}\0${xv}`) ?? 0) + v);
    }
  } else {
    // Wide rows: one row per y, its number columns are the x's.
    const y = yKey ?? cats.find((c) => c.key !== xKey)?.key ?? columns[0]?.key;
    const nums = columns.filter((c) => isNum(c) && c.key !== y);
    if (!y || !nums.length) return undefined;
    xs = nums.map((c) => c.label ?? c.key);
    for (const r of rows) {
      const yv = text(r[y]);
      ys.push(yv);
      nums.forEach((c, i) => {
        const v = num(r[c.key]);
        if (v !== undefined) at.set(`${yv}\0${xs[i]}`, v);
      });
    }
  }
  xs = xs.slice(0, 120);
  ys = ys.slice(0, 120);
  const cells = ys.map((y) => xs.map((x) => at.get(`${y}\0${x}`) ?? null));
  const all = cells.flat().filter((v): v is number => v !== null);
  if (!all.length) return undefined;
  const valueColumn = valueKey ? columns.find((c) => c.key === valueKey) : undefined;
  return { xs, ys, cells, min: view.min ?? Math.min(...all), max: view.max ?? Math.max(...all), ...(valueColumn ? { valueColumn } : {}) };
}

// ---------------------------------------------------------------- calendar

export interface CalendarDay {
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly value: number | null;
  /** Inside the range shown (days before the first or after the last pad the weeks). */
  readonly inside: boolean;
  readonly note?: string;
}
export interface CalendarPlan {
  /** Monday-first weeks, each 7 days. */
  readonly weeks: readonly (readonly CalendarDay[])[];
  /** Where each month starts (the week index) and its name. */
  readonly months: readonly { readonly week: number; readonly label: string }[];
  readonly min: number;
  readonly max: number;
  readonly total: number;
  readonly days: number;
  readonly valueColumn?: Column;
}

const dayKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function planCalendar(view: View, rows: readonly Row[], columns: readonly Column[]): CalendarPlan | undefined {
  const dateKey = findKey(columns, view.x ?? view.start, /^(date|day|when|at|time|timestamp|created(_?at)?)$/i) ?? columns.find(isDate)?.key;
  if (!dateKey) return undefined;
  const valueKey = findKey(columns, view.value ?? view.series[0]?.key, /^(value|count|n|total|amount|commits?|hours|minutes|events|contributions)$/i, isNum) ?? columns.find((c) => isNum(c) && c.key !== dateKey)?.key;
  const noteKey = view.label && columns.some((c) => c.key === view.label) ? view.label : undefined;
  const values = new Map<string, number>();
  const notes = new Map<string, string>();
  let first: Date | undefined;
  let last: Date | undefined;
  for (const r of rows) {
    const d = toDate(r[dateKey] ?? null);
    if (!d) continue;
    const k = dayKey(d);
    // No value column: each row counts once (events on a day).
    values.set(k, (values.get(k) ?? 0) + (valueKey ? (num(r[valueKey]) ?? 0) : 1));
    if (noteKey && r[noteKey] !== null && r[noteKey] !== undefined) notes.set(k, notes.has(k) ? `${notes.get(k)}, ${text(r[noteKey])}` : text(r[noteKey]));
    if (!first || d < first) first = d;
    if (!last || d > last) last = d;
  }
  if (!first || !last) return undefined;
  const from = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  let to = new Date(last.getFullYear(), last.getMonth(), last.getDate());
  // At most a year and a bit, the latest days.
  if ((to.getTime() - from.getTime()) / DAY > 380) from.setTime(to.getTime() - 371 * DAY);
  const start = new Date(from);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  to = new Date(to);
  const weeks: CalendarDay[][] = [];
  const months: { week: number; label: string }[] = [];
  let lastMonth = -1;
  for (const d = new Date(start); d <= to || weeks.at(-1)?.length !== 7; d.setDate(d.getDate() + 1)) {
    if (!weeks.length || weeks.at(-1)!.length === 7) weeks.push([]);
    const k = dayKey(d);
    const inside = d >= from && d <= to;
    weeks.at(-1)!.push({ date: k, value: inside ? (values.get(k) ?? 0) : null, inside, ...(notes.has(k) ? { note: notes.get(k)! } : {}) });
    if (inside && d.getMonth() !== lastMonth && d.getDate() <= 7) {
      months.push({ week: weeks.length - 1, label: MONTHS[d.getMonth()]! });
      lastMonth = d.getMonth();
    }
    if (weeks.length > 60) break;
  }
  const all = weeks.flat().filter((d) => d.inside).map((d) => d.value ?? 0);
  const valueColumn = valueKey ? columns.find((c) => c.key === valueKey) : undefined;
  return { weeks, months, min: view.min ?? 0, max: view.max ?? Math.max(1, ...all), total: all.reduce((a, b) => a + b, 0), days: all.filter((v) => v > 0).length, ...(valueColumn ? { valueColumn } : {}) };
}

// ---------------------------------------------------------------- color scale

/** Soft scales (pastel, never neon): from the surface to the color. Light and dark. */
export const HEAT_LIGHT = ['#eef1f5', '#cfe3f7', '#9ec9ef', '#6aa9e0', '#3f86cc'] as const;
export const HEAT_DARK = ['#22262d', '#23395a', '#2c5684', '#3a74ad', '#5b97d1'] as const;
/** Days: the calendar's greens. */
export const DAYS_LIGHT = ['#eef1f5', '#cdeccf', '#9ad8a2', '#5fbd72', '#3a9a52'] as const;
export const DAYS_DARK = ['#22262d', '#1f4a2c', '#2a6b3c', '#3b8f50', '#5bb36e'] as const;

function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A value's color between `min` and `max` along a scale of colors (null: the empty color). */
export function scaleColor(v: number | null, min: number, max: number, scale: readonly string[]): string {
  if (v === null || scale.length < 2) return scale[0] ?? '#eeeeee';
  const t = max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : v > 0 ? 1 : 0;
  // Nothing (zero or less, at the bottom) is the surface; anything else is at least the first tint.
  if (t === 0 && v <= 0) return scale[0]!;
  const steps = scale.length - 1;
  const at = 1 + t * (steps - 1);
  const i = Math.min(steps - 1, Math.floor(at));
  const f = at - i;
  const a = hexRgb(scale[i]!);
  const b = hexRgb(scale[Math.min(steps, i + 1)]!);
  return `#${a.map((x, k) => Math.round(x + (b[k]! - x) * f).toString(16).padStart(2, '0')).join('')}`;
}

/** A custom scale from the view's own colors (two or more), else the default. */
export function scaleOf(view: Pick<View, 'colors' | 'type'>, dark: boolean): readonly string[] {
  if (view.colors && view.colors.length >= 2 && view.colors.every((c) => /^#[0-9a-f]{6}$/i.test(c))) return [dark ? HEAT_DARK[0] : HEAT_LIGHT[0], ...view.colors];
  if (view.type === 'calendar') return dark ? DAYS_DARK : DAYS_LIGHT;
  return dark ? HEAT_DARK : HEAT_LIGHT;
}
