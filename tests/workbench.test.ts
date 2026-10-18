import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import type { PullRequest } from '../src/core/work-store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { TerminalManager } from '../src/terminal/index.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { runId, setupId } from '../src/core/workbench.js';
import { attach, waitFor } from './helpers.js';

const keys = deriveKeys(generateSecret());
let hub: Hub;
let base: string;
let terminals: TerminalManager;
const sessions: Session[] = [];
const home = process.env.KLAUD_HOME;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-bench-')));
  process.env.KLAUD_HOME = path.join(base, 'klaud-home');
  terminals = new TerminalManager();
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  terminals.closeAll();
  await hub?.close();
  process.env.KLAUD_HOME = home;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

function repo(files: Record<string, string> = {}): string {
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  const dir = path.join(base, 'code', 'app');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  return dir;
}

async function solo(dir: string, opts: { findPr?: (d: string, b: string) => Promise<PullRequest | undefined>; script?: (i: AgentRunInput) => Promise<string> } = {}) {
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, reconnect: false });
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [], projects: [dir], hidden: [] });
  const workspaces = new WorkspaceManager(wsStore);
  await workspaces.refresh();
  const runs: AgentRunInput[] = [];
  const desktop: string[] = [];
  const opened: string[] = [];
  const session = new Session({
    client,
    store,
    shares: new ShareService([]),
    agentCwd: base,
    workspaces,
    terminals,
    hasGh: async () => true,
    findPr: opts.findPr ?? (async () => undefined),
    open: (t) => void opened.push(t),
    desktopNotify: (n) => void desktop.push(n.title),
    zoom: async () => ({ ok: true, message: '' }),
    copy: async () => undefined,
    saveSettings: () => undefined,
    createAgent: (): AgentBackend => ({
      run: async (input) => {
        runs.push(input);
        input.onEvent('usage', JSON.stringify({ input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300, cost: 0.05, session: 's1' }));
        return opts.script ? opts.script(input) : 'done';
      },
    }),
  });
  const screen = attach(session);
  session.start();
  sessions.push(session);
  await waitFor(() => store.getState().self, 4000);
  return { session, state: store.getState, screen: screen.store, runs, workspaces, desktop, opened, bench: session.workbench! };
}

const projectOf = (w: WorkspaceManager) => w.list.find((p) => p.root)!;

