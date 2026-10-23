import { describe, expect, it } from 'vitest';
import { inferType, pageOf, parseText, parseView, pick, queryRows, readView, totalOf, viewFenceType } from '../src/shared/view-spec.js';
import { initialState, resolveControls } from '../src/shared/view-controls.js';
import { MOCK_VIEWS_ANSWER, DEMO_CUSTOMERS } from '../src/agent/mock-views.js';

const ok = (text: string, type?: Parameters<typeof parseView>[1]) => {
  const r = parseView(text, type);
  if (!r.ok) throw new Error(r.error);
  return r.view;
};

describe('beluga-view blocks', () => {
  it('knows its fences', () => {
    expect(viewFenceType('beluga-view')).toBe('any');
    expect(viewFenceType('beluga-chart')).toBe('chart');
    expect(viewFenceType('beluga-graph')).toBeUndefined();
    expect(viewFenceType('json')).toBeUndefined();
  });

  it('reads a table and infers what its columns hold', () => {
    const view = ok(JSON.stringify({ title: 'Users', data: [{ id: 1, email: 'a@b.c', created_at: '2026-10-01T10:00:00Z', status: 'active', site: 'https://x.dev', color: '#ff0000', paid: true }] }));
    expect(view.type).toBe('table');
    expect(Object.fromEntries(view.columns.map((c) => [c.key, c.type]))).toEqual({ id: 'number', email: 'text', created_at: 'datetime', status: 'badge', site: 'url', color: 'color', paid: 'bool' });
    expect(view.pageSize).toBe(10);
  });

  it('takes rows as arrays with columns, CSV text, or a bare array', () => {
    expect(ok(JSON.stringify({ columns: ['day', 'n'], data: [['mon', 3], ['tue', 5]] })).rows).toEqual([{ day: 'mon', n: 3 }, { day: 'tue', n: 5 }]);
    expect(ok('day,n\nmon,3\ntue,"5"', 'table').rows).toEqual([{ day: 'mon', n: 3 }, { day: 'tue', n: 5 }]);
    expect(ok(JSON.stringify([{ a: 1 }]), 'table').rows).toEqual([{ a: 1 }]);
  });

  it('reads near-misses kindly and says what is wrong', () => {
    const v = ok(JSON.stringify({ type: 'graph', chart: 'Spline', curve: 'smoothed', data: [{ x: 1, y: 2 }], y: 'y' }));
    expect([v.type, v.chart, v.curve, v.series]).toEqual(['chart', 'line', 'smooth', [{ key: 'y' }]]);
    const bad = parseView(JSON.stringify({ type: 'chart' }));
    expect(bad.ok ? '' : bad.error).toBe('a chart needs "data" or a "source"');
    const cut = parseView('{"type": "table", "data": [{"a": 1');
    expect(!cut.ok && cut.incomplete).toBe(true);
  });

  it('works out a source from what it has', () => {
    const r = readView({ type: 'table', source: { path: '/tmp/a.db', query: 'select 1' } });
    expect(r.ok && r.view.source?.kind).toBe('sqlite');
    const c = readView({ type: 'table', source: 'ls -la' });
    expect(c.ok && c.view.source).toEqual({ kind: 'command', command: 'ls -la', format: 'auto' });
    const h = readView({ type: 'table', source: { url: 'https://api.github.com/repos/x/y/issues', rows: 'items', refresh: 30 } });
    expect(h.ok && h.view.source).toMatchObject({ kind: 'http', method: 'GET', rows: 'items', refresh: 30 });
  });

  it('the demo answer is all good views', () => {
    const blocks = [...MOCK_VIEWS_ANSWER.matchAll(/```(beluga-\w+)\n([\s\S]*?)\n```/g)];
    expect(blocks.length).toBe(7);
    for (const [, fence, body] of blocks) expect(parseView(body!, viewFenceType(fence) === 'any' ? undefined : (viewFenceType(fence) as never)).ok).toBe(true);
  });
});

