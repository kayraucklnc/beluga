import { describe, expect, it } from 'vitest';
import { exportFileName, exportRows, toAlignedMarkdown, toDelimited, toJsonRows, toSqlInserts } from '../packages/mac/src/components/views/export.js';
import { formatCell } from '../packages/mac/src/components/views/format.js';
import type { Column } from '../src/shared/view-spec.js';

const col = (key: string, type: Column['type'] = 'number', extra: Partial<Column> = {}): Column => ({ key, type, ...extra }) as Column;
const cols = [col('name', 'text'), col('revenue', 'currency'), col('ok', 'bool')];
const rows = [
  { name: 'Acme, Inc.', revenue: 48210, ok: true },
  { name: "O'Hara\tco", revenue: null, ok: false },
];

describe('exporting a table', () => {
  it('pads Markdown so its columns line up, numbers to the right', () => {
    const md = toAlignedMarkdown(rows, cols).split('\n');
    expect(new Set(md.map((l) => l.length)).size).toBe(1);
    expect(md[0]).toMatch(/^\| Name +\| +Revenue \| +Ok +\|$/);
    expect(md[1]).toMatch(/^\| -+ \| -+: \| :-+: \|$/);
    expect(md[2]).toContain(formatCell(48210, cols[1]!));
  });

  it('writes CSV with raw values under the keys, or as shown under the headings', () => {
    expect(toDelimited(rows, cols, ',', false)).toBe(['name,revenue,ok', '"Acme, Inc.",48210,true', "O'Hara\tco,,false"].join('\n'));
    const shown = toDelimited(rows, cols, ',', true).split('\n');
    expect(shown[0]).toBe('Name,Revenue,Ok');
    expect(shown[1]).toContain('Yes');
  });

  it('keeps TSV one line per row: tabs and breaks in a cell become spaces', () => {
    expect(toDelimited([{ name: 'a\tb\nc', revenue: 1, ok: true }], cols, '\t', false)).toBe('name\trevenue\tok\na b c\t1\ttrue');
  });

  it('gives JSON rows, not the view: typed raw values, or the text the table shows', () => {
    expect(JSON.parse(toJsonRows(rows, cols, false))).toEqual([
      { name: 'Acme, Inc.', revenue: 48210, ok: true },
      { name: "O'Hara\tco", revenue: null, ok: false },
    ]);
    const shown = JSON.parse(toJsonRows(rows, cols, true)) as Record<string, string>[];
    expect(Object.keys(shown[0]!)).toEqual(['Name', 'Revenue', 'Ok']);
    expect(shown[0]!.Ok).toBe('Yes');
    expect(shown[1]!.Revenue).toBe('');
  });

  it('writes SQL inserts with quoted names and escaped strings', () => {
    expect(toSqlInserts(rows, cols, 'Customers by revenue', false)).toBe(
      ['INSERT INTO "customers_by_revenue" ("name", "revenue", "ok") VALUES', "  ('Acme, Inc.', 48210, TRUE),", "  ('O''Hara\tco', NULL, FALSE);"].join('\n'),
    );
    expect(toSqlInserts([], cols, '', false)).toBe('-- "rows": no rows');
  });

  it('picks the format by name and names the file after the title', () => {
    expect(exportRows('csv', rows, cols)).toBe(toDelimited(rows, cols, ',', false));
    expect(exportFileName('Customers by revenue!', 'csv')).toBe('customers-by-revenue.csv');
    expect(exportFileName(undefined, 'json')).toBe('table.json');
  });
});
