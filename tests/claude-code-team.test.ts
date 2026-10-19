import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CcSession } from '../src/core/claude-code/model.js';
import { describeTool, factsOf, messageStep, parseLine } from '../src/core/claude-code/transcript.js';
import { ClaudeCodeWatcher } from '../src/core/claude-code/watch.js';
import { Store, initialState } from '../src/core/store.js';

/**
 * Agents messaging each other in Claude Code (SendMessage): a message to an agent shows in its
 * transcript and wakes it, the sender's transcript says whom it went to, and named agents that
 * message each other show as a team with a timeline. Fake transcripts in Claude Code's shapes.
 */

const T0 = Date.parse('2026-10-18T20:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const SID = 'c40fea54-5cab-4cc2-9384-84792e63291d';
const CWD = '/work/klaude/madrid';
const line = (o: Record<string, unknown>, at: number): string => JSON.stringify({ timestamp: iso(at), sessionId: SID, cwd: CWD, ...o });
const user = (content: unknown, at: number, extra: Record<string, unknown> = {}): string => line({ type: 'user', message: { role: 'user', content }, ...extra }, at);
const assistant = (content: unknown[], at: number, stop: string | null = 'tool_use'): string => line({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop } }, at);
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const result = (id: string, at: number, text: string, tur?: unknown): string => user([{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }], at, tur ? { toolUseResult: tur } : {});
const HANDBACK = '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user.\nThe harness indents every line of the report.\n\n    Fixed both bugs.\n    Tests pass.';

