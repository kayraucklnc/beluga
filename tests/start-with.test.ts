import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import { Plans } from '../src/core/plans/plans.js';
import { PlansWork } from '../src/core/plans/work.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceController, type WorktreeEvent } from '../src/core/workspace-controller.js';
import { API } from '../src/ipc/api.js';
import type { AgentRef } from '../src/protocol.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { screenOver } from './helpers.js';

/** BLG-506: Start with… everywhere work starts: the API takes the agent, the core starts with it. */

const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5.5' };
const LOCAL: AgentRef = { runtime: 'local', label: 'Local model', model: 'qwen3' };
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the API takes who starts the work, as an additive, optional field', () => {
  it('plans.startTask', () => {
    const args = API['plans.startTask'].args;
    expect(args.parse(['p1', 'a', CODEX])[2]).toEqual(CODEX);
    expect(args.parse(['p1', 'a'])[2]).toBeUndefined();
    expect(() => args.parse(['p1', 'a', { runtime: 'Not ok', label: 'x' }])).toThrow();
  });

  it('board.start, workspaces.startWorktree and workspaces.continueInWorktree', () => {
    expect(API['board.start'].args.parse(['BOB-1', { claude: true, agent: LOCAL }])[1]?.agent).toEqual(LOCAL);
    expect(API['workspaces.startWorktree'].args.parse(['p', 'Fix it', { agent: CODEX }])[2]?.agent).toEqual(CODEX);
    expect(API['workspaces.continueInWorktree'].args.parse(['w1', { task: 'Go on', agent: CODEX }])[1]?.agent).toEqual(CODEX);
    expect(API['workspaces.continueInWorktree'].args.parse(['w1', { task: 'Go on' }])[1]?.agent).toBeUndefined();
  });

  it('companion.ask: a new worktree from the phone with its agent; a question or a message takes none', () => {
    const args = API['companion.ask'].args;
    const [a] = args.parse([{ target: { project: 'p', worktree: true, agent: CODEX }, text: 'Fix the login' }]);
    expect('project' in a.target && a.target.agent).toEqual(CODEX);
    expect(() => args.parse([{ target: { topic: 'conv:ws:w1', agent: CODEX }, text: 'hi' }])).toThrow();
  });
});

// ------------------------------------------------------------------ a plan's Start task

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree'): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `beluga/${name}`, createdAt: 0, external: false }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });

const BODY: BodyInput = {
  title: 'Parser',
  goal: 'A faster parser.',
  milestones: [{ id: 'm1', title: 'Fast', criteria: ['fast'], tasks: [{ id: 'a', title: 'Lexer' }] }],
};

function plansSetup(workers: 'milestone' | 'task') {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [ws('main', 'api', 'bob-api', 'chat')])] });
  const listeners: Array<(e: WorktreeEvent) => void> = [];
  const made: Array<{ name: string; agent?: AgentRef }> = [];
  let n = 0;
  const controller = {
    onWorktree: (l: (e: WorktreeEvent) => void) => {
      listeners.push(l);
      return () => undefined;
    },
    newWorktree: async (projectId: string, name: string, o: { agent?: AgentRef } = {}) => {
      made.push({ name, ...(o.agent ? { agent: o.agent } : {}) });
      const w = ws(`w${++n}`, projectId, name);
      store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
      listeners.forEach((l) => l({ kind: 'created', ws: w }));
      return w;
    },
  } as unknown as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: () => 'bob-api' });
  const work = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
  const plans = new Plans({ store, dir: null });
  const plansWork = new PlansWork({ store, plans, board: work, controller, git: null, askClaude: () => 'ask', intend: () => undefined, delayMs: 0, workers });
  /** A plan you run step by step (nothing starts by itself), approved. */
  const approved = (agent?: AgentRef) => {
    const plan = plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'step', ...(agent ? { agent } : {}) }, work.myClaude());
    plansWork.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    plansWork.approve(plan.id);
    return plan;
  };
  return { made, plansWork, approved };
}

