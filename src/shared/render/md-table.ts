import { type Row, type View, readView } from '../view-spec.js';

/**
 * A plain Markdown table Claude wrote (the kind Claude Code prints in a terminal), read as a view:
 * its headings and cells as rows, so it sorts, searches and turns into a chart like any other.
 * Only plain cells (text, bold, code): a table with links or pictures in it stays as written.
 * Pure (tested in tests/mac-views.test.ts).
 */

type Hast = { type: string; tagName?: string; value?: string; children?: Hast[] };

const PLAIN = new Set(['strong', 'em', 'b', 'i', 'code', 'del', 's', 'span', 'br', 'sup', 'sub']);

/** The table's text, or undefined when it has more than text in it (or is too small to be worth it). */
export function tableRows(node: Hast | undefined): { columns: string[]; rows: string[][] } | undefined {
  if (!node) return undefined;
  const trs: Hast[] = [];
  const walk = (n: Hast): void => {
    if (n.type === 'element' && n.tagName === 'tr') trs.push(n);
    else n.children?.forEach(walk);
  };
  walk(node);
  const cells = (tr: Hast): Hast[] => (tr.children ?? []).filter((c) => c.type === 'element' && (c.tagName === 'td' || c.tagName === 'th'));
  let rich = false;
  const text = (n: Hast): string => {
    if (n.type === 'text') return n.value ?? '';
    if (n.type === 'element' && n.tagName && !PLAIN.has(n.tagName) && n.tagName !== 'td' && n.tagName !== 'th') rich = true;
    if (n.tagName === 'br') return ' ';
    return (n.children ?? []).map(text).join('');
  };
  const [head, ...body] = trs;
  if (!head || body.length < 2) return undefined;
  const columns = cells(head).map((c) => text(c).trim());
  const rows = body.map((tr) => cells(tr).map((c) => text(c).trim()));
  if (rich || columns.length < 2 || columns.some((c) => !c)) return undefined;
  return { columns, rows };
}

/** As a view: numbers read as numbers ("1,204", "$12.50", "42%"), so they sort and chart. */
export function tableView(t: { columns: string[]; rows: string[][] }): View | undefined {
  const keys = uniqueKeys(t.columns);
  // A column of numbers with one unit ("388 ms", "12 GB") is numbers, the unit said once.
  const units = keys.map((_, i) => {
    const found = t.rows.map((r) => /^[-+]?\d[\d,]*(\.\d+)?\s*([a-zA-Zµ]{1,4})$/.exec((r[i] ?? '').trim())?.[2]);
    return found.every((u) => u && u === found[0]) ? found[0] : undefined;
  });
  const data: Row[] = t.rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, cellOf(units[i] ? (r[i] ?? '').replace(units[i]!, '') : (r[i] ?? ''))])));
  const numeric = keys.filter((k) => data.every((r) => r[k] === null || typeof r[k] === 'number'));
  const columns = keys.map((key, i) => {
    const raw = t.rows.map((r) => r[i] ?? '');
    const pct = numeric.includes(key) && raw.some((x) => /%\s*$/.test(x));
    const money = numeric.includes(key) && raw.some((x) => /^[-+]?\$/.test(x.trim()));
    return { key, label: t.columns[i]!, ...(pct ? { type: 'number', unit: '%' } : money ? { type: 'currency' } : units[i] ? { type: 'number', unit: units[i] } : {}) };
  });
  const parsed = readView({ type: 'table', data, columns, pageSize: 15, search: t.rows.length > 8 });
  return parsed.ok ? parsed.view : undefined;
}

function uniqueKeys(cols: string[]): string[] {
  const seen = new Map<string, number>();
  return cols.map((c) => {
    const n = seen.get(c) ?? 0;
    seen.set(c, n + 1);
    return n ? `${c} (${n + 1})` : c;
  });
}

/** A cell's text as a value: "1,204" → 1204, "$12.50" → 12.5, "42%" → 42, "—" → empty. */
function cellOf(s: string): string | number | null {
  const t = s.trim();
  if (!t || /^[-–—]$/.test(t) || /^n\/?a$/i.test(t)) return null;
  const m = /^([-+]?)\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\s*%?$/.exec(t);
  if (m && !/^0\d/.test(t.replace(/^[-+$\s]+/, ''))) return Number(`${m[1]}${m[2]!.replace(/,/g, '')}${m[4] ?? ''}`);
  return t;
}
