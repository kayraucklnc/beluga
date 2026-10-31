import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import { Plans } from '../src/core/plans/plans.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController, WorktreeEvent } from '../src/core/workspace-controller.js';
import { BOARD_API } from '../src/ipc/board-api.js';
import { BOARD_HANDLERS } from '../src/ipc/board-handlers.js';
import { PLANS_API } from '../src/ipc/plans-api.js';
import { PLANS_HANDLERS } from '../src/ipc/plans-handlers.js';
import { PhoneCalls } from '../src/companion/calls.js';
import { PHONE } from '../src/companion/coverage.js';
import { planPageView, taskPageView } from '../src/companion/views.js';
import type { AgentRef } from '../src/protocol.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/** BLG-498: a task's agent, and a plan's agent for its work, changed after they were made. */

const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5.5' };
const LOCAL: AgentRef = { runtime: 'local', label: 'Local model', model: 'qwen3' };

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree'): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `beluga/${name}`, createdAt: 0, external: false }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup() {
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
  return { store, board, work, controller, made };
}

describe('a task’s agent, changed (BLG-498)', () => {
  it('kept on the task with a line in its activity; null goes back to your default; the same pick changes nothing', () => {
    const t = setup();
    const task = t.board.create({ projectId: 'api', title: 'Port the parser' }, t.work.me());
    const said = t.work.setAgent(task.id, CODEX);
    expect(t.board.need(task.id).agent).toEqual(CODEX);
    expect(said).toMatch(/Codex \(GPT-5\.5\) works .* when it starts/);
    expect(t.board.need(task.id).activity.at(-1)!.text).toBe('chose Codex (GPT-5.5) to work this');
    const lines = t.board.need(task.id).activity.length;
    t.work.setAgent(task.id, CODEX);
    expect(t.board.need(task.id).activity).toHaveLength(lines);
    t.work.setAgent(task.id, null);
    expect(t.board.need(task.id).agent).toBeUndefined();
    expect('agent' in t.board.need(task.id)).toBe(false);
    expect(t.board.need(task.id).activity.at(-1)!.text).toBe('left this to the default agent');
  });

  it('its next start runs the new agent; a start can still name another', async () => {
    const t = setup();
    const task = t.board.create({ projectId: 'api', title: 'Bench', agent: CODEX }, t.work.me());
    t.work.setAgent(task.id, LOCAL);
    await t.work.start(task.id, { claude: true });
    expect(t.made[0]!.agent).toEqual(LOCAL);
    const other = t.board.create({ projectId: 'api', title: 'Other', agent: CODEX }, t.work.me());
    await t.work.start(other.id, { claude: true, agent: LOCAL });
    expect(t.made[1]!.agent).toEqual(LOCAL);
  });

  it('a worktree already working it keeps its agent, and the answer says so', async () => {
    const t = setup();
    const task = t.board.create({ projectId: 'api', title: 'Lexer' }, t.work.me());
    await t.work.start(task.id, { claude: true });
    expect(t.made[0]!.agent).toBeUndefined();
    const said = t.work.setAgent(task.id, CODEX);
    expect(said).toMatch(/keeps the agent it started with; Codex \(GPT-5\.5\) works .* from its next start/);
    expect(t.made).toHaveLength(1);
  });

  it('the API: board.setAgent takes an agent or null; board.start an optional agent', () => {
    const args = BOARD_API['board.setAgent'].args;
    expect(args.parse(['BOB-1', CODEX])[1]).toEqual(CODEX);
    expect(args.parse(['BOB-1', null])[1]).toBeNull();
    expect(() => args.parse(['BOB-1'])).toThrow();
    expect(() => args.parse(['BOB-1', { runtime: 'Bad one', label: 'x' }])).toThrow();
    const start = BOARD_API['board.start'].args;
    expect(start.parse(['BOB-1', { claude: true, agent: LOCAL }])[1]!.agent).toEqual(LOCAL);
    expect(start.parse(['BOB-1'])[1]).toBeUndefined();
    expect(typeof BOARD_HANDLERS['board.setAgent']).toBe('function');
  });
});

