import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentStatus, noticeStatus, readMeta } from '../src/core/claude-code/agents.js';
import { attachClaudeCode, claudeCodeOf, claudeHome, launchClaudeCode } from '../src/core/claude-code/launch.js';
import { agentEnded, outsideSessions, reduceClaudeCode, runningAgents, sessionLive, sessionsIn, type CcSession } from '../src/core/claude-code/model.js';
import { MAX_STEPS, TranscriptTracker } from '../src/core/claude-code/sessions.js';
import { Tail, headLines } from '../src/core/claude-code/tail.js';
import { describeTool, factsOf, parseLine, parseNotices } from '../src/core/claude-code/transcript.js';
import { ClaudeCodeWatcher, placeOf } from '../src/core/claude-code/watch.js';
import { CLAUDE_CODE_HANDLERS } from '../src/ipc/claude-code-handlers.js';
import { parseArgs } from '../src/ipc/api.js';
import { Store, initialState, reduce } from '../src/core/store.js';
import type { Project } from '../src/workspaces/types.js';
import type { Session } from '../src/core/session.js';

/** Fake Claude Code transcripts: the same line shapes Claude Code writes. */
const T0 = Date.parse('2026-10-18T20:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const SID = 'c40fea54-5cab-4cc2-9384-84792e63291d';
const CWD = '/work/klaude/madrid';

const user = (text: string, at: number, extra: Record<string, unknown> = {}): string => JSON.stringify({ type: 'user', timestamp: iso(at), sessionId: SID, cwd: CWD, message: { role: 'user', content: text }, ...extra });
const assistant = (content: unknown[], at: number, extra: Record<string, unknown> = {}, stop: string | null = 'tool_use'): string =>
  JSON.stringify({ type: 'assistant', timestamp: iso(at), sessionId: SID, cwd: CWD, message: { role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 50 } }, ...extra });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, at: number, opts: { error?: boolean; tur?: unknown; text?: string } = {}): string =>
  JSON.stringify({ type: 'user', timestamp: iso(at), sessionId: SID, cwd: CWD, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: opts.text ?? 'ok' }], is_error: opts.error ?? false }] }, ...(opts.tur ? { toolUseResult: opts.tur } : {}) });
const notice = (taskId: string, toolUseId: string, status: string, summary: string): string =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

