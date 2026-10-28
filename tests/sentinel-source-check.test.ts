import { describe, expect, it } from 'vitest';
import { createSentinelToolDefs } from '../src/agent/sentinel-tools.js';
import { decideTool } from '../src/agent/policy.js';
import { firstLine } from '../src/core/sentinel/model.js';
import { EMPTY_FLAG, columnEmptiness, describePreview, flaggedColumns, isEmptyCell, previewOf } from '../src/core/sentinel/preview.js';
import { NOT_IN_TEST } from '../src/core/sentinel/sentinels.js';
import type { SourceFetch } from '../src/core/sentinel/runner.js';
import { sentinelAskBrief, sentinelChatBrief, dashboardAskBrief, sentinelNote } from '../src/core/sentinel/prompt.js';
import { RECIPES } from '../src/core/sentinel/recipes.js';
import { setup, until } from './sentinel-fakes.js';

/**
 * Setup checks the data before saving, and a paused sentinel can be test-run (BLG-302, BLG-304):
 * the preview (first rows, how empty each column is, flagged columns), sentinel_create refusing a
 * source that fails, sentinel_test keeping what it finds without turning anything on.
 */

const JOBS = [
  { id: 1, file: 'a.pdf', project: null, who: 'ata@x.dev' },
  { id: 2, file: 'b.pdf', project: null, who: 'mia@x.dev' },
  { id: 3, file: 'c.pdf', project: '', who: null },
];

describe('the preview of a source', () => {
  it('says how empty each column is and flags those empty in (nearly) every row', () => {
    expect([null, undefined, '', '  ', []].every(isEmptyCell)).toBe(true);
    expect([0, false, 'x', [1]].some(isEmptyCell)).toBe(false);
    const empty = columnEmptiness(JOBS, ['id', 'file', 'project', 'who']);
    expect(empty).toEqual({ id: 0, file: 0, project: 1, who: 1 / 3 });
    expect(flaggedColumns(empty)).toEqual(['project']);
    expect(flaggedColumns({ a: EMPTY_FLAG, b: EMPTY_FLAG - 0.01 })).toEqual(['a']);
    const p = previewOf('st1', 'Yesterday’s jobs', JOBS, ['id', 'file', 'project', 'who']);
    expect(p).toMatchObject({ state: 'ok', rows: 3, flagged: ['project'] });
    const text = describePreview(p);
    expect(text).toContain('Empty values: project 100%, who 33%');
    expect(text).toContain('Flagged: project is empty in all or nearly all rows');
    expect(text).toContain('| id | file | project | who |');
    expect(text).toContain('| 3 | c.pdf |  |  |');
  });

  it('says when no rows came back, rather than a table of nothing', () => {
    expect(describePreview(previewOf('st1', 'Jobs', [], ['id']))).toContain('No rows came back');
  });
});

describe('firstLine keeps underscores inside words (variable names)', () => {
  it('drops emphasis, not `$DATABASE_URL`', () => {
    expect(firstLine('the source didn’t answer: `$DATABASE_URL` isn’t set; nor is `$DATABASE_POOLER_URL`')).toBe('the source didn’t answer: $DATABASE_URL isn’t set; nor is $DATABASE_POOLER_URL');
    expect(firstLine('_quietly_ and __boldly__ done')).toBe('quietly and boldly done');
  });
});

