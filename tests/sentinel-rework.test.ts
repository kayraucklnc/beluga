import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DASHBOARD_TOOL_NAMES, createDashboardToolDefs } from '../src/agent/dashboard-tools.js';
import { ALWAYS_ASK_YOU, decideTool } from '../src/agent/policy.js';
import { outputFormat, outputLook, outputRows, outputSteps, tileOutput, tileState, tileStateIn } from '../src/core/sentinel/dashboard-model.js';
import { tileOf } from '../src/core/sentinel/dashboards.js';
import { measureFrom, outputOf, readLine, readOutput, seriesOf } from '../src/core/sentinel/metrics.js';
import { activeSentinelChat, isSentinelChat, sentinelChatChannel, sentinelChatOf, sentinelChatTitle } from '../src/core/sentinel/model.js';
import { SavedDashboardSchema, TileInputSchema } from '../src/core/sentinel/schema.js';
import { channelOf, shownChannel } from '../src/core/store.js';
import { placeName } from '../src/core/notify.js';
import { convView, sentinelsView } from '../src/companion/views.js';
import { PHONE } from '../src/companion/coverage.js';
import { Channel } from '../src/protocol.js';
import { fakeShell, setup, until } from './sentinel-fakes.js';

/** The rework (BLG-246, docs/sentinel.md §10 and §12): tile kinds, keeping series and outputs, Add a Tile's drafts, the Sentinel chat. */

const tmp: string[] = [];
const dirOf = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-rework-'));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('keeping a whole array, and a step’s output', () => {
  it('a series from numbers, rows (x and y named or found) or an object of numbers', () => {
    expect(seriesOf([3, '4', 5])).toEqual([{ x: '1', y: 3 }, { x: '2', y: 4 }, { x: '3', y: 5 }]);
    expect(seriesOf([{ day: 'Mon', revenue: 3120, n: 2 }, { day: 'Tue', revenue: '3,400', n: 3 }])).toEqual([{ x: 'Mon', y: 3120 }, { x: 'Tue', y: 3400 }]);
    expect(seriesOf([{ day: 'Mon', revenue: 3120, n: 2 }], 'day', 'n')).toEqual([{ x: 'Mon', y: 2 }]);
    expect(seriesOf({ Mon: 3, Tue: 5, note: 'x' })).toEqual([{ x: 'Mon', y: 3 }, { x: 'Tue', y: 5 }]);
    expect(seriesOf('[1,2]')).toEqual([{ x: '1', y: 1 }, { x: '2', y: 2 }]);
    expect(seriesOf('all good')).toBeUndefined();
    expect(seriesOf(Array.from({ length: 900 }, (_, i) => i))).toHaveLength(500);
  });

  it('an output: the whole text as it reads (Markdown, JSON, text), or the picked part as JSON', () => {
    expect(outputOf(undefined, '# Brief\n\n- one')).toEqual({ text: '# Brief\n\n- one', format: 'markdown' });
    expect(outputOf(undefined, '{"ok":true}')).toEqual({ text: '{"ok":true}', format: 'json' });
    expect(outputOf(undefined, 'done')).toEqual({ text: 'done', format: 'text' });
    expect(outputOf({ a: 1 }, undefined)).toEqual({ text: '{\n  "a": 1\n}', format: 'json' });
    expect(outputOf(undefined, '  ')).toBeUndefined();
  });

  it('measureFrom keeps series and outputs beside numbers, and says what it couldn’t find', () => {
    const raw = '{"days":[{"day":"Mon","signups":18},{"day":"Tue","signups":22}],"total":40}';
    const { found, missing } = measureFrom(readOutput(raw), [
      { name: 'total' },
      { name: 'by-day', kind: 'series', pick: '$.days', x: 'day', y: 'signups' },
      { name: 'answer', kind: 'output' },
      { name: 'days', kind: 'output', pick: '$.days[0]' },
      { name: 'nope', kind: 'series', pick: '$.missing' },
    ], 200, raw);
    expect(found).toEqual([
      { name: 'total', value: 40 },
      { name: 'by-day', series: [{ x: 'Mon', y: 18 }, { x: 'Tue', y: 22 }] },
      { name: 'answer', output: { text: raw, format: 'json' } },
      { name: 'days', output: { text: '{\n  "day": "Mon",\n  "signups": 18\n}', format: 'json' } },
    ]);
    expect(missing).toEqual(['nope']);
  });

  it('a file line keeps a series or an output, and reads back', () => {
    expect(readLine(JSON.stringify({ at: 1, runId: 'r', series: [{ x: 'a', y: 1 }, { bad: true }] }))).toEqual({ at: 1, runId: 'r', series: [{ x: 'a', y: 1 }] });
    expect(readLine(JSON.stringify({ at: 1, runId: 'r', output: { text: 'hi', format: 'odd' } }))).toEqual({ at: 1, runId: 'r', output: { text: 'hi', format: 'text' } });
  });

  it('a run keeps them: the state carries the latest array and output, the file a line per run (an output its last 30)', async () => {
    const dir = dirOf();
    const sh = fakeShell(() => ({ exitCode: 0, output: '[{"day":"Mon","signups":18},{"day":"Tue","signups":22}]' }));
    const s = setup({ shell: sh.shell, dir });
    const made = s.sentinels.create({ name: 'Signups', trigger: { kind: 'manual' }, steps: [{ kind: 'script', command: 'x', cwd: 'home', timeoutSec: 5 }, { kind: 'measure', from: 'previous', metrics: [{ name: 'by-day', kind: 'series', label: 'Signups by day' }, { name: 'raw', kind: 'output' }] }] });
    const run = s.sentinels.start(made.id, 'you');
    await until(() => s.sentinels.runGet(run.id).run.state === 'done');
    const m = s.store.getState().sentinel.metrics![made.id]!;
    expect(m['by-day']).toMatchObject({ kind: 'series', label: 'Signups by day', series: [{ x: 'Mon', y: 18 }, { x: 'Tue', y: 22 }], rowsRunId: run.id, points: [{ value: 2 }] });
    expect(m.raw).toMatchObject({ kind: 'output', output: { format: 'json' }, rowsRunId: run.id });
    expect(s.sentinels.runGet(run.id).run.steps[1]!.output).toBe('Kept Signups by day: 2 points · Raw: its output (JSON)');
    const file = readFileSync(path.join(dir, 'sentinel', 'metrics', made.id, 'by-day.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(file[0]!)).toMatchObject({ runId: run.id, series: [{ x: 'Mon', y: 18 }, { x: 'Tue', y: 22 }] });
    s.sentinels.stopAll();
  });
});

