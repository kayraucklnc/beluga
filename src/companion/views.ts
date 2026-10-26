import { type Approval, type DomainState, type LogItem, type SubAgent, isRunning } from '../core/store.js';
import { waitingNote } from '../core/friend-share-people.js';
import { criteria, tally } from '../core/board/criteria.js';
import { OFFER_DETAIL, offerWords, workingOn, workingWords } from '../core/team/model.js';
import { type Issue, STATUS_INFO, actorName, activityText, assigneeName, byStatus, isArchived } from '../core/board/model.js';
import type { CcAgent } from '../core/claude-code/model.js';
import type { PendingQuestion } from '../core/collab-store.js';
import { type TaskView as GwTask, isFinal, requestGist, stateLabel, stateTone, targetLabel } from '../core/gateway/model.js';
import { parseDecisionQid } from '../core/plans/decisions.js';
import { type Plan, planForHome, planTitle } from '../core/plans/model.js';
import { planOwnerOf } from '../core/plans/owner.js';
import { branchState } from '../core/branch-state.js';
import { type RunSummary, type Sentinel, type SentinelState, firstLine, isLive, lastRunOf, pausedWords, runsOf, scheduleSentence, sentinelById } from '../core/sentinel/model.js';
import type { Workspace } from '../workspaces/types.js';
import { type PlanView as PlanProgress, planView } from '../core/plans/progress.js';
import { shortVersion } from '../net/mesh/features.js';
import type { MessageView, PersonView } from '../net/mesh/views.js';
import { chatPeople, claudePill, offlineNote, waitingIn, waitingLabel } from '../core/chat-people.js';
import type { Usage } from '../protocol.js';
import {
  type BranchView,
  type ChatMessageView,
  type ChatsView,
  type ChatView,
  type ConvSummary,
  type ConvView,
  type HomeView,
  type LiveView,
  type MergeView,
  type NeedsYou,
  type OutputView,
  type PeopleView,
  type PlansView,
  type PlanView,
  type SentinelPageView,
  type SentinelRunView,
  type SentinelSummary,
  type SentinelsView,
  type StepView,
  type SubAgentView,
  TASK_OTHERS,
  type TaskPageView,
  type TaskSummary,
  type TasksView,
  Topic,
  type TurnView,
  type UsageView,
  VIEW_TURNS,
  type WorkView,
} from './protocol.js';
import { HIDDEN_STEP, humanizeDoing, humanizeStep, plainLine, stepWords, stripCode } from './strip.js';
import { withMath } from './math-svg.js';
import { ASSISTANT_CHANNEL, ASSISTANT_TITLE, activeAssistantChannel, assistantChatTitle, isAssistant } from '../shared/assistant.js';
import { STEERED_IN, type SteeredMessage, steeredMessages, steerWaiting } from '../shared/claude-notices.js';
import { slotWaitDetail } from '../shared/run-slots.js';

/** Words for a turn: code taken out (strip.ts), math typeset (math-svg.ts). */
const proseOf = (markdown: string) => withMath(stripCode(markdown));

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
  /** A project's icon, as the checksum of its small PNG (companion.icon), once it's been made (icons.ts). */
  readonly icons?: (projectId: string) => string | undefined;
  /** Where a merge started from the phone stands, per worktree (merge.ts). */
  readonly merges?: (workspaceId: string) => MergeView | undefined;
}

// ---- small helpers

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const valid = (t: string): Topic | undefined => (Topic.safeParse(t).success ? (t as Topic) : undefined);

