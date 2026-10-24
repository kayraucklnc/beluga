import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { CONTINUE_PROMPT } from '../src/core/workspace-controller.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { TerminalManager } from '../src/terminal/index.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { attach, waitFor } from './helpers.js';

/**
 * "Never change main": a chat in a project's main folder is questions only, and asking for a
 * change there turns that same chat into a new worktree, where Claude goes on.
 */

const keys = deriveKeys(generateSecret());
let hub: Hub;
let base: string;
let terminals: TerminalManager;
const sessions: Session[] = [];
const home = process.env.BELUGA_HOME;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-move-')));
  process.env.BELUGA_HOME = path.join(base, 'klaud-home');
  terminals = new TerminalManager();
  hub = await startHub({ keys });
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  terminals.closeAll();
  await hub?.close();
  process.env.BELUGA_HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
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

async function solo(dir: string, script: (input: AgentRunInput) => Promise<string>) {
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, reconnect: false });
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [], projects: [dir], hidden: [] });
  const workspaces = new WorkspaceManager(wsStore);
  await workspaces.refresh();
  const runs: AgentRunInput[] = [];
  const session = new Session({
    client,
    store,
    shares: new ShareService([]),
    agentCwd: base,
    workspaces,
    terminals,
    hasGh: async () => false,
    findPr: async () => undefined,
    open: () => undefined,
    desktopNotify: () => undefined,
    zoom: async () => ({ ok: true, message: '' }),
    copy: async () => undefined,
    saveSettings: () => undefined,
    createAgent: (): AgentBackend => ({
      nameTask: async () => 'blue-button',
      run: async (input) => {
        runs.push(input);
        return script(input);
      },
    }),
  });
  const screen = attach(session);
  session.start();
  sessions.push(session);
  await waitFor(() => store.getState().self, 4000);
  return { session, state: store.getState, screen: screen.store, runs, workspaces };
}

const projectOf = (w: WorkspaceManager) => w.list.find((p) => p.root)!;
const said = (state: () => ReturnType<Store['getState']>, channel: string): string[] => state().log.filter((l) => l.channel === channel).map((l) => ('text' in l ? l.text : ''));

