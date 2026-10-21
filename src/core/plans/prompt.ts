import { type BoardState, STATUS_INFO, filterIssues } from '../board/model.js';
import { AUTONOMY_INFO, type Plan, type PlanBody, diffBodies, milestoneDeps, shownBody } from './model.js';
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
  later: 'waiting on earlier milestones',
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
  '- Plan only what the work needs: as few milestones and tasks as it takes, not more. One milestone is fine for',
  '  small work, and one task per milestone is fine. Don\'t split for the sake of it: a split must buy something',
  '  (work that really runs in parallel, a checkpoint the user wants to see).',
  '- Milestones are steps that each leave something working and checkable. Each has pass criteria: concrete,',
  '  verifiable statements (a command that passes, a behaviour you can see), not vague goals.',
  '- Milestones run side by side unless one really builds on another: set depends_on (earlier milestone ids)',
  '  only then. Left out, it\'s inferred from tasks\' blocked_by into other milestones; [] means no dependency.',
  '- Tasks are sized for one worktree and one pull request: an estimate of 1, 2, 3 or 5 points (8 means split it).',
  '- Make work parallel: tasks only wait on (blocked_by) tasks whose code they really build on, even across',
  '  milestones. Tasks without blockers run side by side in their own worktrees, so give each task its `touches`',
  '  (files or folders it changes) and avoid two parallel tasks touching the same ones.',
  '- Every task has a goal in your own words, the context someone new needs, and acceptance criteria. Use',
  '  sub-tasks (parent) only for a task that is really several steps. Default assignee is Claude; use "me" for',
  '  what only the user can do (accounts, secrets, decisions).',
  '- Use short, stable ids (like "auth-api"): keep them when you revise, so tasks keep their history.',
].join('\n');

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
    'After writing, answer briefly: the milestones in a line each, which run side by side and which wait, risks and open questions. Then the user',
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
  const now = view.open.map((x) => `“${x.milestone.title}” (${MILESTONE_WORDS[x.state]}, ${x.finished}/${x.total} tasks finished)`);
  const warnings = overlaps(view).map(([a, b, files]) => `- “${a.task.title}” and “${b.task.title}” both touch ${files.join(', ')}`);
  return [
    '',
    '<klaud_plan_head>',
    `You are the head of the plan “${shownBody(plan)?.title ?? 'plan'}” in klaud's Plans (${AUTONOMY_INFO[m?.autonomy ?? plan.autonomy].label}: ${AUTONOMY_INFO[m?.autonomy ?? plan.autonomy].hint.toLowerCase()}).`,
    'Each task runs in its own worktree with its own Claude; klaud starts what\'s ready (up to the plan\'s limit) and',
    'opens every milestone whose dependencies have passed, so independent milestones run side by side, each with',
    'its own check. You coordinate:',
    '- plan_get: the plan and the state of every task (who\'s working, what waits on what).',
    '- plan_message_task: tell a task\'s Claude something (a decision, a heads-up about another task).',
    '- plan_start_task: start a ready task now (when the user asks).',
    '- plan_gate: after checking a finished milestone\'s pass criteria, pass or fail it with notes per criterion.',
    '  Check for real: read the tasks\' briefs, handoffs and proof, their pull requests and diffs (git diff main...branch).',
    '- plan_update: change the plan (new tasks to fix what failed, a re-cut). The user approves changes',
    '  unless the plan runs on autopilot.',
    plan.paused ? 'The plan is paused: nothing starts until the user resumes it.' : '',
    now.length ? `Now: ${now.length > 1 ? 'milestones' : 'milestone'} ${now.join(', ')}${now.length > 1 ? ', side by side' : ''}; ${view.active.length} tasks in progress, ${view.ready.length} ready.` : 'Every milestone has passed.',
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
  const lines = [`# ${body.title}`, body.goal ? `\n${body.goal}` : '', `\nStatus: ${plan.status}${plan.paused ? ' (paused)' : ''} · autonomy ${plan.autonomy} · up to ${plan.maxParallel} tasks at once`];
  if (plan.draft && plan.body) {
    const d = diffBodies(plan.body, plan.draft);
    lines.push(`Changes waiting for the user's approval: ${d.added.length} new, ${d.changed.length} changed, ${d.removed.length} removed (shown below as proposed).`);
  } else if (!plan.body) lines.push('Draft: not approved yet.');
  const titleOf = new Map(body.milestones.map((m) => [m.id, m.title]));
  body.milestones.forEach((m, i) => {
    const mv = view.milestones.find((x) => x.milestone.id === m.id);
    lines.push('', `## ${i + 1}. ${m.title} [id ${m.id}]${mv && plan.body ? ` — ${MILESTONE_WORDS[mv.state]}` : ''}${m.autonomy ? ` · ${m.autonomy}` : ''}`);
    lines.push(runsWith(body, m.id, titleOf));
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

/** When a milestone runs: "after …" what it depends on, or "runs alongside …" the others (said or inferred). */
function runsWith(body: PlanBody, id: string, titleOf: ReadonlyMap<string, string>): string {
  const m = body.milestones.find((x) => x.id === id)!;
  const deps = milestoneDeps(body, m);
  const how = m.dependsOn ? '' : ' (inferred from blocked_by)';
  const name = (d: string): string => `${d} “${titleOf.get(d) ?? d}”`;
  // Every milestone it waits on, directly or not.
  const before = (from: string): Set<string> => {
    const out = new Set<string>();
    const walk = (at: string): void => {
      for (const d of milestoneDeps(body, body.milestones.find((x) => x.id === at)!)) if (!out.has(d)) (out.add(d), walk(d));
    };
    walk(from);
    return out;
  };
  const mine = before(id);
  const beside = body.milestones.filter((x) => x.id !== id && !mine.has(x.id) && !before(x.id).has(id)).map((x) => x.id);
  const after = deps.length ? `Runs after ${deps.map(name).join(', ')}${how}` : 'Depends on no other milestone';
  return `${after}${beside.length ? `; runs alongside ${beside.map(name).join(', ')}` : ''}.`;
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
    'Read their briefs (task_get), handoffs, proof and diffs. Then call plan_gate with pass or fail and notes that say,',
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