describe('transcript lines → steps', () => {
  it('skips blank, broken, request-log and non-object lines', () => {
    expect(parseLine('')).toBeUndefined();
    expect(parseLine('{not json')).toBeUndefined();
    expect(parseLine('[1,2]')).toBeUndefined();
    expect(parseLine('{"type":"api-request-blob","message":{}}')).toBeUndefined();
    expect(parseLine('{"type":"api-request","id":1}')).toBeUndefined();
    expect(parseLine('{"type":"user"}')).toEqual({ type: 'user' });
  });

  it('describes tool calls in words, paths relative to the folder', () => {
    expect(describeTool('Read', { file_path: `${CWD}/src/core/store.ts` }, CWD)).toBe('Reading src/core/store.ts');
    expect(describeTool('Edit', { file_path: '/elsewhere/a.ts' }, CWD)).toBe('Editing /elsewhere/a.ts');
    // A long path keeps its end: the file's name is what you look for.
    const long = `/elsewhere/${'deep/'.repeat(30)}Screen Shot 1.png`;
    expect(describeTool('Read', { file_path: long }, CWD)).toMatch(/^Reading ….*\/Screen Shot 1\.png$/);
    expect(describeTool('Read', { file_path: long }, CWD).length).toBe('Reading '.length + 90);
    expect(describeTool('Write', { file_path: `${CWD}/x.md` }, CWD)).toBe('Writing x.md');
    expect(describeTool('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('Run the tests');
    expect(describeTool('Bash', { command: 'npm   test\n--watch' })).toBe('Running npm test --watch');
    expect(describeTool('Grep', { pattern: 'foo', path: `${CWD}/src` }, CWD)).toBe('Searching for foo in src');
    expect(describeTool('Glob', { pattern: '**/*.ts' })).toBe('Finding **/*.ts');
    expect(describeTool('WebFetch', { url: 'https://x.dev' })).toBe('Fetching https://x.dev');
    expect(describeTool('WebSearch', { query: 'tauri' })).toBe('Searching the web for tauri');
    expect(describeTool('TodoWrite', {})).toBe('Updating the plan');
    expect(describeTool('Agent', { description: 'Fix the sidebar' })).toBe('Agent: Fix the sidebar');
    expect(describeTool('mcp__claude-in-chrome__navigate', { url: 'https://a.b' })).toBe('navigate https://a.b');
    expect(describeTool('Mystery', {})).toBe('Mystery');
    expect(describeTool('Read', { file_path: `/${'a'.repeat(200)}` }).length).toBeLessThan(110);
    for (const name of ['Read', 'Edit', 'Write', 'Bash', 'BashOutput', 'KillShell', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'SendMessage', 'Skill']) expect(describeTool(name, {})).toBeTruthy();
  });

  it('reads your messages without the wrappers tools add, and skips what Claude Code adds itself', () => {
    const f = factsOf(parseLine(user('<system_instruction>attached files</system_instruction>\n\nFix the login page', T0))!);
    expect(f.steps).toEqual([{ ts: T0, kind: 'user', text: 'Fix the login page' }]);
    expect(f.title).toBe('Fix the login page');
    expect(f.final).toBe(false);
    expect(factsOf(parseLine(user('<system-reminder>x</system-reminder>', T0))!).steps).toEqual([]);
    expect(factsOf(parseLine(user('[Image: original 10x10]', T0, { isMeta: true }))!).steps).toEqual([]);
    expect(factsOf(parseLine(user('[Request interrupted by user]', T0))!).steps[0]).toMatchObject({ kind: 'note', text: 'Interrupted' });
  });

  it("reads Claude's words, tool calls, context size and whether it ended its turn", () => {
    const f = factsOf(parseLine(assistant([{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Looking.' }, toolUse('t1', 'Read', { file_path: `${CWD}/a.ts` })], T0))!);
    expect(f.steps.map((s) => [s.kind, s.text, s.status])).toEqual([
      // Thinking is a step of its own (opened from the transcript); its time is set once it's placed.
      ['thinking', 'Thought', undefined],
      ['text', 'Looking.', undefined],
      ['tool', 'Reading a.ts', 'running'],
    ]);
    expect(f.tokens).toBe(1062);
    expect(f.model).toBe('claude-opus-5-5');
    expect(f.final).toBe(false);
    const end = factsOf(parseLine(assistant([{ type: 'text', text: 'Done.' }], T0, {}, 'end_turn'))!);
    expect(end.final).toBe(true);
    const synthetic = factsOf(parseLine(JSON.stringify({ type: 'assistant', timestamp: iso(T0), message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } }))!);
    expect(synthetic.steps[0]).toMatchObject({ kind: 'note', text: 'API Error' });
    expect(synthetic.model).toBeUndefined();
  });

  it('sees sub-agents launched, sent to the background, and reporting back', () => {
    const launch = factsOf(parseLine(assistant([toolUse('toolu_A', 'Agent', { description: 'Fix worktrees', subagent_type: 'general-purpose', prompt: 'long' })], T0))!);
    expect(launch.launches).toEqual([{ toolUseId: 'toolu_A', description: 'Fix worktrees', type: 'general-purpose', background: false, ts: T0 }]);
    const async = factsOf(parseLine(toolResult('toolu_A', T0 + 1, { text: 'Async agent launched successfully.\nagentId: a1', tur: { isAsync: true, status: 'async_launched', agentId: 'a1' } }))!);
    expect(async.results).toEqual([{ toolUseId: 'toolu_A', error: false, async: true, agentId: 'a1', ts: T0 + 1, output: 'Async agent launched successfully.\nagentId: a1' }]);
    const queued = factsOf(parseLine(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(T0 + 5), content: notice('a1', 'toolu_A', 'completed', 'Agent "Fix worktrees" finished') }))!);
    expect(queued.notices).toEqual([{ taskId: 'a1', toolUseId: 'toolu_A', status: 'completed', summary: 'Agent "Fix worktrees" finished', ts: T0 + 5 }]);
    expect(queued.steps).toEqual([]);
    const dequeued = factsOf(parseLine(JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: iso(T0 + 6), content: notice('a1', 'toolu_A', 'completed', 'x') }))!);
    expect(dequeued.notices).toEqual([]);
    const attached = factsOf(parseLine(JSON.stringify({ type: 'attachment', timestamp: iso(T0 + 5), attachment: { type: 'queued_command', prompt: notice('a1', 'toolu_A', 'completed', 'Agent finished') } }))!);
    expect(attached.steps).toEqual([{ ts: T0 + 5, kind: 'note', text: 'Agent finished' }]);
    const inMessage = factsOf(parseLine(user(notice('b2', 'toolu_B', 'failed', 'Command failed'), T0 + 7))!);
    expect(inMessage.notices[0]).toMatchObject({ taskId: 'b2', status: 'failed' });
    expect(parseNotices('<task-notification><task-id>x</task-id></task-notification>', 0)).toEqual([]);
  });

  it('takes titles from summaries and Claude Code, notes compactions, ignores unknown types', () => {
    expect(factsOf({ type: 'summary', summary: 'Login fix' }).title).toBe('Login fix');
    expect(factsOf({ type: 'ai-title', aiTitle: 'Klaud plan' }).aiTitle).toBe('Klaud plan');
    expect(factsOf({ type: 'system', subtype: 'compact_boundary', timestamp: iso(T0) }).steps[0]).toMatchObject({ kind: 'note' });
    expect(factsOf({ type: 'system', subtype: 'stop_hook_summary' }).steps).toEqual([]);
    expect(factsOf({ type: 'atis-latch' } as never)).toMatchObject({ steps: [], results: [], launches: [], notices: [] });
    expect(factsOf({ type: 'last-prompt' }).final).toBeUndefined();
  });
});

describe('agent status', () => {
  const base = { now: T0 + 60_000, idleMs: 5 * 60_000 };
  it('maps Claude Code statuses', () => {
    expect(noticeStatus('completed')).toBe('finished');
    expect(noticeStatus('failed')).toBe('failed');
    expect(noticeStatus('killed')).toBe('stopped');
    expect(noticeStatus('whatever')).toBe('finished');
  });
  it('trusts the session when its word is newer than the agent, else the agent itself', () => {
    expect(agentStatus({ ...base, lastAt: T0, final: false })).toEqual({ status: 'running' });
    expect(agentStatus({ ...base, lastAt: T0, final: true })).toEqual({ status: 'finished', endedAt: T0 });
    expect(agentStatus({ ...base, lastAt: T0, final: false, notice: { taskId: 'a', status: 'killed', ts: T0 + 10 } })).toEqual({ status: 'stopped', endedAt: T0 + 10 });
    // Resumed after it reported: working again.
    expect(agentStatus({ ...base, lastAt: T0 + 50_000, final: false, notice: { taskId: 'a', status: 'completed', ts: T0 } })).toEqual({ status: 'running' });
    expect(agentStatus({ ...base, lastAt: T0, final: false, result: { toolUseId: 't', error: true, async: false, ts: T0 + 1 } })).toEqual({ status: 'failed', endedAt: T0 + 1 });
    expect(agentStatus({ ...base, lastAt: T0, final: false, result: { toolUseId: 't', error: false, async: true, ts: T0 + 1 } })).toEqual({ status: 'running' });
    expect(agentStatus({ ...base, now: T0 + 10 * 60_000, lastAt: T0, final: false })).toEqual({ status: 'idle' });
    // Quiet, and Claude Code marked it finished: finished, not idle.
    expect(agentStatus({ ...base, now: T0 + 10 * 60_000, lastAt: T0, final: false, marked: true })).toEqual({ status: 'finished', endedAt: T0 });
    expect(agentStatus({ ...base, lastAt: T0, final: false, marked: true })).toEqual({ status: 'running' });
  });
});

describe('files: tail, head, meta', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-cc-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads only what was added, whole lines only', () => {
    const file = path.join(dir, 'a.jsonl');
    expect(new Tail(file).read()).toEqual([]);
    writeFileSync(file, 'one\ntwo\nthr');
    const tail = new Tail(file);
    expect(tail.read()).toEqual(['one', 'two']);
    expect(tail.read()).toEqual([]);
    appendFileSync(file, 'ee\nfour\n');
    expect(tail.read()).toEqual(['three', 'four']);
    // Replaced by a shorter file: read again.
    writeFileSync(file, 'new\n');
    expect(tail.read()).toEqual(['new']);
  });

  it('opens a huge file at its end, and skips ahead when far behind', () => {
    const file = path.join(dir, 'big.jsonl');
    const line = (i: number): string => `${JSON.stringify({ i, pad: 'x'.repeat(80) })}\n`;
    writeFileSync(file, Array.from({ length: 5000 }, (_, i) => line(i)).join(''));
    const tail = new Tail(file, { firstBytes: 10_000, maxBytes: 20_000 });
    const first = tail.read();
    expect(first.length).toBeGreaterThan(50);
    expect(first.length).toBeLessThan(130);
    expect(JSON.parse(first.at(-1)!).i).toBe(4999);
    // Every line it gives is whole.
    for (const l of first) expect(() => JSON.parse(l)).not.toThrow();
    appendFileSync(file, Array.from({ length: 2000 }, (_, i) => line(5000 + i)).join(''));
    const next = tail.read();
    expect(JSON.parse(next.at(-1)!).i).toBe(6999);
    expect(next.length).toBeLessThan(250);
    for (const l of next) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('reads the head and meta files, tolerating broken ones', () => {
    const file = path.join(dir, 'h.jsonl');
    writeFileSync(file, 'a\nb\nunfinished');
    expect(headLines(file)).toEqual(['a', 'b']);
    expect(headLines(path.join(dir, 'missing'))).toEqual([]);
    const meta = path.join(dir, 'm.json');
    writeFileSync(meta, JSON.stringify({ agentType: 'general-purpose', description: 'Fix it', toolUseId: 'toolu_1', requestShape: 'background', spawnDepth: 1 }));
    expect(readMeta(meta)).toEqual({ agentType: 'general-purpose', description: 'Fix it', toolUseId: 'toolu_1', requestShape: 'background' });
    writeFileSync(meta, '{broken');
    expect(readMeta(meta)).toEqual({});
    expect(readMeta(path.join(dir, 'none.json'))).toEqual({});
  });

  it('keeps the last steps of a transcript, settles tool calls and pages through them', () => {
    const file = path.join(dir, `${SID}.jsonl`);
    writeFileSync(file, [JSON.stringify({ type: 'ai-title', aiTitle: 'Klaud plan' }), user('Do the thing', T0)].join('\n') + '\n');
    const t = new TranscriptTracker(file);
    t.update();
    expect(t.title).toBe('Klaud plan');
    expect(t.cwd).toBe(CWD);
    expect(t.startedAt).toBe(T0);
    const lines: string[] = [];
    for (let i = 0; i < MAX_STEPS + 50; i++) {
      lines.push(assistant([toolUse(`t${i}`, 'Read', { file_path: `${CWD}/f${i}.ts` })], T0 + i * 10));
      lines.push(toolResult(`t${i}`, T0 + i * 10 + 5, { error: i === MAX_STEPS + 49 }));
    }
    appendFileSync(file, lines.join('\n') + '\n');
    t.update();
    expect(t.count).toBe(MAX_STEPS + 51);
    const page = t.page();
    expect(page.steps).toHaveLength(MAX_STEPS);
    expect(page.steps.at(-1)).toMatchObject({ kind: 'tool', text: `Reading f${MAX_STEPS + 49}.ts`, status: 'error' });
    expect(page.steps.at(-2)).toMatchObject({ status: 'done' });
    expect(page.steps.at(-1)).not.toHaveProperty('toolUseId');
    expect(page.more).toBe(false);
    expect(t.current).toBe(`Reading f${MAX_STEPS + 49}.ts`);
    const last = page.steps.at(-1)!.seq;
    const small = t.page({ limit: 10 });
    expect(small.steps).toHaveLength(10);
    expect(small.more).toBe(true);
    expect(t.page({ before: small.steps[0]!.seq, limit: 5 }).steps.at(-1)!.seq).toBe(small.steps[0]!.seq - 1);
    expect(t.page({ after: last }).steps).toEqual([]);
    appendFileSync(file, assistant([{ type: 'text', text: '**All** done.\nMore.' }], T0 + 99_999, {}, 'end_turn') + '\n');
    t.update();
    expect(t.page({ after: last }).steps).toMatchObject([{ kind: 'text', text: '**All** done.\nMore.' }]);
    expect(t.current).toBe('All done.');
    expect(t.final).toBe(true);
  });
});

/** A fake ~/.claude with one session (and agents) in a Conductor worktree. */
function fakeHome(): { home: string; session: string; agentsDir: string; add: (file: string, ...lines: string[]) => void } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klaud-claude-home-'));
  const folder = path.join(home, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'));
  const agentsDir = path.join(folder, SID, 'subagents');
  mkdirSync(agentsDir, { recursive: true });
  const session = path.join(folder, `${SID}.jsonl`);
  writeFileSync(session, '');
  return { home, session, agentsDir, add: (file, ...lines) => appendFileSync(file, lines.map((l) => `${l}\n`).join('')) };
}

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'klaude',
  root: '/work/klaude/main',
  base: 'main',
  workspaces: [
    { id: 'w-main', projectRoot: '/work/klaude/main', name: 'main', path: '/work/klaude/main', kind: 'main', createdAt: 0, projectId: 'p1', external: false },
    { id: 'w-madrid', projectRoot: '/work/klaude/main', name: 'madrid', path: CWD, kind: 'worktree', createdAt: 0, projectId: 'p1', external: true },
    { id: 'w-own', projectRoot: '/work/klaude/main', name: 'own', path: '/work/klaude/own', kind: 'worktree', createdAt: 0, projectId: 'p1', external: false, sessionId: 'aaaaaaaa-0000-0000-0000-000000000000' },
  ],
  ...over,
});

