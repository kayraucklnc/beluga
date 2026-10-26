import type { Action, DomainState, Store } from '../../store.js';
import { planTitle } from '../../plans/model.js';
import { type BelugaTrigger, sentinelOfChannel } from '../model.js';
import { type TriggerContext, type TriggerDeps, type TriggerEvent, clip } from './types.js';

/**
 * Beluga's own events (docs/sentinel.md §1): a task is done, a pull request opens or merges, a
 * plan's milestone passes, a worktree's Claude finishes, a friend asks something. Heard from the
 * store as they happen (only changes count: a task that was done already isn't news). `projectId`
 * keeps it to one project. The loop guard: what a sentinel's own run made (its worktree, its pull
 * request, its chat) never starts that sentinel (TriggerEvent.from).
 */

/** What the listener remembers, to tell a change from a repeat. */
interface Memory {
  readonly status: Map<string, string>;
  readonly prs: Map<string, { readonly number: number; readonly state: string }>;
  readonly passed: Set<string>;
  readonly asks: Set<string>;
}

function remembered(st: DomainState): Memory {
  const passed = new Set<string>();
  for (const p of st.plans.plans) for (const [mid, run] of Object.entries(p.runs)) if (run.passedAt) passed.add(`${p.id}:${mid}`);
  return {
    status: new Map(st.board.issues.map((i) => [i.id, i.status])),
    prs: new Map(Object.entries(st.prs).map(([id, pr]) => [id, { number: pr.number, state: pr.state }])),
    passed,
    asks: new Set(st.gateway.tasks.map((t) => t.id)),
  };
}

const workspaceOf = (st: DomainState, id: string) => {
  for (const p of st.projects) {
    const ws = p.workspaces.find((w) => w.id === id);
    if (ws) return { project: p, ws };
  }
  return undefined;
};

/** The sentinel run that made this place (its chat or worktree), for the loop guard. */
const madeBy = (st: DomainState, channel: string | undefined): TriggerEvent['from'] => {
  const owner = sentinelOfChannel(st.sentinel, channel);
  return owner?.runId ? { sentinelId: owner.sentinel.id, runId: owner.runId } : undefined;
};

/** One action, in Beluga's words: the event it is for this trigger (none: not this, or not news). Updates the memory. */
export function belugaEvent(t: BelugaTrigger, a: Action, st: DomainState, mem: Memory, selfId: string): TriggerEvent | undefined {
  const inProject = (projectId: string | undefined): boolean => !t.projectId || projectId === t.projectId;
  switch (a.type) {
    case 'board_issue': {
      const was = mem.status.get(a.issue.id);
      mem.status.set(a.issue.id, a.issue.status);
      if (t.what !== 'task-done' || a.issue.status !== 'done' || was === 'done' || !inProject(a.issue.projectId)) return undefined;
      const issue = a.issue;
      const from = issue.worktrees.map((w) => madeBy(st, `ws:${w}`)).find(Boolean);
      const project = st.projects.find((p) => p.id === issue.projectId)?.name;
      return { summary: clip(`Beluga: ${issue.key} is done: ${issue.title}`, 130), payload: { event: 'task-done', key: issue.key, title: issue.title, project, labels: issue.labels, ...(issue.pr ? { pr: issue.pr } : {}) }, ...(from ? { from } : {}) };
    }
    case 'pr': {
      const was = mem.prs.get(a.id);
      const pr = a.pr;
      if (pr) mem.prs.set(a.id, { number: pr.number, state: pr.state });
      else mem.prs.delete(a.id);
      if (!pr || (t.what !== 'pr-opened' && t.what !== 'pr-merged')) return undefined;
      const place = workspaceOf(st, a.id);
      if (!inProject(place?.project.id)) return undefined;
      const opened = t.what === 'pr-opened' && pr.state === 'OPEN' && (!was || was.number !== pr.number);
      const merged = t.what === 'pr-merged' && pr.state === 'MERGED' && was !== undefined && was.number === pr.number && was.state !== 'MERGED';
      if (!opened && !merged) return undefined;
      const from = madeBy(st, `ws:${a.id}`);
      return {
        summary: clip(`Beluga: pull request #${pr.number} ${opened ? 'opened' : 'merged'}: ${pr.title}`, 130),
        payload: { event: t.what, number: pr.number, title: pr.title, url: pr.url, draft: pr.draft, checks: pr.checks, project: place?.project.name, worktree: place?.ws.name, branch: place?.ws.branch },
        ...(from ? { from } : {}),
      };
    }
    case 'plan_put': {
      const plan = a.plan;
      let out: TriggerEvent | undefined;
      for (const [mid, run] of Object.entries(plan.runs)) {
        const key = `${plan.id}:${mid}`;
        if (!run.passedAt || mem.passed.has(key)) continue;
        mem.passed.add(key);
        if (t.what !== 'milestone-passed' || out || !inProject(plan.projectId)) continue;
        const milestone = plan.body?.milestones.find((m) => m.id === mid);
        const title = milestone?.title ?? 'A milestone';
        const planName = planTitle(plan);
        out = { summary: clip(`Beluga: milestone “${title}” passed in ${planName}`, 130), payload: { event: 'milestone-passed', plan: planName, milestone: title, goal: milestone?.goal, criteria: milestone?.criteria, project: st.projects.find((p) => p.id === plan.projectId)?.name } };
      }
      return out;
    }
    case 'agent_event': {
      if (t.what !== 'claude-finished' || a.event !== 'done' || a.owner !== selfId || !a.channel?.startsWith('ws:')) return undefined;
      const place = workspaceOf(st, a.channel.slice(3));
      if (!place || place.ws.kind !== 'worktree' || !inProject(place.project.id)) return undefined;
      const from = madeBy(st, a.channel);
      return { summary: clip(`Beluga: Claude finished in ${place.ws.name}`, 130), payload: { event: 'claude-finished', project: place.project.name, worktree: place.ws.name, branch: place.ws.branch, answer: clip(a.text, 2000) }, ...(from ? { from } : {}) };
    }
    case 'gw_task': {
      const task = a.task;
      if (mem.asks.has(task.id)) return undefined;
      mem.asks.add(task.id);
      if (t.what !== 'friend-asks' || task.direction !== 'received') return undefined;
      if (t.projectId && task.project && st.projects.find((p) => p.id === t.projectId)?.name !== task.project) return undefined;
      return { summary: clip(`Beluga: ${task.peerName} asks: ${task.summary ?? task.ask}`, 130), payload: { event: 'friend-asks', from: task.peerName, kind: task.kind, ask: clip(task.ask, 2000), project: task.project, state: task.state } };
    }
    case 'gw_init':
      for (const task of a.state.tasks) mem.asks.add(task.id);
      return undefined;
    case 'board_init':
      for (const i of a.state.issues) mem.status.set(i.id, i.status);
      return undefined;
    default:
      return undefined;
  }
}

/** Listen to the store until stopped; the first `warmupMs` only remembers (the daemon's start isn't news). → stop. */
export function startBeluga(t: BelugaTrigger, ctx: TriggerContext, deps: TriggerDeps & { readonly store: Store }): () => void {
  const now = deps.now ?? Date.now;
  const quietUntil = now() + (deps.warmupMs ?? 0);
  const mem = remembered(deps.store.getState());
  return deps.store.onAction((a) => {
    // After the reducer: the state has what the action brought.
    queueMicrotask(() => {
      const e = belugaEvent(t, a, deps.store.getState(), mem, deps.selfId());
      if (e && now() >= quietUntil) ctx.fire(e);
    });
  });
}