describe('setup and run scripts', () => {
  it('runs the setup command in every new worktree, in its terminal, and reports the result', async () => {
    hub = await startHub({ keys });
    const dir = repo({ 'klaud.json': JSON.stringify({ scripts: { setup: 'echo installing && touch .ready', run: 'echo serving; sleep 30' } }) });
    const kay = await solo(dir);
    expect(projectOf(kay.workspaces).scripts?.setup).toEqual({ command: 'echo installing && touch .ready', source: 'klaud.json' });
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'feature');
    // It comes from the repository, so the first time it asks; "always" remembers this command.
    await waitFor(() => kay.state().approvals.length === 1, 4000);
    expect(kay.state().approvals[0]?.title).toBe("app's klaud.json wants to run its setup in new worktrees");
    kay.session.answerApproval('always');
    await waitFor(() => kay.state().setup[ws!.id]?.status === 'done', 8000);
    const next = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'second');
    await waitFor(() => kay.state().setup[next!.id]?.status === 'done', 8000);
    expect(kay.state().approvals).toHaveLength(0);
    const setup = terminals.get(setupId(ws!.id))!;
    expect(setup.backlog()).toContain('installing');

    const run = kay.bench.run(ws!.id)!;
    await waitFor(() => run.backlog().includes('serving'), 8000);
    expect(kay.bench.run(ws!.id)).toBe(run); // already running: the same session
    kay.bench.stopRun(ws!.id);
    await waitFor(() => !terminals.get(runId(ws!.id))?.running, 4000);
  });

  it('tells you when setup fails, and can be turned off', async () => {
    hub = await startHub({ keys });
    const dir = repo({ 'klaud.json': JSON.stringify({ scripts: { setup: 'exit 3' } }) });
    const kay = await solo(dir);
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'broken');
    await waitFor(() => kay.state().approvals.length === 1, 4000);
    kay.session.answerApproval('yes');
    await waitFor(() => kay.state().setup[ws!.id]?.status === 'failed', 8000);
    expect(kay.state().setup[ws!.id]?.detail).toBe('exit code 3');
    // You're looking at it, so it's a toast; from elsewhere it goes to the inbox (and the desktop).
    expect(kay.screen.getState().toast?.text).toContain('Setup failed in broken');
    kay.screen.dispatch({ type: 'view', view: { kind: 'overview' } });
    kay.bench.runSetup(ws!.id); // you asked for it: no question
    await waitFor(() => kay.state().inbox.some((n) => n.title === 'Setup failed in broken'), 8000);
    await waitFor(() => kay.desktop.includes('Setup failed in broken'), 4000);
    kay.session.setPrefs({ autoSetup: false });
    const quiet = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'quiet');
    expect(kay.state().setup[quiet!.id]).toBeUndefined();
  });

  it('lets you set the commands for yourself or for the team (klaud.json)', async () => {
    hub = await startHub({ keys });
    const dir = repo({ 'package-lock.json': '{}', 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) });
    const kay = await solo(dir);
    const id = projectOf(kay.workspaces).id;
    expect(projectOf(kay.workspaces).scripts).toMatchObject({ setup: { command: 'npm install', source: 'detected' }, run: { command: 'npm run dev', source: 'detected' } });
    kay.bench.setScript(id, 'setup', 'npm ci');
    await waitFor(() => projectOf(kay.workspaces).scripts?.setup?.source === 'yours', 4000);
    kay.bench.shareScripts(id);
    await waitFor(() => projectOf(kay.workspaces).scripts?.setup?.command === 'npm ci', 4000);
    expect(JSON.parse(execFileSync('cat', [path.join(dir, 'klaud.json')]).toString())).toEqual({ scripts: { setup: 'npm ci', run: 'npm run dev' } });
  });
});

describe('pull requests', () => {
  it('asks Claude with your PR instructions, then follows the PR and its checks', async () => {
    hub = await startHub({ keys });
    const dir = repo();
    let pr: PullRequest | undefined;
    const kay = await solo(dir, { findPr: async () => pr });
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'auth');
    kay.bench.createPr(ws!.id, 'mention the migration');
    await waitFor(() => kay.runs.length === 1, 4000);
    expect(kay.runs[0]?.prompt).toContain('gh pr create --base main --head klaud/auth');
    expect(kay.runs[0]?.prompt).toContain('For this pull request, also: mention the migration');
    expect(kay.runs[0]?.prompt).toContain('## Why');

    kay.screen.dispatch({ type: 'view', view: { kind: 'overview' } });
    pr = { number: 7, url: 'https://github.com/x/app/pull/7', state: 'OPEN', title: 'Add auth', draft: false, checks: 'pending' };
    await kay.bench.refreshPrs(ws!.id);
    expect(kay.state().prs[ws!.id]?.number).toBe(7);
    await waitFor(() => kay.state().inbox.some((n) => n.title === 'Pull request #7 is open for auth'), 4000);
    pr = { ...pr, checks: 'failing' };
    await kay.bench.refreshPrs(ws!.id);
    await waitFor(() => kay.state().inbox.some((n) => n.title === 'Checks failing on PR #7'), 4000);
    kay.bench.fixChecks(ws!.id);
    await waitFor(() => kay.runs.length === 2, 4000);
    expect(kay.runs[1]?.prompt).toContain('gh run view --log-failed');
    kay.bench.openPr(ws!.id);
    expect(kay.opened).toEqual(['https://github.com/x/app/pull/7']);
  });

  it("stays quiet about PRs you didn't ask for, and ignores worktrees other tools made", async () => {
    hub = await startHub({ keys });
    const dir = repo();
    const asked: string[] = [];
    const kay = await solo(dir, { findPr: async (d) => (asked.push(d), { number: 9, url: 'u', state: 'OPEN', title: 'T', draft: false, checks: 'pending' }) });
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'quiet');
    kay.screen.dispatch({ type: 'view', view: { kind: 'overview' } });
    await kay.bench.refreshPrs(ws!.id);
    await kay.bench.refreshPrs(ws!.id);
    expect(kay.state().prs[ws!.id]?.number).toBe(9);
    expect(kay.state().inbox.filter((n) => n.kind === 'pr')).toEqual([]);

    execFileSync('git', ['worktree', 'add', '-q', '-b', 'agent-x', path.join(dir, '.claude', 'worktrees', 'agent-x')], { cwd: dir });
    await kay.session.workspaces!.refresh();
    const agent = projectOf(kay.workspaces).workspaces.find((w) => w.name === 'agent-x');
    expect(agent).toBeDefined();
    asked.length = 0;
    await kay.bench.refreshPrs(agent!.id);
    expect(asked).toEqual([]);
  });

  it('only offers PRs for worktrees, and explains a missing GitHub CLI', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const main = projectOf(kay.workspaces).workspaces.find((w) => w.kind === 'main')!;
    kay.bench.createPr(main.id);
    expect(kay.screen.getState().toast?.text).toContain('Pull requests are for worktrees');
    kay.session.store.dispatch({ type: 'gh', ok: false });
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'x');
    kay.bench.createPr(ws!.id);
    expect(kay.screen.getState().toast?.text).toContain('Install the GitHub CLI');
  });
});