describe('the watcher', () => {
  let now = T0 + 60_000;
  let fake: ReturnType<typeof fakeHome>;
  let store: Store;
  let notes: Array<{ title: string; body: string; failed: boolean }>;
  let w: ClaudeCodeWatcher;
  const sessions = (): readonly CcSession[] => store.getState().claudeCode.sessions;
  const tick = async (): Promise<void> => {
    await w.scan();
    w.poll();
    w.publish();
  };

  beforeEach(() => {
    now = T0 + 60_000;
    fake = fakeHome();
    store = new Store(initialState('room'));
    store.dispatch({ type: 'projects', projects: [project()] });
    notes = [];
    w = new ClaudeCodeWatcher({ home: fake.home, store, now: () => now, watch: false, publishMs: 0, notify: (n) => notes.push(n) });
  });
  afterEach(() => {
    w.stop();
    rmSync(fake.home, { recursive: true, force: true });
  });

  /** Files' times follow the fake clock. */
  const touch = (file: string, at = now): void => utimesSync(file, at / 1000, at / 1000);

  it('finds a live session, where it runs, its title and step; follows it as lines are added', async () => {
    fake.add(fake.session, JSON.stringify({ type: 'ai-title', aiTitle: 'Klaud plan' }), user('Make the sidebar draggable', T0), assistant([toolUse('t1', 'Read', { file_path: `${CWD}/src/core/store.ts` })], T0 + 1000));
    touch(fake.session, T0 + 1000);
    await tick();
    expect(sessions()).toHaveLength(1);
    const s = sessions()[0]!;
    expect(s).toMatchObject({ id: SID, title: 'Klaud plan', cwd: CWD, projectId: 'p1', workspaceId: 'w-madrid', status: 'working', step: 'Reading src/core/store.ts', steps: 2, startedAt: T0 });
    expect(sessionLive(s)).toBe(true);
    fake.add(fake.session, toolResult('t1', T0 + 2000), assistant([{ type: 'text', text: 'Done.' }], T0 + 3000, {}, 'end_turn'));
    touch(fake.session, T0 + 3000);
    await tick();
    expect(sessions()[0]).toMatchObject({ status: 'waiting', step: 'Done.', steps: 3 });
    const page = w.steps(SID);
    expect(page.steps.map((x) => x.kind)).toEqual(['user', 'tool', 'text']);
    expect(page.steps[1]!.status).toBe('done');
    // Quiet for a long time: gone from the list.
    now = T0 + 2 * 60 * 60_000;
    await tick();
    expect(sessions()).toEqual([]);
    expect(w.steps(SID).missing).toBe(true);
  });

  it('shows sub-agents with their meta, steps and status, and tells you when a background one finishes', async () => {
    fake.add(fake.session, user('Fix three things', T0), assistant([toolUse('toolu_A', 'Agent', { description: 'Fix worktrees', subagent_type: 'general-purpose' }), toolUse('toolu_B', 'Agent', { description: 'Review', subagent_type: 'typescript-reviewer' })], T0 + 100));
    fake.add(fake.session, toolResult('toolu_A', T0 + 200, { text: 'Async agent launched successfully.', tur: { isAsync: true, status: 'async_launched', agentId: 'a1' } }));
    fake.add(fake.session, toolResult('toolu_B', T0 + 200, { text: 'Async agent launched successfully.', tur: { isAsync: true, status: 'async_launched', agentId: 'b2' } }));
    touch(fake.session, T0 + 200);
    const a1 = path.join(fake.agentsDir, 'agent-a1.jsonl');
    const b2 = path.join(fake.agentsDir, 'agent-b2.jsonl');
    writeFileSync(path.join(fake.agentsDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Fix worktrees', toolUseId: 'toolu_A', requestShape: 'background' }));
    writeFileSync(path.join(fake.agentsDir, 'agent-b2.meta.json'), JSON.stringify({ agentType: 'typescript-reviewer', description: 'Review', toolUseId: 'toolu_B', requestShape: 'background' }));
    fake.add(a1, user('Fix the worktrees page', T0 + 300, { isSidechain: true, agentId: 'a1' }), assistant([toolUse('x1', 'Grep', { pattern: 'worktree' })], T0 + 400));
    fake.add(b2, user('Review the code', T0 + 300), assistant([toolUse('y1', 'Read', { file_path: `${CWD}/a.ts` })], T0 + 400));
    touch(a1, T0 + 400);
    touch(b2, T0 + 400);
    await tick();
    const s = sessions()[0]!;
    expect(s.agents.map((a) => [a.id, a.description, a.type, a.background, a.status, a.step, a.steps])).toEqual([
      ['a1', 'Fix worktrees', 'general-purpose', true, 'running', 'Searching for worktree', 2],
      ['b2', 'Review', 'typescript-reviewer', true, 'running', 'Reading a.ts', 2],
    ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
    expect(runningAgents(sessions())).toBe(2);
    expect(sessionsIn(sessions(), 'w-madrid')).toHaveLength(1);

    // a1 ends with a final answer and the session gets its notification; b2 is killed.
    now += 5000;
    fake.add(a1, assistant([{ type: 'text', text: 'Fixed it.' }], now - 1000, {}, 'end_turn'));
    touch(a1, now - 1000);
    fake.add(fake.session, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(now), content: notice('a1', 'toolu_A', 'completed', 'Agent "Fix worktrees" finished') }));
    fake.add(fake.session, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(now), content: notice('b2', 'toolu_B', 'killed', 'Agent "Review" was stopped') }));
    touch(fake.session);
    await tick();
    const after = sessions()[0]!.agents;
    expect(after.find((a) => a.id === 'a1')).toMatchObject({ status: 'finished', step: 'Fixed it.', endedAt: now });
    expect(after.find((a) => a.id === 'b2')).toMatchObject({ status: 'stopped' });
    expect(agentEnded(after[0]!)).toBe(true);
    expect(notes).toEqual([
      { title: 'An agent finished in madrid', body: 'Fix worktrees', failed: false },
      { title: 'An agent stopped in madrid', body: 'Review', failed: false },
    ]);
    // The agent's own steps, on demand.
    expect(w.steps(SID, 'a1').steps.map((x) => x.text)).toEqual(['Fix the worktrees page', 'Searching for worktree', 'Fixed it.']);
    expect(w.steps(SID, 'nope').missing).toBe(true);
    // Nothing changes: nothing is published again.
    const before = store.getState();
    await tick();
    expect(store.getState()).toBe(before);
  });

  it('keeps a quiet session while one of its agents works, and drops old agents', async () => {
    fake.add(fake.session, user('Go', T0 - 60 * 60_000));
    touch(fake.session, T0 - 60 * 60_000);
    const old = path.join(fake.agentsDir, 'agent-old1.jsonl');
    fake.add(old, user('old task', T0 - 2 * 60 * 60_000));
    touch(old, T0 - 2 * 60 * 60_000);
    const live = path.join(fake.agentsDir, 'agent-live1.jsonl');
    fake.add(live, user('Long task', now - 5000), assistant([toolUse('z', 'Bash', { command: 'npm test' })], now - 1000));
    touch(live, now - 1000);
    await tick();
    expect(sessions()).toHaveLength(1);
    expect(sessions()[0]!.status).toBe('idle');
    expect(sessions()[0]!.agents.map((a) => [a.id, a.description, a.background, a.status])).toEqual([['live1', 'Long task', false, 'running']]);
  });

  it("leaves out Beluga's own conversations, and maps folders outside any project to none", async () => {
    const folder = path.dirname(fake.session);
    writeFileSync(path.join(folder, 'aaaaaaaa-0000-0000-0000-000000000000.jsonl'), `${user('mine', now)}\n`);
    const other = path.join(fake.home, 'projects', '-tmp-x');
    mkdirSync(other);
    writeFileSync(path.join(other, 'bbbbbbbb-1111-1111-1111-111111111111.jsonl'), `${JSON.stringify({ type: 'user', timestamp: iso(now), cwd: '/tmp/x', message: { content: 'elsewhere' } })}\n`);
    writeFileSync(path.join(other, 'notes.txt'), 'not a transcript');
    await tick();
    // klaud's own conversation is watched (for its sub-agents) but marked, so Activity leaves it out.
    expect(outsideSessions(sessions()).map((s) => s.id)).toEqual(['bbbbbbbb-1111-1111-1111-111111111111']);
    expect(sessions().find((s) => s.id.startsWith('aaaa'))).toMatchObject({ own: true });
    expect(outsideSessions(sessions())[0]).not.toHaveProperty('workspaceId');
  });

  it("follows Beluga's own conversations' sub-agents: where they started, model, effort, own worktree", async () => {
    const OWN = 'aaaaaaaa-0000-0000-0000-000000000000';
    const folder = path.dirname(fake.session);
    const ownFile = path.join(folder, `${OWN}.jsonl`);
    const agents = path.join(folder, OWN, 'subagents');
    mkdirSync(agents, { recursive: true });
    const wt = '/work/klaude/main/.claude/worktrees/agent-b0b1';
    writeFileSync(ownFile, `${JSON.stringify({ type: 'user', timestamp: iso(now - 3000), sessionId: OWN, cwd: '/work/klaude/own', message: { content: 'Fix it' } })}\n${assistant([toolUse('toolu_O', 'Agent', { description: 'Check the tests', subagent_type: 'general-purpose', isolation: 'worktree' })], now - 2500, { sessionId: OWN, cwd: '/work/klaude/own' })}\n`);
    writeFileSync(path.join(agents, 'agent-b0b1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Check the tests', toolUseId: 'toolu_O', model: 'sonnet', worktreePath: wt, worktreeBranch: 'worktree-agent-b0b1', parentAgentId: 'x1', name: 'checker' }));
    // A worktree path outside .claude/worktrees isn't believed.
    writeFileSync(path.join(agents, 'agent-bad.meta.json'), JSON.stringify({ description: 'Elsewhere', worktreePath: '/etc' }));
    writeFileSync(path.join(agents, 'agent-b0b1.jsonl'), `${assistant([toolUse('r', 'Read', { file_path: `${wt}/a.ts` })], now - 1000, { sessionId: OWN, cwd: wt, effort: 'high' })}\n`);
    writeFileSync(path.join(agents, 'agent-bad.jsonl'), `${user('x', now - 1000)}\n`);
    await tick();
    const own = sessions().find((x) => x.id === OWN)!;
    expect(own).toMatchObject({ own: true, workspaceId: 'w-own', projectId: 'p1' });
    const agent = own.agents.find((a) => a.id === 'b0b1')!;
    expect(agent).toMatchObject({ description: 'Check the tests', model: 'claude-opus-5-5', effort: 'high', cwd: wt, worktree: { path: wt, branch: 'worktree-agent-b0b1' }, toolUseId: 'toolu_O', parentAgentId: 'x1', name: 'checker' });
    expect(own.agents.find((a) => a.id === 'bad')).not.toHaveProperty('worktree');
    expect(outsideSessions(sessions()).some((x) => x.id === OWN)).toBe(false);
  });

  it('finds an old sub-agent by its id and keeps it watched while you look', async () => {
    const old = T0 - 5 * 60 * 60_000;
    const agentFile = path.join(fake.agentsDir, 'agent-ancient1.jsonl');
    fake.add(fake.session, user('Long ago', old));
    touch(fake.session, old);
    fake.add(agentFile, user('Old task', old));
    touch(agentFile, old);
    await tick();
    expect(sessions()).toEqual([]);
    expect(w.adopt('nope-nothing')).toBeUndefined();
    expect(w.adopt('ancient1')).toBe(SID);
    await tick();
    expect(sessions()[0]!.agents.map((a) => a.id)).toEqual(['ancient1']);
    expect(w.steps(SID, 'ancient1').steps.map((x) => x.text)).toContain('Old task');
    // Once nobody looks for a while, it's let go again.
    now += 11 * 60_000;
    await tick();
    expect(sessions()).toEqual([]);
  });

  it('starts, watches and stops on its own timers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearInterval', 'clearTimeout'] });
    try {
      const live = new ClaudeCodeWatcher({ home: fake.home, store, now: () => now, watch: true, pollMs: 50, scanMs: 100, publishMs: 10 });
      fake.add(fake.session, user('Hello', now));
      touch(fake.session);
      live.start();
      // The scan reads the disk for real (async): time moves on while it does.
      for (let i = 0; i < 100 && !sessions().length; i++) {
        await vi.advanceTimersByTimeAsync(20);
        await new Promise((r) => setImmediate(r));
      }
      expect(sessions()).toHaveLength(1);
      // Projects change: sessions map again.
      store.dispatch({ type: 'projects', projects: [project({ workspaces: [] })] });
      await vi.advanceTimersByTimeAsync(200);
      expect(sessions()[0]).not.toHaveProperty('workspaceId');
      expect(sessions()[0]!.projectId).toBeUndefined();
      live.stop();
      await live.scan();
      live.poll();
      live.publish();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('placing a folder in Beluga', () => {
  it('picks the deepest workspace, else the project, else nothing', () => {
    const p = project({ workspaces: [...project().workspaces, { id: 'w-deep', projectRoot: '/work/klaude/main', name: 'deep', path: '/work/klaude/main/.claude/worktrees/x', kind: 'worktree', createdAt: 0, projectId: 'p1', external: true }] });
    expect(placeOf([p], '/work/klaude/main/.claude/worktrees/x/src')).toEqual({ projectId: 'p1', workspaceId: 'w-deep' });
    expect(placeOf([p], '/work/klaude/main/src')).toEqual({ projectId: 'p1', workspaceId: 'w-main' });
    expect(placeOf([project({ workspaces: [] })], '/work/klaude/main/src')).toEqual({ projectId: 'p1' });
    expect(placeOf([p], '/work/klaude/mainly')).toEqual({});
  });
});

describe('launching, the state and the API', () => {
  it('finds Claude Code’s folder', () => {
    expect(claudeHome({ BELUGA_CLAUDE_HOME: '/x' })).toBe('/x');
    expect(claudeHome({ CLAUDE_CONFIG_DIR: '/y' })).toBe('/y');
    expect(claudeHome({})).toBe(path.join(os.homedir(), '.claude'));
  });

  it('runs in the daemon only; the demo only with a folder of its own', () => {
    const session = {};
    expect(() => claudeCodeOf(session)).toThrow(/Mac/);
    const store = new Store(initialState('room'));
    launchClaudeCode({ session, store, demo: true })();
    expect(() => claudeCodeOf(session)).toThrow(/Mac/);
    const home = mkdtempSync(path.join(os.tmpdir(), 'klaud-claude-launch-'));
    const prev = process.env.BELUGA_CLAUDE_HOME;
    process.env.BELUGA_CLAUDE_HOME = home;
    const events: unknown[] = [];
    try {
      const stop = launchClaudeCode({ session, store, demo: true, notify: (e) => events.push(e) });
      expect(claudeCodeOf(session).steps(SID)).toEqual({ steps: [], more: false, missing: true });
      expect(CLAUDE_CODE_HANDLERS['claudeCode.steps'](session as Session, SID, undefined, { limit: 5, before: 3, after: 1 })).toEqual({ steps: [], more: false, missing: true });
      stop();
    } finally {
      if (prev === undefined) delete process.env.BELUGA_CLAUDE_HOME;
      else process.env.BELUGA_CLAUDE_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
    attachClaudeCode(session, new ClaudeCodeWatcher({ home, store, watch: false }));
    expect(claudeCodeOf(session)).toBeInstanceOf(ClaudeCodeWatcher);
  });

  it('checks the arguments of claudeCode.steps', () => {
    expect(parseArgs('claudeCode.steps', [SID])).toEqual([SID]);
    expect(parseArgs('claudeCode.steps', [SID, 'a1', { after: 3 }])).toEqual([SID, 'a1', { after: 3 }]);
    expect(() => parseArgs('claudeCode.steps', ['../etc'])).toThrow();
    expect(() => parseArgs('claudeCode.steps', [SID, '../x'])).toThrow();
    expect(() => parseArgs('claudeCode.steps', [SID, 'a1', { limit: 1000 }])).toThrow();
  });

  it('puts the sessions in the shared state as they come', () => {
    const s: CcSession = { id: SID, title: 't', cwd: CWD, status: 'working', lastAt: T0, steps: 1, agents: [] };
    const state = reduce(initialState('room'), { type: 'claude_code', sessions: [s] });
    expect(state.claudeCode.sessions).toEqual([s]);
    expect(reduceClaudeCode(state, { type: 'claude_code', sessions: [] }).claudeCode.sessions).toEqual([]);
  });
});

describe('Beluga’s own conversations stay out of Activity', () => {
  it('remembers them after the conversation is deleted', async () => {
    const { ClaudeCodeWatcher } = await import('../src/core/claude-code/watch.js');
    const { Store, initialState } = await import('../src/core/store.js');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const home = mkdtempSync(pathMod.join(os.tmpdir(), 'cc-own-'));
    const own = pathMod.join(home, 'own.json');
    const dir = pathMod.join(home, 'projects', '-tmp-proj');
    mkdirSync(dir, { recursive: true });
    const sid = '11111111-2222-3333-4444-555555555555';
    writeFileSync(pathMod.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), sessionId: sid, cwd: '/tmp/proj', message: { role: 'user', content: 'hi' } }) + '\n');
    const store = new Store(initialState('test', 'ask'));
    const ws = { id: 'w1', projectId: 'p1', name: 'chat', path: '/tmp/proj', kind: 'chat', createdAt: 0, sessionId: sid, external: false };
    store.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'proj', root: '/tmp/proj', base: 'main', workspaces: [ws] }] } as never);
    const first = new ClaudeCodeWatcher({ home, store, watch: false, ownFile: own });
    await first.scan();
    expect(store.getState().claudeCode?.sessions ?? []).toHaveLength(0);
    first.stop();
    // The conversation is deleted; a new klaud (restarted) still keeps its session out.
    store.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'proj', root: '/tmp/proj', base: 'main', workspaces: [] }] } as never);
    const second = new ClaudeCodeWatcher({ home, store, watch: false, ownFile: own });
    await second.scan();
    await new Promise((r) => setTimeout(r, 400));
    expect((store.getState().claudeCode?.sessions ?? []).map((s: { id: string }) => s.id)).not.toContain(sid);
    second.stop();
  });
});

