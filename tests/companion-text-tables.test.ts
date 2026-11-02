import { describe, expect, it } from 'vitest';
import { stripCode } from '../src/companion/strip.js';
import { tableView } from '../src/shared/render/md-table.js';
import { findTextTables, looksLikeTable, readTextTable } from '../src/shared/render/text-table.js';
import { parseView } from '../src/shared/view-spec.js';

/**
 * Tables Claude writes as text (BLG-71): read into rows and columns, sent to the phone as a table
 * view (never a "code · N lines" chip), and kept monospaced when they don't read cleanly.
 */

// How October compares with the Sept 30 forecast (as Claude answered it in revenue-forecast-from-stripe).
const FORECAST_BOX = [
  '┌──────────────┬────────────┬────────────┬──────────┐',
  '│ Week         │ Forecast   │ Actual     │ Diff     │',
  '├──────────────┼────────────┼────────────┼──────────┤',
  '│ Oct 1–7      │ $6,900     │ $7,240     │ +4.9%    │',
  '│ Oct 8–14     │ $7,100     │ $7,380     │ +3.9%    │',
  '│ Oct 15–21    │ $7,300     │ $6,810     │ -6.7%    │',
  '│ Oct 22–24    │ $3,200     │ $3,050     │ -4.7%    │',
  '├──────────────┼────────────┼────────────┼──────────┤',
  '│ **October**  │ $24,500    │ $24,480    │ -0.1%    │',
  '└──────────────┴────────────┴────────────┴──────────┘',
].join('\n');

const GRID = ['+---------+-------+--------+', '| Plan    | Seats | MRR    |', '+=========+=======+========+', '| Starter | 140   | $2,660 |', '| Team    | 38    | $4,560 |', '+---------+-------+--------+'].join('\n');

const ALIGNED = ['Customer          Plan     MRR      Since', '----------------  -------  -------  ----------', 'Acme Corp         Team     $1,200   2025-03-02', 'Globex            Starter  $190     2025-08-19', 'Initech           Team     $960     2026-01-05'].join('\n');

const PIPES = ['metric        | sept   | oct', '--------------|--------|-------', 'new customers | 41     | 47', 'churned       | 6      | 4', 'net revenue   | 22,910 | 24,480'].join('\n');

describe('reading a table written as text', () => {
  it('box drawing: heading, rows (a rule between them is fine), emphasis gone', () => {
    const t = readTextTable(FORECAST_BOX)!;
    expect(t.columns).toEqual(['Week', 'Forecast', 'Actual', 'Diff']);
    expect(t.rows).toHaveLength(5);
    expect(t.rows[4]).toEqual(['October', '$24,500', '$24,480', '-0.1%']);
    // As a view, with the same table as Markdown tables: money and percentages are numbers.
    const view = tableView(t)!;
    expect(view.columns.map((c) => c.type)).toEqual(['text', 'currency', 'currency', 'text']);
    // Changes keep their signs as written.
    expect(view.rows[0]).toMatchObject({ Week: 'Oct 1–7', Forecast: 6900, Actual: 7240, Diff: '+4.9%' });
  });

  it('a +---+ grid, columns lined up with spaces over dashes, and pipes over a rule', () => {
    expect(readTextTable(GRID)).toEqual({ columns: ['Plan', 'Seats', 'MRR'], rows: [['Starter', '140', '$2,660'], ['Team', '38', '$4,560']] });
    expect(readTextTable(ALIGNED)).toEqual({
      columns: ['Customer', 'Plan', 'MRR', 'Since'],
      rows: [
        ['Acme Corp', 'Team', '$1,200', '2025-03-02'],
        ['Globex', 'Starter', '$190', '2025-08-19'],
        ['Initech', 'Team', '$960', '2026-01-05'],
      ],
    });
    expect(readTextTable(PIPES)?.rows[2]).toEqual(['net revenue', '22,910', '24,480']);
  });

  it('what isn’t a table isn’t one; a box that doesn’t read still looks like one', () => {
    expect(readTextTable('Run it with a | b\nthen c\nand d')).toBeUndefined();
    const ragged = ['┌──────┬──────┐', '│ Name │ Note │', '├──────┼──────┤', '│ a    │ one  │', '│ b    │ two  │ extra │', '└──────┴──────┘'].join('\n');
    expect(readTextTable(ragged)).toBeUndefined();
    expect(looksLikeTable(ragged)).toBe(true);
    expect(looksLikeTable('just\nsome\nwords')).toBe(false);
  });

  it('finds tables in prose, leaving Markdown’s own tables and sentences alone', () => {
    const lines = ['How October compares:', '', ...FORECAST_BOX.split('\n'), '', 'Mostly on track.', '| a | b |', '|---|---|', '| 1 | 2 |'];
    const found = findTextTables(lines);
    expect(found).toEqual([{ start: 2, end: 11, table: expect.objectContaining({ columns: ['Week', 'Forecast', 'Actual', 'Diff'] }) }]);
  });
});

describe('tables on the phone (stripCode)', () => {
  it('a table in the prose becomes a table view, in its place', () => {
    const p = stripCode(`How October compares with your Sept 30 forecast:\n\n${FORECAST_BOX}\n\nSlightly under, on the last week.`);
    expect(p.text).toBe('How October compares with your Sept 30 forecast:\n\n[[code:0]]\n\nSlightly under, on the last week.');
    expect(p.code[0]!.block?.kind).toBe('view');
    const parsed = parseView(p.code[0]!.block!.text);
    expect(parsed.ok && parsed.view.type).toBe('table');
    expect(parsed.ok && parsed.view.rows).toHaveLength(5);
  });

  it('a fenced block that is only a table is a table, not a code chip; code stays a chip', () => {
    const p = stripCode(`\`\`\`\n${ALIGNED}\n\`\`\`\n\n\`\`\`ts\nconst x = a | b;\n\`\`\``);
    expect(p.code[0]).toMatchObject({ lang: 'table', block: { kind: 'view' } });
    expect(p.code[1]).toEqual({ lang: 'ts', lines: 1 });
  });

  it('one that only looks like a table goes as text, shown monospaced', () => {
    const ragged = ['+------+------+', '| a    | one  |', '| b    | two  | x |', '+------+------+'].join('\n');
    const p = stripCode(`\`\`\`text\n${ragged}\n\`\`\``);
    expect(p.code[0]).toMatchObject({ block: { kind: 'text', text: ragged } });
  });

  it('a Markdown table stays Markdown (the phone draws those already)', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
    expect(stripCode(md)).toEqual({ text: md, code: [] });
  });
});