/** A conversation's topic (`room` → `conv:room`, `ws:<id>` → `conv:ws:<id>`). */
export const convTopic = (channel: string): Topic | undefined => valid(`conv:${channel}`);
export const chatTopic = (conversation: string): Topic | undefined => valid(`chat:${conversation}`);
export const planTopic = (id: string): Topic | undefined => valid(`plan:${id}`);
export const taskTopic = (id: string): Topic | undefined => valid(`task:${id}`);
export const sentinelTopic = (id: string): Topic | undefined => valid(`sentinel:${id}`);
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
  // A friends' chat opens that chat (a request from there, your Claude working there: BLG-207).
  const topic = a.channel ? (/^(dm|group):/.test(a.channel) ? chatTopic(a.channel) : convTopic(a.channel)) : undefined;
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
      { label: a.once ? 'Allow once' : 'Approve', tone: 'main', method: 'host.answerApproval', args: ['yes', a.id] },
      { label: 'Decline', tone: 'danger', method: 'host.answerApproval', args: ['no', a.id] },
      // A friend's request for a secret is asked each time: no Always.
      ...(a.once ? [] : [{ label: 'Always', tone: 'plain' as const, method: 'host.answerApproval', args: ['always', a.id] }]),
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
          // Send it, and let your Claude ask them without checking from now on.
          { label: 'Always', tone: 'plain', method: 'gateway.confirm', args: [t.id, true, '', true] },
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
        title: clip(t.secret ? `${t.peerName} wants ${t.secret.label}` : t.summary ? `${t.peerName}: ${t.summary}` : `${t.peerName} asks your Claude`, 500),
        detail: clip(plainLine(t.ask, 64_000), 64_000),
        from: clip(t.peerName, 100),
        ...(t.chat && chatTopic(t.chat) ? { topic: chatTopic(t.chat)! } : {}),
        askedAt: t.createdAt,
        actions: [
          { label: t.secret ? 'Allow once' : 'Approve', tone: 'main', method: 'gateway.decide', args: [t.id, { answer: 'yes' }] },
          { label: 'Decline', tone: 'danger', method: 'gateway.decide', args: [t.id, { answer: 'no' }] },
          ...(t.secret ? [] : [{ label: 'Always', tone: 'plain' as const, method: 'gateway.decide', args: [t.id, { answer: 'always' }] }]),
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
  // Claude is still writing the first plan: nothing to approve yet (the Mac's Approve Plan waits too).
  if (next.kind === 'approve' && !progress.body?.milestones.length) return [];
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

/** Someone in your room asks to be friends on the Beluga network (BLG-202). */
function offerItems(state: DomainState): NeedsYou[] {
  return (state.network.offers ?? [])
    .filter((o) => o.dir === 'in')
    .map((o) => ({
      id: `friend:${o.peerId}`,
      kind: 'request' as const,
      title: clip(`${o.name} wants to add you as a friend`, 500),
      detail: 'You’re in the same room. As friends you can talk, share and ask each other’s Claude, with nobody hosting',
      from: clip(o.name, 100),
      askedAt: o.at,
      actions: [
        { label: 'Accept', tone: 'main' as const, method: 'network.friends.answerOffer', args: [o.peerId, true] },
        { label: 'Not now', tone: 'danger' as const, method: 'network.friends.answerOffer', args: [o.peerId, false] },
      ],
    }));
}

/** A friend on the same GitHub repository: team up on it (BLG-221). Only offers waiting on you. */
function teamOfferItems(state: DomainState): NeedsYou[] {
  return state.team.offers
    .filter((o) => o.state !== 'asked')
    .map((o) => ({
      id: `team:${o.peerId}:${o.projectId}`,
      kind: 'request' as const,
      title: clip(`${offerWords(o)}. Team up?`, 500),
      detail: OFFER_DETAIL,
      from: clip(o.name, 100),
      askedAt: o.at,
      actions: [
        { label: 'Team Up', tone: 'main' as const, method: 'team.answer', args: [o.peerId, o.projectId, true] },
        { label: 'Not Now', tone: 'danger' as const, method: 'team.answer', args: [o.peerId, o.projectId, false] },
      ],
    }));
}

/** A teammate gave you a task (BLG-223): it waits until you've seen it. */
function assignedItems(state: DomainState): NeedsYou[] {
  return state.team.assigned.flatMap((a) => {
    const topic = taskTopic(a.issueId);
    return [
      {
        id: `team-task:${a.issueId}`,
        kind: 'request' as const,
        title: clip(`${a.by} gave you ${a.key}: ${a.title}`, 500),
        detail: 'It’s in your tasks, on your board for this repository.',
        from: clip(a.by, 100),
        ...(topic ? { topic } : {}),
        askedAt: a.at,
        actions: [{ label: 'Got It', tone: 'main' as const, method: 'team.ackAssignment', args: [a.issueId] }],
      },
    ];
  });
}

/**
 * Shared plans (BLG-225): a plan a teammate shared that you haven't approved (Approve, or words as a
 * comment), and a teammate's suggested change to a plan of yours (Apply / Set Aside).
 */
function sharedPlanItems(state: DomainState): NeedsYou[] {
  const self = myId(state);
  const theirs = state.team.plans
    .filter((p) => p.status === 'draft' && !p.reviews.some((r) => r.by === self && r.kind === 'approve' && r.rev === p.rev))
    .map((p) => ({
      id: `team-plan:${p.owner}:${p.id}:${p.rev}`,
      kind: 'decision' as const,
      title: clip(`${p.ownerName} shared the plan “${p.title}”: approve it?`, 500),
      detail: clip(
        [plainLine(p.body.goal, 2000), ...p.body.milestones.map((m, i) => `${i + 1}. ${m.title} (${m.tasks.length} task${m.tasks.length === 1 ? '' : 's'})`)].filter(Boolean).join('\n'),
        64_000,
      ),
      from: clip(p.ownerName, 100),
      askedAt: p.updatedAt,
      freeText: true,
      actions: [{ label: 'Approve', tone: 'main' as const, method: 'team.reviewPlan', args: [p.owner, p.id, { kind: 'approve' }] }],
      answer: { method: 'team.reviewPlan', args: [p.owner, p.id, { kind: 'comment', text: '' }], slot: [2, 'text'], text: true, picks: false, label: 'Comment' },
    }));
  const mine = Object.values(state.team.planShares).flatMap((share) => {
    const plan = state.plans.plans.find((p) => p.id === share.planId);
    if (!plan) return [];
    return share.reviews
      .filter((r) => r.kind === 'suggest' && !r.settled)
      .map((r) => ({
        id: `team-suggest:${r.id}`,
        kind: 'decision' as const,
        title: clip(`${r.name} suggests ${r.ops?.length === 1 ? 'a change' : `${r.ops?.length ?? 0} changes`} to “${planTitle(plan)}”`, 500),
        ...(r.text ? { detail: clip(r.text, 64_000) } : {}),
        from: clip(r.name, 100),
        ...(planTopic(plan.id) ? { topic: planTopic(plan.id)! } : {}),
        askedAt: r.at,
        actions: [
          { label: 'Apply', tone: 'main' as const, method: 'team.applySuggestion', args: [plan.id, r.id] },
          { label: 'Set Aside', tone: 'danger' as const, method: 'team.dismissSuggestion', args: [plan.id, r.id] },
        ],
      }));
  });
  return [...theirs, ...mine];
}

/**
 * Sentinel runs waiting for you (docs/sentinel.md §5): a merge that passed its checks and review,
 * held for your Merge. The detail is the merge step's own line (the checks, Claude's review).
 */
function sentinelItems(state: DomainState): NeedsYou[] {
  const s = state.sentinel;
  if (!s.enabled) return [];
  return s.runs.flatMap((r) => {
    const sn = r.state === 'needs-you' ? sentinelById(s, r.sentinelId) : undefined;
    if (!sn) return [];
    const at = sn.steps.findIndex((st) => st.kind === 'merge');
    const step = at >= 0 ? (r.steps.find((x) => x.id === sn.steps[at]!.id) ?? r.steps[at]) : undefined;
    const detail = [step?.why ? firstLine(step.why, 2000) : '', r.pr ? `Pull request #${r.pr.number}` : ''].filter(Boolean).join('\n');
    const topic = sentinelTopic(sn.id);
    return [
      {
        id: `sentinel:${r.id}`,
        kind: 'decision' as const,
        title: clip(firstLine(r.headline, 500) || `${sn.name} waits for you`, 500),
        ...(detail ? { detail: clip(detail, 64_000) } : {}),
        from: clip(sn.name, 100),
        ...(topic ? { topic } : {}),
        askedAt: Math.round(step?.startedAt ?? r.startedAt),
        actions: [
          { label: 'Merge', tone: 'main' as const, method: 'sentinel.decide', args: [r.id, 'merge'] },
          { label: 'Not Now', tone: 'danger' as const, method: 'sentinel.decide', args: [r.id, 'skip'] },
        ],
      },
    ];
  });
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
    ...offerItems(state),
    ...teamOfferItems(state),
    ...assignedItems(state),
    ...sharedPlanItems(state),
    ...sentinelItems(state),
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

/**
 * "Your Mac" (BLG-47, core/assistant): your Claude for the whole Mac, not in any project. Since
 * BLG-102 it has chats (the Mac's tabs): each its own conversation, named by its tab when there
 * are more than one; the open one is Home's Ask your Mac.
 */
function assistantConversations(state: DomainState): Conversation[] {
  const chats = state.assistant.chats;
  if (!chats.length) return [{ channel: ASSISTANT_CHANNEL, title: ASSISTANT_TITLE, mine: true }];
  return chats.map((c) => ({ channel: c.channel, title: chats.length > 1 ? `${ASSISTANT_TITLE} · ${assistantChatTitle(c.channel, state.log)}` : ASSISTANT_TITLE, mine: true }));
}

/** The open chat of Your Mac: Home's Ask your Mac. */
const openAssistant = (state: DomainState): Conversation => {
  const channel = activeAssistantChannel(state.assistant);
  return assistantConversations(state).find((c) => c.channel === channel) ?? { channel, title: ASSISTANT_TITLE, mine: true };
};

/** Your Mac's chats for the phone's list (1.14): in tab order, each titled by its tab. */
function macChatSummaries(state: DomainState, waiting: ReadonlySet<string>, ctx?: ViewContext): ConvSummary[] {
  return state.assistant.chats.slice(0, 40).flatMap((c) => summaryOf(state, { channel: c.channel, title: assistantChatTitle(c.channel, state.log, 60), mine: true }, waiting, ctx) ?? []);
}

/**
 * The conversation a channel the phone names is: an older phone knows only `mac:assistant`, so
 * once that first chat is deleted it means the chat open on the Mac. Anything else as it is.
 */
export function phoneChannel(state: DomainState, channel: string): string {
  if (channel !== ASSISTANT_CHANNEL || !state.assistant.chats.length || state.assistant.chats.some((c) => c.channel === channel)) return channel;
  return activeAssistantChannel(state.assistant);
}

/**
 * Every conversation the phone can open: Your Mac, your workspaces (not archived), the ones shared
 * with you, and the room's. A project's main checkout is none (BLG-70): its conversations are the
 * chats and worktrees you started (an old main conversation became one of its chats).
 */
export function conversations(state: DomainState): Conversation[] {
  const own = state.projects.flatMap((p) =>
    p.workspaces.filter((w) => !w.archived && !w.pending && w.kind !== 'main').map((w) => ({ channel: `ws:${w.id}`, title: w.name, project: p.name, projectId: p.id, cwd: w.path, mine: true })),
  );
  const shared = state.shared.map((w) => ({ channel: `ws:${w.id}`, title: w.name, project: `${nameOf(state, w.owner) ?? 'a friend'} · ${w.project}`, mine: w.role === 'contribute' }));
  const room = state.log.some((l) => l.channel === 'room') ? [{ channel: 'room', title: state.room || 'The room', mine: true }] : [];
  // What you asked friends' Claudes yourself (not from a conversation): each reads as its own conversation.
  const asked = state.gateway.tasks
    .filter((t) => t.direction === 'sent' && !t.conversation)
    .slice(-TASKS_SHOWN)
    .map((t) => ({ channel: `task:${t.id}`, title: plainLine(t.summary ?? t.ask, 300) || 'A question', project: 'Asked of friends', projectId: 'asked', mine: false }));
  const seen = new Set<string>();
  return [...assistantConversations(state), ...own, ...shared, ...room, ...asked].filter((c) => !seen.has(c.channel) && Boolean(seen.add(c.channel)));
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
    { id: `${t.id}:ask`, who: 'you', name: clip(myName(state), 100), prose: proseOf(t.ask), ts: t.createdAt },
    {
      id: `${t.id}:answer`,
      who: 'friend',
      name: clip(`${t.peerName}'s Claude`, 100),
      prose: proseOf(said),
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

/** Steps in words with their tools' kinds, newest last (what the Mac's chat hides stays hidden). */
const trailOf = (steps: readonly string[], max: number): StepView[] =>
  steps
    .filter((s) => !HIDDEN_STEP.test(s))
    .slice(-max)
    .map((s) => {
      const w = stepWords(s);
      return { tool: w.tool, text: w.did };
    });

/** The Claude Code agents of a conversation's own sessions (a worktree's), by the tool call that started each: their live step and kind. */
function ccAgents(state: DomainState, channel: string): Map<string, CcAgent> {
  const ws = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  const out = new Map<string, CcAgent>();
  if (!ws) return out;
  for (const s of state.claudeCode.sessions) if (s.workspaceId === ws) for (const a of s.agents) out.set(a.toolUseId ?? a.id, a);
  return out;
}

function subView(sub: SubAgent, outputs: readonly OutputView[], cc?: CcAgent): SubAgentView {
  const steps = sub.steps.filter((s) => !HIDDEN_STEP.test(s));
  const last = steps.at(-1);
  // Still at work when Claude Code sees it working, though its run counted it done (BLG-110: its
  // turn ended while it works on in the background): the phone shouldn't say nothing happens.
  const status = sub.status === 'done' && cc?.status === 'running' ? 'running' : sub.status;
  // What it's doing now: Claude Code's own words for it when it's watched, else its last step.
  const now = status !== 'running' ? undefined : cc?.step ? humanizeDoing(cc.step) : last ? (({ doing, tool }) => ({ text: doing, tool }))(stepWords(last)) : undefined;
  return {
    id: clip(sub.id, 200),
    title: clip(plainLine(sub.title, 300) || 'Sub-agent', 300),
    status,
    steps: sub.steps.slice(-30).map(humanizeStep),
    outputs: outputs.filter((o) => o.by === sub.id).slice(0, 50),
    trail: trailOf(sub.steps, 30),
    ...(now ? { step: clip(now.text, 300), tool: now.tool } : {}),
    ...(cc?.type ? { type: clip(cc.type, 60) } : {}),
    ...((sub.startedAt ?? cc?.startedAt) !== undefined ? { startedAt: Math.round((sub.startedAt ?? cc?.startedAt)!) } : {}),
    ...(cc?.endedAt !== undefined && status !== 'running' ? { endTs: Math.round(cc.endedAt) } : {}),
    count: Math.max(steps.length, cc?.steps ?? 0),
  };
}

/**
 * A Claude Code agent of this worktree's sessions that no run reported as its own sub-agent (one a
 * sub-agent started, say): drawn with the turn it worked in, from what Claude Code says of it.
 */
function ccSubView(a: CcAgent, outputs: readonly OutputView[]): SubAgentView {
  const status: SubAgentView['status'] = a.status === 'running' || a.status === 'idle' ? (a.status === 'running' ? 'running' : 'done') : a.status === 'failed' ? 'failed' : 'done';
  const now = status === 'running' && a.step ? humanizeDoing(a.step) : undefined;
  const id = a.toolUseId ?? a.id;
  return {
    id: clip(id, 200),
    title: clip(plainLine(a.description, 300) || a.type || 'Sub-agent', 300),
    status,
    steps: [],
    outputs: outputs.filter((o) => o.by === id).slice(0, 50),
    trail: [],
    ...(now ? { step: clip(now.text, 300), tool: now.tool } : {}),
    ...(a.type ? { type: clip(a.type, 60) } : {}),
    startedAt: Math.round(a.startedAt),
    ...(a.endedAt !== undefined ? { endTs: Math.round(a.endedAt) } : {}),
    count: a.steps,
  };
}

/** What a running turn is doing now: thinking, writing, a step with its tool and count, waiting. */
function liveOf(item: AgentItem): LiveView | undefined {
  if (!isRunning(item.status)) return undefined;
  const agents = item.subagents.filter((s) => s.status === 'running' && s.kind !== 'background').length;
  const subs = agents ? { agents } : {};
  if (item.status === 'queued') return { phase: 'queued', ...subs };
  if (item.status === 'awaiting_approval') return { phase: 'approval', ...subs };
  if (item.between === 'thinking' || item.between === 'writing') return { phase: item.between, ...(item.betweenAt !== undefined ? { since: Math.round(item.betweenAt) } : {}), ...subs };
  const last = item.steps.filter((s) => !HIDDEN_STEP.test(s)).at(-1);
  if (!last) return item.text ? { phase: 'writing', ...subs } : { phase: 'starting', ...(item.ts ? { since: item.ts } : {}), ...subs };
  const w = stepWords(last);
  return {
    phase: 'step',
    words: clip(w.doing, 300),
    tool: w.tool,
    ...(item.progress ? { progress: clip(item.progress, 40) } : {}),
    ...(item.stepAt !== undefined ? { since: Math.round(item.stepAt) } : {}),
    ...subs,
  };
}

/** The step a running turn is on, in words ("Running the tests · 137/215", "Thinking"). */
function liveStep(item: AgentItem): string | undefined {
  const live = liveOf(item);
  if (!live) return undefined;
  switch (live.phase) {
    case 'queued':
      return 'Waiting its turn';
    case 'approval':
      return 'Waiting for your approval';
    case 'thinking':
      return 'Thinking';
    case 'writing':
      return 'Writing';
    case 'starting':
      return 'Working';
    default:
      return clip(live.progress ? `${live.words ?? 'Working'} · ${live.progress}` : (live.words ?? 'Working'), 300);
  }
}

/**
 * A conversation's items with your steered messages as the Mac draws them (BLG-54): one Claude
 * hasn't read yet says so on the message, and the note cards about them aren't turns.
 */
function withSteers(items: readonly LogItem[]): Array<{ item: LogItem; steer?: SteeredMessage }> {
  const { waiting, notes } = steeredMessages(items);
  return items.flatMap((item) => (notes.has(item.id) ? [] : [{ item, ...(waiting.has(item.id) ? { steer: waiting.get(item.id)! } : {}) }]));
}

function turnOf(state: DomainState, item: LogItem, outputs: readonly OutputView[], cc: ReadonlyMap<string, CcAgent> = new Map(), steer?: SteeredMessage): TurnView | undefined {
  const me = myId(state);
  if (item.type === 'chat') {
    const who = item.byAgent ? 'claude' : item.from === me ? 'you' : 'friend';
    return { id: item.id, who, name: clip(who === 'you' ? myName(state) : item.name, 100), prose: proseOf(item.text), ts: item.ts, ...(steer && who === 'you' ? { steer: { request: clip(steer.request, 200), waiting: steer.waiting } } : {}) };
  }
  if (item.type === 'system') {
    // Earlier lines of a shared workspace's conversation ("bob: …") read as that person's turn.
    if (item.said) return { id: item.id, who: item.said.byAgent ? 'claude' : item.said.from === me ? 'you' : 'friend', name: clip(item.said.name, 100), prose: proseOf(item.said.text), ts: item.said.ts };
    if (item.level === 'info') return undefined;
    return { id: item.id, who: 'system', name: 'Beluga', prose: proseOf(item.text), ts: item.ts };
  }
  if (item.type === 'shell') {
    // A command on a friend's Mac: that it ran and how it went, not the command or its output.
    const how = item.status === 'done' ? 'finished' : item.status === 'failed' ? 'failed' : item.status === 'declined' ? 'was declined' : item.status === 'waiting' ? 'waits for their approval' : 'is running';
    return { id: item.id, who: 'system', name: 'Beluga', prose: { text: `${clip(item.by, 60)} ran a command on ${clip(item.ownerName, 60)}'s Mac: it ${how}.`, code: [] }, ts: item.ts };
  }
  const end = item.endTs ?? Number.POSITIVE_INFINITY;
  const status = turnStatus(item);
  const step = status === 'working' || status === 'queued' ? liveStep(item) : undefined;
  const live = status === 'working' || status === 'queued' ? liveOf(item) : undefined;
  const subs = item.subagents.filter((s) => s.kind !== 'background');
  const known = new Set(item.subagents.map((s) => s.id));
  // Agents Claude Code saw working in this turn that no run event named (a sub-agent's own helpers).
  const extra = [...cc.values()].filter((a) => !known.has(a.toolUseId ?? a.id) && !a.background && a.startedAt >= item.ts && a.startedAt <= end);
  const theirs = new Set([...known, ...extra.map((a) => a.toolUseId ?? a.id)]);
  const mineOut = outputs.filter((o) => o.ts !== undefined && o.ts >= item.ts && o.ts <= end && !(o.by && theirs.has(o.by)));
  const agents = [...subs.map((s) => subView(s, outputs, cc.get(s.id))), ...extra.map((a) => ccSubView(a, outputs.filter((o) => o.by === (a.toolUseId ?? a.id))))].slice(-40);
  const trail = trailOf(item.steps, 40);
  return {
    id: item.id,
    who: 'claude',
    name: clip(item.owner === me || !item.owner ? 'Claude' : `${item.ownerName}'s Claude`, 100),
    prose: proseOf(item.text),
    ts: item.ts,
    ...(status ? { status } : {}),
    ...(step ? { step } : {}),
    steps: item.steps.length,
    ...(agents.length ? { subagents: agents } : {}),
    ...(mineOut.length ? { outputs: mineOut.slice(0, 50) } : {}),
    ...(item.endTs !== undefined ? { endTs: item.endTs } : {}),
    ...(live ? { live } : {}),
    ...(trail.length ? { trail } : {}),
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

/** A project's icon checksum, when the Mac has one for it. */
const iconOf = (ctx: ViewContext | undefined, projectId: string | undefined): { icon: string } | Record<string, never> => {
  const sum = projectId && ctx?.icons ? ctx.icons(projectId) : undefined;
  return sum && /^[0-9a-f]{16,64}$/.test(sum) ? { icon: sum } : {};
};

/** Outputs made since the conversation's latest run began (what Home hints at as new). */
function freshOutputs(state: DomainState, ctx: ViewContext | undefined, conv: Conversation): number {
  if (!ctx?.outputs) return 0;
  const since = [...itemsOf(state, conv.channel)].reverse().find((l) => l.type === 'agent' && l.status !== 'queued')?.ts;
  if (since === undefined) return 0;
  return outputsOf(ctx, conv).filter((o) => (o.ts ?? 0) >= since).length;
}

function summaryOf(state: DomainState, conv: Conversation, waiting: ReadonlySet<string>, ctx?: ViewContext): ConvSummary | undefined {
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
  // A note about a steered message ("reads this after its current step") isn't the last thing said.
  const last = [...items].reverse().find((l) => (l.type === 'chat' || (l.type === 'agent' && !steerWaiting(l) && l.text !== STEERED_IN)) && (l.type === 'chat' ? l.text : l.text || l.prompt));
  const lastText = last?.type === 'chat' ? last.text : last?.type === 'agent' ? last.text || last.prompt || '' : '';
  const status: ConvSummary['status'] = waiting.has(topic) ? 'waiting' : running.length ? 'working' : lastAgent && (lastAgent.status === 'error' || lastAgent.status === 'denied') ? 'failed' : 'idle';
  const lastAt = Math.max(0, ...items.map((l) => (l.type === 'agent' ? (l.lastAt ?? l.endTs ?? l.ts) : l.ts)));
  const subs = running.reduce((n, a) => n + a.subagents.filter((s) => s.status === 'running' && s.kind !== 'background').length, 0);
  const unread = state.unread[conv.channel] ?? 0;
  const fresh = freshOutputs(state, ctx, conv);
  // While it works, its line is what it's doing now (as the conversation's live step says it).
  const liveLine = running.length ? liveStep(running.at(-1)!) : undefined;
  return {
    topic,
    title: clip(conv.title, 300),
    ...(conv.project ? { project: clip(conv.project, 200) } : {}),
    status,
    ...(liveLine && status === 'working' ? { last: liveLine } : lastText ? { last: plainLine(refWords(state, lastText), 300) } : {}),
    ...(lastAt ? { lastAt } : {}),
    ...(unread ? { unread } : {}),
    ...(waiting.has(topic) ? { needsYou: true } : {}),
    ...(subs ? { agents: subs } : {}),
    ...(conv.projectId && conv.projectId !== 'asked' ? { projectId: clip(conv.projectId, 200), ...iconOf(ctx, conv.projectId) } : {}),
    ...(fresh ? { fresh } : {}),
  };
}

/** A one-line summary names what Your Mac started (`worktree:<id>`, `plan:<id>`, `task:<KEY>`) by its name, not its id. */
function refWords(state: DomainState, text: string): string {
  return text.replace(/`(worktree|plan|task):\s*([\w-]+)`/gi, (_m, kind: string, id: string) => {
    if (kind.toLowerCase() === 'worktree') return state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id)?.name ?? 'a new worktree';
    if (kind.toLowerCase() === 'plan') {
      const plan = state.plans.plans.find((p) => p.id === id);
      return plan ? planTitle(plan) : 'a plan';
    }
    return id.toUpperCase();
  });
}

const waitingTopics = (items: readonly NeedsYou[]): Set<string> => new Set(items.flatMap((n) => (n.topic ? [n.topic] : [])));

// ---- the views

export function homeView(state: DomainState, ctx: ViewContext): HomeView {
  const items = needsYou(state);
  const waiting = waitingTopics(items);
  const convs = conversations(state);
  const summaries = convs.flatMap((c) => summaryOf(state, c, waiting, ctx) ?? []);
  const running = summaries.filter((s) => s.status === 'working' || s.status === 'waiting').sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const work = convs.reduce((n, c) => n + (state.unread[c.channel] ?? 0), 0);
  const chats = state.network.friends.reduce((n, f) => n + f.unread, 0) + state.network.groups.reduce((n, g) => n + g.unread, 0);
  const review = boardIssues(state).filter((i) => i.status === 'in_review');
  const first = review[0] ? taskTopic(review[0].id) : undefined;
  const assistant = summaryOf(state, openAssistant(state), waiting, ctx);
  const macChats = macChatSummaries(state, waiting, ctx);
  return {
    mac: { name: clip(ctx.mac.name, 100), version: clip(ctx.mac.version, 40), keepAwake: state.prefs.keepAwake ?? 'off' },
    // 1.5: Your Mac, for Home's "Ask your Mac" (its last line, whether it works).
    ...(assistant ? { assistant } : {}),
    // 1.14: all of Your Mac's chats, for the phone's chat list.
    ...(macChats.length ? { macChats } : {}),
    me: { name: clip(myName(state), 64), peerId: myId(state) },
    usage: usageViews(state.self?.usage),
    needsYou: items,
    running: running.slice(0, 20),
    // Outputs live with their conversation now (ConvView `outputs`); Home only hints (`fresh`).
    outputs: [],
    unread: { work, chats },
    ...(review.length ? { review: { count: review.length, ...(first ? { first: { topic: first, key: clip(review[0]!.key, 40), title: clip(plainLine(review[0]!.title, 300), 300) } } : {}) } } : {}),
  };
}

export function workView(state: DomainState, ctx?: ViewContext): WorkView {
  const waiting = waitingTopics(needsYou(state));
  const convs = conversations(state);
  const byProject = new Map<string, { id: string; name: string; conversations: ConvSummary[]; icon?: string }>();
  // Your Mac has its own places (Home, the Ask sheet's first target).
  for (const c of convs) {
    if (isAssistant(c.channel)) continue;
    const s = summaryOf(state, c, waiting, ctx);
    if (!s) continue;
    const key = c.projectId ?? (c.channel === 'room' ? 'room' : `shared:${c.project ?? ''}`);
    const entry = byProject.get(key) ?? { id: clip(key, 200), name: clip(c.project ?? c.title, 200), conversations: [], ...(c.projectId ? iconOf(ctx, c.projectId) : {}) };
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
export function convTurns(state: DomainState, ctx: ViewContext, named: string, opts: { before?: string; limit?: number } = {}): { turns: TurnView[]; more: boolean } {
  const channel = phoneChannel(state, named);
  const conv = conversations(state).find((c) => c.channel === channel) ?? { channel };
  const task = taskOf(state, channel);
  const outputs = task ? [] : outputsOf(ctx, conv);
  const cc = ccAgents(state, channel);
  const all = task ? taskTurns(state, ctx, task) : withLateOutputs(withSteers(itemsOf(state, channel)).flatMap(({ item, steer }) => (turnOf(state, item, outputs, cc, steer) ?? [])), outputs);
  const end = opts.before ? all.findIndex((t) => t.id === opts.before) : all.length;
  const upto = end < 0 ? all.length : end;
  const limit = opts.limit ?? VIEW_TURNS;
  const turns = all.slice(Math.max(0, upto - limit), upto);
  return { turns, more: upto > turns.length };
}

export function convView(state: DomainState, ctx: ViewContext, topic: Topic): ConvView {
  const channel = phoneChannel(state, channelOf(topic) ?? '');
  const conv = conversations(state).find((c) => c.channel === channel);
  const { turns, more } = convTurns(state, ctx, channel);
  const real = convTopic(channel);
  // The plan it's the home of: its decisions (approve, pass a milestone) are asked here too, as on the Mac.
  const plan = planForHome(state.plans, channel);
  const planT = plan ? planTopic(plan.id) : undefined;
  const items = needsYou(state).filter((n) => n.topic === topic || (real && n.topic === real) || (planT && n.topic === planT));
  const task = taskOf(state, channel);
  const working = task ? !isFinal(task.state) : itemsOf(state, channel).some((l) => l.type === 'agent' && isRunning(l.status));
  // Everything this worktree made, newest first: what the viewer swipes through from here.
  const outputs = task ? turns.flatMap((t) => t.outputs ?? []) : outputsOf(ctx, conv ?? { channel });
  const queue = queueOf(state, channel);
  return {
    topic,
    title: clip(conv?.title ?? (channel === 'room' ? state.room || 'The room' : 'Conversation'), 300),
    ...(conv?.project ? { project: clip(conv.project, 200) } : {}),
    turns,
    more,
    needsYou: items.slice(0, 20),
    canSend: conv?.mine ?? false,
    working,
    ...(conv?.projectId && conv.projectId !== 'asked' ? { projectId: clip(conv.projectId, 200), ...iconOf(ctx, conv.projectId) } : {}),
    outputs: outputs.slice(0, 100),
    ...(queue.length ? { queue } : {}),
    ...mergeOf(state, ctx, channel),
    ...(plan && planT ? { plan: planBand(state, plan, planT) } : {}),
    ...waitingOf(state, channel),
  };
}

/** A friend's worktree whose Mac is offline: the message box says so (what you send waits for it). */
function waitingOf(state: DomainState, channel: string): { waiting?: string } {
  const note = channel.startsWith('ws:') ? waitingNote(state, channel.slice(3)) : undefined;
  return note ? { waiting: clip(note, 200) } : {};
}

function planBand(state: DomainState, plan: Plan, topic: Topic): NonNullable<ConvView['plan']> {
  const progress = progressOf(state, plan);
  return { topic, title: clip(planTitle(plan), 300), state: planState(plan, progress), done: progress.done, total: progress.total, milestones: progress.milestones.length };
}

const base = (p: string): string => p.split('/').at(-1) ?? p;

/**
 * A worktree's merge as the phone follows it: what the phone started (merging, Claude resolving),
 * or conflicts the Mac's own Merge found. Claude resolving reads as done once its run there ends.
 */
function mergeOf(state: DomainState, ctx: ViewContext, channel: string): Pick<ConvView, 'mergeable' | 'merge' | 'branch'> {
  const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  const ws = id ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) : undefined;
  if (!id || !ws || ws.kind !== 'worktree' || !ws.branch || ws.archived) return {};
  const conflicts = (state.conflicts[id] ?? []).slice(0, 100).map((f) => clip(base(f), 300));
  let merge = ctx.merges?.(id);
  if (merge?.phase === 'resolving') {
    const at = merge.at;
    const runs = itemsOf(state, channel).filter((l): l is AgentItem => l.type === 'agent' && l.ts >= at - 1000);
    if (runs.length && !runs.some((r) => isRunning(r.status))) merge = { ...merge, phase: 'resolved' };
  }
  // (No time: the Mac's merge doesn't say when; a view must hash the same while nothing changes.)
  if (!merge && conflicts.length) merge = { phase: 'conflicts', at: 0, conflicts };
  const branch = branchViewOf(state, ws);
  return { mergeable: true, ...(merge ? { merge } : {}), ...(branch ? { branch } : {}) };
}

/** The branch's state, the Mac toolbar's own (core/branch-state.ts), in words. */
function branchViewOf(state: DomainState, ws: Workspace): BranchView | undefined {
  const b = branchState(state, ws, { planned: Boolean(planOwnerOf(state.plans, state.board, ws.id)) });
  if (!b) return undefined;
  const next = b.steps[0];
  const url = state.prs[ws.id]?.url;
  // Create PR with Instructions is the Mac's sheet: the phone has the other ways.
  const phoneSteps = b.steps.filter((s) => s.id !== 'pr_custom');
  return {
    kind: b.kind,
    label: clip(b.label, 80),
    tone: b.tone,
    detail: clip(plainLine(b.detail, 300), 300),
    branch: clip(b.branch, 250),
    into: clip(b.into, 250),
    ...(b.pr ? { pr: { ...b.pr, ...(url ? { url: clip(url, 500) } : {}) } } : {}),
    ...(next ? { next: { id: next.id, label: clip(next.label, 80), ...(next.claude ? { claude: true } : {}) } } : {}),
    ...(phoneSteps.length ? { steps: phoneSteps.slice(0, 20).map((s) => ({ id: s.id, label: clip(s.label, 80), hint: clip(plainLine(s.hint, 300), 300), ...(s.claude ? { claude: true } : {}), ...(s.danger ? { danger: true } : {}) })) } : {}),
  };
}

/** Your messages waiting for your Claude in a conversation, in run order (the Mac's queue tray, src/ui/compose.ts queueIn). */
function queueOf(state: DomainState, channel: string): NonNullable<ConvView['queue']> {
  const me = myId(state);
  return state.log
    .filter((l): l is AgentItem => l.type === 'agent' && l.channel === channel && l.status === 'queued' && l.owner === me && (l.requester !== undefined ? l.requester === me : l.requesterName === l.ownerName))
    .slice(0, 20)
    .map((l) => ({ id: clip(l.requestId, 200), text: plainLine(l.prompt ?? '', 300) || 'A message', ...(l.slotWait ? { waiting: clip(slotWaitDetail(l.slotWait), 300) } : {}) }));
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
        const goal = t.task.goal ? plainLine(t.task.goal, 1000) : '';
        // What it still waits on while it can't start; the plan's wiring while it's a draft.
        const waits = t.state === 'draft' || t.state === 'later' ? t.task.blockedBy : t.waitsOn;
        return {
          id: clip(t.task.id, 200),
          title: clip(t.issue?.key ? `${t.issue.key} ${t.task.title}` : t.task.title, 300),
          state: t.state,
          ...(t.forYou ? { mine: true } : {}),
          ...(conv ? { topic: conv } : {}),
          ...(goal ? { goal } : {}),
          ...(t.task.acceptance.length ? { acceptance: t.task.acceptance.slice(0, 20).map((a) => clip(plainLine(a, 400), 400)) } : {}),
          ...(waits.length ? { blockedBy: waits.slice(0, 20).map((b) => clip(b, 200)) } : {}),
          ...(t.why ? { why: clip(plainLine(t.why, 300), 300) } : {}),
        };
      }),
      ...(m.dependsOn.length ? { dependsOn: m.dependsOn.slice(0, 20).map((d) => clip(d, 200)) } : {}),
      ...(m.autonomy !== plan.autonomy ? { autonomy: m.autonomy } : {}),
    })),
    autonomy: plan.autonomy,
    ...(plan.paused ? { paused: true } : {}),
    parallel: plan.maxParallel,
    running: progress.active.length,
    needsYou: needsYou(state)
      .filter((n) => n.topic === topic || (home && n.topic === home))
      .slice(0, 20),
  };
}

