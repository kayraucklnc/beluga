import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_SIGN_IN, claudeStatus, readAuthStatus, signedInWithoutBinary } from '../src/agent/runtime/claude/status.js';
import { runtimeStatuses } from '../src/agent/runtime/registry.js';
import { CODEX_MISSING, CODEX_SIGN_IN } from '../src/agent/runtime/codex/status.js';
import type { RuntimeStatus } from '../src/agent/runtime/types.js';
import { Store, initialState } from '../src/core/store.js';
import { Workbench, withRuntimeStatus } from '../src/core/workbench.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { type RuntimeChoice, runtimeChoices } from '../src/shared/agent-runtimes.js';
import { agentRows, pickDefault } from '../packages/mac/src/onboarding/agent-setup.js';
import { STEPS, groupOf, inTour, stepBy } from '../packages/mac/src/onboarding/onboarding-model.js';

/** Your agents, found (BLG-507): Claude Code's sign-in, every runtime's state kept and merged, and onboarding's rows. */

describe('is Claude Code signed in here', () => {
  // What Claude Code 2.1.301's `claude auth status --json` prints (exit 0 signed in, 1 not).
  const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
  const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });

  it('reads `claude auth status --json`', () => {
    expect(readAuthStatus(SIGNED_IN)).toBe(true);
    expect(readAuthStatus(SIGNED_OUT)).toBe(false);
    expect(readAuthStatus('error: unknown command auth')).toBeUndefined();
    expect(readAuthStatus('{}')).toBeUndefined();
  });

  it('asks the binary: ready, or not signed in with how to sign in', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: SIGNED_IN }));
    expect(await claudeStatus({ bin: '/bin/claude', run })).toEqual({ state: 'ready', models: [] });
    expect(run).toHaveBeenCalledWith('/bin/claude', ['auth', 'status', '--json']);
    expect(await claudeStatus({ bin: '/bin/claude', run: async () => ({ code: 1, stdout: SIGNED_OUT }) })).toEqual({ state: 'signed_out', fix: CLAUDE_SIGN_IN, models: [] });
  });

  it('without an answer from the binary (an older one, or not downloaded yet), looks for what a sign-in leaves', async () => {
    const signedIn = vi.fn(async () => true);
    expect(await claudeStatus({ bin: '/bin/claude', run: async () => ({ code: 1, stdout: 'unknown command' }), signedIn })).toEqual({ state: 'ready', models: [] });
    expect(await claudeStatus({ bin: null, signedIn: async () => false })).toEqual({ state: 'signed_out', fix: CLAUDE_SIGN_IN, models: [] });
  });

  describe('the signs a sign-in leaves', () => {
    let home: string;
    afterEach(() => rmSync(home, { recursive: true, force: true }));
    const none = async (): Promise<boolean> => false;

    it('an API key, a credentials file or the keychain item; else none', async () => {
      home = mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
      expect(await signedInWithoutBinary({ env: {}, home, keychain: none })).toBe(false);
      expect(await signedInWithoutBinary({ env: { ANTHROPIC_API_KEY: 'sk-x' }, home, keychain: none })).toBe(true);
      expect(await signedInWithoutBinary({ env: {}, home, keychain: async () => true })).toBe(true);
      expect(await signedInWithoutBinary({ env: {}, home, keychain: async () => Promise.reject(new Error('no security')) })).toBe(false);
      mkdirSync(path.join(home, '.claude'));
      writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
      expect(await signedInWithoutBinary({ env: {}, home, keychain: none })).toBe(true);
    });
  });

  it('every runtime is asked at once, Claude first; one that fails is left out', async () => {
    const codex = { id: 'codex', label: 'Codex', state: 'missing' as const, fix: CODEX_MISSING, models: [] };
    expect(await runtimeStatuses({ claude: async () => ({ state: 'ready', models: [] }), others: async () => [codex] })).toEqual([{ id: 'claude', state: 'ready', models: [] }, codex]);
    expect(await runtimeStatuses({ claude: async () => Promise.reject(new Error('boom')), others: async () => [codex] })).toEqual([codex]);
  });
});

