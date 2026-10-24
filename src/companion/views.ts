import { type Approval, type DomainState, type LogItem, type SubAgent, isRunning } from '../core/store.js';
import type { PendingQuestion } from '../core/collab-store.js';
import { type TaskView as GwTask, isFinal } from '../core/gateway/model.js';
import { parseDecisionQid } from '../core/plans/decisions.js';
import { type Plan, planTitle } from '../core/plans/model.js';
import { type PlanView as PlanProgress, planView } from '../core/plans/progress.js';
import type { MessageView } from '../net/mesh/views.js';
import type { Usage } from '../protocol.js';
import {
  type ChatMessageView,
  type ChatsView,
  type ChatView,
  type ConvSummary,
  type ConvView,
  type HomeView,
  type NeedsYou,
  type OutputView,
  type PeopleView,
  type PlansView,
  type PlanView,
  type SubAgentView,
  Topic,
  type TurnView,
  type UsageView,
  VIEW_TURNS,
  type WorkView,
} from './protocol.js';
import { humanizeStep, plainLine, stripCode } from './strip.js';

/**
 * What the phone sees: small, finished views of the Mac's shared state, one per topic
 * (docs/companion.md, "Views, not state"). Pure functions of `DomainState` (and the outputs on
 * disk the host looks up), so a change to the state that breaks a view breaks the typecheck, and
 * tests/companion-views.test.ts shows in review what a change does to the phone.
 *
 * Cut down for the phone: code stripped from Claude's words (strip.ts), steps in words, paths only
 * as refs (files.ts), never keys, diffs, terminals or settings. Each needs-you item carries the API
 * calls its buttons make, exactly as the phone sends them (all `phone` in coverage.ts).
 */

/** An output on disk for one conversation (a sub-agent's, the scratch folder's): the host finds them. */
export interface ConvOutput {
  readonly path: string;
  readonly size?: number;
  readonly ts?: number;
  /** The sub-agent that made it (a SubAgent's id), if known. */
  readonly by?: string;
  /** The folder the conversation works in (text inside it is source unless it's where outputs go). */
  readonly cwd?: string;
}

export interface ViewContext {
  /** Hands out refs for paths (files.ts RefTable). */
  readonly refs: { output(path: string, extra?: { size?: number; ts?: number; by?: string; cwd?: string }): OutputView | undefined };
  readonly mac: { readonly name: string; readonly version: string };
  /** Outputs per conversation (channel), newest first. */
  readonly outputs?: (channel: string) => readonly ConvOutput[];
}

// ---- small helpers

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const valid = (t: string): Topic | undefined => (Topic.safeParse(t).success ? (t as Topic) : undefined);

/** A conversation's topic (`room` → `conv:room`, `ws:<id>` → `conv:ws:<id>`). */
export const convTopic = (channel: string): Topic | undefined => valid(`conv:${channel}`);
export const chatTopic = (conversation: string): Topic | undefined => valid(`chat:${conversation}`);
export const planTopic = (id: string): Topic | undefined => valid(`plan:${id}`);
/** The channel a `conv:` topic names. */
export const channelOf = (topic: string): string | undefined => (topic.startsWith('conv:') ? topic.slice(5) : undefined);

const nameOf = (state: DomainState, peerId: string | undefined): string | undefined =>
  peerId ? (state.peers.find((p) => p.peerId === peerId)?.name ?? state.network.friends.find((f) => f.peerId === peerId)?.name) : undefined;

const myName = (state: DomainState): string => state.self?.name ?? state.network.self?.name ?? 'me';
const myId = (state: DomainState): string => state.selfId || state.self?.peerId || state.network.self?.peerId || 'me';

// ---- usage

/** Your allowance as a list of providers (Claude Code today; other agents later). */
export function usageViews(usage: Usage | undefined): UsageView[] {
  if (!usage) return [];
  const windows = [
    ...(usage.fiveHour ? [{ label: '5 hours', pct: usage.fiveHour.pct, ...(usage.fiveHour.resetsAt !== undefined ? { resetsAt: Math.round(usage.fiveHour.resetsAt) } : {}) }] : []),
    ...(usage.week ? [{ label: 'Week', pct: usage.week.pct, ...(usage.week.resetsAt !== undefined ? { resetsAt: Math.round(usage.week.resetsAt) } : {}) }] : []),
  ].map((w) => ({ ...w, pct: Math.max(0, Math.min(100, w.pct)) }));
  return [{ provider: 'Claude Code', ...(usage.plan ? { plan: clip(usage.plan, 40) } : {}), windows, updatedAt: Math.round(usage.updatedAt) }];
}

// ---- what needs you

function approvalItem(state: DomainState, a: Approval): NeedsYou {
  const from = a.peer ? `${nameOf(state, a.peer) ?? 'a friend'}` : 'your Claude';
  const topic = a.channel ? convTopic(a.channel) : undefined;
  return {
    id: `approval:${a.id}`,
    kind: a.kind === 'request' ? 'request' : 'approval',
    title: clip(a.title, 500),
    ...(a.detail ? { detail: clip(plainLine(a.detail, 64_000), 64_000) } : {}),
    from,
    ...(topic ? { topic } : {}),
    ...(a.askedAt !== undefined ? { askedAt: a.askedAt } : {}),
    ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}),
    actions: [
      { label: 'Approve', tone: 'main', method: 'host.answerApproval', args: ['yes', a.id] },
      { label: 'Decline', tone: 'danger', method: 'host.answerApproval', args: ['no', a.id] },
      { label: 'Always', tone: 'plain', method: 'host.answerApproval', args: ['always', a.id] },
    ],
  };
}