const call = async (defs: ReturnType<typeof createSentinelToolDefs>, name: string, args: unknown) =>
  (defs.find((d) => d.name === name)!.handler as (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>)(args, {});

const jobsDraft = (query = 'select id, file, project, who from jobs') => ({
  name: 'Yesterday’s translations',
  project: 'bob-api',
  trigger: { kind: 'schedule', every: 'day', at: '08:00', missed: 'catch-up' },
  steps: [{ kind: 'measure', name: 'Yesterday’s jobs', from: 'source', source: { kind: 'postgres', query }, metrics: [{ name: 'jobs', kind: 'rows', label: 'Jobs' }] }],
});

describe('sentinel_create with a source', () => {
  it('runs it once first, saves, keeps it as a test run and answers with the preview (flagging the empty column)', async () => {
    const asked: Array<{ byClaude?: boolean; cwd: string }> = [];
    const fetchSource: SourceFetch = async (_source, cwd, _signal, opts) => {
      asked.push({ cwd, ...(opts?.byClaude ? { byClaude: true } : {}) });
      return { rows: JOBS, columns: ['id', 'file', 'project', 'who'] };
    };
    const s = setup({ fetchSource });
    const defs = createSentinelToolDefs(s.sentinels.forRun('sentinel-chat:main', 'p-me')!.tools);
    const out = await call(defs, 'sentinel_create', jobsDraft());
    expect(out.isError).toBeUndefined();
    const text = out.content[0]!.text;
    expect(text).toMatch(/^Made “Yesterday’s translations”/);
    expect(text).toContain('Show the user this preview before you say it’s done');
    expect(text).toContain('Flagged: project is empty');
    // With the project's folder (its variables), as Claude: nothing that needs the user's yes.
    expect(asked).toEqual([{ cwd: '/code/bob-api', byClaude: true }]);
    const made = s.sentinels.list().find((x) => x.name === 'Yesterday’s translations')!;
    expect(made.paused).toBe(true);
    // The check is a test run in its history, and what it found is kept (its tiles fill).
    const [run] = s.sentinels.runsOf(made.id);
    expect(run).toMatchObject({ by: 'claude', state: 'done', headline: 'Test: Kept Jobs: 3 rows' });
    expect(s.store.getState().sentinel.metrics![made.id]!.jobs).toMatchObject({ kind: 'rows', points: [{ value: 3 }] });
  });

  it('saves nothing when the source can’t connect, and says why', async () => {
    const s = setup({ fetchSource: async () => 'Supabase’s direct address (db.x.supabase.co) answers only over IPv6, and this network has none. (connecting with `$DATABASE_URL`)' });
    const defs = createSentinelToolDefs(s.sentinels.forRun('sentinel-chat:main', 'p-me')!.tools);
    const out = await call(defs, 'sentinel_create', jobsDraft());
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/^Not saved: a source didn’t work/);
    expect(out.content[0]!.text).toContain('answers only over IPv6');
    expect(out.content[0]!.text).toContain('`$DATABASE_URL`');
    expect(s.sentinels.list()).toEqual([]);
  });

  it('a command source isn’t run by Claude alone: saved, and the preview says it waits for the user', async () => {
    const s = setup({ fetchSource: async (source, _cwd, _signal, opts) => (opts?.byClaude ? { needsYes: (source as { command: string }).command } : { rows: [], columns: [] }) });
    const defs = createSentinelToolDefs(s.sentinels.forRun('sentinel-chat:main', 'p-me')!.tools);
    const draft = { ...jobsDraft(), steps: [{ kind: 'measure', name: 'Count', from: 'source', source: { kind: 'command', command: 'wc -l jobs.csv' }, metrics: [{ name: 'n' }] }] };
    const out = await call(defs, 'sentinel_create', draft);
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toContain('not checked: it runs wc -l jobs.csv, which waits for the user’s yes');
  });
});

