import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import { type BodyInput, PlanError, applyOps, normalizeBody } from '../src/core/plans/edit.js';
import { diffBodies, milestoneDeps, planForHome } from '../src/core/plans/model.js';
import { Plans } from '../src/core/plans/plans.js';
import { overlaps, planView, waves } from '../src/core/plans/progress.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController, WorktreeEvent } from '../src/core/workspace-controller.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { PLAN_TOOL_NAMES, createPlanToolDefs, milestoneInput, toOps } from '../src/agent/plan-tools.js';
import { decideTool } from '../src/agent/policy.js';

/** Plans: drafts that stay off the board, approving onto it, and the scheduler running them. */

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree', extra: Partial<Workspace> = {}): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `klaud/${name}`, createdAt: 0, external: false, ...extra }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup(opts: { titlePlan?: (goal: string) => Promise<string | undefined> } = {}) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [ws('main', 'api', 'bob-api', 'chat', { askOnly: true } as Partial<Workspace>)])] });
  const listeners: Array<(e: WorktreeEvent) => void> = [];
  const asked: Array<{ prompt: string; channel: string; echo: boolean }> = [];
  const made: Array<{ name: string; base?: string; quiet?: boolean }> = [];
  let n = 0;
  const add = (w: Workspace): void => {
    store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === w.projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
  };
  const controller = {
    onWorktree: (l: (e: WorktreeEvent) => void) => {
      listeners.push(l);
      return () => undefined;
    },
    newWorktree: async (projectId: string, name: string, opts: { base?: string; quiet?: boolean } = {}) => {
      made.push({ name, ...opts });
      const w = ws(`w${++n}`, projectId, name);
      add(w);
      listeners.forEach((l) => l({ kind: 'created', ws: w }));
      return w;
    },
    newChat: async (projectId: string, title: string) => {
      const w = ws(`c${++n}`, projectId, title, 'chat', { askOnly: true } as Partial<Workspace>);
      add(w);
      return w;
    },
    renameChat: async (id: string, name: string) => {
      store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => ({ ...p, workspaces: p.workspaces.map((w) => (w.id === id ? { ...w, name } : w)) })) });
    },
  } as unknown as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
  const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: (prompt, channel) => void asked.push({ prompt, channel, echo: true }) });
  const plans = new Plans({ store, dir: null });
  const intents: unknown[] = [];
  const work = new PlansWork({ store, plans, board: boardWork, controller, askClaude: (prompt, channel, echo) => void asked.push({ prompt, channel, echo }), intend: (i) => void intents.push(i), delayMs: 0, ...(opts.titlePlan ? { titlePlan: opts.titlePlan } : {}) });
  const claude = boardWork.myClaude();
  const me = boardWork.me();
  /** Claude in a worktree finishes its run, or works. */
  const run = (channel: string, status: 'started' | 'done', id = `r-${Math.random()}`): void => store.dispatch({ type: 'agent_event', owner: 'p-me', requestId: id, requester: 'p-me', event: status, text: '', ts: Date.now(), channel });
  return { store, board, boardWork, plans, work, asked, made, intents, claude, me, run };
}

describe('a new plan’s name (KLD-28)', () => {
  const chatName = (t: ReturnType<typeof setup>, home: string): string | undefined => t.store.getState().projects.flatMap((p) => p.workspaces).find((w) => `ws:${w.id}` === home)?.name;
  const goal = 'A couple of things that we should improve because they look unfinished while Claude drafts the plan';

  it('is never your message: "New plan", then the quick model’s name, in the sidebar too', async () => {
    let name!: (title: string | undefined) => void;
    const t = setup({ titlePlan: () => new Promise((r) => (name = r)) });
    const plan = await t.work.create({ projectId: 'api', goal });
    expect(plan.draft!.title).toBe('New plan');
    expect(plan.draft!.goal).toBe(goal);
    expect(chatName(t, plan.home)).toBe('New plan');
    name('Calmer plan drafting screen');
    await tick();
    expect(t.plans.need(plan.id).draft!.title).toBe('Calmer plan drafting screen');
    expect(chatName(t, plan.home)).toBe('Calmer plan drafting screen');
  });

  it('Claude’s plan_write names it after that, and a late quick name doesn’t win', async () => {
    let name!: (title: string | undefined) => void;
    const t = setup({ titlePlan: () => new Promise((r) => (name = r)) });
    const plan = await t.work.create({ projectId: 'api', goal });
    t.work.forRun(plan.home, 'p-me')!.tools!.write(BODY);
    expect(t.plans.need(plan.id).draft!.title).toBe('Payments');
    expect(chatName(t, plan.home)).toBe('Payments');
    name('Too late');
    await tick();
    expect(t.plans.need(plan.id).draft!.title).toBe('Payments');
  });

  it('stays "New plan" when the model can’t name it', async () => {
    const t = setup({ titlePlan: async () => undefined });
    const plan = await t.work.create({ projectId: 'api', goal });
    await tick();
    expect(t.plans.need(plan.id).draft!.title).toBe('New plan');
  });
});