/** Claude's question (or plan to approve), or a plan task waiting on your decision. */
function questionItem(state: DomainState, q: PendingQuestion): NeedsYou {
  const topic = convTopic(q.channel);
  const owner = q.owner === myId(state) || !q.owner ? 'your Claude' : `${nameOf(state, q.owner) ?? 'a friend'}'s Claude`;
  const base = { id: `question:${q.qid}`, from: owner, ...(topic ? { topic } : {}) };
  if (q.question.kind === 'plan') {
    return {
      ...base,
      kind: 'question',
      title: 'Claude has a plan for you to approve',
      detail: clip(stripCode(q.question.plan).text, 64_000),
      freeText: true,
      actions: [
        { label: 'Approve', tone: 'main', method: 'questions.answer', args: [q.qid, { kind: 'plan', approve: true, feedback: '' }] },
        { label: 'Keep planning', tone: 'danger', method: 'questions.answer', args: [q.qid, { kind: 'plan', approve: false, feedback: '' }] },
      ],
      // Your words: what to change in the plan (it keeps planning with them).
      answer: { method: 'questions.answer', args: [q.qid, { kind: 'plan', approve: false, feedback: '' }], slot: [1, 'feedback'], text: true, picks: false, label: 'Send changes' },
    };
  }
  const [first, ...rest] = q.question.questions.filter((x) => !(x.question in q.picked));
  const head = first ?? q.question.questions[0]!;
  const decision = parseDecisionQid(q.qid);
  const plan = decision ? state.plans.plans.find((p) => p.id === decision.plan) : undefined;
  const planT = plan ? planTopic(plan.id) : undefined;
  // Answers to the earlier questions of this prompt (picked one at a time with questions.pick).
  const picked = Object.fromEntries(Object.entries(q.picked).filter(([k]) => !k.endsWith('#multi')));
  const last = !rest.length;
  const single = last && !head.multiSelect && head.options.length > 0 && head.options.length <= 3;
  // Several picks (joined with ", " as the Mac does) or your own words go where `slot` says: the
  // last question sends every answer (questions.answer); an earlier one is kept with questions.pick.
  const answer: NonNullable<NeedsYou['answer']> = last
    ? { method: 'questions.answer', args: [q.qid, { kind: 'answers', answers: { ...picked, [head.question]: '' } }], slot: [1, 'answers', head.question], join: ', ', text: true, picks: head.options.length > 0, label: 'Send' }
    : { method: 'questions.pick', args: [q.qid, head.question, ''], slot: [2], join: ', ', text: true, picks: head.options.length > 0, label: 'Next' };
  return {
    ...base,
    kind: decision ? 'decision' : 'question',
    ...(decision ? { from: plan ? `the plan “${clip(planTitle(plan), 80)}”` : 'a plan' } : {}),
    ...(decision && planT ? { topic: planT } : {}),
    title: clip(plainLine(head.question, 500), 500),
    ...(rest.length ? { detail: clip(rest.map((r) => plainLine(r.question, 1000)).join('\n'), 64_000) } : {}),
    choices: head.options.slice(0, 12).map((o) => ({ label: clip(o.label, 200), ...(o.description ? { description: clip(o.description, 1000) } : {}) })),
    multi: head.multiSelect,
    freeText: true,
    // One question with a few options: a button each (the phone sends the rest, multi-select or words, itself).
    actions: [
      ...(single ? head.options.map((o) => ({ label: clip(o.label, 40), tone: 'plain' as const, method: 'questions.answer', args: [q.qid, { kind: 'answers', answers: { ...picked, [head.question]: o.label } }] })) : []),
      { label: 'Skip', tone: 'danger', method: 'questions.answer', args: [q.qid, { kind: 'skip' }] },
    ],
    answer,
  };
}