describe('messages between sessions, line by line', () => {
  it('reads a message from the lead session, from another agent, and a report handed back', () => {
    expect(messageStep('The coordinator sent a message while you were working:\nReview the diff instead.', 1)).toMatchObject({ kind: 'message', from: 'lead', text: 'Review the diff instead.' });
    expect(messageStep('Another Claude session sent a message while you were working:\n<agent-message from="a1">\nFound 2 bugs\n</agent-message>', 1)).toMatchObject({ kind: 'message', from: 'a1', text: 'Found 2 bugs' });
    const report = messageStep(`Another Claude session sent a message:\n<agent-message from="a2">\n${HANDBACK}\n</agent-message>`, 1, { kind: 'peer', from: 'a2', name: 'fixer' });
    expect(report).toMatchObject({ kind: 'message', from: 'a2', report: true, text: 'Fixed both bugs.\nTests pass.' });
    expect(messageStep('just a message you typed', 1)).toBeUndefined();
  });

  it('sees a lead message even as a meta entry, and messages delivered while working as attachments', () => {
    const lead = factsOf(parseLine(user('The coordinator sent a message while you were working:\nStop and commit.', T0, { isMeta: true, origin: { kind: 'coordinator' } }))!);
    expect(lead.steps).toMatchObject([{ kind: 'message', from: 'lead', text: 'Stop and commit.' }]);
    expect(lead.final).toBe(false);
    const queued = factsOf(parseLine(line({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<agent-message from="reviewer">\nPlease send your findings.\n</agent-message>' } }, T0))!);
    expect(queued.steps).toMatchObject([{ kind: 'message', from: 'reviewer', text: 'Please send your findings.' }]);
  });

  it('says whom a SendMessage went to, and remembers it for the timeline', () => {
    expect(describeTool('SendMessage', { to: 'a1', summary: 'Review the commit', message: 'long…' })).toBe('→ sent to a1: Review the commit');
    const f = factsOf(parseLine(assistant([tool('s1', 'SendMessage', { to: 'fixer', summary: 'Found 2 bugs', message: 'details' })], T0))!);
    expect(f.steps[0]).toMatchObject({ kind: 'tool', tool: 'SendMessage', to: 'fixer', text: '→ sent to fixer: Found 2 bugs' });
    expect(f.sends).toEqual([{ to: 'fixer', summary: 'Found 2 bugs', ts: T0 }]);
    const named = factsOf(parseLine(assistant([tool('A', 'Agent', { description: 'Review', prompt: 'p', name: 'reviewer', run_in_background: true })], T0))!);
    expect(named.launches[0]).toMatchObject({ name: 'reviewer', background: true });
  });
});

describe('a team in the watcher', () => {
  let home: string;
  let store: Store;
  let w: ClaudeCodeWatcher;
  let now = T0 + 60_000;
  let session: string;
  let agentsDir: string;
  const add = (file: string, ...lines: string[]): void => appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
  const touch = (file: string, at = now): void => utimesSync(file, at / 1000, at / 1000);
  const sessions = (): readonly CcSession[] => store.getState().claudeCode.sessions;
  const tick = (): void => {
    w.scan();
    w.poll();
    w.publish();
  };
  const agent = (id: string, meta: Record<string, unknown>): string => {
    writeFileSync(path.join(agentsDir, `agent-${id}.meta.json`), JSON.stringify(meta));
    const file = path.join(agentsDir, `agent-${id}.jsonl`);
    writeFileSync(file, '');
    return file;
  };

  beforeEach(() => {
    now = T0 + 60_000;
    home = mkdtempSync(path.join(os.tmpdir(), 'klaud-claude-team-'));
    const folder = path.join(home, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'));
    agentsDir = path.join(folder, SID, 'subagents');
    mkdirSync(agentsDir, { recursive: true });
    session = path.join(folder, `${SID}.jsonl`);
    writeFileSync(session, '');
    store = new Store(initialState('room'));
    w = new ClaudeCodeWatcher({ home, store, now: () => now, watch: false, publishMs: 0 });
  });
  afterEach(() => {
    w.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('wakes an agent with a message, names whom messages went to, and shows the team with its timeline', () => {
    add(
      session,
      user('Review and fix the auth module', T0),
      assistant([tool('toolu_A', 'Agent', { description: 'Review auth', prompt: 'review', subagent_type: 'code-reviewer', name: 'reviewer', run_in_background: true })], T0 + 1000),
      result('toolu_A', T0 + 1100, 'Async agent launched successfully.\nagentId: a1', { isAsync: true, status: 'async_launched', agentId: 'a1' }),
      assistant([tool('toolu_B', 'Agent', { description: 'Fix auth bugs', prompt: 'fix', name: 'fixer', run_in_background: true })], T0 + 1200),
      result('toolu_B', T0 + 1300, 'Async agent launched successfully.\nagentId: a2', { isAsync: true, status: 'async_launched', agentId: 'a2' }),
    );
    const a1 = agent('a1', { toolUseId: 'toolu_A', description: 'Review auth', agentType: 'code-reviewer', requestShape: 'background' });
    const a2 = agent('a2', { toolUseId: 'toolu_B', description: 'Fix auth bugs', agentType: 'general-purpose', requestShape: 'background' });
    // The reviewer finished its first pass…
    add(a1, user('review', T0 + 2000, { isSidechain: true, agentId: 'a1' }), assistant([{ type: 'text', text: 'Looks fine.' }], T0 + 5000, 'end_turn'));
    add(a2, user('fix', T0 + 2000, { isSidechain: true, agentId: 'a2' }), assistant([tool('r1', 'Read', { file_path: `${CWD}/src/auth.ts` })], T0 + 3000));
    for (const f of [session, a1, a2]) touch(f, T0 + 5000);
    now = T0 + 6000;
    tick();
    expect(sessions()[0]!.agents.find((a) => a.id === 'a1')).toMatchObject({ name: 'reviewer', status: 'finished' });

    // …then the lead sends it a message: it shows in its transcript and the reviewer is working again.
    add(session, assistant([tool('m1', 'SendMessage', { to: 'a1', summary: 'Review the commit diff', message: 'Review the commit diff, not the working tree.' })], T0 + 8000), result('m1', T0 + 8100, 'Message sent'));
    add(a1, user('The coordinator sent a message while you were working:\nReview the commit diff, not the working tree.', T0 + 8200, { isMeta: true, origin: { kind: 'coordinator' }, isSidechain: true }));
    for (const f of [session, a1]) touch(f, T0 + 8200);
    now = T0 + 8500;
    tick();
    expect(sessions()[0]!.agents.find((a) => a.id === 'a1')).toMatchObject({ status: 'running', step: 'Message from the lead session: Review the commit diff, not the working tree.' });
    // The reviewer tells the fixer what it found; the fixer gets it while working.
    add(a1, assistant([tool('m2', 'SendMessage', { to: 'fixer', summary: 'Found 2 bugs in auth.ts', message: 'Line 12 and 40.' })], T0 + 9000));
    add(a2, line({ type: 'attachment', isSidechain: true, attachment: { type: 'queued_command', prompt: '<agent-message from="a1">\nLine 12 and 40.\n</agent-message>' } }, T0 + 9100));
    for (const f of [session, a1, a2]) touch(f, T0 + 9100);
    now = T0 + 10_000;
    tick();

    const s = sessions()[0]!;
    const reviewer = s.agents.find((a) => a.id === 'a1')!;
    expect(reviewer).toMatchObject({ name: 'reviewer', status: 'running' });
    expect(reviewer.step).toBe('→ sent to fixer: Found 2 bugs in auth.ts');
    // The parent's step list says whom it messaged, by name.
    expect(w.steps(SID).steps.find((x) => x.tool === 'SendMessage')?.text).toBe('→ sent to reviewer: Review the commit diff');
    // The agent's transcript shows the message, from the lead session.
    const lead = w.steps(SID, 'a1').steps.find((x) => x.kind === 'message');
    expect(lead).toMatchObject({ from: 'lead', who: 'the lead session', text: 'Review the commit diff, not the working tree.' });
    expect(w.steps(SID, 'a2').steps.find((x) => x.kind === 'message')).toMatchObject({ from: 'a1', who: 'reviewer', text: 'Line 12 and 40.' });
    // A team: both named agents, and the messages between them and the lead.
    expect(s.team?.members.slice().sort()).toEqual(['a1', 'a2']);
    expect(s.team?.messages).toEqual([
      { from: 'lead', to: 'a1', summary: 'Review the commit diff', ts: T0 + 8000 },
      { from: 'a1', to: 'a2', summary: 'Found 2 bugs in auth.ts', ts: T0 + 9000 },
    ]);

    // The fixer hands its report back to the lead session.
    add(session, user(`Another Claude session sent a message:\n<agent-message from="a2">\n${HANDBACK}\n</agent-message>`, T0 + 12_000, { isMeta: true, origin: { kind: 'peer', from: 'a2', name: 'fixer' } }));
    touch(session, T0 + 12_000);
    now = T0 + 13_000;
    tick();
    expect(w.steps(SID).steps.at(-1)).toMatchObject({ kind: 'message', report: true, who: 'fixer', text: 'Fixed both bugs.\nTests pass.' });
  });

  it('shows no team for agents the lead only started', () => {
    add(session, user('go', T0), assistant([tool('toolu_A', 'Agent', { description: 'Explore', prompt: 'look' })], T0 + 1000));
    const a1 = agent('a1', { toolUseId: 'toolu_A', description: 'Explore' });
    add(a1, user('look', T0 + 2000, { isSidechain: true }), assistant([tool('r', 'Read', { file_path: 'x' })], T0 + 3000));
    for (const f of [session, a1]) touch(f, T0 + 3000);
    now = T0 + 4000;
    tick();
    expect(sessions()[0]!.agents).toHaveLength(1);
    expect(sessions()[0]!.team).toBeUndefined();
  });
});