const BODY: BodyInput = {
  title: 'Payments',
  goal: 'Take payments',
  milestones: [
    {
      id: 'safe',
      title: 'Safe payments',
      criteria: ['401 without a session', 'A replayed webhook charges once'],
      tasks: [
        { id: 'auth', title: 'Auth on payment routes', goal: 'Only signed-in users pay.', acceptance: ['401 without session'], touches: ['src/auth'], estimate: 3 },
        { id: 'retries', title: 'Idempotent webhooks', acceptance: '- [ ] each event once\n- [ ] backoff', touches: ['src/webhooks'], estimate: 5 },
        { id: 'receipts', title: 'Receipts once', blockedBy: ['retries'], touches: ['src/email'] },
      ],
    },
    { id: 'refunds', title: 'Refunds', criteria: ['A refund works end to end'], tasks: [{ id: 'refund-api', title: 'Refund endpoint', blockedBy: ['auth', 'retries'] }, { id: 'keys', title: 'Live keys', assignee: 'me' }] },
  ],
};

describe('writing a plan', () => {
  it('reads input kindly: ids from titles, checklists as lines', () => {
    const body = normalizeBody({ title: 'P', goal: '', milestones: [{ title: 'First step', criteria: '- [ ] works', tasks: [{ title: 'Do The Thing', acceptance: '- [ ] a\n- [x] b' }, { title: 'Do the thing' }] }] });
    expect(body.milestones[0]!.id).toBe('first-step');
    expect(body.milestones[0]!.criteria).toEqual(['works']);
    expect(body.milestones[0]!.tasks.map((t) => t.id)).toEqual(['do-the-thing', 'do-the-thing-2']);
    expect(body.milestones[0]!.tasks[0]!.acceptance).toEqual(['a', 'b']);
  });

  it('refuses loops, unknown blockers and blockers in a later milestone', () => {
    const loop = { title: 'P', goal: '', milestones: [{ title: 'M', tasks: [{ id: 'a', title: 'A', blockedBy: ['b'] }, { id: 'b', title: 'B', blockedBy: ['a'] }] }] };
    expect(() => normalizeBody(loop)).toThrow(/loop: a → b → a|loop/);
    expect(() => normalizeBody({ title: 'P', goal: '', milestones: [{ title: 'M', tasks: [{ id: 'a', title: 'A', blockedBy: ['zz'] }] }] })).toThrow(PlanError);
    expect(() => normalizeBody({ title: 'P', goal: '', milestones: [{ title: 'M1', tasks: [{ id: 'a', title: 'A', blockedBy: ['b'] }] }, { title: 'M2', tasks: [{ id: 'b', title: 'B' }] }] })).toThrow(/later milestone/);
  });

  it('ops change it step by step; removing a task drops it from blockers; moving takes sub-tasks along', () => {
    let body = normalizeBody(BODY);
    body = applyOps(body, [
      { op: 'add_task', milestone: 'safe', task: { id: 'sub', title: 'Sub', parent: 'auth' } },
      { op: 'remove_task', id: 'retries' },
      { op: 'update_task', id: 'auth', patch: { title: 'Auth everywhere' } },
    ]);
    const tasks = body.milestones.flatMap((m) => m.tasks);
    expect(tasks.find((t) => t.id === 'receipts')!.blockedBy).toEqual([]);
    expect(tasks.find((t) => t.id === 'refund-api')!.blockedBy).toEqual(['auth']);
    expect(tasks.find((t) => t.id === 'auth')!.title).toBe('Auth everywhere');
    body = applyOps(body, [{ op: 'move_task', id: 'auth', milestone: 'refunds', before: 'refund-api' }]);
    expect(body.milestones[1]!.tasks.map((t) => t.id)).toEqual(['auth', 'sub', 'refund-api', 'keys']);
  });

  it('waves are what can run side by side', () => {
    const body = normalizeBody(BODY);
    expect(waves(body.milestones[0]!).map((w) => w.map((t) => t.id))).toEqual([['auth', 'retries'], ['receipts']]);
  });
});

