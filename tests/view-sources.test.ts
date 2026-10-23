import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Source, ViewPage } from '../src/shared/view-spec.js';
import { bind, fetchSource, needsYes } from '../src/core/views/sources.js';
import { ViewShelf, showView } from '../src/agent/view-tools.js';
import { decideTool } from '../src/agent/policy.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-views-'));
const before = process.env.BELUGA_HOME;
const hasSqlite = (() => {
  try {
    execFileSync('sqlite3', ['-version']);
    return true;
  } catch {
    return false;
  }
})();

beforeAll(() => {
  process.env.BELUGA_HOME = path.join(dir, 'home');
  writeFileSync(path.join(dir, 'sales.csv'), 'day,amount\n2026-10-01,10\n2026-10-02,30\n2026-10-03,20\n');
  mkdirSync(path.join(dir, 'pics'));
  writeFileSync(path.join(dir, 'pics', 'a.png'), 'x');
  writeFileSync(path.join(dir, 'pics', 'b.txt'), 'hello');
  if (hasSqlite) execFileSync('sqlite3', [path.join(dir, 'app.db'), "create table users(id integer, email text); insert into users values (1,'ann@x.dev'),(2,'bob@x.dev'),(3,'cy@y.dev');"]);
});
afterAll(() => {
  if (before === undefined) delete process.env.BELUGA_HOME;
  else process.env.BELUGA_HOME = before;
});

const page = async (source: Source, q: Partial<Parameters<typeof fetchSource>[1]> = {}, opts: Parameters<typeof fetchSource>[2] = {}): Promise<ViewPage> => {
  const r = await fetchSource(source, { offset: 0, limit: 10, ...q }, opts);
  if ('needsApproval' in r) throw new Error(`needs approval: ${r.what}`);
  return r;
};

describe('view sources', () => {
  it('reads a CSV file, sorted and paged here', async () => {
    const p = await page({ kind: 'file', path: path.join(dir, 'sales.csv'), format: 'auto' }, { sort: { key: 'amount', dir: 'desc' }, limit: 2 });
    expect(p.rows.map((r) => r.amount)).toEqual([30, 20]);
    expect(p).toMatchObject({ total: 3, hasMore: true, columns: ['day', 'amount'] });
  });

  it('lists a folder, with a glob', async () => {
    const p = await page({ kind: 'folder', path: path.join(dir, 'pics'), glob: '*.png' });
    expect(p.rows.map((r) => r.name)).toEqual(['a.png']);
    expect(p.columns).toEqual(['name', 'kind', 'size', 'modified', 'path']);
  });

  it.skipIf(!hasSqlite)('pages, sorts and searches SQLite at the source, read-only', async () => {
    const db = path.join(dir, 'app.db');
    const source: Source = { kind: 'sqlite', path: db, query: 'select * from users;' };
    const p = await page(source, { limit: 2, sort: { key: 'id', dir: 'desc' } });
    expect(p.rows.map((r) => r.id)).toEqual([3, 2]);
    expect(p).toMatchObject({ total: 3, hasMore: true, pushedDown: true });
    expect((await page(source, { search: "x.dev" })).total).toBe(2);
    // A quote in the search is only text.
    expect((await page(source, { search: "'; drop table users; --" })).total).toBe(0);
    await expect(page({ kind: 'sqlite', path: db, query: 'delete from users' })).rejects.toThrow();
    expect((await page(source)).total).toBe(3);
  });

  it('asks before a command runs the first time, then remembers', async () => {
    const source: Source = { kind: 'command', command: 'printf "a\\tb\\n1\\t2\\n"', format: 'auto' };
    expect(needsYes(source, dir)).toBe(source.command);
    expect(await fetchSource(source, { offset: 0, limit: 5 }, { cwd: dir })).toEqual({ needsApproval: true, what: source.command });
    const p = await page(source, {}, { cwd: dir, confirm: true });
    expect(p.rows).toEqual([{ a: 1, b: 2 }]);
    expect(needsYes(source, dir)).toBeUndefined();
  });

  it('fills a command’s page in, quoted', async () => {
    const source: Source = { kind: 'command', command: 'echo "[{\\"offset\\": {{offset}}, \\"limit\\": {{limit}}, \\"q\\": \\"$(printf %s {{search}})\\"}]"', format: 'json' };
    const p = await page(source, { offset: 20, limit: 10, search: "it's; rm -rf /" }, { cwd: dir, confirm: true });
    expect(p.rows[0]).toEqual({ offset: 20, limit: 10, q: "it's; rm -rf /" });
    expect(p.pushedDown).toBe(true);
  });

  it('fills controls into a command, quoted, asking once for the command as written', async () => {
    const source: Source = { kind: 'command', command: 'printf "%s\\n" {{who}}', format: 'lines' };
    expect(bind(source, { who: "a'b; rm -rf /" })).toMatchObject({ command: `printf "%s\\n" 'a'\\''b; rm -rf /'` });
    await page(source, { params: { who: 'x' } }, { cwd: dir, confirm: true });
    const p = await page(source, { params: { who: "it's" } }, { cwd: dir });
    expect(p.rows).toEqual([{ line: "it's" }]);
  });

  it.skipIf(!hasSqlite)('a control’s conditions and top N run in SQLite', async () => {
    const source: Source = { kind: 'sqlite', path: path.join(dir, 'app.db'), query: 'select * from users where id >= {{min}}' };
    const p = await page(source, { params: { min: 2 }, where: [{ key: 'email', op: 'contains', value: 'x.dev' }], sort: { key: 'id', dir: 'desc' }, top: 1 });
    expect(p.rows.map((r) => r.id)).toEqual([2]);
    expect(p.total).toBe(1);
    expect(bind(source, { min: "1 or 1=1" })).toMatchObject({ query: "select * from users where id >= '1 or 1=1'" });
  });

  it('never reads credential files', async () => {
    await expect(page({ kind: 'file', path: path.join(dir, '.env'), format: 'auto' })).rejects.toThrow(/credential/);
    await expect(page({ kind: 'command', command: 'cat ~/.ssh/id_rsa', format: 'auto' }, {}, { confirm: true })).rejects.toThrow(/credential/);
  });
});