describe('tiles', () => {
  it('the kinds: series (one metric or several), output (a step or an output metric), sizes; chart is an older name for series', () => {
    expect(tileOf({ kind: 'series', metric: { sentinelId: 's', metric: 'by-day' }, chart: 'bar' })).toMatchObject({ kind: 'series', width: 3, metric: { metric: 'by-day' }, chart: 'bar' });
    expect(tileOf({ kind: 'chart', metrics: [{ sentinelId: 's', metric: 'a' }, { sentinelId: 's', metric: 'b' }] })).toMatchObject({ kind: 'series', chart: 'line', metrics: [{ metric: 'a' }, { metric: 'b' }] });
    expect(tileOf({ kind: 'output', step: { sentinelId: 's', stepId: 'st_1' }, show: 'tree', width: 6, height: 2 })).toMatchObject({ kind: 'output', step: { stepId: 'st_1' }, show: 'tree', width: 6, height: 2 });
    expect(tileOf({ kind: 'output', step: { sentinelId: 's', stepId: 'st_1' }, show: 'auto' }).show).toBeUndefined();
    expect(() => tileOf({ kind: 'output' })).toThrow('An output tile needs its step');
    expect(tileOf({ kind: 'divider', title: 'Money', height: 2 })).toEqual(expect.objectContaining({ width: 6 }));
    expect(tileOf({ kind: 'divider', title: 'Money', height: 2 }).height).toBeUndefined();
    expect(TileInputSchema.safeParse({ kind: 'number', width: 5 }).success).toBe(false);
    // dashboards.json written before the rework reads as it was, its charts as series.
    const saved = SavedDashboardSchema.parse({ id: 'db', name: 'Old', createdAt: 1, updatedAt: 1, tiles: [{ id: 't', kind: 'chart', width: 3, metrics: [{ sentinelId: 's', metric: 'a' }] }] });
    expect(saved.tiles[0]!.kind).toBe('series');
  });

  it('a tile’s state: a draft (never turned on, never ran), paused, gone, a step taken out, waiting for its output', () => {
    const items = [{ id: 'a', paused: true, steps: [{ id: 'st_1' }] }, { id: 'b', paused: true, steps: [] }, { id: 'c', paused: false, steps: [{ id: 'st_2' }] }];
    const has = () => true;
    expect(tileState({ id: 't', kind: 'number', width: 1, metric: { sentinelId: 'a', metric: 'x' } }, items, has, (id) => id !== 'a')).toBe('draft');
    expect(tileState({ id: 't', kind: 'number', width: 1, metric: { sentinelId: 'b', metric: 'x' } }, items, has, () => true)).toBe('paused');
    expect(tileState({ id: 't', kind: 'output', width: 3, step: { sentinelId: 'c', stepId: 'st_9' } }, items, has)).toBe('gone');
    expect(tileState({ id: 't', kind: 'output', width: 3, step: { sentinelId: 'c', stepId: 'st_2' } }, items, has, () => true, () => false)).toBe('waiting');
    expect(tileState({ id: 't', kind: 'output', width: 3, step: { sentinelId: 'c', stepId: 'st_2' } }, items, has)).toBe('ok');
  });

  it('what an output is, and how it shows: Markdown from Claude, JSON as a tree (a list as a table), text', () => {
    expect([outputFormat('# Hi', 'claude'), outputFormat('{"a":1}', 'http'), outputFormat('ok', 'http'), outputFormat('[1]', 'script'), outputFormat('- a\n- b')]).toEqual(['markdown', 'json', 'text', 'json', 'markdown']);
    expect(outputRows({ data: [{ a: 1 }, { a: 2 }] })).toEqual([{ a: 1 }, { a: 2 }]);
    expect(outputRows([1, 2])).toBeUndefined();
    expect(outputLook({ text: '{"items":[{"a":1}]}', format: 'json' })).toBe('tree');
    expect(outputLook({ text: '[{"a":1}]', format: 'json' })).toBe('table');
    expect(outputLook({ text: '{"items":[{"a":1}]}', format: 'json' }, 'table')).toBe('table');
    expect(outputLook({ text: 'not json', format: 'text' }, 'tree')).toBe('text');
    expect(outputLook({ text: '# Hi', format: 'markdown' })).toBe('markdown');
    expect(outputSteps([{ tiles: [{ id: 't', kind: 'output', width: 3, step: { sentinelId: 's', stepId: 'a' } }, { id: 'u', kind: 'output', width: 3, step: { sentinelId: 's', stepId: 'a' } }] }])).toEqual([{ sentinelId: 's', stepId: 'a' }]);
  });

  it('an output tile shows its step’s latest output, kept in the state while a tile names it', async () => {
    const sh = fakeShell(() => ({ exitCode: 0, output: '{"items":[{"subscriberCount":"1204"}]}' }));
    const s = setup({ shell: sh.shell });
    const made = s.sentinels.create({ name: 'YouTube', trigger: { kind: 'manual' }, steps: [{ kind: 'script', name: 'Ask YouTube', command: 'x', cwd: 'home', timeoutSec: 5 }] });
    const d = s.sentinels.dashboards.create('Mine');
    const { tile } = s.sentinels.dashboards.addTile(d.id, { kind: 'output', step: { sentinelId: made.id, stepId: made.steps[0]!.id } });
    const st = () => s.store.getState().sentinel;
    expect(tileStateIn(st(), s.sentinels.dashboards.get(d.id)!.tiles[0]!)).toBe('draft');
    const run = s.sentinels.start(made.id, 'you');
    await until(() => s.sentinels.runGet(run.id).run.state === 'done');
    expect(st().outputs?.[made.id]?.[made.steps[0]!.id]).toMatchObject({ runId: run.id, format: 'json', text: '{"items":[{"subscriberCount":"1204"}]}' });
    expect(tileOutput(st(), tile)).toMatchObject({ from: 'step', runId: run.id });
    s.sentinels.dashboards.removeTile(d.id, tile.id);
    expect(st().outputs?.[made.id]).toBeUndefined();
    s.sentinels.stopAll();
  });

  it('Claude’s tools: a series, an output by step name, sizes; dashboard_update and dashboard_move_tile; dashboard_remove asks first', async () => {
    const s = setup();
    const made = s.sentinels.create({ name: 'Brief', trigger: { kind: 'manual' }, steps: [{ kind: 'claude', name: 'Read what changed', where: 'mac', prompt: 'x' }, { kind: 'notify', name: 'Tell me', phone: false }] });
    const defs = createDashboardToolDefs(s.sentinels.forRun('ws:else', 'p-me')!.dashboard);
    expect(defs.map((x) => `mcp__beluga_dashboard__${x.name}`)).toEqual(DASHBOARD_TOOL_NAMES.slice(1));
    const call = async (name: string, args: unknown) => (await (defs.find((x) => x.name === name)!.handler as (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>)(args, {}));
    expect((await call('dashboard_create', { name: 'Ops' })).content[0]!.text).toMatch(/^Made the dashboard “Ops”/);
    expect((await call('dashboard_add_tile', { dashboard: 'Ops', kind: 'output', sentinel: 'Brief', step: 'Read what changed', width: 6, height: 2 })).isError).toBeUndefined();
    expect(await call('dashboard_add_tile', { dashboard: 'Ops', kind: 'output', sentinel: 'Brief', step: 'Tell me' })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/shows what an Ask your agent, Call a service or Run a script step said/) }] });
    expect((await call('dashboard_add_tile', { dashboard: 'Ops', kind: 'chart', sentinel: 'Brief', metric: 'by-day' })).isError).toBeUndefined();
    const ops = s.sentinels.dashboards.get('Ops')!;
    expect(ops.tiles.map((t) => [t.kind, t.width, t.height])).toEqual([['output', 6, 2], ['series', 3, undefined]]);
    expect(ops.tiles[0]!.step).toEqual({ sentinelId: made.id, stepId: made.steps[0]!.id });
    expect((await call('dashboard_move_tile', { dashboard: 'Ops', tile: ops.tiles[1]!.id, index: 0 })).content[0]!.text).toMatch(/place 1 of 2/);
    expect((await call('dashboard_update', { dashboard: 'Ops', name: 'Operations', compare: 'week' })).content[0]!.text).toBe(`“Operations” (id ${ops.id}) now compares vs last week.`);
    expect((await call('dashboard_list', {})).content[0]!.text).toMatch(/an output Brief, step “Read what changed” \(st_\w+\), 6 wide, tall/);
    for (const name of ['mcp__beluga_dashboard__dashboard_remove', 'mcp__beluga_sentinel__sentinel_remove']) {
      expect(ALWAYS_ASK_YOU.has(name)).toBe(true);
      expect(decideTool(name, {}, { cwd: '/tmp', roots: [], autoEdit: false })).toBe('ask');
    }
    expect(s.sentinels.confirmWords('mcp__beluga_dashboard__dashboard_remove', { dashboard: 'Operations' })).toEqual({ title: 'Your Claude wants to delete the dashboard “Operations”', detail: '2 tiles go; the numbers stay with their sentinels.' });
    expect(s.sentinels.confirmWords('mcp__beluga_sentinel__sentinel_remove', { id: made.id })?.title).toBe('Your Claude wants to delete the sentinel “Brief”');
    expect((await call('dashboard_remove', { dashboard: 'Operations' })).content[0]!.text).toBe('Deleted the dashboard “Operations”. Its numbers stay with their sentinels.');
    expect(s.sentinels.dashboards.get(ops.id)).toBeUndefined();
  });
});