describe('workspace conversations', () => {
  it("keeps what you sent a workspace before opening it", async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const ws = await kay.workspaces.createWorktree(projectOf(kay.workspaces).id, 'later');
    await kay.session.workspaces!.refresh();
    kay.session.askOwnClaude('fix the flaky test', `ws:${ws.id}`);
    await waitFor(() => kay.runs.length === 1, 4000);
    kay.session.workspaces!.open(ws.id);
    expect(kay.state().log.some((l) => l.channel === `ws:${ws.id}` && l.type === 'chat' && l.text === 'fix the flaky test')).toBe(true);
  });

  it('stops its terminals when a workspace is archived', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'shelly');
    expect(kay.bench.shell(ws!.id)?.running).toBe(true);
    expect(await kay.session.workspaces!.archive(ws!.id, true)).toBe(true);
    expect(kay.bench.terminals?.get(ws!.id)).toBeUndefined();
  });
});

describe('models, usage, space and search', () => {
  it('uses the model picked for a conversation, else your default', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'm');
    kay.bench.setModel(undefined, 'haiku');
    kay.session.askOwnClaude('hi', `ws:${ws!.id}`);
    await waitFor(() => kay.runs.length === 1, 4000);
    expect(kay.runs[0]?.model).toBe('haiku');
    kay.bench.setModel(`ws:${ws!.id}`, 'opus');
    kay.session.setPrefs({ effort: 'high' });
    kay.session.askOwnClaude('again', `ws:${ws!.id}`);
    await waitFor(() => kay.runs.length === 2, 4000);
    expect(kay.runs[1]).toMatchObject({ model: 'opus', effort: 'high' });
    expect(kay.workspaces.find(ws!.id)?.model).toBe('opus');
  });

  it('adds up tokens and cost per workspace and measures its folder', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const ws = await kay.session.workspaces!.newWorktree(projectOf(kay.workspaces).id, 'u');
    kay.session.askOwnClaude('one', `ws:${ws!.id}`);
    await waitFor(() => kay.workspaces.find(ws!.id)?.usage?.runs === 1, 4000);
    kay.session.askOwnClaude('two', `ws:${ws!.id}`);
    await waitFor(() => kay.workspaces.find(ws!.id)?.usage?.runs === 2, 4000);
    // The same conversation reports a running total: nothing new was added the second time.
    expect(kay.workspaces.find(ws!.id)?.usage).toMatchObject({ input: 1000, output: 200, cacheWrite: 300 });
    await kay.bench.measureDisk();
    expect(kay.state().disk[ws!.id]).toBeGreaterThan(0);
    expect(kay.bench.describe(ws!.id)).toMatch(/KB · 2k tokens$/);
  });

  it('searches open, saved and archived conversations', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    const p = projectOf(kay.workspaces);
    const a = await kay.session.workspaces!.newWorktree(p.id, 'payments');
    const b = await kay.session.workspaces!.newWorktree(p.id, 'docs');
    kay.workspaces.saveHistory(b!.id, [{ id: 'x', type: 'chat', channel: `ws:${b!.id}`, from: 'z', name: 'bob', text: 'the Stripe webhook retries', ts: 5, byAgent: false }]);
    kay.session.askOwnClaude('wire the stripe webhook', `ws:${a!.id}`);
    await waitFor(() => kay.runs.length === 1, 4000);
    kay.bench.search('STRIPE webhook');
    const hits = kay.state().search.hits;
    expect(hits.map((h) => h.place)).toEqual(['app › payments', 'app › docs']);
    kay.bench.openHit(1);
    expect(kay.screen.getState().view).toMatchObject({ kind: 'workspace', id: b!.id });
    kay.bench.search('nothing like this');
    expect(kay.state().search.hits).toEqual([]);
  });

  it('saves your own templates', async () => {
    hub = await startHub({ keys });
    const kay = await solo(repo());
    kay.bench.saveTemplate('Write docs: document the public API in README.md');
    expect(kay.state().templates.at(-1)).toMatchObject({ name: 'Write docs', prompt: 'document the public API in README.md' });
    kay.bench.removeTemplate(kay.state().templates.at(-1)!.id);
    expect(kay.state().templates.some((t) => t.name === 'Write docs')).toBe(false);
  });
});