// ---- tasks (the board)

/** The board's tasks the phone shows: not archived, of a project you have. */
const boardIssues = (state: DomainState): Issue[] => (state.board.enabled ? state.board.issues.filter((i) => !isArchived(i) && state.projects.some((p) => p.id === i.projectId)) : []);

/** "you", "your Claude", "Mia", "Mia's Claude": who has it, from where you look. */
const assigneeWords = (state: DomainState, i: Issue): string | undefined => {
  if (!i.assignee) return undefined;
  const name = assigneeName(i.assignee, myId(state));
  return clip(name === 'You' ? 'you' : name === 'Your Claude' ? 'your Claude' : name, 80);
};

/** The conversation of the worktree doing a task, when it's one the phone can open. */
function taskConv(state: DomainState, i: Issue): Topic | undefined {
  const ws = i.worktrees.at(-1) ?? i.carriedBy;
  if (!ws) return undefined;
  const open = state.projects.some((p) => p.workspaces.some((w) => w.id === ws && !w.archived && !w.pending));
  return open ? convTopic(`ws:${ws}`) : undefined;
}

function taskSummary(state: DomainState, i: Issue): TaskSummary | undefined {
  const topic = taskTopic(i.id);
  if (!topic) return undefined;
  const t = tally(i.brief.acceptance);
  const conv = taskConv(state, i);
  const who = assigneeWords(state, i);
  const working = workingWords(workingOn(state.team, i.id).map((p) => p.name));
  return {
    id: clip(i.id, 200),
    topic,
    key: clip(i.key, 40),
    title: clip(plainLine(i.title, 300) || i.key, 300),
    status: i.status,
    priority: i.priority,
    ...(who ? { assignee: who } : {}),
    ...(t.total ? { checks: { done: t.done, total: t.total } } : {}),
    ...(conv ? { conv } : {}),
    ...(i.pr ? { pr: { number: i.pr.number, state: i.pr.state } } : {}),
    ...(working ? { working: clip(working, 200) } : {}),
    updatedAt: Math.round(i.updatedAt),
  };
}

