import { type BoardState, STATUS_INFO, filterIssues } from '../board/model.js';
import { AUTONOMY_INFO, type Plan, type PlanBody, TESTS_AT_INFO, diffBodies, shownBody } from './model.js';
import { type MilestoneView, type PlanView, type TaskView, overlaps } from './progress.js';

/**
 * Plans in Claude's words: how to plan (in the plan's conversation, with the user's planning
 * style), how to run an approved plan (the head Claude), a plan as plan_get shows it, and what a
 * task's worktree is told about the plan it's part of.
 */

const STATE_WORDS: Readonly<Record<TaskView['state'], string>> = {
  draft: 'draft',
  later: 'later milestone',
  blocked: 'blocked',
  ready: 'ready to start',
  running: 'Claude working',
  asking: 'waiting for an answer',
  idle: 'in progress, nobody working right now',
  review: 'in review',
  done: 'done',
  canceled: 'canceled',
  missing: 'its task was deleted',
};

const MILESTONE_WORDS: Readonly<Record<MilestoneView['state'], string>> = {
  draft: 'draft',
  later: 'not started',
  running: 'in progress',
  checking: 'being checked',
  gate: 'finished, waiting to be passed',
  failed: 'check failed',
  passed: 'passed',
};

/** How plans are cut: what the planner Claude is told (plus the user's own style). */
const HOW_TO_PLAN = [
  'How to cut a good plan:',
  '- Read the code first (it\'s read-only here): plan from how things really are, and name real files in context.',
  '- Milestones are steps that each leave something working and checkable. Each has pass criteria: concrete,',
  '  verifiable statements (a command that passes, a behaviour you can see), not vague goals.',
  '- Tasks are sized for one worktree and one pull request: an estimate of 1, 2, 3 or 5 points (8 means split it).',
  '- Make work parallel: tasks only wait on (blocked_by) tasks whose code they really build on, even across',
  '  milestones. Tasks without blockers run side by side in their own worktrees, so give each task its `touches`',
  '  (files or folders it changes) and avoid two parallel tasks touching the same ones.',
  '- Every task has a goal in your own words, the context someone new needs, and acceptance criteria. Use',
  '  sub-tasks (parent) only for a task that is really several steps. Default assignee is Claude; use "me" for',
  '  what only the user can do (accounts, secrets, decisions).',
  '- Use short, stable ids (like "auth-api"): keep them when you revise, so tasks keep their history.',
  '- Ask for proof that fits: a task writes the tests it needs and runs typecheck and those tests; the e2e and full',
  '  suites run once per milestone, at its check, on the combined work (or only at the end, if the plan says so).',
  '  Don\'t make every task run the full suite.',
].join('\n');

/** Under load (other worktrees testing too) a slow moment fails a test: it counts only if it fails alone too. */
const UNDER_LOAD = 'A failure that looks like load (a timeout, "did not start", a flaky wait while the Mac is busy: see `uptime`) counts only if it fails again when re-run once, alone.';

/** How the e2e suite is run on this Mac: one run at a time, machine-wide; it waits its turn. */
const E2E_LOCK = 'Run the Mac e2e with `npm run e2e` in packages/mac: one e2e runs at a time on this Mac (it waits, saying whose run it waits for), with its own port and demo home, and stops everything it started when it ends.';

/** What a task runs, by the plan's test timing. */
export function taskTestsNote(plan: Pick<Plan, 'testsAt'>): string {
  return [
    'Tests: write the tests this task needs. Run only typecheck and the unit-test files you added or changed (for example',
    '`npx vitest run tests/that.test.ts`), not the e2e or the full suites: ' +
      (plan.testsAt === 'end' ? 'this plan runs those once, in its final step.' : 'they run once per milestone, at its check, on the combined work.'),
    UNDER_LOAD,
  ].join('\n');
}

/** What a milestone's check runs, by the plan's test timing (and whether it's the last milestone). */
export function checkTestsNote(plan: Pick<Plan, 'testsAt'>, last: boolean): string {
  if (plan.testsAt === 'end' && !last) return 'This plan runs its test suites only at the end: don\'t run them for this check. Check by reading the code, the diffs, the tests the tasks wrote and their typecheck.';
  return [
    last && plan.testsAt === 'end' ? 'This is the final step: run every test now, once, on the plan\'s combined work: typecheck, the full unit suite and the e2e.' : 'Run the full unit suite and the e2e once for this milestone, on its combined work (not per task): typecheck, the full unit suite, the e2e.',
    'Combine the tasks\' branches in one temporary worktree (git worktree add --detach, then merge each branch), run there, and remove it after.',
    E2E_LOCK,
    UNDER_LOAD,
  ].join('\n');
}