describe('the runtimes as the pickers have them', () => {
  const listed = (local = false): RuntimeChoice[] => runtimeChoices((id) => (id === 'claude' || id === 'codex' ? {} : id === 'local' && local ? { models: [{ value: 'ollama/qwen3', label: 'qwen3', description: '' }] } : undefined));
  const codexModels = [{ value: 'gpt-5.5', label: 'GPT-5.5', description: 'Frontier' }];

  it("Claude's status never wipes its models (they come from Claude Code); not signed in greys it", () => {
    const withModels: RuntimeChoice[] = listed().map((r) => (r.id === 'claude' ? { ...r, models: [{ value: 'opus', label: 'Opus', description: '' }] } : r));
    expect(withRuntimeStatus(withModels, [{ id: 'claude', state: 'ready', models: [] }]).find((r) => r.id === 'claude')).toMatchObject({ available: true, state: 'ready', models: [{ value: 'opus' }] });
    expect(withRuntimeStatus(withModels, [{ id: 'claude', state: 'signed_out', fix: CLAUDE_SIGN_IN, models: [] }]).find((r) => r.id === 'claude')).toMatchObject({ available: false, state: 'signed_out', fix: CLAUDE_SIGN_IN });
  });

  it('a local model with no endpoint says so', () => {
    expect(listed().find((r) => r.id === 'local')).toMatchObject({ available: false, state: 'no_endpoint' });
  });

  const bench = (found: Array<{ id: string } & RuntimeStatus>, local: { on: boolean }) => {
    const store = new Store(initialState('t', 'ask'));
    const status = vi.fn(async () => found);
    const wb = new Workbench({
      store,
      controller: { manager: { list: [], find: () => undefined }, refresh: async () => undefined, open: () => undefined } as unknown as WorkspaceController,
      notify: () => undefined,
      toast: () => undefined,
      intend: () => undefined,
      askClaude: () => undefined,
      setPrefs: () => undefined,
      listRuntimes: () => listed(local.on),
      runtimeStatus: status,
    });
    return { wb, store, status };
  };

  it("a local endpoint answering lists the runtimes again without wiping Codex's sign-in state and models (BLG-507)", async () => {
    const local = { on: false };
    const { wb, store } = bench([{ id: 'codex', state: 'ready', models: codexModels }], local);
    await wb.checkAgents();
    expect(store.getState().runtimes.find((r) => r.id === 'codex')).toMatchObject({ available: true, state: 'ready', models: codexModels });
    local.on = true;
    wb.runtimesChanged();
    const after = store.getState().runtimes;
    expect(after.find((r) => r.id === 'codex')).toMatchObject({ available: true, state: 'ready', models: codexModels });
    expect(after.find((r) => r.id === 'local')).toMatchObject({ available: true, models: [{ value: 'ollama/qwen3' }] });
    wb.stop();
  });

  it('Check Again asks now and answers with the runtimes; one that stops answering keeps its last word', async () => {
    const found: Array<{ id: string } & RuntimeStatus> = [{ id: 'claude', state: 'signed_out', fix: CLAUDE_SIGN_IN, models: [] }, { id: 'codex', state: 'signed_out', fix: CODEX_SIGN_IN, models: [] }];
    const { wb, status } = bench(found, { on: false });
    expect((await wb.checkAgents()).find((r) => r.id === 'claude')).toMatchObject({ available: false, state: 'signed_out' });
    found.splice(0, 2, { id: 'codex', state: 'ready', models: codexModels });
    const again = await wb.checkAgents();
    expect(status).toHaveBeenCalledTimes(2);
    expect(again.find((r) => r.id === 'codex')).toMatchObject({ available: true, state: 'ready' });
    expect(again.find((r) => r.id === 'claude')).toMatchObject({ available: false, state: 'signed_out' });
    wb.stop();
  });

  it('Sign In opens a command Terminal runs: the runtime’s own sign-in', async () => {
    const store = new Store(initialState('t', 'ask'));
    const opened: string[] = [];
    const wb = new Workbench({
      store,
      controller: { manager: { list: [], find: () => undefined }, refresh: async () => undefined, open: () => undefined } as unknown as WorkspaceController,
      notify: () => undefined,
      toast: () => undefined,
      intend: () => undefined,
      askClaude: () => undefined,
      setPrefs: () => undefined,
      open: (f) => void opened.push(f),
      signInCommand: async (id) => (id === 'claude' ? ['/Users/me/.beluga/claude-code/2.1/claude', 'auth', 'login'] : undefined),
    });
    expect(await wb.agentSignIn('claude')).toBe(true);
    expect(opened[0]).toMatch(/beluga-sign-in-claude\.command$/);
    expect(readFileSync(opened[0]!, 'utf8')).toContain('/Users/me/.beluga/claude-code/2.1/claude auth login');
    expect(await wb.agentSignIn('local')).toBe(false);
    wb.stop();
  });
});

describe("onboarding's Your agents step", () => {
  it('comes right after the welcome, before the tour, in a group of its own', () => {
    expect(STEPS.slice(0, 3)).toEqual(['hello', 'yourAgents', 'parallel']);
    expect(stepBy('hello', 1)).toBe('yourAgents');
    expect(inTour('yourAgents')).toBe(false);
    expect(groupOf('yourAgents')).toBe('other');
  });

  const choices = (over: Partial<Record<string, Partial<RuntimeChoice>>> = {}): RuntimeChoice[] =>
    [
      { id: 'claude', label: 'Claude', available: true },
      { id: 'codex', label: 'Codex', available: true },
      { id: 'local', label: 'Local model', available: false, state: 'no_endpoint' as const },
    ].map((r) => ({ ...r, ...over[r.id] }));

  it('says each one’s state in words with its one fix', () => {
    const rows = agentRows(choices({ claude: { available: false, state: 'signed_out' }, codex: { available: false, state: 'missing' } }), true);
    expect(rows.map((r) => [r.id, r.words, r.fix])).toEqual([
      ['claude', 'Not signed in', 'sign_in'],
      ['codex', 'Not installed', 'install'],
      ['local', 'No endpoint', 'set_up'],
    ]);
    expect(agentRows(choices(), true).map((r) => r.words)).toEqual(['Ready', 'Ready', 'No endpoint']);
  });

  it('one not asked yet is still being looked for', () => {
    expect(agentRows(choices({ codex: { available: false } }), false).find((r) => r.id === 'codex')).toMatchObject({ state: undefined, words: 'Checking…' });
    expect(agentRows(choices({ codex: { available: false } }), true).find((r) => r.id === 'codex')).toMatchObject({ state: 'missing', fix: 'install' });
  });

  it('keeps yours when it’s ready, else picks the first ready one; with none ready, picks none', () => {
    expect(pickDefault(agentRows(choices(), true), 'codex')).toBe('codex');
    expect(pickDefault(agentRows(choices({ claude: { available: false, state: 'signed_out' } }), true), 'claude')).toBe('codex');
    expect(pickDefault(agentRows(choices({ claude: { available: false, state: 'signed_out' }, codex: { available: false, state: 'missing' } }), true), 'claude')).toBeUndefined();
  });
});