/** The board's statuses as the phone lists them, and how many of the finished ones. */
const LISTED = ['in_progress', 'in_review', 'in_plan', 'todo', 'backlog', 'done'] as const;
const DONE_SHOWN = 10;
const PER_GROUP = 100;

export function tasksView(state: DomainState, ctx?: ViewContext): TasksView {
  const issues = boardIssues(state);
  const projects = state.projects.flatMap((p) => {
    const mine = issues.filter((i) => i.projectId === p.id);
    if (!mine.length) return [];
    const groups = byStatus(mine)
      .filter((g) => (LISTED as readonly string[]).includes(g.status) && g.issues.length)
      .sort((a, b) => LISTED.indexOf(a.status as (typeof LISTED)[number]) - LISTED.indexOf(b.status as (typeof LISTED)[number]))
      .map((g) => {
        // Done: the latest few, newest first; the rest in the board's order.
        const list = g.status === 'done' ? [...g.issues].sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt)) : g.issues;
        const max = g.status === 'done' ? DONE_SHOWN : PER_GROUP;
        const tasks = list.slice(0, max).flatMap((i) => taskSummary(state, i) ?? []);
        return { status: g.status, label: STATUS_INFO[g.status].label, tasks, ...(list.length > max ? { more: list.length - max } : {}) };
      });
    return [{ id: clip(p.id, 200), name: clip(p.name, 200), ...iconOf(ctx, p.id), groups }];
  });
  // The project with the latest change first.
  const latest = (id: string): number => Math.max(0, ...issues.filter((i) => i.projectId === id).map((i) => i.updatedAt));
  const sorted = projects.sort((a, b) => latest(b.id) - latest(a.id)).slice(0, 100);
  // Every other task by key, title and status (BLG-109): a key in Claude's words is a chip even when the list leaves it out.
  const listed = new Set(sorted.flatMap((p) => p.groups.flatMap((g) => g.tasks.map((t) => t.id))));
  const others = issues
    .filter((i) => !listed.has(i.id) && taskTopic(i.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, TASK_OTHERS)
    .map((i) => ({ id: clip(i.id, 200), key: clip(i.key, 40), title: clip(plainLine(i.title, 120) || i.key, 120), status: i.status }));
  return { projects: sorted, ...(others.length ? { others } : {}) };
}