describe('sub-agent worktrees keep who started them', () => {
  it('places each under the conversation that started it, long after it finished', async () => {
    const { ClaudeCodeWatcher } = await import('../src/core/claude-code/watch.js');
    const { Store, initialState } = await import('../src/core/store.js');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const home = mkdtempSync(pathMod.join(os.tmpdir(), 'cc-origins-'));
    const sid = '11111111-2222-3333-4444-666666666666';
    const dir = pathMod.join(home, 'projects', '-tmp-proj');
    mkdirSync(pathMod.join(dir, sid, 'subagents'), { recursive: true });
    // Months old: the watcher itself no longer follows this session.
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    writeFileSync(pathMod.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'user', timestamp: old, sessionId: sid, cwd: '/tmp/proj', message: { role: 'user', content: 'Split it up' } }) + '\n');
    const wt = '/tmp/proj/.claude/worktrees/agent-abc123';
    writeFileSync(pathMod.join(dir, sid, 'subagents', 'agent-abc123.meta.json'), JSON.stringify({ worktreePath: wt, description: 'Composer package', finished: true }));
    const store = new Store(initialState('test', 'ask'));
    const main = { id: 'main', projectId: 'p1', name: 'proj', path: '/tmp/proj', kind: 'main', createdAt: 0, external: false };
    const agentWs = { id: 'agent', projectId: 'p1', name: 'agent-abc123', path: wt, kind: 'worktree', createdAt: 0, external: true };
    store.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'proj', root: '/tmp/proj', base: 'main', workspaces: [main, agentWs] }] } as never);
    const w = new ClaudeCodeWatcher({ home, store, watch: false });
    await w.scan();
    expect(store.getState().claudeCode.sessions).toHaveLength(0);
    expect(store.getState().claudeCode.origins).toEqual([expect.objectContaining({ path: wt, agentId: 'abc123', description: 'Composer package', sessionTitle: 'Split it up', projectId: 'p1', workspaceId: 'main', finished: true })]);
    w.stop();
  });
});