function gatewayItems(state: DomainState, t: GwTask): NeedsYou[] {
  const topic = t.conversation ? convTopic(t.conversation) : t.direction === 'sent' ? convTopic(`task:${t.id}`) : undefined;
  const at = topic ? { topic } : {};
  if (t.direction === 'sent' && t.state === 'confirm') {
    return [
      {
        id: `confirm:${t.id}`,
        kind: 'confirm',
        title: `Ask ${clip(t.peerName, 60)}'s Claude?`,
        detail: clip(plainLine(t.ask, 64_000), 64_000),
        from: 'your Claude',
        ...at,
        askedAt: t.createdAt,
        actions: [
          { label: 'Ask', tone: 'main', method: 'gateway.confirm', args: [t.id, true] },
          { label: 'Not now', tone: 'danger', method: 'gateway.confirm', args: [t.id, false] },
        ],
      },
    ];
  }
  if (t.direction === 'sent' && t.question) {
    const head = t.question.questions[0];
    if (!head) return [];
    const single = t.question.questions.length === 1 && !head.multiSelect && head.options.length > 0 && head.options.length <= 3;
    return [
      {
        id: `gwq:${t.id}:${t.question.qid}`,
        kind: 'question',
        title: clip(plainLine(head.question, 500), 500),
        detail: clip(plainLine(t.summary ?? t.ask, 64_000), 64_000),
        from: `${clip(t.peerName, 60)}'s Claude`,
        ...at,
        askedAt: t.question.askedAt,
        choices: head.options.slice(0, 12).map((o) => ({ label: clip(o.label, 200), ...(o.description ? { description: clip(o.description, 1000) } : {}) })),
        multi: head.multiSelect,
        // One question: picks or words go in the answer list. Several at once: only on the Mac (or Skip).
        freeText: t.question.questions.length === 1,
        actions: [
          ...(single ? head.options.map((o) => ({ label: clip(o.label, 40), tone: 'plain' as const, method: 'gateway.answer', args: [t.id, [o.label]] })) : []),
          { label: 'Skip', tone: 'danger', method: 'gateway.answer', args: [t.id, 'skip'] },
        ],
        ...(t.question.questions.length === 1 ? { answer: { method: 'gateway.answer', args: [t.id, ['']], slot: [1, 0], join: ', ', text: true, picks: head.options.length > 0, label: 'Send' } } : {}),
      },
    ];
  }
  // A friend's request: its approval card (approvals) already stands for it when there is one.
  if (t.direction === 'received' && t.state === 'awaiting_approval' && !state.approvals.some((a) => a.task === t.id)) {
    return [
      {
        id: `request:${t.id}`,
        kind: 'request',
        title: clip(t.summary ? `${t.peerName}: ${t.summary}` : `${t.peerName} asks your Claude`, 500),
        detail: clip(plainLine(t.ask, 64_000), 64_000),
        from: clip(t.peerName, 100),
        askedAt: t.createdAt,
        actions: [
          { label: 'Approve', tone: 'main', method: 'gateway.decide', args: [t.id, { answer: 'yes' }] },
          { label: 'Decline', tone: 'danger', method: 'gateway.decide', args: [t.id, { answer: 'no' }] },
          { label: 'Always', tone: 'plain', method: 'gateway.decide', args: [t.id, { answer: 'always' }] },
        ],
      },
    ];
  }
  return [];
}

/** What a plan waits for from you: approving its draft, or passing a milestone at its gate. */
function planItems(plan: Plan, progress: PlanProgress): NeedsYou[] {
  const title = clip(planTitle(plan), 200);
  const topic = planTopic(plan.id);
  const at = { ...(topic ? { topic } : {}), from: 'your plan' };
  const next = progress.next;
  if (next.kind === 'approve' || next.kind === 'review_changes') {
    return [
      {
        id: `plan:${plan.id}:approve:${plan.draftRev}`,
        kind: 'decision',
        title: next.kind === 'approve' ? `Approve the plan “${title}”?` : `Approve the changes to “${title}”?`,
        ...(plan.draft?.goal ? { detail: clip(plainLine(plan.draft.goal, 4000), 4000) } : {}),
        ...at,
        askedAt: plan.updatedAt,
        actions: [
          { label: 'Approve', tone: 'main', method: 'plans.approve', args: [plan.id] },
          { label: 'Discard', tone: 'danger', method: 'plans.discard', args: [plan.id] },
        ],
      },
    ];
  }
  if (next.kind === 'pass') {
    const m = next.milestone.milestone;
    return [
      {
        id: `plan:${plan.id}:pass:${m.id}`,
        kind: 'decision',
        title: `“${clip(m.title, 200)}” is ready: pass it?`,
        detail: clip(m.criteria.join('\n'), 64_000),
        ...at,
        // Send it back takes your words (the answer template).
        freeText: true,
        actions: [
          { label: 'Pass', tone: 'main', method: 'plans.pass', args: [plan.id, m.id] },
          { label: 'Check again', tone: 'plain', method: 'plans.recheck', args: [plan.id, m.id] },
        ],
        answer: { method: 'plans.sendBack', args: [plan.id, m.id, ''], slot: [2], text: true, picks: false, label: 'Send back' },
      },
    ];
  }
  return [];
}

const progressOf = (state: DomainState, plan: Plan): PlanProgress => planView(plan, state.board);

/** Someone came to the door with a link you made: let them in (with what the link offers) or turn them away. */
function knockItems(state: DomainState): NeedsYou[] {
  return state.knocks.map((k) => {
    const name = nameOf(state, k.peerId) ?? state.guests[k.peerId]?.name ?? 'Someone';
    const link = state.links.find((l) => l.id === k.linkId);
    return {
      id: `knock:${k.peerId}`,
      kind: 'request',
      title: clip(`${name} wants to come in`, 500),
      detail: clip(link ? `With your link to ${link.label}` : 'With one of your links', 64_000),
      from: clip(name, 100),
      ...(k.ts ? { askedAt: k.ts } : {}),
      actions: [
        { label: 'Let in', tone: 'main', method: 'invites.letIn', args: [k.peerId] },
        { label: 'Turn away', tone: 'danger', method: 'invites.decline', args: [k.peerId] },
      ],
    };
  });
}