describe('your shell, its names and your variables', () => {
  it('starts shells the way you set them up, with your variables, and names them for every screen', async () => {
    hub = await startHub({ keys });
    const dir = repo();
    const kay = await solo(dir);
    const project = projectOf(kay.workspaces);
    await waitFor(() => kay.state().projects.some((p) => p.id === project.id), 4000);
    kay.session.setPrefs({ shell: '/bin/bash', shellLogin: false, shellArgs: ['--norc', '--noprofile'] });
    kay.session.env.set(undefined, [{ key: 'KLAUD_T_MINE', value: 'mine' }, { key: 'KLAUD_T_BOTH', value: 'mine' }]);
    kay.session.env.set(project.id, [{ key: 'KLAUD_T_BOTH', value: 'project' }]);
    const shell = kay.bench.globalShell('shell:1', dir)!;
    shell.run('echo "got:$KLAUD_T_MINE:$KLAUD_T_BOTH:$0"');
    await waitFor(() => shell.backlog().includes('got:mine:project:'), 8000);
    expect(shell.shell).toBe('/bin/bash');

    // Setup and run commands get them too (alongside klaud's own).
    const ws = await kay.session.workspaces!.newWorktree(project.id, 'envy');
    kay.bench.setScript(project.id, 'run', 'echo "run:$KLAUD_T_BOTH:$KLAUD_WORKSPACE_NAME"; sleep 5');
    await waitFor(() => kay.workspaces.list.find((p) => p.id === project.id)?.scripts?.run?.source === 'yours', 4000);
    const run = kay.bench.run(ws!.id)!;
    await waitFor(() => run.backlog().includes('run:project:envy'), 8000);

    kay.bench.renameTerminal('shell:1', '  logs\n');
    expect(kay.state().termNames['shell:1']).toBe('logs');
    kay.bench.renameTerminal('shell:1', '');
    expect(kay.state().termNames['shell:1']).toBeUndefined();
    kay.bench.renameTerminal('shell:1', 'tail');
    kay.bench.closeTerminal('shell:1');
    expect(kay.state().termNames).toEqual({});
  });
});
