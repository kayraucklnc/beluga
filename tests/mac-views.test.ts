import { describe, expect, it } from 'vitest';
import { contrast, formatBytes, formatCell, headingOf, inkOn, parseColor, toCsv, toHex, toneOf } from '../packages/mac/src/components/views/format.js';
import { readInline } from '../packages/mac/src/components/views/inline-model.js';
import { tableRows, tableView } from '../packages/mac/src/components/views/md-table.js';
import { planChart } from '../packages/mac/src/components/views/chart-model.js';
import type { Column } from '../src/shared/view-spec.js';
import { MAX_TASK_CARDS, readTaskKeys } from '../src/shared/task-refs.js';

const col = (key: string, type: Column['type'] = 'number'): Column => ({ key, type });

describe('how cells read', () => {
  it('numbers, money, bytes, percentages and ids', () => {
    expect(formatCell(48210, col('revenue', 'currency'))).toMatch(/48,210$/);
    expect(formatCell(19.5, col('price', 'currency'))).toMatch(/19\.50$/);
    expect(formatBytes(1_536_000)).toBe('1.5 MB');
    expect(formatCell(0.462, col('share', 'percent'))).toBe('46.2%');
    expect(formatCell(1001, col('id'))).toBe('1001');
    expect(formatCell(12345, col('count'))).toBe('12,345');
    expect(formatCell(true, col('ok', 'bool'))).toBe('Yes');
  });

  it('headings, badges and CSV', () => {
    expect(headingOf({ key: 'created_at' })).toBe('Created at');
    expect(headingOf({ key: 'totalCount' })).toBe('Total Count');
    expect([toneOf('Failed'), toneOf('paid'), toneOf('pending'), toneOf('blue')]).toEqual(['critical', 'good', 'warning', 'neutral']);
    expect(toCsv([{ a: 'x, y', b: 1 }], [col('a', 'text'), col('b')])).toBe('a,b\n"x, y",1');
  });

  it('colors', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(toHex(parseColor('rgb(42, 120, 214)')!)).toBe('#2a78d6');
    expect(toHex(parseColor('hsl(0 100% 50%)')!)).toBe('#ff0000');
    expect(contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21);
    expect(inkOn(parseColor('#eda100')!)).toBe('#111111');
    expect(inkOn(parseColor('#1d1d1f')!)).toBe('#ffffff');
  });
});