/** People asking to join a channel you run (you're its admin). */
function joinItems(state: DomainState): NeedsYou[] {
  return state.network.groups
    .filter((g) => g.admin && g.active)
    .flatMap((g) =>
      g.requests.map((r) => {
        const topic = chatTopic(`group:${g.id}`);
        return {
          id: `join:${g.id}:${r.peerId}`,
          kind: 'request',
          title: clip(`${r.name} asks to join ${g.name}`, 500),
          from: clip(r.name, 100),
          ...(topic ? { topic } : {}),
          askedAt: r.ts,
          actions: [
            { label: 'Let in', tone: 'main' as const, method: 'network.groups.approve', args: [g.id, r.peerId] },
            { label: 'Decline', tone: 'danger' as const, method: 'network.groups.decline', args: [g.id, r.peerId] },
          ],
        };
      }),
    );
}

/** Everything waiting for you, oldest first: approvals, Claude's questions, friends' requests, plan decisions. */
export function needsYou(state: DomainState): NeedsYou[] {
  const items = [
    ...state.approvals.map((a) => approvalItem(state, a)),
    ...state.questions.map((q) => questionItem(state, q)),
    ...state.gateway.tasks.flatMap((t) => gatewayItems(state, t)),
    ...state.plans.plans.filter((p) => p.status !== 'done').flatMap((p) => planItems(p, progressOf(state, p))),
    ...knockItems(state),
    ...joinItems(state),
  ];
  // Oldest first; what has no time (Claude's questions) counts as just asked.
  const at = (n: NeedsYou): number => n.askedAt ?? Number.MAX_SAFE_INTEGER;
  return items.sort((a, b) => at(a) - at(b)).slice(0, 50);
}

// ---- conversations

type AgentItem = Extract<LogItem, { type: 'agent' }>;

interface Conversation {
  readonly channel: string;
  readonly title: string;
  readonly project?: string;
  readonly projectId?: string;
  /** The folder it works in. */
  readonly cwd?: string;
  readonly mine: boolean;
}

/** Every conversation the phone can open: your workspaces (not archived), the ones shared with you, and the room's. */
export function conversations(state: DomainState): Conversation[] {
  const own = state.projects.flatMap((p) =>
    p.workspaces.filter((w) => !w.archived && !w.pending).map((w) => ({ channel: `ws:${w.id}`, title: w.name, project: p.name, projectId: p.id, cwd: w.path, mine: true })),
  );
  const shared = state.shared.map((w) => ({ channel: `ws:${w.id}`, title: w.name, project: `${nameOf(state, w.owner) ?? 'a friend'} · ${w.project}`, mine: w.role === 'contribute' }));
  const room = state.log.some((l) => l.channel === 'room') ? [{ channel: 'room', title: state.room || 'The room', mine: true }] : [];
  // What you asked friends' Claudes yourself (not from a conversation): each reads as its own conversation.
  const asked = state.gateway.tasks
    .filter((t) => t.direction === 'sent' && !t.conversation)
    .slice(-TASKS_SHOWN)
    .map((t) => ({ channel: `task:${t.id}`, title: plainLine(t.summary ?? t.ask, 300) || 'A question', project: 'Asked of friends', projectId: 'asked', mine: false }));
  const seen = new Set<string>();
  return [...own, ...shared, ...room, ...asked].filter((c) => !seen.has(c.channel) && Boolean(seen.add(c.channel)));
}

const itemsOf = (state: DomainState, channel: string): LogItem[] => state.log.filter((l) => l.channel === channel);

/** Tasks you asked of friends shown as conversations, the newest. */
const TASKS_SHOWN = 30;

/** The task a `task:<id>` channel is about. */
const taskOf = (state: DomainState, channel: string): GwTask | undefined => (channel.startsWith('task:') ? state.gateway.tasks.find((t) => t.id === channel.slice(5)) : undefined);

/** Where a task you asked stands, as a turn's status and step. */
function taskStatus(t: GwTask): { status: NonNullable<TurnView['status']>; step?: string } {
  const who = clip(t.peerName, 60);
  switch (t.state) {
    case 'confirm':
      return { status: 'queued', step: 'Waiting for you to say Ask' };
    case 'sent':
      return { status: 'queued', step: `Sent to ${who}` };
    case 'queued':
      return { status: 'queued', step: `Waiting its turn on ${who}'s Mac` };
    case 'awaiting_approval':
      return { status: 'working', step: `Waiting for ${who} to approve` };
    case 'working':
      return { status: 'working', step: t.steps.length ? humanizeStep(t.steps.at(-1)!) : 'Working' };
    case 'done':
      return { status: 'done' };
    case 'cancelled':
      return { status: 'stopped' };
    default:
      return { status: 'failed' };
  }
}