describe('a draft stays off the board until approved', () => {
  it('Claude writes the draft; the board has nothing; Approve puts it all there', () => {
    const { store, plans, work, claude } = setup();
    const plan = plans.create({ projectId: 'api', home: 'ws:main' }, claude);
    const tools = work.forRun('ws:main', 'p-me')!.tools!;
    expect(tools.write(BODY)).toContain('nothing is on the board until then');
    expect(store.getState().board.issues).toHaveLength(0);
    work.approve(plan.id);
    const issues = store.getState().board.issues;
    expect(issues).toHaveLength(5);
    const byTitle = (t: string) => issues.find((i) => i.title === t)!;
    // The milestone being worked on is Todo; later ones wait in the Backlog.
    expect(byTitle('Auth on payment routes')).toMatchObject({ status: 'todo', origin: 'plan', estimate: 3, plan: { id: plan.id, milestone: 'safe', task: 'auth' }, assignee: { kind: 'claude' } });
    expect(byTitle('Refund endpoint').status).toBe('backlog');
    expect(byTitle('Live keys').assignee).toMatchObject({ kind: 'person', id: 'p-me' });
    expect(byTitle('Receipts once').blockedBy).toEqual([byTitle('Idempotent webhooks').id]);
    expect(byTitle('Idempotent webhooks').brief.acceptance).toBe('- [ ] each event once\n- [ ] backoff');
    expect(plans.need(plan.id)).toMatchObject({ status: 'active' });
    expect(plans.need(plan.id).draft).toBeUndefined();
  });

  it('throwing a never-approved draft away removes the plan, and the board never knew', () => {
    const { store, plans, work, claude } = setup();
    const plan = plans.create({ projectId: 'api', home: 'ws:main' }, claude);
    work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    work.discard(plan.id);
    expect(store.getState().plans.plans).toHaveLength(0);
    expect(store.getState().board.issues).toHaveLength(0);
  });

  it('changes to an approved plan are proposed; applying them adds, rewrites (ticks kept) and cancels', () => {
    const { store, board, plans, work, claude, me } = setup();
    const plan = plans.create({ projectId: 'api', home: 'ws:main' }, claude);
    const tools = work.forRun('ws:main', 'p-me')!.tools!;
    tools.write(BODY);
    work.approve(plan.id);
    const retries = store.getState().board.issues.find((i) => i.title === 'Idempotent webhooks')!;
    board.editBrief(retries.id, 'acceptance', '- [x] each event once\n- [ ] backoff', me);
    expect(tools.update([{ op: 'add_task', milestone: 'safe', task: { id: 'alerts', title: 'Alerts' } }, { op: 'remove_task', id: 'keys' }, { op: 'update_task', id: 'retries', patch: { acceptance: ['each event once', 'backoff', 'a replay test'] } }])).toContain('the user reviews the changes');
    expect(store.getState().board.issues.some((i) => i.title === 'Alerts')).toBe(false);
    const d = diffBodies(plans.need(plan.id).body, plans.need(plan.id).draft);
    expect(d).toMatchObject({ added: ['alerts'], removed: ['keys'], changed: ['retries'] });
    work.approve(plan.id);
    const after = store.getState().board.issues;
    expect(after.find((i) => i.title === 'Alerts')?.status).toBe('todo');
    expect(after.find((i) => i.title === 'Live keys')).toMatchObject({ status: 'canceled' });
    expect(after.find((i) => i.title === 'Live keys')!.plan).toBeUndefined();
    expect(board.need(retries.id).brief.acceptance).toBe('- [x] each event once\n- [ ] backoff\n- [ ] a replay test');
  });

  it('existing board tasks can be adopted by key', () => {
    const { store, board, plans, work, claude, me } = setup();
    const old = board.create({ projectId: 'api', title: 'Old task', status: 'in_progress' }, me);
    const plan = plans.create({ projectId: 'api', home: 'ws:main' }, claude);
    work.forRun('ws:main', 'p-me')!.tools!.write({ title: 'P', goal: '', milestones: [{ title: 'M', tasks: [{ title: 'Old task', issue: old.key } as never, { title: 'New' }] }] });
    work.approve(plan.id);
    expect(store.getState().board.issues).toHaveLength(2);
    expect(board.need(old.id).plan?.id).toBe(plan.id);
    expect(board.need(old.id).status).toBe('in_progress');
  });
});