describe('rows from text', () => {
  it('reads JSON, JSON lines, TSV and lines', () => {
    expect(parseText('{"data": [{"a": 1}], "total": 9}').rows).toEqual([{ a: 1 }]);
    expect(parseText('{"a":1}\n{"a":2}\n').rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseText('name\tsize\nx\t10\n').rows).toEqual([{ name: 'x', size: 10 }]);
    expect(parseText('hello\nworld', 'lines').rows).toEqual([{ line: 'hello' }, { line: 'world' }]);
  });

  it('reads a table lined up with spaces (ps, docker ps)', () => {
    const { rows, columns } = parseText('PID   TTY      TIME     CMD\n123   ttys001  0:00.10  node server.js --port 3000\n9     ??       1:02.00  launchd\n');
    expect(columns).toEqual(['PID', 'TTY', 'TIME', 'CMD']);
    expect(rows[0]).toEqual({ PID: 123, TTY: 'ttys001', TIME: '0:00.10', CMD: 'node server.js --port 3000' });
  });

  it('keeps leading zeros and quoted commas', () => {
    expect(parseText('zip,city\n02134,"Boston, MA"', 'csv').rows).toEqual([{ zip: '02134', city: 'Boston, MA' }]);
  });

  it('finds rows and totals in an answer', () => {
    expect(pick({ data: { items: [1] } }, 'data.items')).toEqual([1]);
    expect(pick({ results: [{ a: 1 }], next: null }, undefined)).toEqual([{ a: 1 }]);
    expect(totalOf({ total_count: 42, items: [] })).toBe(42);
  });

  it('infers types from names and values', () => {
    expect(inferType('size', [10, 2000])).toBe('bytes');
    expect(inferType('modified', [1_760_000_000_000])).toBe('datetime');
    expect(inferType('thumb', ['/Users/me/a.png'])).toBe('image');
    expect(inferType('name', ['x', null])).toBe('text');
  });
});

describe('sorting, searching and pages', () => {
  const rows = [{ n: 'b', v: 2 }, { n: 'a', v: 10 }, { n: 'c', v: null }];
  it('sorts numbers as numbers, empties last', () => {
    expect(queryRows(rows, { sort: { key: 'v', dir: 'asc' } }).map((r) => r.n)).toEqual(['b', 'a', 'c']);
    expect(queryRows(rows, { sort: { key: 'v', dir: 'desc' } }).map((r) => r.n)).toEqual(['a', 'b', 'c']);
  });
  it('searches every column, pages what matches', () => {
    expect(queryRows(rows, { search: '10' }).map((r) => r.n)).toEqual(['a']);
    expect(pageOf(rows, { offset: 2, limit: 2 })).toEqual({ rows: [rows[2]], total: 3, hasMore: false });
    expect(pageOf(rows, { offset: 0, limit: 2 }).hasMore).toBe(true);
  });
});

describe('controls Claude sets up', () => {
  const view = (() => {
    const r = readView(DEMO_CUSTOMERS);
    if (!r.ok) throw new Error(r.error);
    return r.view;
  })();
  const rowsFor = (state: Record<string, unknown>) => {
    const p = resolveControls(view, { ...initialState(view), ...state } as never);
    return queryRows(view.rows, { ...(p.sort ? { sort: p.sort } : {}), ...(p.where ? { where: p.where } : {}), ...(p.top ? { top: p.top } : {}) });
  };

  it('start where Claude said: All chosen, sorted by revenue', () => {
    expect(initialState(view)).toMatchObject({ rank: 2, late: false });
    const all = rowsFor({});
    expect(all).toHaveLength(18);
    expect(all.map((r) => r.revenue)).toEqual([...all.map((r) => r.revenue as number)].sort((a, b) => b - a));
  });

  it('Top 5 and Bottom 5, a region, a minimum, a toggle', () => {
    const top = rowsFor({ rank: 0 });
    const bottom = rowsFor({ rank: 1 });
    expect(top).toHaveLength(5);
    expect(bottom).toHaveLength(5);
    expect(Math.min(...top.map((r) => r.revenue as number))).toBeGreaterThan(Math.max(...bottom.map((r) => r.revenue as number)));
    expect(rowsFor({ region: 'EU' }).every((r) => r.region === 'EU')).toBe(true);
    expect(rowsFor({ min: 5000 }).every((r) => (r.revenue as number) >= 5000)).toBe(true);
    expect(rowsFor({ late: true }).map((r) => r.status)).toEqual(['overdue', 'overdue', 'overdue']);
  });

  it('a control fills its {{slot}} in the source', () => {
    const r = readView({ type: 'table', source: { kind: 'command', command: './report.sh --region {{region}}' }, controls: [{ id: 'region', type: 'buttons', options: ['EU', 'US'] }] });
    if (!r.ok) throw new Error(r.error);
    expect(resolveControls(r.view, initialState(r.view)).params).toEqual({ region: 'EU' });
  });
});
