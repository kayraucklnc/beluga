import type { PlanTools } from '../../agent/types.js';
import type { Actor, Issue } from '../board/model.js';
import type { BoardWork } from '../board/work.js';
import type { CombineResult } from '../../workspaces/git.js';
import type { Intent } from '../intents.js';
import type { Store } from '../store.js';
import type { WorkspaceController } from '../workspace-controller.js';
import { ApplyError, applyDraft } from './apply.js';
import type { BodyInput, PlanOp, TaskInput } from './edit.js';
import { type Autonomy, type Plan, type TestsAt, allTasks, planForHome, planTaskOfIssue, planTitle } from './model.js';
import { PlanPilot } from './pilot.js';
import { type PlanGit, planGitOf } from './plan-git.js';
import { type Plans, UNTITLED } from './plans.js';
import { describePlan, headBrief, planningBrief, sizeWords, workerNote } from './prompt.js';

/**
 * Plans at work: making a plan (its own conversation, in the project's main folder where Claude
 * only reads), approving it onto the board, running it (the pilot), and what Claude gets: the
 * plan's tools in its home conversation, and the plan a task belongs to in that task's worktree.
 */

export interface PlansWorkDeps {
  readonly store: Store;
  readonly plans: Plans;
  readonly board: BoardWork;
  readonly controller?: WorkspaceController;
  /** Ask your Claude in a conversation; returns the request's id, when it can (to follow a steered message). */
  readonly askClaude: (prompt: string, channel: string, echo: boolean) => string | void;
  /** Steer a waiting message in now: the agent host's Steer Now (AgentHost.promote). */
  readonly promote?: (requestId: string) => boolean;
  readonly intend: (intent: Intent) => void;
  /** Combining a task's start from several branches (default: the project's folder, through the controller). */
  readonly combine?: (projectId: string, key: string, branches: readonly string[], into?: string) => Promise<CombineResult>;
  /** The plan's branch and pull request (default: the project's folder, through the controller; null: none). */
  readonly git?: PlanGit | null;
  /** The agent runner's run state, and taking over a stalled conversation (see watchdog.ts). */
  readonly alive?: (channel: string) => boolean;
  readonly takeOver?: (channel: string) => Promise<readonly string[]>;
  readonly now?: () => number;
  /** A short name for a new plan from its goal (a quick model call; undefined when there's none). */
  readonly titlePlan?: (goal: string) => Promise<string | undefined>;
  readonly delayMs?: number;
}

const WS = 'ws:';

export class PlansWork {
  readonly plans: Plans;
  readonly pilot: PlanPilot;

  constructor(private readonly deps: PlansWorkDeps) {
    this.plans = deps.plans;
    const git = deps.git === null ? undefined : (deps.git ?? (deps.controller?.manager ? planGitOf(deps.controller) : undefined));
    this.pilot = new PlanPilot({
      store: deps.store,
      plans: deps.plans,
      work: deps.board,
      askClaude: deps.askClaude,
      system: (channel, text) => deps.store.dispatch({ type: 'system', channel, text, level: 'info' }),
      ...(deps.combine ? { combine: deps.combine } : deps.controller ? { combine: (projectId, key, branches, into) => deps.controller!.manager.combineBase(projectId, key, branches, into) } : {}),
      ...(git ? { git } : {}),
      ...(deps.controller ? { allowFixup: (channel, dir) => deps.controller!.allowFixup?.(channel, dir) } : {}),
      ...(deps.alive ? { alive: deps.alive } : {}),
      ...(deps.takeOver ? { takeOver: deps.takeOver } : {}),
      ...(deps.promote ? { promote: deps.promote } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.delayMs !== undefined ? { delayMs: deps.delayMs } : {}),
    });
    // A task of a plan: its worktree's Claude knows the plan and what runs beside it.
    deps.board.setBriefExtra((issue) => this.workerBrief(issue));
  }

  stop(): void {
    this.pilot.stop();
    this.plans.flush();
  }

  private me = (): Actor => this.deps.board.me();
  private claude = (): Actor => this.deps.board.myClaude();

  // ------------------------------------------------------------------ for you (the API)

