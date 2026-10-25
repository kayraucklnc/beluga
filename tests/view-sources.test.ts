import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Source, ViewPage } from '../src/shared/view-spec.js';
import { bind, fetchSource, needsYes } from '../src/core/views/sources.js';
import { forgetKept } from '../src/core/views/kept.js';
import { forgetViews } from '../src/core/views/forget.js';
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
  process.env.BELUGA_CACHE_DIR = path.join(dir, 'cache');
  writeFileSync(path.join(dir, 'sales.csv'), 'day,amount\n2026-10-01,10\n2026-10-02,30\n2026-10-03,20\n');
  mkdirSync(path.join(dir, 'pics'));
  writeFileSync(path.join(dir, 'pics', 'a.png'), 'x');
  writeFileSync(path.join(dir, 'pics', 'b.txt'), 'hello');
  if (hasSqlite) execFileSync('sqlite3', [path.join(dir, 'app.db'), "create table users(id integer, email text); insert into users values (1,'ann@x.dev'),(2,'bob@x.dev'),(3,'cy@y.dev');"]);
});
afterAll(() => {
  delete process.env.BELUGA_CACHE_DIR;
  if (before === undefined) delete process.env.BELUGA_HOME;
  else process.env.BELUGA_HOME = before;
});

const page = async (source: Source, q: Partial<Parameters<typeof fetchSource>[1]> = {}, opts: Parameters<typeof fetchSource>[2] = {}): Promise<ViewPage> => {
  const r = await fetchSource(source, { offset: 0, limit: 10, ...q }, opts);
  if ('needsApproval' in r) throw new Error(`needs approval: ${r.what}`);
  if ('notKept' in r) throw new Error('nothing kept');
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

  it('keeps what a source brought: shown again without running it, until Refresh', async () => {
    const counter = path.join(dir, 'runs.txt');
    writeFileSync(counter, '');
    const source: Source = { kind: 'command', command: `echo x >> '${counter}'; wc -l < '${counter}' | tr -d ' '`, format: 'lines' };
    const runs = (): number => Number(readFileSync(counter, 'utf8').split('\n').filter(Boolean).length);
    expect(await fetchSource(source, { offset: 0, limit: 5 }, { cwd: dir, cache: 'only' })).toEqual({ notKept: true });
    expect(runs()).toBe(0);
    const first = await page(source, {}, { cwd: dir, confirm: true, cache: 'prefer' });
    expect(runs()).toBe(1);
    // A new day (the daemon started again): what's kept on disk still does.
    forgetKept();
    const again = await page(source, {}, { cwd: dir, cache: 'prefer' });
    expect(runs()).toBe(1);
    expect(again.at).toBe(first.at);
    expect((await page(source, {}, { cwd: dir, cache: 'only' })).rows).toEqual(first.rows);
    // Refresh runs it, and that's what's kept from then on.
    const fresh = await page(source, {}, { cwd: dir, fresh: true, cache: 'prefer' });
    expect(runs()).toBe(2);
    expect((await page(source, {}, { cwd: dir, cache: 'only' })).at).toBe(fresh.at);
  });

  it.skipIf(!hasSqlite)('keeps each page of a database it was asked for', async () => {
    const source: Source = { kind: 'sqlite', path: path.join(dir, 'app.db'), query: 'select * from users' };
    const sorted = { sort: { key: 'id', dir: 'desc' as const }, limit: 1 };
    expect(await fetchSource(source, { offset: 0, ...sorted }, { cache: 'only' })).toEqual({ notKept: true });
    const p = await page(source, sorted, { cache: 'prefer' });
    expect((await page(source, sorted, { cache: 'only' })).rows).toEqual(p.rows);
    expect(await fetchSource(source, { offset: 1, ...sorted }, { cache: 'only' })).toEqual({ notKept: true });
  });

  it('a source that refreshes itself keeps its rows only that long', async () => {
    const source: Source = { kind: 'command', command: 'echo "a,b\n1,2"', format: 'csv', refresh: 1 };
    await page(source, {}, { cwd: dir, confirm: true });
    expect('rows' in (await fetchSource(source, { offset: 0, limit: 10 }, { cwd: dir, cache: 'only' }))).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await fetchSource(source, { offset: 0, limit: 10 }, { cwd: dir, cache: 'only' })).toEqual({ notKept: true });
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

  it('drops a token it has no view for, its line with it, even when the run showed none (BLG-182)', async () => {
    const shelf = new ViewShelf();
    expect(shelf.finish('Here is the GIF:\n\n[[view:1]]')).toBe('Here is the GIF:');
    expect(shelf.expand('Before.\n\n[[view:2]]\n\nAfter.')).toBe('Before.\n\nAfter.');
    expect(shelf.expand('Before.\n  [[view:2]]  \nAfter.')).toBe('Before.\nAfter.');
    expect(shelf.finish('Two files: [[view:3]] and that is all.')).toBe('Two files: and that is all.');
    expect(shelf.finish('It ends here [[view:3]].')).toBe('It ends here.');
    // The made-up token wasn't a placement: the run's first real view still goes at the end.
    await showView(shelf, dir, { type: 'stats', items: [{ label: 'Up', value: 3 }] });
    expect(shelf.finish('All good.')).toMatch(/^All good\.\n\n```beluga-view\n.*\n```$/);
    const other = new ViewShelf();
    await showView(other, dir, { type: 'stats', items: [{ label: 'Up', value: 3 }] });
    expect(other.finish('[[view:1]]\n\n[[view:2]]\n\nDone.')).toMatch(/^```beluga-view\n.*\n```\n\nDone\.$/);
  });

  it('leaves a token Claude writes about (in code) as it is, and places a real one it quoted', async () => {
    const shelf = new ViewShelf();
    await showView(shelf, dir, { type: 'stats', items: [{ label: 'Up', value: 3 }] });
    const code = 'A stray `[[view:9]]` was text, like this:\n\n```ts\nshelf.finish("[[view:1]]");\n```';
    const answer = shelf.finish(`${code}\n\nNow: \`[[view:1]]\``);
    expect(answer).toMatch(/^A stray `\[\[view:9\]\]` was text, like this:\n\n```ts\nshelf\.finish\("\[\[view:1\]\]"\);\n```\n\nNow:\n\n```beluga-view\n.*\n```$/);
    // Only in code, it isn't placed: the view goes at the end.
    const quoted = new ViewShelf();
    await showView(quoted, dir, { type: 'stats', items: [{ label: 'Up', value: 3 }] });
    expect(quoted.finish(code)).toMatch(/```\n\n```beluga-view\n.*\n```$/);
    expect(quoted.finish(code).startsWith(code)).toBe(true);
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
    expect(show({ kind: 'script', language: 'python', code: 'print(1)' })).toBe('ask');
    expect(show({ kind: 'script', code: 'cat .env' })).toBe('deny');
    expect(decideTool('mcp__beluga_view__show', { view: { type: 'table', source: { kind: 'script', code: 'echo hi' } } }, { ...ctx, askOnly: true })).toBe('deny');
  });

  it('runs a script Claude wrote for the view, kept under a name made from its code', async () => {
    const shelf = new ViewShelf();
    const code = 'import json, sys\nn = int(sys.argv[1]) if len(sys.argv) > 1 else 2\nprint(json.dumps([{"n": i, "sq": i * i} for i in range(n)]))\n';
    const said = await showView(shelf, dir, {
      type: 'table',
      source: { kind: 'script', language: 'py', code, args: '{{count}}', format: 'json' },
      controls: [{ id: 'count', type: 'number', default: 3 }],
    });
    expect(said).toContain('Columns: n, sq');
    const json = JSON.parse(/```beluga-view\n(.*)\n```/.exec(shelf.finish('[[view:1]]'))![1]!);
    expect(json.source.kind).toBe('command');
    const file = /'([^']+\.py)'/.exec(json.source.command)![1]!;
    expect(file.startsWith(path.join(dir, 'home', 'view-scripts'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(code);
    expect(json.data).toEqual([{ n: 0, sq: 0 }, { n: 1, sq: 1 }, { n: 2, sq: 4 }]);
    // The window runs it from then on (it was allowed), whatever the control fills in.
    expect((await page(json.source, { params: { count: 4 } }, { cwd: dir })).rows).toHaveLength(4);
    await expect(showView(shelf, dir, { type: 'table', source: { kind: 'script', code: 'cat .env' } })).rejects.toThrow('credential files');
    await expect(showView(shelf, dir, { type: 'table', source: { kind: 'script', language: 'cobol', code: 'x' } })).rejects.toThrow('Scripts run as');
  });

  it('archiving a conversation forgets its views’ rows, keeping what brings them; deleting it removes that too', async () => {
    const shelf = new ViewShelf();
    await showView(shelf, dir, { type: 'table', source: { kind: 'script', language: 'sh', code: 'echo "a,b"; echo "1,{{n}}"', args: '', format: 'csv' } });
    await showView(shelf, dir, { type: 'table', data: Array.from({ length: 250 }, (_, i) => ({ i })) });
    const answer = shelf.finish('[[view:1]]\n\n[[view:2]]');
    const [script, dumped] = [...answer.matchAll(/```beluga-view\n(.*)\n```/g)].map((m) => (JSON.parse(m[1]!) as { source: Source }).source);
    const file = /'([^']+)'/.exec((script as Extract<Source, { kind: 'command' }>).command)![1]!;
    const data = (dumped as Extract<Source, { kind: 'file' }>).path;
    const kept = async (s: Source): Promise<boolean> => 'rows' in (await fetchSource(s, { offset: 0, limit: 10 }, { cache: 'only' }));
    await page(dumped!, {}, { cache: 'prefer' });
    expect(await kept(script!)).toBe(true);
    expect(await kept(dumped!)).toBe(true);

    expect(forgetViews([answer], 'archived')).toEqual({ rows: 2, files: 0 });
    expect(await kept(script!)).toBe(false);
    expect(await kept(dumped!)).toBe(false);
    expect(existsSync(file) && existsSync(data)).toBe(true);

    // Another conversation still shows the script: only the handed-over rows go.
    expect(forgetViews([answer], 'deleted', () => [`elsewhere: ${file}`])).toEqual({ rows: 0, files: 1 });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(data)).toBe(false);
    expect(forgetViews([answer], 'deleted')).toMatchObject({ files: 1 });
    expect(existsSync(file)).toBe(false);
  });
});