/** Planning (a draft, or changes to an approved plan): in the plan's home conversation. */
export function planningBrief(plan: Plan, board: BoardState, style: string): string {
  const existing = filterIssues(board, { projectId: plan.projectId, scope: 'all' })
    .filter((i) => i.status !== 'canceled' && i.plan?.id !== plan.id)
    .slice(0, 30)
    .map((i) => `- ${i.key} · ${STATUS_INFO[i.status].label} · ${i.title}`);
  const body = shownBody(plan);
  return [
    '',
    '<klaud_plan_mode>',
    `This conversation is planning in klaud's Plans: ${plan.body ? 'an approved plan (changes you make are proposed; the user approves them)' : 'a new plan, a draft only you and the user see'}.`,
    'Write the plan with the plan tools (mcp__klaud_plan__*): plan_write for the whole plan, plan_update for changes,',
    'plan_get to see it. Nothing reaches the task board until the user approves the plan; you can\'t approve it yourself.',
    plan.body && plan.autonomy === 'autopilot' ? 'This plan runs on autopilot: changes you make to it now apply at once and can start work, so change only what the plan needs.' : '',
    'Don\'t move to a worktree or change code here: this conversation is for planning.',
    body?.milestones.length ? 'The plan already has content: revise it with plan_update unless the user wants it rewritten.' : 'The plan is empty: understand what the user wants (ask only what you can\'t find out), read the code, then plan_write.',
    'After writing, answer briefly: the milestones in a line each, what runs in parallel, risks and open questions. Then the user',
    'approves, or tells you what to change.',
    '',
    HOW_TO_PLAN,
    style.trim() ? `\nThe user's planning style (follow it):\n<planning_style>\n${style.replace(/<\/?planning_style>/gi, '').trim()}\n</planning_style>` : '',
    existing.length ? `\nTasks already on this project's board (don't duplicate them; a plan task can say it builds on one in its context):\n${existing.join('\n')}` : '',
    '</klaud_plan_mode>',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

/** Running an approved plan: the head Claude's instructions and where things stand. */
export function headBrief(view: PlanView): string {
  const plan = view.plan;
  const m = view.current;
  const warnings = overlaps(view).map(([a, b, files]) => `- “${a.task.title}” and “${b.task.title}” both touch ${files.join(', ')}`);
  return [
    '',
    '<klaud_plan_head>',
    `You are the head of the plan “${shownBody(plan)?.title ?? 'plan'}” in klaud's Plans (${AUTONOMY_INFO[m?.autonomy ?? plan.autonomy].label}: ${AUTONOMY_INFO[m?.autonomy ?? plan.autonomy].hint.toLowerCase()}).`,
    'Each task runs in its own worktree with its own Claude; klaud starts what\'s ready (up to the plan\'s limit) and',
    'moves to the next milestone when one passes. You coordinate:',
    '- plan_get: the plan and the state of every task (who\'s working, what waits on what).',
    '- plan_message_task: tell a task\'s Claude something (a decision, a heads-up about another task).',
    '- plan_start_task: start a ready task now (when the user asks).',
    '- plan_gate: after checking a finished milestone\'s pass criteria, pass or fail it with notes per criterion.',
    '  Check for real: read the tasks\' briefs, handoffs and proof, their pull requests and diffs (git diff main...branch).',
    '- plan_update: change the plan (new tasks to fix what failed, a re-cut). The user approves changes',
    '  unless the plan runs on autopilot.',
    `Tests: ${TESTS_AT_INFO[plan.testsAt].hint.toLowerCase()}. Don't ask a task to run the full suite.`,
    plan.paused ? 'The plan is paused: nothing starts until the user resumes it.' : '',
    m ? `Now: milestone “${m.milestone.title}” (${MILESTONE_WORDS[m.state]}), ${m.finished}/${m.total} tasks finished; ${view.active.length} in progress, ${view.ready.length} ready.` : 'Every milestone has passed.',
    warnings.length ? `Running side by side and touching the same files (watch for conflicts):\n${warnings.join('\n')}` : '',
    '</klaud_plan_head>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A plan as plan_get shows it: milestones, tasks with ids and states, and what changed if a draft waits. */
export function describePlan(view: PlanView): string {
  const plan = view.plan;
  const body = shownBody(plan);
  if (!body) return 'The plan is empty.';
  const live = new Map(view.milestones.flatMap((m) => m.tasks.map((t) => [t.task.id, t] as const)));
  const lines = [`# ${body.title}`, body.goal ? `\n${body.goal}` : '', `\nStatus: ${plan.status}${plan.paused ? ' (paused)' : ''} · autonomy ${plan.autonomy} · up to ${plan.maxParallel} tasks at once · tests ${plan.testsAt === 'end' ? 'only at the end' : 'each milestone'}`];
  if (plan.draft && plan.body) {
    const d = diffBodies(plan.body, plan.draft);
    lines.push(`Changes waiting for the user's approval: ${d.added.length} new, ${d.changed.length} changed, ${d.removed.length} removed (shown below as proposed).`);
  } else if (!plan.body) lines.push('Draft: not approved yet.');
  body.milestones.forEach((m, i) => {
    const mv = view.milestones.find((x) => x.milestone.id === m.id);
    lines.push('', `## ${i + 1}. ${m.title} [id ${m.id}]${mv && plan.body ? ` — ${MILESTONE_WORDS[mv.state]}` : ''}${m.autonomy ? ` · ${m.autonomy}` : ''}`);
    if (m.goal) lines.push(m.goal);
    if (m.criteria.length) lines.push('Pass criteria:', ...m.criteria.map((c) => `- ${c}`));
    if (mv?.run.check) lines.push(`Last check (${mv.run.check.verdict}): ${mv.run.check.notes.slice(0, 600)}`);
    for (const t of m.tasks) {
      const tv = plan.draft ? undefined : live.get(t.id);
      const facts = [
        tv ? STATE_WORDS[tv.state] : undefined,
        tv?.issue?.key,
        t.estimate ? `${t.estimate} pts` : undefined,
        t.blockedBy.length ? `waits on ${t.blockedBy.join(', ')}` : undefined,
        t.parent ? `sub-task of ${t.parent}` : undefined,
        t.assignee === 'me' ? 'for the user' : undefined,
        tv?.step ? `now: ${tv.step}` : undefined,
      ].filter(Boolean);
      lines.push(`- [${t.id}] ${t.title}${facts.length ? ` (${facts.join(' · ')})` : ''}`);
      if (t.touches?.length) lines.push(`  touches: ${t.touches.join(', ')}`);
    }
  });
  return lines.filter((l) => l !== '').join('\n');
}

/** Ask the head Claude to check a finished milestone. */
export function checkPrompt(view: PlanView, m: MilestoneView): string {
  const tasks = m.tasks.map((t) => `- ${t.issue?.key ?? t.task.id} “${t.task.title}” (${STATE_WORDS[t.state]}${t.issue?.pr ? `, PR #${t.issue.pr.number} ${t.issue.pr.state.toLowerCase()}` : ''}${t.issue?.branch ? `, branch ${t.issue.branch}` : ''})`);
  return [
    `Every task of milestone “${m.milestone.title}” is finished. Check its pass criteria for real, one by one:`,
    ...m.milestone.criteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    'Its tasks:',
    ...tasks,
    '',
    'Read their briefs (task_get), handoffs, proof and diffs.',
    checkTestsNote(view.plan, m.index === view.milestones.length - 1),
    'Then call plan_gate with pass or fail and notes that say,',
    `per criterion, what you checked and found.${m.autonomy === 'autopilot' ? ' On pass, the plan moves on by itself.' : ' The user decides whether it passes.'} If it fails, add the`,
    'fix tasks with plan_update.',
  ].join('\n');
}

/** The plan is done: a short recap in its conversation. */
export function recapPrompt(view: PlanView): string {
  return [
    `Every milestone of “${view.body?.title ?? 'the plan'}” has passed. Write a short recap for the user: what was built, per`,
    'milestone, with links to pull requests, what was decided along the way, and anything left over. Include a klaud-graph',
    'of what changed when it helps.',
  ].join('\n');
}

/** What a task's worktree is told about the plan it's part of (and what runs beside it). */
export function workerNote(view: PlanView, taskId: string): string {
  const me = view.milestones.flatMap((m) => m.tasks).find((t) => t.task.id === taskId);
  const m = view.milestones.find((x) => x.tasks.some((t) => t.task.id === taskId));
  if (!me || !m) return '';
  const beside = view.active.filter((t) => t.task.id !== taskId).map((t) => `- ${t.issue?.key ?? t.task.id} “${t.task.title}”${t.task.touches?.length ? ` (touches ${t.task.touches.join(', ')})` : ''}`);
  return [
    '',
    `This task is part of the plan “${view.body?.title ?? ''}”, milestone ${m.index + 1} “${m.milestone.title}”.`,
    m.milestone.criteria.length ? `The milestone passes when: ${m.milestone.criteria.join('; ')}.` : '',
    me.task.touches?.length ? `This task's area: ${me.task.touches.join(', ')}.` : '',
    beside.length ? `Running beside it now, each in its own worktree (stay out of their areas):\n${beside.join('\n')}` : '',
    taskTestsNote(view.plan),
    'When every acceptance criterion is true and the checks pass, commit your work, rewrite the handoff, and call',
    'task_update with status in_review: that tells the plan this task is finished. Ask the user only what you must.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Words for a body's size ("3 milestones, 11 tasks"). */
export function sizeWords(body: PlanBody | undefined): string {
  const m = body?.milestones.length ?? 0;
  const t = body?.milestones.reduce((n, x) => n + x.tasks.length, 0) ?? 0;
  return `${m} ${m === 1 ? 'milestone' : 'milestones'}, ${t} ${t === 1 ? 'task' : 'tasks'}`;
}