describe('sentinel_update with a changed source', () => {
  it('checks only what changed, and changes nothing when it fails', async () => {
    let fail = false;
    let calls = 0;
    const s = setup({
      fetchSource: async () => {
        calls++;
        return fail ? 'ERROR:  column "admin_id" does not exist' : { rows: JOBS, columns: ['id', 'file', 'project', 'who'] };
      },
    });
    const tools = s.sentinels.forRun('sentinel-chat:main', 'p-me')!.tools;
    const defs = createSentinelToolDefs(tools);
    await call(defs, 'sentinel_create', jobsDraft());
    const made = s.sentinels.list()[0]!;
    calls = 0;
    // A rename runs nothing.
    expect((await call(defs, 'sentinel_update', { id: made.id, name: 'Translations' })).isError).toBeUndefined();
    expect(calls).toBe(0);
    fail = true;
    const step = made.steps[0]!;
    const bad = await call(defs, 'sentinel_update', { id: made.id, steps: [{ ...jobsDraft('select admin_id from jobs').steps[0], id: step.id }] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('Not changed');
    expect(bad.content[0]!.text).toContain('column "admin_id" does not exist');
    expect(JSON.stringify(s.sentinels.get(made.id)!.steps)).not.toContain('admin_id');
    fail = false;
    const good = await call(defs, 'sentinel_update', { id: made.id, steps: [{ ...jobsDraft('select id, file, who from jobs').steps[0], id: step.id }] });
    expect(good.isError).toBeUndefined();
    expect(good.content[0]!.text).toContain('run once');
    expect(JSON.stringify(s.sentinels.get(made.id)!.steps)).toContain('select id, file, who from jobs');
  });
});

describe('sentinel_test: a paused sentinel, tested without turning it on', () => {
  it('runs only its sources, keeps what they find, stays paused and starts nothing after it', async () => {
    const s = setup({ fetchSource: async () => ({ rows: [{ n: 6 }], columns: ['n'] }) });
    const made = s.sentinels.create({
      name: 'Translations',
      projectId: 'api',
      trigger: { kind: 'manual' },
      steps: [
        { kind: 'measure', name: 'Count', from: 'source', source: { kind: 'postgres', query: 'select count(*) as n from jobs where parent_job_id is null' }, metrics: [{ name: 'translations', pick: '' }] },
        { kind: 'script', name: 'Ping', command: 'echo hi', cwd: 'project', timeoutSec: 10 },
        { kind: 'notify', name: 'Tell me', phone: true },
      ],
    });
    const after = s.sentinels.create({ name: 'After it', trigger: { kind: 'after', sentinelId: made.id, on: 'always' }, steps: [{ kind: 'notify', name: 'Tell me', phone: false }] });
    s.sentinels.pause(after.id, false);
    const defs = createSentinelToolDefs(s.sentinels.forRun('sentinel-chat:main', 'p-me')!.tools);
    const out = await call(defs, 'sentinel_test', { id: made.id });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toContain('Test: Kept Translations: 6');
    expect(out.content[0]!.text).toContain('it stays paused');
    expect(s.sentinels.get(made.id)!.paused).toBe(true);
    const [run] = s.sentinels.runsOf(made.id);
    expect(run!.steps.map((st) => st.state)).toEqual(['done', 'skipped', 'skipped']);
    expect(run!.steps[1]!.why).toBe(NOT_IN_TEST);
    expect(s.ran).toEqual([]);
    expect(s.notices).toEqual([]);
    expect(s.store.getState().sentinel.metrics![made.id]!.translations!.points.map((p) => p.value)).toEqual([6]);
    // Nothing ran after it.
    await new Promise((r) => setTimeout(r, 5));
    expect(s.sentinels.runsOf(after.id)).toEqual([]);
    // sentinel_run still refuses a paused one (Claude never turns one on).
    expect((await call(defs, 'sentinel_run', { id: made.id })).isError).toBe(true);
  });

  it('says why a source failed, and counts no failure against the sentinel', async () => {
    const s = setup({ fetchSource: async () => 'The database refused the password (`$DATABASE_URL`’s, then `$SUPABASE_DB_PASSWORD`).' });
    const made = s.sentinels.create({ name: 'Jobs', projectId: 'api', trigger: { kind: 'manual' }, steps: [{ kind: 'measure', name: 'Count', from: 'source', source: { kind: 'postgres', query: 'select 1 as n' }, metrics: [{ name: 'n' }] }] });
    const t = await s.sentinels.test(made.id, 'you');
    expect(t.text).toContain('`$SUPABASE_DB_PASSWORD`');
    const [run] = s.sentinels.runsOf(made.id);
    expect(run).toMatchObject({ by: 'you', state: 'failed' });
    expect(run!.why).toContain('$DATABASE_URL');
    expect(s.sentinels.get(made.id)!.failures).toBe(0);
  });

  it('a sentinel with no source says there is nothing to test alone', async () => {
    const s = setup();
    const made = s.sentinels.create({ name: 'Brief', trigger: { kind: 'manual' }, steps: [{ kind: 'notify', name: 'Tell me', phone: false }] });
    const t = await s.sentinels.test(made.id, 'claude');
    expect(t.runId).toBeUndefined();
    expect(t.text).toContain('nothing to run');
    expect(s.sentinels.runsOf(made.id)).toEqual([]);
  });

  it('sentinel_try_source runs a source alone to read the schema, with up to 60 rows', async () => {
    const cols = Array.from({ length: 80 }, (_, i) => ({ table_name: 'jobs', column_name: `c${i}` }));
    const s = setup({ fetchSource: async () => ({ rows: cols, columns: ['table_name', 'column_name'] }) });
    const defs = createSentinelToolDefs(s.sentinels.forRun('sentinel-chat:main', 'p-me')!.tools);
    const out = await call(defs, 'sentinel_try_source', { source: { kind: 'postgres', query: 'select table_name, column_name from information_schema.columns' }, project: 'bob-api' });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toContain('80 rows');
    expect(out.content[0]!.text).toContain('| jobs | c59 |');
    expect(out.content[0]!.text).not.toContain('| jobs | c60 |');
    expect((await call(defs, 'sentinel_try_source', { source: { kind: 'postgres' } })).isError).toBe(true);
  });

  it('the new tools need no approval (they only read)', () => {
    for (const n of ['sentinel_test', 'sentinel_try_source']) expect(decideTool(`mcp__beluga_sentinel__${n}`, {}, { cwd: '/tmp', roots: [], autoEdit: false })).toBe('allow');
  });
});

describe('what Claude is told about building from data (BLG-304)', () => {
  it('every brief says to read the schema, mind double counts, include who did it, ask instead of guessing, and show the preview', () => {
    const s = setup();
    const made = s.sentinels.create({ name: 'Jobs', trigger: { kind: 'manual' }, steps: [] });
    const briefs = [sentinelChatBrief([], [], '', RECIPES), sentinelAskBrief(made, [], RECIPES), dashboardAskBrief({ id: 'd', name: 'Ops', tiles: [], compare: 'previous' } as never, ''), sentinelNote()];
    for (const b of briefs) {
      expect(b).toMatch(/read the schema/i);
      expect(b).toMatch(/double-count/);
      expect(b).toMatch(/who did it/);
      expect(b).toMatch(/ask the user/i);
      expect(b).toMatch(/preview/);
      expect(b).toMatch(/sentinel_test/);
    }
  });
});

void until;