describe('Add a Tile by description', () => {
  it('Claude is told how to fetch what nothing keeps yet; a sentinel it makes is the ask’s draft until you turn it on', async () => {
    const s = setup({ reply: () => 'Set up Open pull requests to fetch it.' });
    const d = s.sentinels.dashboards.create('Ops');
    const { channel } = s.sentinels.dashboardAsk(d.id, 'the open PR count');
    const run = s.sentinels.forRun(channel, 'p-me')!;
    expect(run.brief).toMatch(/When nothing kept yet is what the user wants/);
    expect(run.brief).toMatch(/output \(a step’s latest export/);
    expect(run.dashboard.building).toBe(d.id);
    run.tools.create({ name: 'Open pull requests', trigger: { kind: 'schedule', every: 'day', at: '09:00', missed: 'catch-up' }, steps: [{ kind: 'script', command: 'gh pr list --state open --json number --jq length', cwd: 'project', timeoutSec: 60 }, { kind: 'measure', from: 'previous', metrics: [{ name: 'open-prs' }] }] } as never);
    const made = s.sentinels.list().find((x) => x.name === 'Open pull requests')!;
    expect(made.paused).toBe(true);
    await until(() => s.store.getState().sentinel.dashboardAsks?.[d.id]?.state === 'done');
    expect(s.store.getState().sentinel.dashboardAsks![d.id]!.made).toEqual([made.id]);
  });
});

describe('the Sentinel chat', () => {
  it('its channels and its view: one section’s, never a workspace’s', () => {
    expect(sentinelChatChannel('main')).toBe('sentinel-chat:main');
    expect([sentinelChatOf('sentinel-chat:ab12'), sentinelChatOf('sentinel-chat:../x'), sentinelChatOf('ws:1')]).toEqual(['ab12', undefined, undefined]);
    expect(isSentinelChat('sentinel-chat:main')).toBe(true);
    // Your messages there reach your Claude (the room protocol takes the channel; its events only go to you).
    expect([Channel.safeParse('sentinel-chat:main').success, Channel.safeParse('sentinel-chat:a1b2').success, Channel.safeParse('sentinel-chat:../x').success]).toEqual([true, true, false]);
    expect(activeSentinelChat(undefined)).toBe('sentinel-chat:main');
    expect(activeSentinelChat({ chats: [{ id: 'main', channel: 'sentinel-chat:main', createdAt: 0 }, { id: 'b', channel: 'sentinel-chat:b', createdAt: 1 }], active: 'b' })).toBe('sentinel-chat:b');
    expect(channelOf({ kind: 'sentinel_chat', chat: 'b' })).toBe('sentinel-chat:b');
    expect(channelOf({ kind: 'sentinel_chat' })).toBe('sentinel-chat:main');
    expect(shownChannel({ kind: 'sentinel_chat' })).toBe('sentinel-chat:main');
    expect(sentinelChatTitle('sentinel-chat:main', [{ channel: 'sentinel-chat:main', type: 'chat', byAgent: false, text: 'What did my sentinels find this week, and anything else?' }], 20)).toBe('What did my sentine…');
  });

  it('Claude there is told how Sentinel works and sees it as it is; its own folder and session, your runs only', () => {
    const s = setup();
    const made = s.sentinels.create({ name: 'Morning brief', trigger: { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' }, steps: [{ kind: 'claude', name: 'Read what changed', where: 'mac', prompt: 'x' }] });
    s.sentinels.dashboards.create('Ops');
    const run = s.sentinels.forRun('sentinel-chat:main', 'p-me')!;
    expect(run.inRun).toBe(false);
    expect(run.brief).toMatch(/You are the Sentinel chat/);
    expect(run.brief).toMatch(/Deleting a sentinel\n?\s*\(sentinel_remove\) or a dashboard \(dashboard_remove\) asks the user first/);
    expect(run.brief).toContain(`Morning brief (id ${made.id}) · Every day at 7:00 · paused · Look · never ran`);
    expect(run.brief).toContain(`  - step ${made.steps[0]!.id}: claude “Read what changed”`);
    expect(run.brief).toMatch(/<dashboards>\nOps \(id db_\w+\): no tiles yet\n<\/dashboards>/);
    expect(run.tools.remove).toBeDefined();
    expect(run.dashboard.remove).toBeDefined();
    expect(s.sentinels.chatPlace('sentinel-chat:main', 'p-me')).toMatchObject({ autoEdit: true });
    expect(s.sentinels.chatPlace('sentinel-chat:main', 'p-friend')).toBeUndefined();
    expect(s.sentinels.chatPlace('ws:1', 'p-me')).toBeUndefined();
    s.sentinels.stopAll();
  });

  it('New, open, Clear, Delete: kept in ~/.beluga/sentinel/chat with each chat’s history and Claude session', async () => {
    const dir = dirOf();
    const s = setup({ dir });
    const chats = () => s.store.getState().sentinel.chats!;
    expect(chats()).toEqual({ chats: [{ id: 'main', channel: 'sentinel-chat:main', createdAt: expect.any(Number) }], active: 'main' });
    s.sentinels.chatPlace('sentinel-chat:main', 'p-me')!.onSession('sess-1');
    const { id, channel } = s.sentinels.chatNew();
    expect(channel).toBe(`sentinel-chat:${id}`);
    expect(chats().active).toBe(id);
    s.sentinels.chatOpen('main');
    expect(chats().active).toBe('main');
    s.store.dispatch({ type: 'chat', id: 'm1', channel: 'sentinel-chat:main', from: 'p-me', name: 'Me', text: 'hello', ts: 1, byAgent: false } as never);
    expect(s.sentinels.chatPlace('sentinel-chat:main', 'p-me')!.resume).toBe('sess-1');
    s.sentinels.chatClear('main');
    expect(s.store.getState().log.filter((l) => l.channel === 'sentinel-chat:main')).toEqual([]);
    expect(s.sentinels.chatPlace('sentinel-chat:main', 'p-me')!.resume).toBeUndefined();
    await s.sentinels.chatDelete('main');
    expect(chats()).toEqual({ chats: [{ id, channel, createdAt: expect.any(Number) }], active: id });
    await s.sentinels.chatDelete(id);
    expect(chats().chats.map((c) => c.id)).toEqual(['main']);
    expect(JSON.parse(readFileSync(path.join(dir, 'sentinel', 'chat', 'chats.json'), 'utf8'))).toMatchObject({ active: 'main', chats: [{ id: 'main' }] });
    s.sentinels.stopAll();
    // A new Beluga reads them back.
    const again = setup({ dir });
    expect(again.store.getState().sentinel.chats!.chats.map((c) => c.id)).toEqual(['main']);
    again.sentinels.stopAll();
  });

  it('quiet: Claude finishing there is no news, its name is the Sentinel chat’s; the phone opens and writes in it', () => {
    const s = setup();
    const st = s.store.getState();
    expect(placeName(st, 'sentinel-chat:main')).toBe('the Sentinel chat');
    s.store.dispatch({ type: 'chat', id: 'm1', channel: 'sentinel-chat:main', from: 'p-me', name: 'Me', text: 'What did they find?', ts: 1, byAgent: false } as never);
    const view = sentinelsView(s.store.getState());
    expect(view.chat).toEqual({ topic: 'conv:sentinel-chat:main', title: 'What did they find?', last: 'What did they find?', lastAt: 1, working: false });
    const conv = convView(s.store.getState(), { outputs: () => [] } as never, 'conv:sentinel-chat:main');
    expect(conv).toMatchObject({ title: 'Sentinel · What did they find?', project: 'Sentinel', canSend: true });
    for (const m of ['sentinel.chatNew', 'sentinel.chatOpen', 'sentinel.chatClear', 'sentinel.chatDelete'] as const) expect(PHONE[m]).toBe('mac');
    s.sentinels.stopAll();
  });
});