/** Where a task may be moved from the phone (board.move): the open statuses and Done, not where it is. */
const MOVES = ['todo', 'in_progress', 'in_review', 'done', 'backlog', 'canceled'] as const;

export function taskPageView(state: DomainState, id: string, ctx?: ViewContext): TaskPageView | undefined {
  const i = boardIssues(state).find((x) => x.id === id);
  const summary = i ? taskSummary(state, i) : undefined;
  if (!i || !summary) return undefined;
  const project = state.projects.find((p) => p.id === i.projectId);
  const me = myId(state);
  const goal = i.brief.goal?.trim() ? stripCode(i.brief.goal.slice(0, 4000)) : undefined;
  const words = (s: string, max: number): string => clip(stripCode(s).text.replace(/\[\[code(?::\d+)?\]\]/g, '(code)'), max);
  const ws = i.worktrees.at(-1);
  const worktree = ws ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === ws)?.name : undefined;
  const { pr: _pr, ...rest } = summary;
  return {
    ...rest,
    project: clip(project?.name ?? '', 200),
    projectId: clip(i.projectId, 200),
    ...iconOf(ctx, i.projectId),
    ...(goal ? { goal } : {}),
    acceptance: criteria(i.brief.acceptance)
      .slice(0, 60)
      .map((c) => ({ text: clip(plainLine(c.text, 1000), 1000), state: c.state, ...(c.reason ? { reason: clip(plainLine(c.reason, 1000), 1000) } : {}) })),
    activity: i.activity.slice(-60).map((a) => ({
      id: clip(a.id, 200),
      at: Math.round(a.at),
      who: clip(actorName(a.by, me), 80),
      text: clip(plainLine(activityText(a, me), 500), 500),
      ...(a.body ? { body: words(a.body, 8000) } : {}),
      ...(a.kind === 'comment' ? { comment: true } : {}),
    })),
    ...(worktree ? { worktree: clip(worktree, 200) } : {}),
    ...(i.pr ? { pr: { number: i.pr.number, state: i.pr.state, title: clip(plainLine(i.pr.title, 300), 300), checks: i.pr.checks } } : {}),
    moves: MOVES.filter((s) => s !== i.status).map((s) => ({ status: s, label: STATUS_INFO[s].label })),
  };
}