describe('what a chart draws', () => {
  const columns = [col('day', 'date'), col('card'), col('wallet'), col('share', 'percent')];
  const rows = [
    { day: '2026-10-02', card: 5, wallet: 1, share: 0.2 },
    { day: '2026-10-01', card: 3, wallet: 2, share: 0.4 },
  ];

  it('dates along the bottom, in order; guessed series share one measure', () => {
    const plan = planChart({ series: [] }, columns, rows);
    expect(plan.x).toBe('day');
    expect(plan.time).toBe(true);
    expect(plan.series.map((s) => s.key)).toEqual(['card', 'wallet']);
    expect(plan.rows.map((r) => r.day)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('long rows become one series per group, past eight folded into Other', () => {
    const long = Array.from({ length: 10 }, (_, i) => ({ day: '2026-10-01', service: `s${i}`, n: 10 - i }));
    const plan = planChart({ series: [{ key: 'n' }], group: 'service', x: 'day' }, [col('day', 'date'), col('service', 'text'), col('n')], long);
    expect(plan.series.map((s) => s.key)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 'Other']);
    expect(plan.rows[0]).toMatchObject({ s0: 10, Other: 3 + 2 + 1 });
  });
});

describe('inline elements', () => {
  it('a color on its own is the color; prefixes say the rest', () => {
    expect(readInline('#3987e5')).toEqual({ kind: 'color', value: '#3987e5' });
    expect(readInline('colors:#fff, #000')).toEqual({ kind: 'colors', values: ['#fff', '#000'] });
    expect(readInline('badge:failed')).toEqual({ kind: 'badge', text: 'failed' });
    expect(readInline('kbd:cmd+shift+p')).toEqual({ kind: 'kbd', keys: ['⌘', '⇧', 'p'] });
    expect(readInline('kbd:⌘K')).toEqual({ kind: 'kbd', keys: ['⌘', 'K'] });
    expect(readInline('progress:3/8')).toMatchObject({ kind: 'progress', ratio: 0.375, label: '3/8' });
    expect(readInline('progress:72%')).toMatchObject({ ratio: 0.72, label: '72%' });
    expect(readInline('delta:+38ms bad')).toEqual({ kind: 'delta', text: '+38ms', dir: 1, good: false });
    expect(readInline('delta:-12%')).toEqual({ kind: 'delta', text: '-12%', dir: -1, good: false });
    expect(readInline('spark:1,2,3')).toEqual({ kind: 'spark', values: [1, 2, 3] });
    expect(readInline('time:2026-10-22T09:30:00Z')).toEqual({ kind: 'time', at: Date.UTC(2026, 9, 22, 9, 30), dateOnly: false });
    expect(readInline('task:blg-12')).toEqual({ kind: 'task', key: 'BLG-12' });
  });

  it('anything else stays code', () => {
    for (const t of ['npm test', 'color:banana', 'progress:lots', 'spark:1', '#zzz', 'time:soon', 'a:b', 'task:BLG', 'task:12', 'task:the login bug']) expect(readInline(t)).toBeUndefined();
  });
});

describe('a beluga-tasks block', () => {
  it('reads one key per line, upper-cased, each once', () => {
    expect(readTaskKeys('BLG-12\n- task:blg-3 the login\n\nBLG-12\nnot a key')).toEqual(['BLG-12', 'BLG-3']);
  });

  it('reads a JSON array of keys or of objects with a key', () => {
    expect(readTaskKeys('["BLG-1", {"key": "BLG-2"}, 7, "nope"]')).toEqual(['BLG-1', 'BLG-2']);
    // Half-streamed JSON reads as lines meanwhile.
    expect(readTaskKeys('["BLG-1",\n "BLG-2')).toEqual(['BLG-1', 'BLG-2']);
  });

  it('keeps at most a screenful', () => {
    expect(readTaskKeys(Array.from({ length: 50 }, (_, i) => `BLG-${i + 1}`).join('\n'))).toHaveLength(MAX_TASK_CARDS);
  });
});

describe('a plain Markdown table', () => {
  const el = (tagName: string, children: unknown[]) => ({ type: 'element', tagName, children });
  const txt = (value: string) => ({ type: 'text', value });
  const tr = (tag: string, cells: string[]) => el('tr', cells.map((c) => el(tag, [txt(c)])));
  const table = el('table', [el('thead', [tr('th', ['Provider', 'Rate', 'p95', 'Fee'])]), el('tbody', [tr('td', ['Stripe', '97.7%', '412 ms', '$0.30']), tr('td', ['Adyen', '98.1%', '388 ms', '$0.25'])])]);

  it('reads as numbers that sort and chart, units said once', () => {
    const view = tableView(tableRows(table as never)!)!;
    expect(view.rows[0]).toEqual({ Provider: 'Stripe', Rate: 97.7, p95: 412, Fee: 0.3 });
    expect(view.columns.map((c) => [c.key, c.type, c.unit])).toEqual([['Provider', 'text', undefined], ['Rate', 'number', '%'], ['p95', 'number', 'ms'], ['Fee', 'currency', undefined]]);
  });

  it('stays as written with links in it, or with one row', () => {
    const linked = el('table', [el('thead', [tr('th', ['a', 'b'])]), el('tbody', [tr('td', ['1', '2']), el('tr', [el('td', [el('a', [txt('x')])]), el('td', [txt('y')])])])]);
    expect(tableRows(linked as never)).toBeUndefined();
    expect(tableRows(el('table', [el('thead', [tr('th', ['a', 'b'])]), el('tbody', [tr('td', ['1', '2'])])]) as never)).toBeUndefined();
  });
});