const BODY: BodyInput = {
  title: 'Parser',
  goal: 'A faster parser.',
  milestones: [
    { id: 'm1', title: 'Fast', criteria: ['fast'], tasks: [{ id: 'a', title: 'Lexer' }] },
    { id: 'm2', title: 'Faster', criteria: ['faster'], dependsOn: ['m1'], tasks: [{ id: 'b', title: 'Grammar' }] },
  ],
};

function plansSetup() {
  const t = setup();
  const plans = new Plans({ store: t.store, dir: null });
  const work = new PlansWork({ store: t.store, plans, board: t.work, controller: t.controller, git: null, askClaude: () => 'ask', intend: () => undefined, delayMs: 0, workers: 'milestone' });
  return { ...t, plans, plansWork: work };
}

describe('a plan’s agent for its work, changed (BLG-498)', () => {
  it('kept on the plan with a line in its activity; what starts next runs it', async () => {
    const t = plansSetup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'autopilot' }, t.work.myClaude());
    const said = t.plansWork.setWorkAgent(plan.id, CODEX);
    expect(said).toBe('Codex (GPT-5.5) works this plan’s milestones and tasks');
    expect(t.plans.need(plan.id).agent).toEqual(CODEX);
    expect(t.plans.need(plan.id).activity.at(-1)!.text).toBe('gave its work to Codex (GPT-5.5) from here on');
    t.plansWork.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.plansWork.approve(plan.id);
    await tick(10);
    expect(t.made).toEqual([{ name: expect.any(String), agent: CODEX }]);
  });

  it('a milestone already at work keeps its agent, and the answer says so; null: your default', async () => {
    const t = plansSetup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'autopilot' }, t.work.myClaude());
    t.plansWork.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.plansWork.approve(plan.id);
    await tick(10);
    expect(t.made).toHaveLength(1);
    expect(t.made[0]!.agent).toBeUndefined();
    expect(t.plansWork.setWorkAgent(plan.id, LOCAL)).toBe('Local model (Qwen3) works what starts next; the milestone already at work keeps its agent');
    expect(t.made).toHaveLength(1);
    t.plansWork.setWorkAgent(plan.id, null);
    expect('agent' in t.plans.need(plan.id)).toBe(false);
  });

  it('the API: plans.setWorkAgent takes an agent or null', () => {
    const args = PLANS_API['plans.setWorkAgent'].args;
    expect(args.parse(['plan-1', LOCAL])[1]).toEqual(LOCAL);
    expect(args.parse(['plan-1', null])[1]).toBeNull();
    expect(() => args.parse(['plan-1'])).toThrow();
    expect(typeof PLANS_HANDLERS['plans.setWorkAgent']).toBe('function');
  });
});

describe('the phone changes them too (BLG-498)', () => {
  it('both are phone methods, answered in words', () => {
    expect(PHONE['board.setAgent']).toBe('phone');
    expect(PHONE['plans.setWorkAgent']).toBe('phone');
    expect(PhoneCalls['board.setAgent'].result.parse('Codex works BOB-1 when it starts')).toBeTypeOf('string');
    expect(PhoneCalls['plans.setWorkAgent'].result.parse('x')).toBe('x');
  });

  it('the task page and the plan page say who works them, with the list to change it from', () => {
    const t = plansSetup();
    t.store.dispatch({ type: 'runtimes', runtimes: [{ id: 'claude', label: 'Claude', available: true }, { id: 'codex', label: 'Codex', available: true, models: [{ value: 'gpt-5.5', label: 'GPT-5.5', description: '' }] }] } as never);
    const task = t.board.create({ projectId: 'api', title: 'Port the parser' }, t.work.me());
    const before = taskPageView(t.store.getState(), task.id)!;
    expect(before.agent).toBeUndefined();
    expect(before.agents).toBeDefined();
    expect(before.agents!.groups.flatMap((g) => g.models).some((m) => m.on)).toBe(false);
    t.work.setAgent(task.id, CODEX);
    const after = taskPageView(t.store.getState(), task.id)!;
    expect(after.agent).toEqual(CODEX);
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'step' }, t.work.myClaude());
    expect(planPageView(t.store.getState(), plan.id)!.agent).toBeUndefined();
    t.plansWork.setWorkAgent(plan.id, LOCAL);
    const pv = planPageView(t.store.getState(), plan.id)!;
    expect(pv.agent).toEqual(LOCAL);
    expect(pv.agents).toBeDefined();
  });
});