/** A task you asked of a friend's Claude, as two turns: what you asked, and their Claude's answer (its files as outputs). */
function taskTurns(state: DomainState, ctx: ViewContext, t: GwTask): TurnView[] {
  const { status, step } = taskStatus(t);
  const said = t.result?.summary || (t.state === 'declined' ? `${t.peerName} declined.` : t.state === 'failed' ? 'It failed.' : '');
  const outputs = (t.result?.files ?? []).flatMap((f) => {
    const v = f.path ? ctx.refs.output(f.path, { size: f.size, ...(t.endedAt ? { ts: t.endedAt } : {}) }) : undefined;
    return v ? [v] : [];
  });
  return [
    { id: `${t.id}:ask`, who: 'you', name: clip(myName(state), 100), prose: stripCode(t.ask), ts: t.createdAt },
    {
      id: `${t.id}:answer`,
      who: 'friend',
      name: clip(`${t.peerName}'s Claude`, 100),
      prose: stripCode(said),
      ts: t.startedAt ?? t.updatedAt,
      status,
      ...(step ? { step: clip(step, 300) } : {}),
      steps: t.steps.length,
      ...(outputs.length ? { outputs: outputs.slice(0, 50) } : {}),
      ...(t.endedAt ? { endTs: t.endedAt } : {}),
    },
  ];
}

function turnStatus(item: AgentItem): TurnView['status'] {
  switch (item.status) {
    case 'queued':
      return 'queued';
    case 'done':
    case 'answered':
      return 'done';
    case 'error':
    case 'denied':
      return 'failed';
    case 'interrupted':
      return 'stopped';
    default:
      return 'working';
  }
}

function subView(sub: SubAgent, outputs: readonly OutputView[]): SubAgentView {
  return {
    id: clip(sub.id, 200),
    title: clip(plainLine(sub.title, 300) || 'Sub-agent', 300),
    status: sub.status,
    steps: sub.steps.slice(-30).map(humanizeStep),
    outputs: outputs.filter((o) => o.by === sub.id).slice(0, 50),
  };
}

/** The step a running turn is on, in words ("Ran npm test · 137/215", "Thinking"). */
function liveStep(item: AgentItem): string | undefined {
  if (!isRunning(item.status)) return undefined;
  if (item.status === 'queued') return 'Waiting its turn';
  if (item.status === 'awaiting_approval') return 'Waiting for your approval';
  if (item.between === 'thinking') return 'Thinking';
  if (item.between === 'writing') return 'Writing';
  const last = item.steps.at(-1);
  const words = last ? humanizeStep(last) : 'Working';
  return clip(item.progress ? `${words} · ${item.progress}` : words, 300);
}

function turnOf(state: DomainState, item: LogItem, outputs: readonly OutputView[]): TurnView | undefined {
  const me = myId(state);
  if (item.type === 'chat') {
    const who = item.byAgent ? 'claude' : item.from === me ? 'you' : 'friend';
    return { id: item.id, who, name: clip(who === 'you' ? myName(state) : item.name, 100), prose: stripCode(item.text), ts: item.ts };
  }
  if (item.type === 'system') {
    // Earlier lines of a shared workspace's conversation ("bob: …") read as that person's turn.
    if (item.said) return { id: item.id, who: item.said.byAgent ? 'claude' : item.said.from === me ? 'you' : 'friend', name: clip(item.said.name, 100), prose: stripCode(item.said.text), ts: item.said.ts };
    if (item.level === 'info') return undefined;
    return { id: item.id, who: 'system', name: 'Beluga', prose: stripCode(item.text), ts: item.ts };
  }
  if (item.type === 'shell') {
    // A command on a friend's Mac: that it ran and how it went, not the command or its output.
    const how = item.status === 'done' ? 'finished' : item.status === 'failed' ? 'failed' : item.status === 'declined' ? 'was declined' : item.status === 'waiting' ? 'waits for their approval' : 'is running';
    return { id: item.id, who: 'system', name: 'Beluga', prose: { text: `${clip(item.by, 60)} ran a command on ${clip(item.ownerName, 60)}'s Mac: it ${how}.`, code: [] }, ts: item.ts };
  }
  const end = item.endTs ?? Number.POSITIVE_INFINITY;
  const mineOut = outputs.filter((o) => o.ts !== undefined && o.ts >= item.ts && o.ts <= end && !item.subagents.some((s) => s.id === o.by));
  const status = turnStatus(item);
  const step = status === 'working' || status === 'queued' ? liveStep(item) : undefined;
  return {
    id: item.id,
    who: 'claude',
    name: clip(item.owner === me || !item.owner ? 'Claude' : `${item.ownerName}'s Claude`, 100),
    prose: stripCode(item.text),
    ts: item.ts,
    ...(status ? { status } : {}),
    ...(step ? { step } : {}),
    steps: item.steps.length,
    ...(item.subagents.length ? { subagents: item.subagents.filter((s) => s.kind !== 'background').slice(-40).map((s) => subView(s, outputs)) } : {}),
    ...(mineOut.length ? { outputs: mineOut.slice(0, 50) } : {}),
    ...(item.endTs !== undefined ? { endTs: item.endTs } : {}),
  };
}

/**
 * Outputs no turn claimed (written after the last answer ended: by hand, by a background job, or
 * after its last step) go with the newest answer from Claude, rather than nowhere.
 */