describe('the show tool', () => {
  it('runs the source once, brings the first rows, and places the view where its token is', async () => {
    const shelf = new ViewShelf();
    const said = await showView(shelf, dir, { type: 'table', title: 'Sales', source: { kind: 'file', path: 'sales.csv' } });
    expect(said).toMatch(/Shown as \[\[view:1\]\]/);
    expect(said).toContain('Columns: day, amount');
    const answer = shelf.finish('Here you go:\n\n[[view:1]]\n\nDone.');
    const block = /```beluga-view\n(.*)\n```/.exec(answer)?.[1];
    const json = JSON.parse(block!);
    expect(json.source.path).toBe(path.join(dir, 'sales.csv'));
    expect(json.data).toHaveLength(3);
    expect(answer.endsWith('Done.')).toBe(true);
  });

  it('puts a view on lines of its own, even when Claude writes its token mid-sentence', async () => {
    const shelf = new ViewShelf();
    await showView(shelf, dir, { type: 'stats', items: [{ label: 'Up', value: 3 }] });
    expect(shelf.finish('Two files: [[view:1]] and that is all.')).toMatch(/^Two files:\n\n```beluga-view\n.*\n```\n\nand that is all\.$/);
  });

  it('adds views it was not told where to put at the end, once', async () => {
    const shelf = new ViewShelf();
    await showView(shelf, dir, { type: 'stats', items: [{ label: 'Up', value: 3 }] });
    const first = shelf.finish('All good.');
    expect(first.startsWith('All good.\n\n```beluga-view')).toBe(true);
    expect(shelf.finish('Next turn.')).toBe('Next turn.');
  });

  it('draws graphs too, and says what is wrong', async () => {
    const shelf = new ViewShelf();
    await showView(shelf, dir, { type: 'graph', nodes: [{ id: 'a', label: 'A' }] });
    expect(shelf.finish('[[view:1]]')).toMatch(/^```beluga-graph\n/);
    await expect(showView(shelf, dir, { type: 'chart' })).rejects.toThrow('a chart needs "data" or a "source"');
  });

  it('asks like Bash for a command and like Read for a file', () => {
    const ctx = { cwd: dir, roots: [dir], autoEdit: false };
    const show = (source: unknown) => decideTool('mcp__beluga_view__show', { view: { type: 'table', source } }, ctx);
    expect(show(undefined)).toBe('allow');
    expect(show({ kind: 'command', command: 'ls' })).toBe('ask');
    expect(show({ kind: 'command', command: 'cat .env' })).toBe('deny');
    expect(show({ kind: 'file', path: 'sales.csv' })).toBe('allow');
    expect(show({ kind: 'file', path: '/etc/hosts' })).toBe('ask');
    expect(show({ kind: 'file', path: path.join(dir, '.env') })).toBe('deny');
    expect(show({ kind: 'http', url: 'https://example.com/a.json' })).toBe('allow');
    expect(show({ kind: 'http', url: 'https://example.com/a.json', headers: { Authorization: 'Bearer $TOKEN' } })).toBe('ask');
  });
});