describe('a plan’s Start with… (plans.startTask with an agent)', () => {
  it('task by task: the agent you pick beats the plan’s, this start only', async () => {
    const t = plansSetup('task');
    const plan = t.approved(CODEX);
    await tick(10);
    expect(t.made).toEqual([]);
    expect(await t.plansWork.startTask(plan.id, 'a', LOCAL)).toMatch(/^Started [A-Z]+-\d+ “Lexer”/);
    expect(t.made).toEqual([{ name: expect.any(String), agent: LOCAL }]);
  });

  it('task by task, none picked: the plan’s agent, as before', async () => {
    const t = plansSetup('task');
    const plan = t.approved(CODEX);
    await t.plansWork.startTask(plan.id, 'a');
    expect(t.made).toEqual([{ name: expect.any(String), agent: CODEX }]);
  });

  it('a milestone’s one agent: the one you start it with', async () => {
    const t = plansSetup('milestone');
    const plan = t.approved();
    expect(await t.plansWork.startTask(plan.id, 'a', CODEX)).toMatch(/^Started one agent for “Fast”/);
    expect(t.made).toEqual([{ name: expect.any(String), agent: CODEX }]);
  });
});

// ------------------------------------------------------------------ Continue in a new worktree, and imports

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

async function controllerSetup(opts: { defaultAgent?: AgentRef; findConversation?: ConstructorParameters<typeof WorkspaceController>[0]['findConversation'] } = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-start-with-')));
  const repo = path.join(base, 'code', 'app');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', path.join(base, 'app.git')], { stdio: 'pipe' });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-m', 'init');
  sh(repo, 'remote', 'add', 'origin', path.join(base, 'app.git'));
  sh(repo, 'push', '-u', 'origin', 'main');
  sh(repo, 'remote', 'set-head', 'origin', 'main');
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  const store = new Store(initialState('room'));
  const manager = new WorkspaceManager(wsStore);
  const asked: Array<{ prompt: string; channel: string; echo?: boolean | string }> = [];
  const toasts: string[] = [];
  const ctl = new WorkspaceController({
    manager,
    store,
    shares: new ShareService([]),
    selfId: () => 'me',
    toast: (text) => void toasts.push(text),
    intend: screenOver(store).intend,
    askClaude: (prompt, channel, o) => void asked.push({ prompt, channel, ...(o?.echo !== undefined ? { echo: o.echo } : {}) }),
    claudeHome: path.join(base, 'claude'),
    ...(opts.defaultAgent ? { defaultAgent: () => opts.defaultAgent!, defaultRuntime: () => opts.defaultAgent!.runtime } : {}),
    ...(opts.findConversation ? { findConversation: opts.findConversation } : {}),
  });
  await ctl.refresh();
  const projectId = store.getState().projects.find((p) => p.root)!.id;
  const said = (channel: string): string[] => store.getState().log.filter((l) => l.channel === channel).map((l) => ('text' in l ? l.text : ''));
  /** A conversation so far in `channel`: you asked, the agent answered. */
  const talk = (channel: string): void => {
    store.dispatch({ type: 'chat', id: 'c1', channel, from: 'me', text: 'Where is the login code?', ts: 1, byAgent: false });
    store.dispatch({ type: 'chat', id: 'c2', channel, from: 'agent', text: 'In src/login.ts, the handler at the top.', ts: 2, byAgent: true });
  };
  return { ctl, manager, store, asked, toasts, projectId, said, talk };
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !ok(); i++) await tick(20);
  expect(ok()).toBe(true);
};

