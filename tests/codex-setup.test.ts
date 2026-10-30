import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_MISSING, CODEX_SIGN_IN, codexStatus } from '../src/agent/runtime/codex/status.js';
import { CodexSessionsWatcher, codexStepWords } from '../src/core/claude-code/codex-watch.js';
import { type CcSession, type ClaudeCodeSlice, outsideSessions, reduceClaudeCode, sessionApp } from '../src/core/claude-code/model.js';
import { Store, initialState } from '../src/core/store.js';
import { runtimeSections } from '../src/ui/runtime-choices.js';
import { FakeCodex } from './fake-codex.js';

describe('is Codex ready here', () => {
  it('not signed in: greyed, with how to sign in', async () => {
    const codex = new FakeCodex();
    codex.signedIn = false;
    expect(await codexStatus({ connect: codex.connect })).toEqual({ state: 'signed_out', fix: CODEX_SIGN_IN, models: [] });
  });

  it('signed in: its models', async () => {
    expect(await codexStatus({ connect: new FakeCodex().connect })).toEqual({ state: 'ready', models: [{ value: '', label: 'GPT-5.5', description: 'Frontier', efforts: ['low', 'high'] }] });
  });

  it("not installed: says how to get it (and doesn't crash when the binary won't start)", async () => {
    expect(await codexStatus({ bin: '/nowhere/codex' })).toEqual({ state: 'missing', fix: CODEX_MISSING, models: [] });
  });

  it('the picker greys it out with why until it is ready, then lists its models', () => {
    const models = [{ value: '', label: 'GPT-5.5', description: 'Frontier' }];
    expect(runtimeSections([{ id: 'codex', label: 'Codex', state: 'signed_out', fix: CODEX_SIGN_IN, models: [] }])).toEqual([{ id: 'codex', label: 'Codex', ready: false, note: `Not signed in · ${CODEX_SIGN_IN}`, models: [] }]);
    expect(runtimeSections([{ id: 'codex', label: 'Codex', state: 'ready', models }])).toEqual([{ id: 'codex', label: 'Codex', ready: true, models }]);
  });

  it('keeps what the daemon found in the shared state', () => {
    const store = new Store(initialState('room'));
    store.dispatch({ type: 'agent_runtimes', runtimes: [{ id: 'codex', label: 'Codex', state: 'missing', models: [] }] });
    expect(store.getState().agentRuntimes).toHaveLength(1);
  });
});

describe('Codex sessions started outside Beluga', () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const rollout = (originator: string, cwd: string, id: string, lines: object[]): void => {
    const now = new Date();
    const dir = path.join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    const ts = now.toISOString();
    const all = [{ timestamp: ts, type: 'session_meta', payload: { id, timestamp: ts, cwd, originator, cli_version: '0.135.0' } }, ...lines];
    writeFileSync(path.join(dir, `rollout-${ts.replace(/[:.]/g, '-')}-${id}.jsonl`), `${all.map((l) => JSON.stringify(l)).join('\n')}\n`);
  };

  it('show in the sessions view with their folder, title, model and step; Beluga’s own runs stay out', () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const store = new Store(initialState('room'));
    rollout('Codex Desktop', '/Users/kay/papers', '019e8d83-aa52-7ad3-9070-029cd4230b2f', [
      { type: 'turn_context', payload: { cwd: '/Users/kay/papers', model: 'gpt-5.5' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Fix the citation export\nplease' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }), call_id: 'c1' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 4200 } } } },
    ]);
    rollout('beluga', '/Users/kay/beluga', '01a18d37-370b-73d0-92b0-3a191485b30e', [{ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }]);
    const watcher = new CodexSessionsWatcher({ home, store, pollMs: 0 });
    watcher.start();
    const sessions = store.getState().claudeCode.sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: '019e8d83-aa52-7ad3-9070-029cd4230b2f', agent: 'codex', title: 'Fix the citation export', cwd: '/Users/kay/papers', model: 'gpt-5.5', step: 'Ran npm test', steps: 1, tokens: 4200, status: 'working', agents: [] });
    expect(sessionApp(sessions[0]!)).toBe('Codex');
    expect(outsideSessions(sessions)).toHaveLength(1);
    watcher.stop();
  });

  it("titles a Codex app session by what you typed first (not the instructions it sends)", () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const store = new Store(initialState('room'));
    rollout('Codex Desktop', '/w', '019e8d83-aa52-7ad3-9070-029cd4230b2f', [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /w' }, { type: 'input_text', text: '<environment_context>…' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Why is this upload stuck?' }] } },
    ]);
    new CodexSessionsWatcher({ home, store, pollMs: 0 }).scan();
    expect(store.getState().claudeCode.sessions[0]?.title).toBe('Why is this upload stuck?');
  });

  it('read only what was added, and say when the turn is done', () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const store = new Store(initialState('room'));
    const id = '019e8d83-aa52-7ad3-9070-029cd4230b2f';
    rollout('codex_cli_rs', '/w', id, [{ type: 'event_msg', payload: { type: 'task_started' } }]);
    const watcher = new CodexSessionsWatcher({ home, store, pollMs: 0 });
    watcher.scan();
    expect(store.getState().claudeCode.sessions[0]?.status).toBe('working');
    rollout('codex_cli_rs', '/w', id, [{ type: 'event_msg', payload: { type: 'task_started' } }, { type: 'event_msg', payload: { type: 'task_complete' } }]);
    watcher.scan();
    expect(store.getState().claudeCode.sessions[0]?.status).toBe('waiting');
  });

  it('Claude Code’s and Codex’s lists are kept side by side', () => {
    const cc = (id: string, agent?: string): CcSession => ({ id, title: id, cwd: '/', status: 'idle', lastAt: 1, steps: 0, agents: [], ...(agent ? { agent } : {}) });
    let state: ClaudeCodeSlice = { claudeCode: { sessions: [], origins: [] } };
    state = reduceClaudeCode(state, { type: 'claude_code', sessions: [cc('claude-1')] });
    state = reduceClaudeCode(state, { type: 'codex_sessions', sessions: [cc('codex-1', 'codex')] });
    state = reduceClaudeCode(state, { type: 'claude_code', sessions: [cc('claude-2')] });
    expect(state.claudeCode.sessions.map((s) => s.id).sort()).toEqual(['claude-2', 'codex-1']);
  });

  it('says what a step did in words', () => {
    expect(codexStepWords('exec_command', JSON.stringify({ cmd: 'git status\nmore' }))).toBe('Ran git status');
    expect(codexStepWords('apply_patch', undefined)).toBe('Edited files');
    expect(codexStepWords('view_image', '{}')).toBe('Used view_image');
  });
});
