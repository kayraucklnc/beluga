import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexRuntime } from '../src/agent/runtime/codex/index.js';
import { ScriptedCodex } from '../src/agent/runtime/codex/scripted.js';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { TerminalManager } from '../src/terminal/index.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { waitFor } from './helpers.js';

/**
 * The Mac e2e's Codex flow (BLG-462), one level down: a Session the way the demo daemon makes it
 * (its own agent, with Codex beside it over the scripted app-server, `alsoRuntimes`). Start a
 * worktree on Codex, run a task, approve a command, stop mid-turn, hand off to Claude.
 */
const keys = deriveKeys(generateSecret());
let hub: Hub;
let base: string;
const sessions: Session[] = [];
const home = process.env.BELUGA_HOME;
const terminals = new TerminalManager();

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-codex-flow-')));
  process.env.BELUGA_HOME = path.join(base, 'beluga-home');
  hub = await startHub({ keys });
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  terminals.closeAll();
  await hub?.close();
  process.env.BELUGA_HOME = home;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

function repo(): string {
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  const dir = path.join(base, 'code', 'app');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  return dir;
}

describe('a worktree on Codex, end to end', () => {
  it('runs a task, asks before a command, stops mid-turn, and hands off to Claude', async () => {
    const dir = repo();
    const store = new Store(initialState('test', 'ask'));
    const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, reconnect: false });
    const wsStore = new WorkspaceStore(path.join(base, 'home'));
    wsStore.saveConfig({ roots: [], projects: [dir], hidden: [] });
    const workspaces = new WorkspaceManager(wsStore);
    await workspaces.refresh();
    const claudeRuns: AgentRunInput[] = [];
    const codex = new ScriptedCodex();
    const session = new Session({
      client,
      store,
      shares: new ShareService([]),
      agentCwd: base,
      workspaces,
      terminals,
      hasGh: async () => false,
      findPr: async () => undefined,
      saveSettings: () => undefined,
      copy: async () => undefined,
      createAgent: (): AgentBackend => ({
        run: async (input) => {
          claudeRuns.push(input);
          // Claude's own conversation from here on (what a real run reports).
          input.place?.onSession('claude-session');
          return 'claude: on it';
        },
      }),
      alsoRuntimes: [createCodexRuntime({ connect: codex.connect })],
    });
    session.start();
    sessions.push(session);
    await waitFor(() => store.getState().self, 4000);

    // Codex shows in the picker as ready here, with its models.
    await waitFor(() => store.getState().runtimes.find((r) => r.id === 'codex')?.models?.length, 4000).catch(() => undefined);
    expect(store.getState().runtimes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'codex', available: true, models: [expect.objectContaining({ label: 'GPT-5.5' })] })]));

    // 1. A worktree on Codex runs a task.
    const project = workspaces.list.find((p) => p.root)!;
    const ws = (await session.workspaces!.newWorktree(project.id, 'on-codex', { quiet: true, agent: { runtime: 'codex', label: 'Codex' } }))!;
    const channel = `ws:${ws.id}`;
    const said = (text: string) => store.getState().log.some((l) => l.channel === channel && l.type === 'agent' && l.text.includes(text));
    session.submit('say hello', { channel });
    await waitFor(() => said('echo: say hello'), 8000);
    expect(claudeRuns).toHaveLength(0);
    expect(codex.sent('thread/start')).toHaveLength(1);

    // 2. A command that leaves its sandbox asks you; Allow runs it.
    session.setPrefs({ selfApproval: 'ask' });
    session.submit('ask to run the tests', { channel });
    await waitFor(() => store.getState().approvals.length === 1, 8000);
    expect(store.getState().approvals[0]).toMatchObject({ detail: expect.stringContaining('echo ask to run the tests') });
    session.answerApproval('yes', store.getState().approvals[0]!.id);
    await waitFor(() => said('echo: ask to run the tests'), 8000);
    expect(codex.approvals.at(-1)).toEqual({ decision: 'accept' });
    // The same thread all along.
    expect(codex.sent('thread/resume').at(-1)?.threadId).toBe(workspaces.find(ws.id)?.sessionId);
    expect(codex.sent('thread/start')).toHaveLength(1);

    // 3. Stop mid-turn: the turn is interrupted, the conversation is free again.
    session.submit('wait for the build', { channel });
    await waitFor(() => codex.sent('turn/start').length === 3, 8000);
    await new Promise((r) => setTimeout(r, 100));
    session.host.stopRun(channel);
    await waitFor(() => codex.sent('turn/interrupt').length === 1, 8000);

    // 4. Hand off to Claude: Codex writes its note, Claude starts seeded with it, and the next message is Claude's.
    // Two Claude runs come close together (the seeded one, then yours): each is waited for by what it says,
    // never by a count a busy machine can step over.
    expect(session.workbench!.setAgent(channel, undefined)).toBe(true);
    await waitFor(() => !workspaces.find(ws.id)?.agent, 8000);
    await waitFor(() => claudeRuns.some((r) => r.prompt.includes('taking over this conversation from Codex')), 8000);
    session.submit('carry on', { channel });
    await waitFor(() => claudeRuns.some((r) => r.prompt === 'carry on'), 8000);
    expect(claudeRuns.find((r) => r.prompt === 'carry on')!.place?.agent?.runtime).toBe('claude');
    await waitFor(() => store.getState().log.filter((l) => l.channel === channel && l.type === 'agent' && l.text === 'claude: on it').length === 2, 8000);

    // 5. Back to Codex quietly (BLG-592): nothing runs now; your next message takes the recent conversation along, once.
    const turns = codex.sent('turn/start').length;
    const asked = claudeRuns.length;
    expect(session.workbench!.setAgent(channel, { runtime: 'codex', label: 'Codex' }, 'quiet')).toBe(true);
    await waitFor(() => workspaces.find(ws.id)?.carryFrom === 'Claude', 8000);
    expect(codex.sent('turn/start')).toHaveLength(turns);
    expect(claudeRuns).toHaveLength(asked);
    session.submit('and the docs', { channel });
    await waitFor(() => codex.sent('turn/start').length === turns + 1, 8000);
    const carried = JSON.stringify(codex.sent('turn/start').at(-1));
    expect(carried).toContain('and the docs');
    expect(carried).toContain('took over this conversation from Claude');
    expect(carried).toContain('carry on');
    expect(workspaces.find(ws.id)?.carryFrom).toBeUndefined();
    // The chat shows only what you wrote.
    expect(store.getState().log.some((l) => l.channel === channel && l.type === 'chat' && l.text === 'and the docs')).toBe(true);
    await waitFor(() => said('echo: and the docs'), 8000);
    session.submit('one more', { channel });
    await waitFor(() => codex.sent('turn/start').length === turns + 2, 8000);
    expect(JSON.stringify(codex.sent('turn/start').at(-1))).not.toContain('took over this conversation');
  }, 30_000);
});