describe('running a plan', () => {
  async function running(autonomy: 'step' | 'gated' | 'autopilot' = 'gated', maxParallel = 3) {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy }, t.claude);
    t.plans.setMaxParallel(plan.id, maxParallel, t.me);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.work.approve(plan.id);
    await tick(5);
    return { ...t, plan };
  }
  const issue = (t: Awaited<ReturnType<typeof running>>, title: string) => t.store.getState().board.issues.find((i) => i.title === title)!;

  it('gated: starts what’s ready by itself, quietly, never a blocked task', async () => {
    const t = await running('gated');
    expect(t.made.map((m) => m.quiet)).toEqual([true, true]);
    expect(issue(t, 'Auth on payment routes').status).toBe('in_progress');
    expect(issue(t, 'Idempotent webhooks').status).toBe('in_progress');
    expect(issue(t, 'Receipts once').status).toBe('todo');
    const v = planView(t.plans.need(t.plan.id), t.store.getState().board);
    expect(v.milestones[0]!.tasks.find((x) => x.task.id === 'receipts')).toMatchObject({ state: 'blocked', why: 'Waits on “Idempotent webhooks”' });
  });

  it('respects the plan’s limit', async () => {
    const t = await running('gated', 1);
    expect(t.made).toHaveLength(1);
  });

  it('step by step: nothing starts; you start a task', async () => {
    const t = await running('step');
    expect(t.made).toHaveLength(0);
    const v = planView(t.plans.need(t.plan.id), t.store.getState().board);
    expect(v.next.kind).toBe('start');
    expect(await t.work.startTask(t.plan.id, 'auth')).toContain('Started');
    await expect(t.work.startTask(t.plan.id, 'receipts')).rejects.toThrow(/can’t start: Waits on/);
  });

  it('a task in review lets what builds on it start from its branch', async () => {
    const t = await running('gated');
    const retries = issue(t, 'Idempotent webhooks');
    t.board.update(retries.id, { status: 'in_review' }, t.claude);
    await tick(5);
    expect(t.made.at(-1)).toMatchObject({ base: retries.branch, quiet: true });
    expect(issue(t, 'Receipts once').status).toBe('in_progress');
  });

  it('finished tasks: Claude is asked to check the criteria; gated waits for you; passing opens the next milestone', async () => {
    const t = await running('gated');
    for (const title of ['Auth on payment routes', 'Idempotent webhooks']) t.board.update(issue(t, title).id, { status: 'done' }, t.me);
    await tick(5);
    t.board.update(issue(t, 'Receipts once').id, { status: 'in_review' }, t.claude);
    await tick(5);
    const check = t.asked.find((a) => a.channel === 'ws:main' && a.prompt.includes('Check its pass criteria'));
    expect(check?.echo).toBe(false);
    expect(check?.prompt).toContain('401 without a session');
    expect(planView(t.plans.need(t.plan.id), t.store.getState().board).current?.state).toBe('checking');
    expect(planView(t.plans.need(t.plan.id), t.store.getState().board).next.kind).toBe('checking');
    t.work.forRun('ws:main', 'p-me')!.tools!.gate('safe', 'pass', '1 ✓ 2 ✓');
    await tick(5);
    const v = planView(t.plans.need(t.plan.id), t.store.getState().board);
    expect(v.current?.milestone.id).toBe('safe');
    expect(v.next.kind).toBe('pass');
    t.work.pass(t.plan.id, 'safe');
    await tick(5);
    expect(issue(t, 'Refund endpoint').status).toBe('in_progress');
    // "Live keys" is yours: it waits for you.
    expect(issue(t, 'Live keys').status).toBe('todo');
  });

  it.each(['step', 'gated', 'autopilot'] as const)('%s: while the head Claude checks, the plan waits on Claude; it’s yours to pass only once the check is back (KLD-22)', async (autonomy) => {
    const t = await running(autonomy);
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(issue(t, title).id, { status: 'in_review' }, t.claude);
    await tick(5);
    await tick(5);
    const view = () => planView(t.plans.need(t.plan.id), t.store.getState().board);
    expect(view().next).toMatchObject({ kind: 'checking', milestone: { milestone: { id: 'safe' } } });
    t.work.forRun('ws:main', 'p-me')!.tools!.gate('safe', 'pass', '1 ✓ 2 ✓');
    await tick(5);
    if (autonomy === 'autopilot') expect(t.plans.need(t.plan.id).runs.safe?.passedAt).toBeDefined();
    else expect(view().next).toMatchObject({ kind: 'pass', milestone: { milestone: { id: 'safe' } } });
  });

  it('the pilot writes what happened: started, finished, checked, passed, the mode changed (KLD-22)', async () => {
    const t = await running('gated');
    t.board.update(issue(t, 'Idempotent webhooks').id, { status: 'in_review' }, t.claude);
    await tick(5);
    t.work.setAutonomy(t.plan.id, 'autopilot');
    const kinds = t.plans.need(t.plan.id).activity.map((e) => `${e.kind}: ${e.text}`);
    expect(kinds.filter((k) => k.startsWith('started:')).length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContainEqual(expect.stringMatching(/^finished: finished [A-Z]+-\d+ “Idempotent webhooks”$/));
    expect(kinds.at(-1)).toBe('autonomy: switched the plan to Autopilot');
  });

  it('autopilot: a passing check moves on by itself; a failing one stops there', async () => {
    const t = await running('autopilot');
    for (const title of ['Auth on payment routes', 'Idempotent webhooks', 'Receipts once']) t.board.update(issue(t, title).id, { status: 'done' }, t.me);
    await tick(5);
    await tick(5);
    const tools = t.work.forRun('ws:main', 'p-me')!.tools!;
    tools.gate('safe', 'fail', 'replay sends two receipts');
    await tick(5);
    expect(planView(t.plans.need(t.plan.id), t.store.getState().board).next.kind).toBe('failed');
    // Claude adds a fix task: on autopilot it applies at once, and starts.
    expect(tools.update([{ op: 'add_task', milestone: 'safe', task: { id: 'fix', title: 'Fix double receipts' } }])).toContain('Applied at once');
    await tick(5);
    expect(issue(t, 'Fix double receipts').status).toBe('in_progress');
    t.board.update(issue(t, 'Fix double receipts').id, { status: 'done' }, t.me);
    await tick(5);
    await tick(5);
    expect(t.asked.filter((a) => a.prompt.includes('Check its pass criteria'))).toHaveLength(2);
    tools.gate('safe', 'pass', 'all good');
    await tick(5);
    await tick(5);
    expect(t.plans.need(t.plan.id).runs.safe?.passedAt).toBeDefined();
    expect(issue(t, 'Refund endpoint').status).toBe('in_progress');
  });

  it('a task’s worktree knows the plan, its milestone and what runs beside it', async () => {
    const t = await running('gated');
    const auth = issue(t, 'Auth on payment routes');
    const brief = t.boardWork.forRun(`ws:${auth.worktrees.at(-1)}`, 'p-me')!.brief!;
    expect(brief).toContain('part of the plan “Payments”, milestone 1 “Safe payments”');
    expect(brief).toContain('“Idempotent webhooks” (touches src/webhooks)');
    expect(brief).toContain('status in_review');
  });

  it('paused: nothing starts', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.plans.setPaused(plan.id, true, t.me);
    t.work.approve(plan.id);
    await tick(5);
    expect(t.made).toHaveLength(0);
    expect(planView(t.plans.need(plan.id), t.store.getState().board).next.kind).toBe('resume');
  });

  it('warns about parallel tasks touching the same files', () => {
    const body = normalizeBody({ title: 'P', goal: '', milestones: [{ title: 'M', tasks: [{ id: 'a', title: 'A', touches: ['src/api'] }, { id: 'b', title: 'B', touches: ['src/api/x.ts'] }] }] });
    const fake = { active: body.milestones[0]!.tasks.map((task) => ({ task })) } as never;
    expect(overlaps(fake)).toHaveLength(1);
  });
});