describe('Continue in a new worktree with another agent (BLG-506)', () => {
  it('a worktree’s conversation forked to Codex: it runs there, starts fresh, handed the conversation, your task shown once', { timeout: 20_000 }, async () => {
    const t = await controllerSetup();
    const src = (await t.ctl.newWorktree(t.projectId, 'login', { quiet: true }))!;
    t.ctl.place(`ws:${src.id}`)!.onSession('claude-session');
    t.talk(`ws:${src.id}`);
    const moved = (await t.ctl.continueInWorktree(src.id, async () => 'login-fix', { task: 'Fix the login bug', agent: CODEX }))!;
    expect(t.manager.find(moved.id)).toMatchObject({ agent: { runtime: 'codex', label: 'Codex' }, model: 'gpt-5.5' });
    // Codex never gets Claude's session.
    expect(t.ctl.place(`ws:${moved.id}`)).toMatchObject({ agent: CODEX, resume: undefined });
    await until(() => t.asked.length === 1);
    const run = t.asked[0]!;
    expect(run.channel).toBe(`ws:${moved.id}`);
    expect(run.prompt).toContain('<note>');
    expect(run.prompt).toContain('In src/login.ts, the handler at the top.');
    expect(run.prompt.endsWith('Fix the login bug')).toBe(true);
    // Your message is the task, not the handoff.
    expect(run.echo).toBe('Fix the login bug');
    expect(t.said(`ws:${moved.id}`).some((s) => /Codex can’t pick up this conversation, so it starts fresh here, handed the conversation so far/.test(s))).toBe(true);
    expect(t.toasts.some((s) => /Codex starts fresh, handed the conversation so far/.test(s))).toBe(true);
  });

  it('no agent picked, same runtime: it remembers the conversation, as before', { timeout: 20_000 }, async () => {
    const t = await controllerSetup();
    const src = (await t.ctl.newWorktree(t.projectId, 'same', { quiet: true }))!;
    t.ctl.place(`ws:${src.id}`)!.onSession('claude-session');
    t.talk(`ws:${src.id}`);
    const moved = (await t.ctl.continueInWorktree(src.id, async () => 'same-fix', { task: 'Fix the login bug' }))!;
    expect(t.ctl.place(`ws:${moved.id}`)).toMatchObject({ resume: 'claude-session', forkSession: true });
    await until(() => t.asked.length === 1);
    expect(t.asked[0]).toEqual({ prompt: 'Fix the login bug', channel: `ws:${moved.id}` });
    expect(t.said(`ws:${moved.id}`).some((s) => s.endsWith('Your agent remembers the conversation.'))).toBe(true);
  });

  it('a chat in the main folder becomes a worktree run by Codex: fresh, handed the conversation', { timeout: 20_000 }, async () => {
    const t = await controllerSetup();
    const chat = (await t.ctl.newChat(t.projectId, 'login', undefined, { quiet: true }))!;
    t.ctl.place(`ws:${chat.id}`)!.onSession('claude-session');
    t.talk(`ws:${chat.id}`);
    const moved = (await t.ctl.continueInWorktree(chat.id, async () => 'login-chat', { agent: CODEX }))!;
    expect(moved.id).toBe(chat.id);
    expect(t.manager.find(chat.id)).toMatchObject({ kind: 'worktree', agent: { runtime: 'codex' } });
    await until(() => t.asked.length === 1);
    expect(t.asked[0]!.prompt).toContain('In src/login.ts');
    expect(t.said(`ws:${chat.id}`).some((s) => /Codex can’t pick up this conversation, so it starts fresh here/.test(s))).toBe(true);
  });
});

describe('a Claude Code conversation brought in (BLG-506 wording)', () => {
  const convo = { sessionId: 'outside', title: 'Login work', lastModified: 1, items: [{ id: 't-0', type: 'chat' as const, channel: '', from: 'me', name: 'kay', text: 'Fix the login', ts: 1, byAgent: false }] };

  it('on Claude: your agent remembers all of it', { timeout: 20_000 }, async () => {
    const t = await controllerSetup({ findConversation: async () => convo });
    const w = (await t.ctl.newWorktree(t.projectId, 'import-claude', { quiet: true }))!;
    t.ctl.open(w.id);
    await until(() => t.said(`ws:${w.id}`).some((s) => s.startsWith('Continuing "Login work"')));
    expect(t.said(`ws:${w.id}`).find((s) => s.startsWith('Continuing'))).toMatch(/Your agent remembers all of it\.$/);
  });

  it('on Codex: it says Codex starts fresh, and how to go on with all of it', { timeout: 20_000 }, async () => {
    const t = await controllerSetup({ defaultAgent: { runtime: 'codex', label: 'Codex' }, findConversation: async () => convo });
    const w = (await t.ctl.newWorktree(t.projectId, 'import-codex', { quiet: true }))!;
    t.ctl.open(w.id);
    await until(() => t.said(`ws:${w.id}`).some((s) => s.startsWith('Continuing "Login work"')));
    const line = t.said(`ws:${w.id}`).find((s) => s.startsWith('Continuing'))!;
    expect(line).toContain('Codex can’t pick up a Claude Code conversation, so it starts fresh here');
    expect(line).not.toContain('remembers');
  });
});