describe('a chat in the main folder', () => {
  it('is read-only, and a change request makes the same chat a worktree, with its session, without asking', { timeout: 20_000 }, async () => {
    const dir = repo();
    const kay = await solo(dir, async (input) => {
      // Like real Claude: remember the conversation, and move when asked for a change.
      input.place?.onSession('session-1');
      if (input.place?.askOnly && /blue/.test(input.prompt)) {
        await input.continueInWorktree!('Make the button blue');
        return 'Moving to a new worktree.';
      }
      return 'Answered.';
    });
    // Claude Code files the conversation under the folder it ran in.
    const claudeDir = path.join(base, 'claude');
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const filed = (d: string) => path.join(claudeDir, 'projects', d.replace(/[^a-zA-Z0-9]/g, '-'), 'session-1.jsonl');
    mkdirSync(path.dirname(filed(dir)), { recursive: true });
    writeFileSync(filed(dir), '{}\n');
    const project = projectOf(kay.workspaces);
    await kay.session.workspaces!.startChat(project.id, 'How does the button work?');
    await waitFor(() => kay.runs.length === 1, 4000);
    const chat = kay.workspaces.list.flatMap((p) => p.workspaces).find((w) => w.kind === 'chat')!;
    const first = kay.runs[0]!;
    expect(first.place).toMatchObject({ cwd: dir, autoEdit: false, askOnly: { project: 'app' } });
    expect(first.continueInWorktree).toBeTypeOf('function');
    await waitFor(() => said(kay.state, `ws:${chat.id}`).includes('Answered.'), 4000);

    kay.session.askOwnClaude('Please make the button blue', `ws:${chat.id}`);
    await waitFor(() => kay.runs.length === 3, 8000);
    // The same chat, now a worktree: no second conversation.
    const all = kay.workspaces.list.flatMap((p) => p.workspaces);
    const worktree = all.find((w) => w.id === chat.id)!;
    expect(worktree).toMatchObject({ kind: 'worktree', name: 'blue-button', base: 'origin/main', sessionId: 'session-1' });
    expect(worktree.path).not.toBe(dir);
    expect(worktree.askOnly).toBeFalsy();
    expect(all.filter((w) => w.kind === 'chat')).toEqual([]);
    const moved = kay.runs[2]!;
    // In the worktree: may edit, starts on the task, and resumes the very same session there.
    expect(moved.prompt).toBe('Make the button blue');
    expect(moved.place).toMatchObject({ cwd: worktree.path, autoEdit: true, resume: 'session-1', forkSession: false });
    expect(moved.place?.askOnly).toBeUndefined();
    expect(moved.continueInWorktree).toBeUndefined();
    expect(existsSync(filed(realpathSync(worktree.path)))).toBe(true);
    // Your own request: no approval card.
    expect(kay.state().approvals).toEqual([]);
    expect(kay.state().questions).toEqual([]);
    // One conversation, start to end, and your screen stayed on it.
    const there = said(kay.state, `ws:${chat.id}`);
    expect(there).toContain('How does the button work?');
    expect(there).toContain('Please make the button blue');
    expect(there).toContain('Moving to a new worktree.');
    expect(there.some((t) => t.startsWith('This chat is now the worktree blue-button'))).toBe(true);
    expect(kay.screen.getState().view).toMatchObject({ kind: 'workspace', id: chat.id });
  });

  it('continues in a worktree from the button, with what you asked last when no task is given', { timeout: 20_000 }, async () => {
    const dir = repo();
    const kay = await solo(dir, async () => 'Answered.');
    const project = projectOf(kay.workspaces);
    await kay.session.workspaces!.startChat(project.id, 'Where is the login code?');
    await waitFor(() => kay.runs.length === 1, 4000);
    const chat = kay.workspaces.list.flatMap((p) => p.workspaces).find((w) => w.kind === 'chat')!;
    const id = await kay.session.workspaces!.continueInWorktree(chat.id, async (p) => `named-${p.split(' ')[0]!.toLowerCase()}`, {});
    expect(id?.name).toBe('named-where');
    await waitFor(() => kay.runs.length === 2, 4000);
    expect(kay.runs[1]!.prompt).toBe(CONTINUE_PROMPT);
    expect(kay.runs[1]!.place?.cwd).toBe(id!.path);
  });

  it('shows the task once when it is word-for-word what you asked last', { timeout: 20_000 }, async () => {
    const dir = repo();
    const kay = await solo(dir, async () => 'Answered.');
    const project = projectOf(kay.workspaces);
    await kay.session.workspaces!.startChat(project.id, 'Make the  login button blue');
    await waitFor(() => kay.runs.length === 1, 4000);
    const chat = kay.workspaces.list.flatMap((p) => p.workspaces).find((w) => w.kind === 'chat')!;
    await waitFor(() => said(kay.state, `ws:${chat.id}`).includes('Answered.'), 4000);
    // The sheet starts with what you asked last (trimmed): the task is the same message.
    const ws = await kay.session.workspaces!.continueInWorktree(chat.id, async () => 'blue-login', { task: 'Make the login button blue' });
    await waitFor(() => kay.runs.length === 2, 4000);
    // Claude still starts on it, there…
    expect(kay.runs[1]!.prompt).toBe('Make the login button blue');
    expect(kay.runs[1]!.place?.cwd).toBe(ws!.path);
    await waitFor(() => said(kay.state, `ws:${ws!.id}`).filter((t) => t === 'Answered.').length === 2, 4000);
    // …but the conversation shows your message once (the one carried over).
    const mine = kay.state().log.filter((l) => l.channel === `ws:${ws!.id}` && l.type === 'chat' && l.from === kay.state().self?.peerId);
    expect(mine.map((l) => ('text' in l ? l.text : ''))).toEqual(['Make the  login button blue']);
  });

  it('still shows a different task as your message', { timeout: 20_000 }, async () => {
    const dir = repo();
    const kay = await solo(dir, async () => 'Answered.');
    const project = projectOf(kay.workspaces);
    await kay.session.workspaces!.startChat(project.id, 'How does login work?');
    await waitFor(() => kay.runs.length === 1, 4000);
    const chat = kay.workspaces.list.flatMap((p) => p.workspaces).find((w) => w.kind === 'chat')!;
    await waitFor(() => said(kay.state, `ws:${chat.id}`).includes('Answered.'), 4000);
    const ws = await kay.session.workspaces!.continueInWorktree(chat.id, async () => 'login-fix', { task: 'Fix the login bug' });
    await waitFor(() => kay.runs.length === 2, 4000);
    const mine = () => kay.state().log.filter((l) => l.channel === `ws:${ws!.id}` && l.type === 'chat' && l.from === kay.state().self?.peerId).map((l) => ('text' in l ? l.text : ''));
    await waitFor(() => mine().includes('Fix the login bug'), 4000);
    expect(mine()).toEqual(['How does login work?', 'Fix the login bug']);
  });
});