describe('making a plan', () => {
  it('New Plan opens a conversation in the main folder, goes to the plan’s page, and asks Claude', async () => {
    const t = setup();
    const plan = await t.work.create({ projectId: 'api', goal: 'Add refunds to the admin' });
    expect(plan.home).toMatch(/^ws:c\d+$/);
    expect(t.intents).toEqual([{ type: 'navigate', view: { kind: 'plan', id: plan.id } }]);
    expect(t.asked).toEqual([{ prompt: 'Add refunds to the admin', channel: plan.home, echo: true }]);
    expect(t.work.forRun(plan.home, 'p-me')!.brief).toContain('a new plan, a draft only you and the user see');
  });

  it('or plans in the conversation you’re in; a friend’s run gets no plan', () => {
    const t = setup();
    const plan = t.work.here('ws:main');
    expect(planForHome(t.store.getState().plans, 'ws:main')?.id).toBe(plan.id);
    expect(t.work.here('ws:main').id).toBe(plan.id);
    expect(t.work.forRun('ws:main', 'p-bob')).toBeUndefined();
  });

  it('your planning style goes into Claude’s instructions', () => {
    const t = setup();
    t.work.setStyle('Always end with a docs milestone.');
    t.work.here('ws:main');
    expect(t.work.forRun('ws:main', 'p-me')!.brief).toContain('Always end with a docs milestone.');
  });

  it('the plan tools are all allowed, under their own server', () => {
    const t = setup();
    t.work.here('ws:main');
    const defs = createPlanToolDefs(t.work.forRun('ws:main', 'p-me')!.tools!);
    expect(defs.map((d) => `mcp__klaud_plan__${d.name}`)).toEqual(PLAN_TOOL_NAMES);
    for (const name of PLAN_TOOL_NAMES) expect(decideTool(name, {}, { cwd: '/tmp', roots: [], autoEdit: false, askOnly: true })).toBe('allow');
  });
});