  /**
   * A new plan with Claude: a conversation of its own in the project's main folder (Claude reads
   * the code there and changes nothing), and the plan's page. Claude starts planning from `goal`.
   */
  async create(input: { readonly projectId: string; readonly goal: string; readonly autonomy?: Autonomy; readonly testsAt?: TestsAt }): Promise<Plan> {
    const controller = this.deps.controller;
    if (!controller) throw new Error('Plans need a project folder');
    const goal = input.goal.trim();
    if (!goal) throw new Error('Say what the plan is for');
    const chat = await controller.newChat(input.projectId, UNTITLED, undefined, { quiet: true });
    if (!chat) throw new Error('Couldn’t start the plan’s conversation');
    const home = `${WS}${chat.id}`;
    const plan = this.plans.create({ projectId: input.projectId, home, goal, ...(input.autonomy ? { autonomy: input.autonomy } : {}), ...(input.testsAt ? { testsAt: input.testsAt } : {}) }, this.me());
    this.deps.intend({ type: 'navigate', view: { kind: 'plan', id: plan.id } });
    this.deps.askClaude(goal, home, true);
    // Named in a moment by a quick model (your message is never its name); Claude's plan_write names it after that.
    void this.deps
      .titlePlan?.(goal)
      .then((title) => {
        const named = title ? this.plans.autoTitle(plan.id, title) : undefined;
        if (named) this.nameHome(named, UNTITLED);
      })
      .catch(() => undefined);
    return plan;
  }