// ---- Sentinel (docs/sentinel.md): your watchers, their runs and reports

/** Runs that ended, across sentinels, for Home's "ran since you looked". */
const RECENT_RUNS = 20;

function sentinelSummary(state: DomainState, s: SentinelState, sn: Sentinel): SentinelSummary | undefined {
  const topic = sentinelTopic(sn.id);
  if (!topic) return undefined;
  const project = sn.projectId ? state.projects.find((p) => p.id === sn.projectId) : undefined;
  const last = lastRunOf(s, sn.id);
  const next = s.nextAt[sn.id];
  return {
    id: clip(sn.id, 200),
    topic,
    name: clip(sn.name, 100),
    icon: clip(sn.icon, 40),
    ...(sn.projectId ? { projectId: clip(sn.projectId, 200) } : {}),
    ...(project ? { project: clip(project.name, 200) } : {}),
    sentence: clip(scheduleSentence(sn.trigger, (id) => sentinelById(s, id)?.name), 300),
    paused: sn.paused,
    ...(pausedWords(sn) ? { pausedWhy: clip(pausedWords(sn)!, 300) } : {}),
    ...(!sn.paused && s.troubles?.[sn.id] ? { trouble: clip(s.troubles[sn.id]!, 300) } : {}),
    ...(last ? { last: { state: last.state, headline: firstLine(last.headline, 300), at: Math.round(last.endedAt ?? last.startedAt) } } : {}),
    ...(next !== undefined && !sn.paused ? { nextAt: Math.round(next) } : {}),
    live: s.runs.some((r) => r.sentinelId === sn.id && isLive(r.state)),
  };
}