function withLateOutputs(turns: TurnView[], outputs: readonly OutputView[]): TurnView[] {
  let at = turns.length - 1;
  while (at >= 0 && turns[at]!.who !== 'claude') at--;
  const last = turns[at];
  if (!last) return turns;
  const claimed = new Set(turns.flatMap((t) => [...(t.outputs ?? []), ...(t.subagents ?? []).flatMap((a) => a.outputs)].map((o) => o.ref)));
  const late = outputs.filter((o) => !claimed.has(o.ref) && o.ts !== undefined && o.ts >= last.ts);
  if (!late.length) return turns;
  const copy = [...turns];
  copy[at] = { ...last, outputs: [...(last.outputs ?? []), ...late].slice(0, 50) };
  return copy;
}

/** A conversation's outputs as refs (what may go to the phone), newest first. */
function outputsOf(ctx: ViewContext, conv: Pick<Conversation, 'channel' | 'cwd'>): OutputView[] {
  return (ctx.outputs?.(conv.channel) ?? []).flatMap((o) => {
    const v = ctx.refs.output(o.path, { ...(o.size !== undefined ? { size: o.size } : {}), ...(o.ts !== undefined ? { ts: o.ts } : {}), ...(o.by ? { by: o.by } : {}), ...((o.cwd ?? conv.cwd) ? { cwd: o.cwd ?? conv.cwd } : {}) });
    return v ? [v] : [];
  });
}

function summaryOf(state: DomainState, conv: Conversation, waiting: ReadonlySet<string>): ConvSummary | undefined {
  const topic = convTopic(conv.channel);
  if (!topic) return undefined;
  const task = taskOf(state, conv.channel);
  if (task) {
    const { status } = taskStatus(task);
    const last = task.result?.summary ? plainLine(task.result.summary, 300) : taskStatus(task).step;
    return {
      topic,
      title: clip(conv.title, 300),
      project: clip(`${conv.project ?? 'Asked of friends'} · ${task.peerName}`, 200),
      status: waiting.has(topic) ? 'waiting' : status === 'working' || status === 'queued' ? 'working' : status === 'failed' ? 'failed' : 'idle',
      ...(last ? { last } : {}),
      lastAt: task.updatedAt,
      ...(waiting.has(topic) ? { needsYou: true } : {}),
    };
  }
  const items = itemsOf(state, conv.channel);
  const agents = items.filter((l): l is AgentItem => l.type === 'agent');
  const running = agents.filter((a) => isRunning(a.status));
  const lastAgent = agents.at(-1);
  const last = [...items].reverse().find((l) => (l.type === 'chat' || l.type === 'agent') && (l.type === 'chat' ? l.text : l.text || l.prompt));
  const lastText = last?.type === 'chat' ? last.text : last?.type === 'agent' ? last.text || last.prompt || '' : '';
  const status: ConvSummary['status'] = waiting.has(topic) ? 'waiting' : running.length ? 'working' : lastAgent && (lastAgent.status === 'error' || lastAgent.status === 'denied') ? 'failed' : 'idle';
  const lastAt = Math.max(0, ...items.map((l) => (l.type === 'agent' ? (l.lastAt ?? l.endTs ?? l.ts) : l.ts)));
  const subs = running.reduce((n, a) => n + a.subagents.filter((s) => s.status === 'running' && s.kind !== 'background').length, 0);
  const unread = state.unread[conv.channel] ?? 0;
  return {
    topic,
    title: clip(conv.title, 300),
    ...(conv.project ? { project: clip(conv.project, 200) } : {}),
    status,
    ...(lastText ? { last: plainLine(lastText, 300) } : {}),
    ...(lastAt ? { lastAt } : {}),
    ...(unread ? { unread } : {}),
    ...(waiting.has(topic) ? { needsYou: true } : {}),
    ...(subs ? { agents: subs } : {}),
  };
}

const waitingTopics = (items: readonly NeedsYou[]): Set<string> => new Set(items.flatMap((n) => (n.topic ? [n.topic] : [])));

// ---- the views

export function homeView(state: DomainState, ctx: ViewContext): HomeView {
  const items = needsYou(state);
  const waiting = waitingTopics(items);
  const convs = conversations(state);
  const summaries = convs.flatMap((c) => summaryOf(state, c, waiting) ?? []);
  const running = summaries.filter((s) => s.status === 'working' || s.status === 'waiting').sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const outputs = convs
    .flatMap((c) => outputsOf(ctx, c).map((o) => ({ ...o, ...(convTopic(c.channel) ? { topic: convTopic(c.channel) } : {}) })))
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
    .slice(0, 30);
  const work = convs.reduce((n, c) => n + (state.unread[c.channel] ?? 0), 0);
  const chats = state.network.friends.reduce((n, f) => n + f.unread, 0) + state.network.groups.reduce((n, g) => n + g.unread, 0);
  return {
    mac: { name: clip(ctx.mac.name, 100), version: clip(ctx.mac.version, 40) },
    me: { name: clip(myName(state), 64), peerId: myId(state) },
    usage: usageViews(state.self?.usage),
    needsYou: items,
    running: running.slice(0, 20),
    outputs,
    unread: { work, chats },
  };
}