  /** A plan's own conversation goes by the plan's name (in the sidebar too), unless you renamed it. */
  private nameHome(plan: Plan, was: string): void {
    const title = planTitle(plan);
    if (title === was || !plan.home.startsWith(WS)) return;
    const ws = this.deps.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === plan.home.slice(WS.length));
    if (ws?.kind === 'chat' && (ws.name === UNTITLED || ws.name === was.slice(0, 40))) void this.deps.controller?.renameChat(ws.id, title);
  }

  /** A plan's own conversation, made quietly (the demo's plan). */
  async homeFor(projectId: string, title: string): Promise<string | undefined> {
    const chat = await this.deps.controller?.newChat(projectId, `Plan: ${title}`, undefined, { quiet: true });
    return chat ? `${WS}${chat.id}` : undefined;
  }

  /** Plan in the conversation you're in (the composer's Plan with Tasks): an empty draft, written from what you say next. */
  here(channel: string, autonomy?: Autonomy): Plan {
    const existing = planForHome(this.plans.state(), channel);
    if (existing && existing.status !== 'done') return existing;
    const ws = channel.startsWith(WS) ? this.deps.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === channel.slice(WS.length)) : undefined;
    const project = ws ? this.deps.store.getState().projects.find((p) => p.id === ws.projectId && p.root) : undefined;
    if (!ws || !project) throw new Error('Plans belong to a project: start one from a conversation in a project');
    return this.plans.create({ projectId: project.id, home: channel, ...(autonomy ? { autonomy } : {}) }, this.me());
  }

  /** Approve the draft: its tasks go on the board, and the plan runs (or carries on with the changes). */
  approve(id: string, by: Actor = this.me()): Plan {
    const plan = this.plans.need(id);
    let applied: ReturnType<typeof applyDraft>;
    try {
      applied = applyDraft(plan, this.deps.board.board, { by, me: this.deps.board.me(), claude: this.deps.board.myClaude() });
    } catch (err) {
      // What was made stays linked to the draft, so approving again doesn't make it twice.
      if (err instanceof ApplyError) this.plans.linkDraft(id, err.linked);
      throw err;
    }
    const { body, summary } = applied;
    const done = this.plans.approved(id, body, by, summary);
    this.deps.store.dispatch({ type: 'system', channel: plan.home, text: plan.body ? `Changes applied: ${summary}.` : `Plan approved: ${summary} are on the board now.`, level: 'info' });
    this.pilot.schedule();
    return done;
  }

  discard(id: string): Plan | undefined {
    return this.plans.discard(id, this.me());
  }

  /** Your changes: an approved plan without waiting changes takes them at once (you're the one approving). */
  edit(id: string, ops: readonly PlanOp[]): Plan {
    const plan = this.plans.need(id);
    const retitle = ops.length === 1 && ops[0]!.op === 'retitle' && ops[0]!.goal === undefined && ops[0]!.title !== undefined;
    if (retitle) {
      const named = this.plans.retitle(id, ops[0]!.op === 'retitle' ? ops[0]!.title! : '', this.me());
      this.nameHome(named, planTitle(plan));
      return named;
    }
    const direct = Boolean(plan.body) && !plan.draft;
    const next = this.plans.editDraft(id, ops, this.me());
    return direct && next.draft ? this.approve(id) : next;
  }

  setAutonomy(id: string, autonomy: Autonomy, milestone?: string): Plan {
    const plan = this.plans.setAutonomy(id, autonomy, this.me(), milestone);
    this.pilot.schedule();
    return plan;
  }

  setPaused(id: string, paused: boolean): Plan {
    const plan = this.plans.setPaused(id, paused, this.me());
    this.pilot.schedule();
    return plan;
  }

  setParallel(id: string, n: number): Plan {
    const plan = this.plans.setMaxParallel(id, n, this.me());
    this.pilot.schedule();
    return plan;
  }

  /** When the plan runs its test suites: each milestone's check, or only the final step. */
  setTestsAt(id: string, testsAt: TestsAt): Plan {
    return this.plans.setTestsAt(id, testsAt, this.me());
  }

  pass(id: string, milestone: string): Plan {
    return this.pilot.pass(id, milestone, this.me());
  }

  /** “Tidy up N merged task worktrees?”: only Yes merges and clears them away (see PlanPilot.tidyUp). */
  tidyUp(id: string, yes: boolean): Plan {
    return this.pilot.tidyUp(id, yes, this.me());
  }

  /** Not yet: what's missing goes to the head Claude, which adds the work to the plan. */
  sendBack(id: string, milestone: string, note: string): Plan {
    const plan = this.plans.need(id);
    const m = plan.body?.milestones.find((x) => x.id === milestone);
    if (!m) throw new Error('That milestone isn’t in the approved plan');
    const text = note.trim();
    if (!text) throw new Error('Say what’s missing');
    this.plans.note(id, 'failed', `sent “${m.title}” back: ${text}`, this.me());
    this.deps.askClaude(`Milestone “${m.title}” isn't done yet: ${text}\n\nAdd the tasks that fix it to this milestone with plan_update (the user approves them), or tell me what you need.`, plan.home, true);
    return this.plans.need(id);
  }

  /** Ask the head Claude to check a milestone again. */
  recheck(id: string, milestone: string): Plan {
    this.pilot.recheck(id, milestone);
    return this.plans.need(id);
  }

  /** The plan's pull request (its branch → main), merging it on GitHub, or merging the branch here. */
  openPr(id: string): Promise<Plan> {
    return this.pilot.openPr(id);
  }

  mergePr(id: string): Promise<Plan> {
    return this.pilot.mergePr(id);
  }

  mergeLocal(id: string): Promise<Plan> {
    return this.pilot.mergeLocal(id);
  }

  startTask(id: string, task: string): Promise<string> {
    return this.pilot.startNow(id, task, this.me());
  }

  /** Wake a task whose Claude stopped without finishing (Resume on its card). */
  resumeTask(id: string, task: string): string {
    return this.pilot.resume(id, task);
  }

  remove(id: string): void {
    this.plans.remove(id);
  }

  setStyle(text: string): void {
    this.plans.setStyle(text);
  }

  // ------------------------------------------------------------------ for Claude

  /** A run in a plan's home conversation (yours): the plan's tools, and how to plan or run it. */
  forRun(channel: string, from: string): { readonly tools?: PlanTools; readonly brief?: string } | undefined {
    const me = this.deps.board.me();
    if (me.kind !== 'person' || from !== me.id) return undefined;
    const plan = planForHome(this.plans.state(), channel);
    if (!plan) return undefined;
    const board = this.deps.store.getState().board;
    const view = this.pilot.view(plan);
    const brief = plan.body ? headBrief(view) + planningBrief(plan, board, this.plans.planningStyle) : planningBrief(plan, board, this.plans.planningStyle);
    return { tools: this.toolsFor(plan.id), brief };
  }

  /** In a task's worktree: the plan it's part of. */
  private workerBrief(issue: Issue): string {
    const hit = planTaskOfIssue(this.plans.state(), issue.id);
    if (!hit || hit.plan.status !== 'active') return '';
    return workerNote(this.pilot.view(hit.plan), hit.task.id);
  }

  /** A task Claude says is an existing board task (its key): that task, adopted into the plan. */
  private adopt<T extends Partial<TaskInput> & { readonly issue?: string }>(t: T, planId: string): T {
    if (!t.issue) return t;
    const { issue: key, ...rest } = t;
    const issue = this.deps.board.board.get(key);
    const plan = this.plans.need(planId);
    if (!issue) throw new Error(`There's no task ${key} on the board`);
    if (issue.projectId !== plan.projectId) throw new Error(`${issue.key} belongs to another project`);
    if (issue.plan && issue.plan.id !== planId) throw new Error(`${issue.key} is already part of another plan`);
    return { ...rest, issueId: issue.id } as T;
  }

  private toolsFor(planId: string): PlanTools {
    const plans = this.plans;
    const after = (change: () => Plan): string => {
      const was = planTitle(plans.need(planId));
      const plan = change();
      this.nameHome(plan, was);
      if (!plan.draft) return 'The plan is unchanged.';
      // On autopilot, the head Claude's changes to a running plan apply at once.
      if (plan.body && plan.autonomy === 'autopilot') {
        const applied = this.approve(plan.id, this.claude());
        return `Applied at once (the plan runs on autopilot): ${sizeWords(applied.body)}.`;
      }
      return plan.body ? `Proposed (${sizeWords(plan.draft)}): the user reviews the changes and applies them.` : `Saved the draft (${sizeWords(plan.draft)}). The user reviews it and clicks Approve; nothing is on the board until then.`;
    };
    return {
      get: () => describePlan(this.pilot.view(plans.need(planId))),
      write: (body: BodyInput) => after(() => plans.writeDraft(planId, { ...body, milestones: body.milestones.map((m) => ({ ...m, tasks: (m.tasks ?? []).map((t) => this.adopt(t, planId)) })) }, this.claude())),
      update: (ops: readonly PlanOp[], reason?: string) =>
        after(() =>
          plans.editDraft(
            planId,
            ops.map((o) => (o.op === 'add_task' ? { ...o, task: this.adopt(o.task, planId) } : o.op === 'update_task' ? { ...o, patch: this.adopt(o.patch, planId) } : o.op === 'add_milestone' ? { ...o, milestone: { ...o.milestone, tasks: (o.milestone.tasks ?? []).map((t) => this.adopt(t, planId)) } } : o)),
            this.claude(),
            reason,
          ),
        ),
      gate: (milestone, verdict, notes) => {
        const plan = plans.need(planId);
        const m = plan.body?.milestones.find((x) => x.id === milestone || x.title.toLowerCase() === milestone.toLowerCase());
        if (!m) throw new Error(`There's no milestone "${milestone}" in the approved plan (milestones: ${(plan.body?.milestones ?? []).map((x) => x.id).join(', ')})`);
        plans.recordCheck(planId, m.id, { by: this.claude(), verdict, notes });
        this.pilot.schedule();
        const auto = (m.autonomy ?? plan.autonomy) === 'autopilot';
        return verdict === 'pass' ? (auto ? 'Recorded: the milestone passes and the plan moves on.' : 'Recorded: the user passes the milestone.') : 'Recorded as failed. Add the fix tasks with plan_update.';
      },
      start: (task) => this.pilot.startNow(planId, task, this.claude()),
      message: (task, text, mode = 'queue') => {
        const plan = plans.need(planId);
        const hit = allTasks(plan.body).find((t) => t.task.id === task || (t.task.issueId && this.deps.board.board.get(t.task.issueId)?.key === task.toUpperCase()));
        if (!hit?.task.issueId) throw new Error(`There's no task "${task}" on the board from this plan`);
        const issue = this.deps.board.board.need(hit.task.issueId);
        const w = issue.worktrees.at(-1);
        if (!w || issue.worktreeGone) throw new Error(`${issue.key} hasn't started: nothing to tell yet (start it, or change its brief)`);
        const steer = mode === 'steer';
        // Shown there as the plan's message, not as yours.
        this.deps.store.dispatch({ type: 'system', channel: `${WS}${w}`, text: `${steer ? 'Urgent, from' : 'From'} the plan’s Claude: ${text.trim().slice(0, 2000)}`, level: 'info' });
        const prompt = `${steer ? 'An urgent message' : 'A message'} from the head of the plan “${plan.body?.title ?? ''}” (another Claude coordinating the plan, not the user):\n\n${text.trim()}`;
        const id = this.deps.askClaude(prompt, `${WS}${w}`, false);
        if (!steer) return `Queued for the Claude working on ${issue.key}: it reads it when its current turn ends (its card shows it waiting; use mode "steer" if it can't wait)`;
        // Steered: in now (interrupting a long command or a dead run), and followed until it's read.
        if (id) this.pilot.steer(planId, hit.task.id, id, prompt);
        return `Steered into ${issue.key}: its Claude gets it now (a long command or a stuck turn is interrupted). If it isn't read within 2 minutes, Klaud delivers it again`;
      },
    };
  }
}