export function sentinelsView(state: DomainState): SentinelsView {
  const s = state.sentinel;
  if (!s.enabled) return { enabled: false, sentinels: [], recent: [] };
  const recent = s.runs
    .filter((r) => !isLive(r.state) && r.endedAt !== undefined && sentinelById(s, r.sentinelId))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, RECENT_RUNS)
    .map((r) => ({ id: clip(r.id, 200), sentinelId: clip(r.sentinelId, 200), state: r.state, at: Math.round(r.endedAt!) }));
  return { enabled: true, sentinels: s.items.slice(0, 200).flatMap((sn) => sentinelSummary(state, s, sn) ?? []), recent };
}

/** Who ran it, in words ("schedule", "you", "after Nightly tests"). */
function runBy(s: SentinelState, r: RunSummary): string {
  if (r.by.startsWith('after:')) {
    const before = s.runs.find((x) => x.id === r.by.slice('after:'.length));
    const name = before ? sentinelById(s, before.sentinelId)?.name : undefined;
    return clip(name ? `after ${name}` : 'after another sentinel', 120);
  }
  if (r.by === 'event') return firstLine(r.trigger.summary, 120) || 'an event';
  return r.by === 'phone' ? 'your phone' : r.by === 'claude' ? 'your Claude' : r.by;
}

function sentinelRunView(s: SentinelState, sn: Sentinel, r: RunSummary, ctx?: ViewContext): SentinelRunView {
  const live = s.live[r.id]?.stepId;
  const step = live && isLive(r.state) ? sn.steps.find((st) => st.id === live)?.name : undefined;
  const report = r.report ? ctx?.refs.output(r.report, r.endedAt !== undefined ? { ts: r.endedAt } : {}) : undefined;
  return {
    id: clip(r.id, 200),
    by: runBy(s, r),
    state: r.state,
    headline: firstLine(r.headline, 300),
    startedAt: Math.round(r.startedAt),
    ...(r.endedAt !== undefined ? { endedAt: Math.round(r.endedAt) } : {}),
    ...(r.why && (r.state === 'failed' || r.state === 'stopped' || r.state === 'skipped') ? { why: firstLine(r.why, 500) } : {}),
    ...(r.pr ? { pr: { number: r.pr.number, url: clip(r.pr.url, 500) } } : {}),
    ...(step ? { step: clip(step, 100) } : {}),
    ...(report ? { report } : {}),
  };
}

export function sentinelPageView(state: DomainState, id: string, ctx?: ViewContext): SentinelPageView | undefined {
  const s = state.sentinel;
  const sn = s.enabled ? sentinelById(s, id) : undefined;
  const summary = sn ? sentinelSummary(state, s, sn) : undefined;
  if (!sn || !summary) return undefined;
  return {
    ...summary,
    steps: sn.steps.slice(0, 40).map((st) => ({ kind: st.kind, name: clip(st.name, 100) })),
    runs: runsOf(s, sn.id)
      .slice(0, 30)
      .map((r) => sentinelRunView(s, sn, r, ctx)),
    needsYou: needsYou(state)
      .filter((n) => n.topic === summary.topic)
      .slice(0, 10),
  };
}

/**
 * Sentinel runs that ended since `prev`, to tell the phone (a `done` nudge): those whose sentinel
 * notifies the phone (`notify` phone or both), or whose Notify step for the phone ran. A failed
 * one says so (and that it paused the sentinel); skipped and stopped runs say nothing. A run only
 * counts when its sentinel was there before (the demo's history arriving isn't news).
 */