export function workView(state: DomainState): WorkView {
  const waiting = waitingTopics(needsYou(state));
  const convs = conversations(state);
  const byProject = new Map<string, { id: string; name: string; conversations: ConvSummary[] }>();
  for (const c of convs) {
    const s = summaryOf(state, c, waiting);
    if (!s) continue;
    const key = c.projectId ?? (c.channel === 'room' ? 'room' : `shared:${c.project ?? ''}`);
    const entry = byProject.get(key) ?? { id: clip(key, 200), name: clip(c.project ?? c.title, 200), conversations: [] };
    entry.conversations.push(s);
    byProject.set(key, entry);
  }
  const lastOf = (p: { conversations: ConvSummary[] }): number => Math.max(0, ...p.conversations.map((c) => c.lastAt ?? 0));
  return {
    projects: [...byProject.values()]
      .map((p) => ({ ...p, conversations: p.conversations.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).slice(0, 200) }))
      .sort((a, b) => lastOf(b) - lastOf(a))
      .slice(0, 200),
  };
}

/** One conversation's turns (the last VIEW_TURNS, or those before `before`). */
export function convTurns(state: DomainState, ctx: ViewContext, channel: string, opts: { before?: string; limit?: number } = {}): { turns: TurnView[]; more: boolean } {
  const conv = conversations(state).find((c) => c.channel === channel) ?? { channel };
  const task = taskOf(state, channel);
  const outputs = task ? [] : outputsOf(ctx, conv);
  const all = task ? taskTurns(state, ctx, task) : withLateOutputs(itemsOf(state, channel).flatMap((l) => turnOf(state, l, outputs) ?? []), outputs);
  const end = opts.before ? all.findIndex((t) => t.id === opts.before) : all.length;
  const upto = end < 0 ? all.length : end;
  const limit = opts.limit ?? VIEW_TURNS;
  const turns = all.slice(Math.max(0, upto - limit), upto);
  return { turns, more: upto > turns.length };
}

export function convView(state: DomainState, ctx: ViewContext, topic: Topic): ConvView {
  const channel = channelOf(topic) ?? '';
  const conv = conversations(state).find((c) => c.channel === channel);
  const { turns, more } = convTurns(state, ctx, channel);
  const items = needsYou(state).filter((n) => n.topic === topic);
  const task = taskOf(state, channel);
  const working = task ? !isFinal(task.state) : itemsOf(state, channel).some((l) => l.type === 'agent' && isRunning(l.status));
  return {
    topic,
    title: clip(conv?.title ?? (channel === 'room' ? state.room || 'The room' : 'Conversation'), 300),
    ...(conv?.project ? { project: clip(conv.project, 200) } : {}),
    turns,
    more,
    needsYou: items.slice(0, 20),
    canSend: conv?.mine ?? false,
    working,
  };
}

const planState = (plan: Plan, progress: PlanProgress): string => (plan.status === 'active' && plan.paused ? 'paused' : plan.status === 'active' && progress.next.kind === 'done' ? 'done' : plan.status);

export function plansView(state: DomainState): PlansView {
  return {
    plans: state.plans.plans.slice(0, 100).map((plan) => {
      const progress = progressOf(state, plan);
      const topic = planTopic(plan.id);
      return { id: clip(plan.id, 200), title: clip(planTitle(plan), 300), state: planState(plan, progress), ...(topic ? { topic } : {}), done: progress.done, total: progress.total };
    }),
  };
}

export function planPageView(state: DomainState, id: string): PlanView | undefined {
  const plan = state.plans.plans.find((p) => p.id === id);
  if (!plan) return undefined;
  const progress = progressOf(state, plan);
  const home = convTopic(plan.home);
  const goal = (plan.body ?? plan.draft)?.goal;
  const topic = planTopic(plan.id);
  return {
    id: clip(plan.id, 200),
    title: clip(planTitle(plan), 300),
    ...(goal ? { goal: clip(plainLine(goal, 4000), 4000) } : {}),
    state: planState(plan, progress),
    ...(home ? { topic: home } : {}),
    milestones: progress.milestones.slice(0, 50).map((m) => ({
      id: clip(m.milestone.id, 200),
      title: clip(m.milestone.title, 300),
      state: m.state,
      criteria: m.milestone.criteria.slice(0, 40).map((c) => clip(c, 1000)),
      tasks: m.tasks.slice(0, 100).map((t) => {
        const conv = t.worktree ? convTopic(`ws:${t.worktree}`) : undefined;
        return { id: clip(t.task.id, 200), title: clip(t.issue?.key ? `${t.issue.key} ${t.task.title}` : t.task.title, 300), state: t.state, ...(t.forYou ? { mine: true } : {}), ...(conv ? { topic: conv } : {}) };
      }),
    })),
    needsYou: needsYou(state)
      .filter((n) => n.topic === topic || (home && n.topic === home))
      .slice(0, 20),
  };
}

const lastLine = (m: MessageView | undefined): string | undefined => (m ? plainLine(m.text || (m.files?.length ? `${m.files.length} file${m.files.length === 1 ? '' : 's'}` : ''), 300) || undefined : undefined);