describe('review fixes', () => {
  it('re-approving keeps what was changed on the board: briefs, canceled tasks', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'step' }, t.claude);
    const tools = t.work.forRun('ws:main', 'p-me')!.tools!;
    tools.write(BODY);
    t.work.approve(plan.id);
    const auth = t.store.getState().board.issues.find((i) => i.title === 'Auth on payment routes')!;
    const retries = t.store.getState().board.issues.find((i) => i.title === 'Idempotent webhooks')!;
    t.board.editBrief(auth.id, 'goal', 'Rewritten on the board.', t.me);
    t.board.update(retries.id, { status: 'canceled' }, t.me);
    tools.update([{ op: 'add_task', milestone: 'refunds', task: { id: 'docs', title: 'Docs' } }]);
    t.work.approve(plan.id);
    expect(t.board.need(auth.id).brief.goal).toBe('Rewritten on the board.');
    expect(t.board.need(retries.id).status).toBe('canceled');
  });

  it('an approval that fails partway keeps what it made: trying again makes nothing twice', () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    const relate = t.board.relate.bind(t.board);
    let fail = true;
    t.board.relate = ((...a: Parameters<typeof relate>) => {
      if (fail) throw new Error('disk full');
      return relate(...a);
    }) as typeof relate;
    expect(() => t.work.approve(plan.id)).toThrow('disk full');
    const made = t.store.getState().board.issues.length;
    expect(made).toBe(5);
    fail = false;
    t.work.approve(plan.id);
    expect(t.store.getState().board.issues).toHaveLength(5);
  });

  it('Claude can’t start tasks on a step-by-step or paused plan; you can', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'step' }, t.claude);
    const tools = t.work.forRun('ws:main', 'p-me')!.tools!;
    tools.write(BODY);
    t.work.approve(plan.id);
    await expect(tools.start('auth')).rejects.toThrow(/step by step/);
    expect(await t.work.startTask(plan.id, 'auth')).toContain('Started');
  });

  it('a task that failed to start doesn’t hold up the others', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.plans.setMaxParallel(plan.id, 1, t.me);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    let first = true;
    const start = t.boardWork.start.bind(t.boardWork);
    t.boardWork.start = (async (...a: Parameters<typeof start>) => {
      if (first) {
        first = false;
        throw new Error('no disk');
      }
      return start(...a);
    }) as typeof start;
    t.work.approve(plan.id);
    await tick(10);
    await tick(10);
    expect(t.store.getState().board.issues.filter((i) => i.status === 'in_progress')).toHaveLength(1);
  });

  it('the last milestone passing asks for the recap; a check can be asked again', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    t.work.forRun('ws:main', 'p-me')!.tools!.write({ title: 'Small', goal: '', milestones: [{ id: 'only', title: 'Only', criteria: ['works'], tasks: [{ id: 'x', title: 'X' }] }] });
    t.work.approve(plan.id);
    await tick(5);
    t.board.update(t.store.getState().board.issues[0]!.id, { status: 'done' }, t.me);
    await tick(5);
    expect(t.asked.filter((a) => a.prompt.includes('Check its pass criteria'))).toHaveLength(1);
    t.work.recheck(plan.id, 'only');
    await tick(5);
    expect(t.asked.filter((a) => a.prompt.includes('Check its pass criteria'))).toHaveLength(2);
    t.work.pass(plan.id, 'only');
    expect(t.plans.need(plan.id).status).toBe('done');
    expect(t.asked.at(-1)?.prompt).toContain('Write a short recap');
  });

  it('a message to a task’s Claude is labelled as the plan’s, not yours', async () => {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main' }, t.claude);
    const tools = t.work.forRun('ws:main', 'p-me')!.tools!;
    tools.write(BODY);
    t.work.approve(plan.id);
    await tick(5);
    tools.message('auth', 'Use signed cookies');
    const sent = t.asked.at(-1)!;
    expect(sent.echo).toBe(false);
    expect(sent.prompt).toContain('not the user');
  });
});

