import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import { planForHome } from '../src/core/plans/model.js';
import { Plans } from '../src/core/plans/plans.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { PLAN_TOOL_NAMES, createPlanToolDefs } from '../src/agent/plan-tools.js';
import { decideTool } from '../src/agent/policy.js';

/** A chat's agent opens and closes the chat's own plan, behind the chatPlans pref (BLG-415). */

const ws = (id: string, kind: Workspace['kind'], extra: Partial<Workspace> = {}): Workspace => ({ id, projectId: 'api', name: id, path: `/tmp/${id}`, kind, projectRoot: '/tmp/p', createdAt: 0, external: false, ...extra }) as unknown as Workspace;
const project = (workspaces: Workspace[]): Project => ({ id: 'api', name: 'bob-api', root: '/tmp/bob-api', base: 'main', workspaces });

function setup(opts: { chatPlans?: boolean } = {}) {
  const store = new Store(initialState('room', 'ask', { chatPlans: opts.chatPlans ?? true }));
  store.dispatch({ type: 'projects', projects: [project([ws('chat', 'chat', { askOnly: true } as Partial<Workspace>), ws('wt', 'worktree'), ws('codex', 'chat', { agent: { runtime: 'codex', label: 'Codex' } } as Partial<Workspace>)])] });
  const asked: Array<{ prompt: string; channel: string; echo: boolean }> = [];
  const controller = { onWorktree: () => () => undefined } as unknown as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: () => 'bob-api' });
  const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
  const plans = new Plans({ store, dir: null });
  const work = new PlansWork({ store, plans, board: boardWork, askClaude: (prompt, channel, echo) => `ask-${asked.push({ prompt, channel, echo })}`, intend: () => undefined, delayMs: 0, git: null });
  return { store, plans, work, asked, me: boardWork.me() };
}

const names = (run: ReturnType<PlansWork['forRun']>): string[] => createPlanToolDefs(run!.tools!).map((d) => d.name);

describe('chatPlans on: a project chat that is no plan home', () => {
  it('gets only plan_open and plan_get, and keeps asking only', () => {
    const t = setup();
    const run = t.work.forRun('ws:chat', 'p-me');
    expect(names(run)).toEqual(['plan_get', 'plan_open']);
    expect(run!.opener).toBe(true);
    expect(run!.brief).toContain('plan_open');
    expect(t.work.forRun('ws:chat', 'p-me')!.tools!.get()).toMatch(/no plan/);
    for (const n of ['plan_open', 'plan_close']) expect(decideTool(`mcp__beluga_plan__${n}`, {}, { cwd: '/tmp', roots: [], autoEdit: false, askOnly: true })).toBe('allow');
  });

  it('plan_open makes a draft here and queues one follow-up turn that has the full tools', async () => {
    const t = setup();
    const said = await t.work.forRun('ws:chat', 'p-me')!.tools!.open!();
    const plan = planForHome(t.store.getState().plans, 'ws:chat');
    expect(plan).toMatchObject({ status: 'draft', home: 'ws:chat', projectId: 'api' });
    expect(said).toMatch(/turn/);
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]).toMatchObject({ channel: 'ws:chat', echo: false });
    expect(t.asked[0]!.prompt).toContain('plan_write');
    const next = t.work.forRun('ws:chat', 'p-me')!;
    expect(next.opener).toBeUndefined();
    expect(next.brief).toContain('<beluga_plan_mode>');
    expect(names(next)).toContain('plan_write');
    expect(names(next)).toContain('plan_close');
    expect(names(next)).toContain('plan_open');
    expect(() => next.tools!.open!()).toThrow(/plan_close first/);
    // A follow-up run writes the draft.
    next.tools!.write({ title: 'Chat plan', goal: 'g', milestones: [{ title: 'M', criteria: ['c'], tasks: [{ title: 'T' }] }] } as never);
    expect(t.plans.need(plan!.id).draft?.title).toBe('Chat plan');
  });

  it('plan_close closes the current plan; plan_open then starts a new one, and the old one reads only', async () => {
    const t = setup();
    await t.work.forRun('ws:chat', 'p-me')!.tools!.open!();
    const old = planForHome(t.store.getState().plans, 'ws:chat')!;
    const said = await t.work.forRun('ws:chat', 'p-me')!.tools!.close!();
    expect(said).toContain('plan_open');
    expect(t.plans.need(old.id).closedAt).toBeDefined();
    const after = t.work.forRun('ws:chat', 'p-me')!;
    expect(names(after)).toEqual(['plan_get', 'plan_open']);
    expect(after.tools!.get()).toContain('closed');
    await after.tools!.open!();
    const fresh = planForHome(t.store.getState().plans, 'ws:chat')!;
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.status).toBe('draft');
  });

  it('“Close the current plan and open a new one” works in one turn', async () => {
    const t = setup();
    await t.work.forRun('ws:chat', 'p-me')!.tools!.open!();
    const old = planForHome(t.store.getState().plans, 'ws:chat')!;
    const run = t.work.forRun('ws:chat', 'p-me')!;
    run.tools!.close!();
    run.tools!.open!();
    expect(t.plans.need(old.id).closedAt).toBeDefined();
    const now = planForHome(t.store.getState().plans, 'ws:chat')!;
    expect(now.id).not.toBe(old.id);
    expect(now.status).toBe('draft');
    expect(t.asked.filter((a) => a.channel === 'ws:chat')).toHaveLength(2);
  });

  it('worktree chats, checker chats, other agents and friends get neither tool', () => {
    const t = setup();
    expect(t.work.forRun('ws:wt', 'p-me')).toBeUndefined();
    expect(t.work.forRun('ws:codex', 'p-me')).toBeUndefined();
    expect(t.work.forRun('ws:chat', 'p-bob')).toBeUndefined();
    expect(t.work.forRun('ws:nowhere', 'p-me')).toBeUndefined();
  });
});

describe('chatPlans off', () => {
  it('a chat gets no plan tools, and a plan home gets today’s tools', () => {
    const t = setup({ chatPlans: false });
    expect(t.work.forRun('ws:chat', 'p-me')).toBeUndefined();
    t.work.here('ws:chat');
    const run = t.work.forRun('ws:chat', 'p-me')!;
    expect(createPlanToolDefs(run.tools!).map((d) => `mcp__beluga_plan__${d.name}`)).toEqual(PLAN_TOOL_NAMES.filter((n) => n !== 'mcp__beluga_plan__plan_review')); // plan_review: the draft's reviewer's alone
    expect(run.opener).toBeUndefined();
  });
});

describe('plans.close and plans.ofHome (BLG-416)', () => {
  it('close by you, and the chat’s plans listed newest first', () => {
    const t = setup();
    const old = t.work.here('ws:chat');
    expect(t.work.close(old.id).closedBy).toEqual(t.me);
    const now = t.work.here('ws:chat');
    expect(t.work.ofHome('ws:chat')).toEqual([
      { id: now.id, title: 'New plan', status: 'draft', createdAt: now.createdAt, current: true },
      { id: old.id, title: 'New plan', status: 'draft', createdAt: old.createdAt, closedAt: expect.any(Number), current: false },
    ]);
  });
});