export function chatsView(state: DomainState): ChatsView {
  const net = state.network;
  const dms = net.friends.flatMap((f) => {
    const topic = chatTopic(`dm:${f.peerId}`);
    const last = lastLine(f.last);
    return topic ? [{ topic, name: clip(f.name, 100), kind: 'dm' as const, ...(last ? { last } : {}), ...(f.last ? { lastAt: f.last.ts } : {}), unread: f.unread }] : [];
  });
  const groups = net.groups.flatMap((g) => {
    const topic = chatTopic(`group:${g.id}`);
    const last = lastLine(g.last);
    return topic ? [{ topic, name: clip(g.name, 100), kind: 'group' as const, ...(last ? { last } : {}), ...(g.last ? { lastAt: g.last.ts } : {}), unread: g.unread }] : [];
  });
  return { chats: [...dms, ...groups].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).slice(0, 600) };
}

function messageView(state: DomainState, ctx: ViewContext, m: MessageView): ChatMessageView {
  const files = (m.files ?? []).flatMap((f) => {
    const here = state.network.files?.[f.sha];
    const v = here?.state === 'here' && here.path ? ctx.refs.output(here.path, { size: f.size, ts: m.ts }) : undefined;
    return v ? [{ ...v, name: clip(f.name, 256) }] : [];
  });
  return {
    id: clip(m.id, 200),
    from: clip(m.mine ? myName(state) : m.name, 100),
    mine: m.mine,
    ...(m.claude ? { claude: true } : {}),
    text: stripCode(m.text).text,
    ts: m.ts,
    ...(files.length ? { files: files.slice(0, 20) } : {}),
  };
}

/** One chat's messages (the newest, or those before `before`). */
export function chatMessages(state: DomainState, ctx: ViewContext, conversation: string, opts: { before?: string; limit?: number } = {}): { messages: ChatMessageView[]; more: boolean } {
  const all = state.network.messages[conversation] ?? [];
  const end = opts.before ? all.findIndex((m) => m.id === opts.before) : all.length;
  const upto = end < 0 ? all.length : end;
  const limit = opts.limit ?? 100;
  const list = all.slice(Math.max(0, upto - limit), upto);
  return { messages: list.map((m) => messageView(state, ctx, m)), more: upto > list.length };
}

export function chatView(state: DomainState, ctx: ViewContext, topic: Topic): ChatView {
  const conversation = topic.slice('chat:'.length);
  const net = state.network;
  const dm = conversation.startsWith('dm:') ? net.friends.find((f) => `dm:${f.peerId}` === conversation) : undefined;
  const group = conversation.startsWith('group:') ? net.groups.find((g) => `group:${g.id}` === conversation) : undefined;
  const { messages, more } = chatMessages(state, ctx, conversation);
  return {
    topic,
    name: clip(dm?.name ?? group?.name ?? 'Chat', 100),
    kind: group || conversation.startsWith('group:') ? 'group' : 'dm',
    messages,
    more,
    live: (net.live?.[conversation] ?? []).slice(0, 20).map((l) => clip(`${l.name}'s Claude`, 100)),
    members: chatMembers(state, dm, group),
  };
}

/** Whose Claude a chat message can ask: you first, then the friend (a DM) or the group's members. */
function chatMembers(state: DomainState, dm: { peerId: string; name: string } | undefined, group: { members: readonly { peerId: string; name: string; self: boolean }[] } | undefined): ChatView['members'] {
  const me = { peerId: clip(myId(state), 200), name: clip(myName(state), 64), me: true };
  const others = dm ? [{ peerId: dm.peerId, name: dm.name }] : (group?.members ?? []).filter((m) => !m.self && m.peerId !== me.peerId).map((m) => ({ peerId: m.peerId, name: m.name }));
  return [me, ...others.slice(0, 199).map((m) => ({ peerId: clip(m.peerId, 200), name: clip(m.name, 64) }))];
}

export function peopleView(state: DomainState): PeopleView {
  return {
    people: state.network.friends.slice(0, 600).map((f) => {
      const usage = usageViews(state.peers.find((p) => p.peerId === f.peerId)?.usage)[0];
      const card = state.gateway.cards[f.peerId];
      const chat = chatTopic(`dm:${f.peerId}`);
      return {
        peerId: clip(f.peerId, 200),
        name: clip(f.name, 64),
        presence: f.online ? f.presence.state : 'offline',
        ...(f.presence.note ? { note: clip(f.presence.note, 200) } : {}),
        ...(usage ? { usage } : {}),
        offers: [...(card?.claude ? ['claude'] : []), ...(card?.offers ?? [])].slice(0, 20),
        ...(chat ? { chat } : {}),
      };
    }),
  };
}

/** The view a topic carries, or undefined when there's nothing by that name (a plan that's gone). */
export function viewOf(state: DomainState, ctx: ViewContext, topic: Topic): unknown {
  if (topic === 'home') return homeView(state, ctx);
  if (topic === 'work') return workView(state);
  if (topic === 'plans') return plansView(state);
  if (topic === 'chats') return chatsView(state);
  if (topic === 'people') return peopleView(state);
  if (topic.startsWith('conv:')) return convView(state, ctx, topic);
  if (topic.startsWith('plan:')) return planPageView(state, topic.slice('plan:'.length));
  if (topic.startsWith('chat:')) return chatView(state, ctx, topic);
  return undefined;
}