describe('milestones run side by side unless one builds on another', () => {
  /** Two milestones that share nothing, and one that builds on the first. */
  const SIDE: BodyInput = {
    title: 'Polish',
    goal: '',
    milestones: [
      { id: 'channels', title: 'Channels', criteria: ['@ works'], tasks: [{ id: 'mentions', title: 'Mentions' }] },
      { id: 'pilot', title: 'Parallel milestones', criteria: ['both open'], tasks: [{ id: 'runner', title: 'Runner' }] },
      { id: 'header', title: 'Plan header', criteria: ['drawn'], dependsOn: ['pilot'], tasks: [{ id: 'canvas', title: 'Canvas' }] },
    ],
  };

  async function running(body: BodyInput, autonomy: 'step' | 'gated' | 'autopilot' = 'gated', maxParallel = 3) {
    const t = setup();
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy }, t.claude);
    t.plans.setMaxParallel(plan.id, maxParallel, t.me);
    t.work.forRun('ws:main', 'p-me')!.tools!.write(body);
    t.work.approve(plan.id);
    await tick(5);
    const issue = (title: string) => t.store.getState().board.issues.find((i) => i.title === title)!;
    const view = () => planView(t.plans.need(plan.id), t.store.getState().board);
    return { ...t, plan, issue, view };
  }

  it('infers dependencies from blocked_by into other milestones; none without such links', () => {
    const body = normalizeBody(BODY);
    expect(milestoneDeps(body, body.milestones[1]!)).toEqual(['safe']);
    expect(milestoneDeps(body, body.milestones[0]!)).toEqual([]);
    const side = normalizeBody(SIDE);
    expect(side.milestones.map((m) => milestoneDeps(side, m))).toEqual([[], [], ['pilot']]);
    // Said outright, it wins over what blockers would say ([]: alongside from the start).
    const said = normalizeBody({ ...BODY, milestones: [BODY.milestones[0]!, { ...BODY.milestones[1]!, dependsOn: [] }] });
    expect(milestoneDeps(said, said.milestones[1]!)).toEqual([]);
  });

  it('refuses depends_on a later or unknown milestone', () => {
    expect(() => normalizeBody({ title: 'P', goal: '', milestones: [{ id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B' }] })).toThrow(/comes after it/);
    expect(() => normalizeBody({ title: 'P', goal: '', milestones: [{ id: 'a', title: 'A', dependsOn: ['zz'] }] })).toThrow(/isn't in the plan/);
  });

  it('two independent milestones both open and start; a dependent one waits in the Backlog', async () => {
    const t = await running(SIDE);
    expect(t.view().open.map((m) => m.milestone.id)).toEqual(['channels', 'pilot']);
    expect(t.issue('Mentions').status).toBe('in_progress');
    expect(t.issue('Runner').status).toBe('in_progress');
    expect(t.issue('Canvas').status).toBe('backlog');
    expect(t.view().milestones[2]).toMatchObject({ state: 'later', dependsOn: ['pilot'] });
    expect(t.view().milestones[2]!.tasks[0]).toMatchObject({ state: 'later', why: 'Starts after “Parallel milestones”' });
  });

  it('each milestone has its own check and pass; passing one opens what waited on it', async () => {
    const t = await running(SIDE);
    t.board.update(t.issue('Runner').id, { status: 'in_review' }, t.claude);
    await tick(5);
    const checks = t.asked.filter((a) => a.prompt.includes('Check its pass criteria'));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.prompt).toContain('Parallel milestones');
    expect(t.view().milestones.map((m) => m.state)).toEqual(['running', 'checking', 'later']);
    // While the head Claude checks, the plan waits on Claude, not on you.
    expect(t.view().next).toMatchObject({ kind: 'checking', milestone: { milestone: { id: 'pilot' } } });
    t.work.pass(t.plan.id, 'pilot');
    await tick(5);
    expect(t.view().open.map((m) => m.milestone.id)).toEqual(['channels', 'header']);
    expect(t.issue('Canvas').status).toBe('in_progress');
    expect(t.plans.need(t.plan.id).status).toBe('active');
  });

  it('the limit on tasks at once is the whole plan’s', async () => {
    const t = await running(SIDE, 'gated', 1);
    expect(t.made).toHaveLength(1);
  });

  it('autopilot passes an independent milestone on its own check while the other still runs', async () => {
    const t = await running(SIDE, 'autopilot');
    t.board.update(t.issue('Mentions').id, { status: 'done' }, t.me);
    await tick(5);
    t.work.forRun('ws:main', 'p-me')!.tools!.gate('channels', 'pass', '@ ✓');
    await tick(5);
    expect(t.plans.need(t.plan.id).runs.channels?.passedAt).toBeDefined();
    expect(t.view().milestones.map((m) => m.state)).toEqual(['passed', 'running', 'later']);
  });

  it('step by step applies per milestone: Claude starts nothing there, but the other milestone runs', async () => {
    const t = await running({ ...SIDE, milestones: [{ ...SIDE.milestones[0]!, autonomy: 'step' }, ...SIDE.milestones.slice(1)] });
    expect(t.issue('Mentions').status).toBe('todo');
    expect(t.issue('Runner').status).toBe('in_progress');
    expect(t.view().next).toMatchObject({ kind: 'start', tasks: [{ task: { id: 'mentions' } }] });
    await expect(t.work.forRun('ws:main', 'p-me')!.tools!.start('mentions')).rejects.toThrow(/step by step/);
  });

  it('plan_write / plan_update take depends_on; plan_get says what runs alongside and after what', async () => {
    const write = milestoneInput({ id: 'b', title: 'B', criteria: [], depends_on: ['a'], tasks: [{ title: 'T', blocked_by: ['x'] }] });
    expect(write).toMatchObject({ dependsOn: ['a'], tasks: [{ title: 'T', blockedBy: ['x'] }] });
    expect(toOps([{ op: 'update_milestone', id: 'b', depends_on: [] }])).toEqual([{ op: 'update_milestone', id: 'b', dependsOn: [] }]);
    expect(toOps([{ op: 'add_milestone', milestone: { title: 'C', depends_on: ['b'] } }])[0]).toMatchObject({ op: 'add_milestone', milestone: { title: 'C', dependsOn: ['b'] } });
    const t = await running(SIDE);
    const tools = t.work.forRun('ws:main', 'p-me')!.tools!;
    tools.update(toOps([{ op: 'update_milestone', id: 'header', depends_on: [] }]));
    expect(t.plans.need(t.plan.id).draft!.milestones[2]!.dependsOn).toEqual([]);
    const got = tools.get();
    expect(got).toContain('Depends on no other milestone; runs alongside channels “Channels”, pilot “Parallel milestones”');
    t.work.discard(t.plan.id);
    expect(tools.get()).toContain('Runs after pilot “Parallel milestones”; runs alongside channels “Channels”.');
  });
});