export function sentinelDone(prev: DomainState, state: DomainState): Array<{ title: string; body: string; topic?: Topic; channel?: string; run: string }> {
  const was = prev.sentinel;
  const s = state.sentinel;
  if (!s.enabled || !was.enabled || was === s) return [];
  return s.runs.flatMap((r) => {
    if (r.state !== 'done' && r.state !== 'failed') return [];
    const before = was.runs.find((x) => x.id === r.id);
    if (before ? !isLive(before.state) : false) return [];
    const sn = sentinelById(s, r.sentinelId);
    if (!sn || !sentinelById(was, sn.id)) return [];
    const phoneStep = sn.steps.some((st) => st.kind === 'notify' && st.phone && r.steps.find((x) => x.id === st.id)?.state === 'done');
    if (sn.notify !== 'phone' && sn.notify !== 'both' && !phoneStep) return [];
    const topic = sentinelTopic(sn.id);
    const failed = r.state === 'failed';
    const why = pausedWords(sn);
    const title = failed ? (why ? `${sn.name}: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : `${sn.name} failed`) : sn.name;
    const body = firstLine(r.headline, 300) || (failed && r.why ? firstLine(r.why, 300) : 'It ran');
    return [{ title: clip(title, 200), body: clip(body, 300), ...(topic ? { topic } : {}), ...(r.channel ? { channel: r.channel } : {}), run: r.id }];
  });
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
    ...(offerOf(state, m) ? { offer: offerOf(state, m) } : {}),
    ...(chatTaskOf(state, m) ? { task: chatTaskOf(state, m) } : {}),
  };
}

/** A task's card in a chat (BLG-208), from this Mac's task book; someone the task isn't between sees just the words. */
function chatTaskOf(state: DomainState, m: MessageView): ChatMessageView['task'] {
  const t = m.task ? state.gateway.tasks.find((x) => x.id === m.task?.id) : undefined;
  if (!t) return undefined;
  const title = t.direction === 'sent' ? `To ${targetLabel(t)}` : `From ${t.peerName}${t.by === 'agent' ? '’s Claude' : ''}`;
  const summary = t.result?.summary ? plainLine(stripCode(t.result.summary).text, 600) : '';
  const files = (t.result?.files ?? []).map((f) => clip(f.name, 200)).slice(0, 8);
  // Whose it is, as the Mac's chat heads it (BLG-210): "Your Claude · asked ata’s Claude", "mia’s Claude · asked your Mac".
  const sent = t.direction === 'sent';
  const owner = t.by === 'agent' ? (sent ? 'Your Claude' : `${t.peerName}’s Claude`) : sent ? 'You' : t.peerName;
  const who = `${owner} · asked ${sent ? targetLabel(t) : t.kind === 'ask' ? 'your Claude' : 'your Mac'}`;
  return {
    id: clip(t.id, 200),
    title: clip(title, 200),
    ask: clip(plainLine(t.kind === 'run' && t.command ? `$ ${t.command}` : requestGist(t, 300), 300), 300),
    state: clip(stateLabel(t), 80),
    tone: stateTone(t),
    ...(summary ? { summary: clip(summary, 600) } : {}),
    ...(files.length ? { files } : {}),
    who: clip(who, 200),
    ...(t.secret && !isFinal(t.state) ? { secret: true } : {}),
  };
}

/** A friend's Claude, answering a message of yours, offers to do it on their Mac as a request. */
function offerOf(state: DomainState, m: MessageView): ChatMessageView['offer'] {
  const request = m.claude?.request;
  if (!request || m.mine || !state.network.messages[m.conversation]?.some((x) => x.id === m.claude?.for && x.mine)) return undefined;
  return { to: m.from, ask: clip(request.ask, 500), ...(request.needs?.length ? { needs: [...request.needs] } : {}) };
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
  const people = chatPeopleOf(state, conversation, dm, group);
  const waiting = waitingIn({ conversation, tasks: state.gateway.tasks, approvals: state.approvals });
  const note = offlineNote(people);
  return {
    topic,
    name: clip(dm?.name ?? group?.name ?? 'Chat', 100),
    kind: group || conversation.startsWith('group:') ? 'group' : 'dm',
    messages,
    more,
    live: (net.live?.[conversation] ?? []).slice(0, 20).map((l) => clip(`${l.name}'s Claude`, 100)),
    members: chatMembers(state, dm, group, people),
    ...(waiting.length ? { waiting: waiting.slice(0, 10).map((w) => ({ text: clip(waitingLabel(w), 300), you: w.on === 'you', ...(w.target.kind === 'task' ? { task: clip(w.target.id, 200) } : {}) })) } : {}),
    ...(note ? { note: clip(note, 200) } : {}),
  };
}

/** Who's in a chat and what their Claudes do (BLG-210), as the Mac's header says it. */
function chatPeopleOf(state: DomainState, conversation: string, dm: PersonView | undefined, group: { members: readonly (PersonView & { self: boolean })[] } | undefined) {
  const net = state.network;
  const others = dm ? [dm] : (group?.members ?? []).filter((m) => !m.self);
  const run = [...state.log].reverse().find((l) => l.type === 'agent' && l.channel === conversation && l.owner === state.selfId && isRunning(l.status) && l.status !== 'queued' && l.status !== 'awaiting_approval');
  const doing = run?.type === 'agent' ? (run.steps.at(-1) ?? run.prompt) : undefined;
  const now = Date.now();
  return chatPeople({
    conversation,
    self: { peerId: net.self?.peerId ?? myId(state), name: myName(state), ...(net.self ? { presence: net.self.appearOffline ? 'offline' : net.self.presence.state } : {}) },
    others,
    live: (net.live?.[conversation] ?? []).filter((l) => now - l.since < 3 * 60_000),
    tasks: state.gateway.tasks,
    myRun: { working: Boolean(run), ...(doing ? { doing } : {}) },
  });
}

/** Whose Claude a chat message can ask: you first, then the friend (a DM) or the group's members; each with presence and their Claude's state (1.20). */
function chatMembers(state: DomainState, dm: { peerId: string; name: string } | undefined, group: { members: readonly { peerId: string; name: string; self: boolean }[] } | undefined, people: ReturnType<typeof chatPeopleOf>): ChatView['members'] {
  const extra = (peerId: string, mine: boolean) => {
    const p = people.find((x) => (mine ? x.me : x.peerId === peerId));
    return p ? { presence: p.presence, claude: clip(claudePill(p), 80) } : {};
  };
  const me = { peerId: clip(myId(state), 200), name: clip(myName(state), 64), me: true, ...extra(myId(state), true) };
  const others = dm ? [{ peerId: dm.peerId, name: dm.name }] : (group?.members ?? []).filter((m) => !m.self && m.peerId !== me.peerId).map((m) => ({ peerId: m.peerId, name: m.name }));
  return [me, ...others.slice(0, 199).map((m) => ({ peerId: clip(m.peerId, 200), name: clip(m.name, 64), ...extra(m.peerId, false) }))];
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
        ...(f.beluga && f.beluga.version !== 'unknown' ? { beluga: clip(shortVersion(f.beluga.version), 40) } : {}),
        ...(f.update ? { update: f.update } : {}),
      };
    }),
  };
}

/** The view a topic carries, or undefined when there's nothing by that name (a plan that's gone). */
export function viewOf(state: DomainState, ctx: ViewContext, topic: Topic): unknown {
  if (topic === 'home') return homeView(state, ctx);
  if (topic === 'work') return workView(state, ctx);
  if (topic === 'plans') return plansView(state);
  if (topic === 'chats') return chatsView(state);
  if (topic === 'people') return peopleView(state);
  if (topic === 'tasks') return tasksView(state, ctx);
  if (topic.startsWith('conv:')) return convView(state, ctx, topic);
  if (topic.startsWith('plan:')) return planPageView(state, topic.slice('plan:'.length));
  if (topic.startsWith('chat:')) return chatView(state, ctx, topic);
  if (topic.startsWith('task:')) return taskPageView(state, topic.slice('task:'.length), ctx);
  if (topic === 'sentinels') return sentinelsView(state);
  if (topic.startsWith('sentinel:')) return sentinelPageView(state, topic.slice('sentinel:'.length), ctx);
  return undefined;
}
