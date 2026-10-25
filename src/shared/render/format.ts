import type { Cell, Column, ColumnType, Row } from '../view-spec.js';

/**
 * How a view's cells read: numbers with their digits grouped, bytes as KB/MB, dates in your
 * locale, percentages, money. Pure (tested in tests/mac-views.test.ts).
 */

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let f = numberFormats.get(key);
  if (!f) numberFormats.set(key, (f = make()));
  return f;
}

export function formatNumber(n: number, opts: { decimals?: number; compact?: boolean } = {}): string {
  if (opts.compact && Math.abs(n) >= 10_000) return nf(`c${opts.decimals ?? ''}`, () => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: opts.decimals ?? 1 })).format(n);
  const d = opts.decimals ?? (Number.isInteger(n) ? 0 : Math.abs(n) < 1 ? 3 : 2);
  return nf(`n${d}`, () => new Intl.NumberFormat(undefined, { maximumFractionDigits: d, minimumFractionDigits: opts.decimals ?? 0 })).format(n);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1000 && i < units.length - 1) (v /= 1000, i++);
  return `${n < 0 ? '-' : ''}${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** A date from a cell: ISO text, or milliseconds (or seconds) since 1970. */
export function toDate(c: Cell): Date | undefined {
  if (typeof c === 'number') return new Date(c < 1e11 ? c * 1000 : c);
  if (typeof c !== 'string' || !c.trim()) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(c.trim()) ? `${c.trim()}T00:00:00` : c);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const dateF = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const dateTimeF = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function formatCell(c: Cell, col: { readonly type: ColumnType; readonly decimals?: number | undefined; readonly currency?: string | undefined; readonly unit?: string | undefined; readonly key?: string }): string {
  if (c === null || c === undefined) return '';
  const type: ColumnType = col.type;
  const unit = col.unit ? (col.unit === '%' ? '%' : ` ${col.unit}`) : '';
  if (typeof c === 'number') {
    switch (type) {
      case 'bytes':
        return formatBytes(c);
      case 'percent':
        return `${formatNumber(Math.abs(c) <= 1 ? c * 100 : c, { decimals: col.decimals ?? 1 })}%`;
      case 'currency': {
        // Whole amounts without cents ("$48,210"), unless the column says how many digits.
        const d = col.decimals ?? (Number.isInteger(c) ? 0 : 2);
        const code = (col.currency ?? 'USD').toUpperCase();
        return nf(`$${code}${d}`, () => new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: d, minimumFractionDigits: d })).format(c);
      }
      case 'date':
      case 'datetime': {
        const d = toDate(c);
        return d ? (type === 'date' ? dateF : dateTimeF).format(d) : String(c);
      }
      default:
        // Ids, years and ports read as written ("1001", not "1,001").
        if (col.key && Number.isInteger(c) && /(^|_|\b)(id|year|port|pid|code|zip|number|no)$/i.test(col.key)) return `${c}${unit}`;
        return `${formatNumber(c, col.decimals !== undefined ? { decimals: col.decimals } : {})}${unit}`;
    }
  }
  if (typeof c === 'boolean') return c ? 'Yes' : 'No';
  if (type === 'date' || type === 'datetime') {
    const d = toDate(c);
    return d ? (type === 'date' ? dateF : dateTimeF).format(d) : c;
  }
  return `${c}${unit && c ? unit : ''}`;
}

/** "3 minutes ago", for when the rows were fetched. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return dateF.format(new Date(at));
}

export const numericTypes: ReadonlySet<ColumnType> = new Set(['number', 'percent', 'currency', 'bytes']);
export const isNumeric = (c: Column): boolean => numericTypes.has(c.type);
export const alignOf = (c: Column): 'left' | 'right' | 'center' => c.align ?? (isNumeric(c) ? 'right' : c.type === 'bool' || c.type === 'color' ? 'center' : 'left');

/** A column's heading: its label (a blank one stays blank), else its key in words ("created_at" → "Created at"). */
export function headingOf(c: Pick<Column, 'key' | 'label'>): string {
  if (c.label !== undefined) return c.label;
  const words = c.key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : c.key;
}

/** Rows as CSV (Copy as CSV). */
export function toCsv(rows: readonly Row[], columns: readonly Column[]): string {
  const esc = (v: Cell): string => {
    const t = v === null ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [columns.map((c) => esc(c.key)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key] ?? null)).join(','))].join('\n');
}

/** A badge's tone from its words ("failed" reads as a problem). */
export function toneOf(v: string): 'good' | 'warning' | 'critical' | 'info' | 'neutral' {
  const t = v.toLowerCase();
  if (/^(ok|done|success|succeeded|passed|pass|active|healthy|up|paid|merged|open|online|ready|complete|completed|true|yes)$/.test(t)) return 'good';
  if (/^(failed|fail|error|errored|down|critical|blocked|rejected|cancelled|canceled|offline|dead|refunded|false|no)$/.test(t)) return 'critical';
  if (/^(warn|warning|pending|waiting|queued|slow|degraded|review|in review|draft|partial|stale|todo|overdue|late|expiring)$/.test(t)) return 'warning';
  if (/^(running|in progress|in_progress|building|new|info|started)$/.test(t)) return 'info';
  return 'neutral';
}

// ---------------------------------------------------------------- colors

/**
 * Series colors, in a fixed order (never cycled past eight: more fold into "Other"). Validated
 * for color-vision deficiencies on light and dark surfaces (the dataviz reference palette).
 */
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'] as const;
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;
export const MAX_SERIES = 8;

/** A color's parts (hex, rgb() or hsl()), or undefined for anything else. */
export function parseColor(raw: string): { r: number; g: number; b: number; a: number } | undefined {
  const s = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const n = (i: number): number => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (rgb) return { r: +rgb[1]!, g: +rgb[2]!, b: +rgb[3]!, a: rgb[4] ? (rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : +rgb[4]) : 1 };
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (hsl) {
    const [r, g, b] = hslToRgb(+hsl[1]!, +hsl[2]! / 100, +hsl[3]! / 100);
    return { r, g, b, a: hsl[4] ? (hsl[4].endsWith('%') ? parseFloat(hsl[4]) / 100 : +hsl[4]) : 1 };
  }
  return undefined;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

export function toHsl({ r, g, b }: { r: number; g: number; b: number }): string {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return `hsl(${Math.round((h * 60 + 360) % 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

const lin = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export const luminance = ({ r, g, b }: { r: number; g: number; b: number }): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrast(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
/** Text that reads on a color: near-black or white, whichever has more contrast. */
export const inkOn = (c: { r: number; g: number; b: number }): string => (contrast(c, { r: 255, g: 255, b: 255 }) >= contrast(c, { r: 17, g: 17, b: 17 }) ? '#ffffff' : '#111111');
