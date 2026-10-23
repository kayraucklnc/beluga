import type { AppState } from '../../../../src/core/store.js';
import { type Plan, planTitle } from '../../../../src/core/plans/model.js';
import { isLivePlan, isPlanOwned, planConversations, planOwnerOf } from '../../../../src/core/plans/owner.js';
import { activityOf } from '../../../../src/ui/workspace-models.js';
import type { Project, Workspace } from '../../../../src/workspaces/types.js';

/**
 * What each conversation in the sidebar is waiting on, Slack-style: it needs you (an approval,
 * Claude's question or plan, a merge conflict, failed checks), it has news you haven't seen
 * (Claude finished, a friend wrote), Claude is working, or nothing. Pure, so it's tested on its
 * own (tests/mac-attention.test.ts); the sidebar only draws it.
 */

export type Need = 'approval' | 'question' | 'plan' | 'conflict' | 'checks';

/** Needs you > unread > working > idle: the one a row shows. */
export type Level = 'needs' | 'unread' | 'working' | 'idle';

export interface Signal {
  readonly level: Level;
  /** New messages since you last looked (cleared by opening the conversation). */
  readonly unread: number;
  /** What waits for you (cleared only by answering or fixing it). */
  readonly need?: Need;
  readonly working: boolean;
  /** What a tooltip says ("Claude finished · 2 new messages"); empty when idle. */
  readonly tip: string;
}

export const IDLE_SIGNAL: Signal = { level: 'idle', unread: 0, working: false, tip: '' };

type Source = Pick<AppState, 'log' | 'unread' | 'questions' | 'approvals' | 'conflicts' | 'prs' | 'claudeCode' | 'plans' | 'board'>;

const NEED_TIPS: Record<Need, string> = {
  approval: 'Claude needs your approval',
  question: 'Claude asks a question',
  plan: 'Claude has a plan for you to approve',
  conflict: 'A merge conflict to resolve',
  checks: 'Checks failed on its pull request',
};

export const needTip = (need: Need): string => NEED_TIPS[need];

const plural = (n: number, word: string): string => `${n} new ${word}${n === 1 ? '' : 's'}`;

/** What holds a conversation up. `ws`: one of your workspaces (conflicts and checks are kept per workspace). */
export function needOf(state: Source, channel: string, ws?: string): Need | undefined {
  if (state.approvals.some((a) => a.channel === channel) || activityOf(state.log, channel).awaiting) return 'approval';
  const asks = state.questions.filter((q) => q.channel === channel);
  if (asks.some((q) => q.question.kind === 'plan')) return 'plan';
  if (asks.length) return 'question';
  if (ws && state.conflicts[ws]?.length) return 'conflict';
  const pr = ws ? state.prs[ws] : undefined;
  if (pr?.state === 'OPEN' && pr.checks === 'failing') return 'checks';
  return undefined;
}

/** How the news starts: Claude finished (or stopped), when its answer is the last thing there. */
function newsLead(state: Source, channel: string): string | undefined {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const item = state.log[i]!;
    if (item.channel !== channel) continue;
    if (item.type !== 'agent') return undefined;
    return item.status === 'done' ? 'Claude finished' : item.status === 'error' ? 'Claude stopped' : undefined;
  }
  return undefined;
}

/** One conversation's signal. `ws`: the id when it's one of your workspaces (not one shared with you). */
export function signalOf(state: Source, channel: string, ws?: string): Signal {
  const unread = state.unread[channel] ?? 0;
  const need = needOf(state, channel, ws);
  const working = activityOf(state.log, channel).running || (ws !== undefined && state.claudeCode.sessions.some((x) => !x.own && x.workspaceId === ws && x.status === 'working'));
  const news = unread ? [newsLead(state, channel), plural(unread, 'message')].filter(Boolean).join(' · ') : '';
  if (need) return { level: 'needs', unread, need, working, tip: [needTip(need), unread ? plural(unread, 'message') : ''].filter(Boolean).join(' · ') };
  if (unread) return { level: 'unread', unread, working, tip: news };
  if (working) return { level: 'working', unread: 0, working, tip: 'Claude is working' };
  return IDLE_SIGNAL;
}

export const workspaceSignal = (state: Source, ws: Workspace): Signal => (ws.archived ? IDLE_SIGNAL : signalOf(state, `ws:${ws.id}`, ws.id));

/** What a project or group adds up to: how many conversations have news, how many need you. */
export interface Tally {
  readonly unread: number;
  readonly needs: number;
  readonly working: boolean;
}

export const NO_TALLY: Tally = { unread: 0, needs: 0, working: false };

export function tally(signals: readonly Signal[]): Tally {
  return {
    unread: signals.filter((x) => x.unread > 0).length,
    needs: signals.filter((x) => x.need).length,
    working: signals.some((x) => x.working),
  };
}

/** The conversations a project's row stands for: its live worktrees and chats (the main folder isn't listed), a plan's own not on their own. */
const projectConversations = (state: Pick<Source, 'plans' | 'board'>, p: Project): readonly Workspace[] => p.workspaces.filter((w) => !w.archived && w.kind !== 'main' && !isPlanOwned(state, w.id));

/** A project's live plans (each one item, however many tasks it runs). */
export const projectPlans = (state: Pick<Source, 'plans'>, p: Project): readonly Plan[] => state.plans.plans.filter((x) => x.projectId === p.id && isLivePlan(x));

const projectSignals = (state: Source, p: Project): Signal[] => [...projectConversations(state, p).map((w) => workspaceSignal(state, w)), ...projectPlans(state, p).map((x) => planSignal(state, x))];

export const projectTally = (state: Source, p: Project): Tally => tally(projectSignals(state, p));

export const groupTally = (state: Source, projects: readonly Project[]): Tally => tally(projects.flatMap((p) => projectSignals(state, p)));

const NEED_WORDS: Record<Need, string> = {
  approval: 'needs your approval',
  question: 'asks a question',
  plan: 'has a plan for you to approve',
  conflict: 'has a merge conflict',
  checks: 'has failing checks',
};

/** Where a plan waits on you: which of its conversations, and the plan's task there (its id), if it's a task's. */
export interface PlanNeed {
  readonly ws: string;
  readonly task?: string;
}

/**
 * A plan's signal, as one conversation's: the news in its home and all its tasks' worktrees added
 * up ("3 updates"), and the first of them that needs you, by name ("KLD-12 asks a question").
 */
export function planSignal(state: Source, plan: Plan): Signal & { readonly at?: PlanNeed } {
  const list = planConversations(state, plan.id).map((ws) => ({ ws, signal: signalOf(state, `ws:${ws}`, ws) }));
  const unread = list.reduce((n, x) => n + x.signal.unread, 0);
  const working = list.some((x) => x.signal.working);
  const news = unread ? `${unread} update${unread === 1 ? '' : 's'}` : '';
  const waiting = list.find((x) => x.signal.need);
  if (waiting) {
    const owner = planOwnerOf(state.plans, state.board, waiting.ws);
    const who = owner?.issue.key ?? 'Claude';
    const need = waiting.signal.need!;
    const at = { ws: waiting.ws, ...(owner ? { task: owner.task.id } : {}) };
    return { level: 'needs', unread, need, working, tip: [`${who} ${NEED_WORDS[need]}`, news].filter(Boolean).join(' · '), at };
  }
  if (unread) return { level: 'unread', unread, working, tip: news };
  if (working) return { level: 'working', unread: 0, working, tip: 'Claude is working' };
  return IDLE_SIGNAL;
}

/**
 * What a plan's own row in the sidebar shows (BLG-12): a count only of what's new at the plan's
 * level (its own conversation), never its tasks' worktrees added up; news in those is at most a
 * quiet dot (`inside`). One that needs you still says so (and which task). Opening the plan
 * counts all of it as seen (client/screen.ts › attentionOf).
 */
export interface PlanRowSignal extends Signal {
  /** Something new in one of its tasks' conversations (they have no row of their own). */
  readonly inside: boolean;
}

export function planRowSignal(state: Source, plan: Plan): PlanRowSignal {
  const all = planSignal(state, plan);
  const own = state.unread[plan.home] ?? 0;
  const tasks = planConversations(state, plan.id).filter((ws) => `ws:${ws}` !== plan.home);
  const inside = tasks.some((ws) => (state.unread[`ws:${ws}`] ?? 0) > 0);
  const news = own ? plural(own, 'message') : '';
  const tip = all.level === 'needs' ? all.tip.replace(/ · \d+ updates?$/, '') : own ? news : inside ? 'New in its tasks' : all.tip;
  const level: Level = all.level === 'needs' ? 'needs' : own ? 'unread' : all.working ? 'working' : 'idle';
  return { level, unread: own, ...(all.need ? { need: all.need } : {}), working: all.working, tip: [tip, all.level === 'needs' && own ? news : ''].filter(Boolean).join(' · '), inside };
}

/**
 * Claude is at work somewhere in a project: a Beluga run or a Claude Code session, in any of its
 * live workspaces (its main folder and worktrees made outside Beluga too). Folded, its row shows it.
 */
export const projectWorking = (state: Source, p: Project): boolean => p.workspaces.some((w) => !w.archived && workspaceSignal(state, w).working);

export const groupWorking = (state: Source, projects: readonly Project[]): boolean => projects.some((p) => projectWorking(state, p));

/** What a project's (or group's) row says on hover about what's inside. */
export function tallyTip(t: Tally): string {
  const parts = [t.needs ? `${t.needs} need${t.needs === 1 ? 's' : ''} you` : '', t.unread ? `${t.unread} unread` : ''].filter(Boolean);
  return parts.join(' · ');
}

/** A conversation in the sidebar's Unread section. */
export type UnreadEntry = {
  readonly channel: string;
  readonly name: string;
  readonly signal: Signal;
  /** When something last happened there (newest first, after what needs you). */
  readonly ts: number;
} & (
  | { readonly kind: 'workspace'; readonly ws: Workspace; readonly project?: Project }
  | { readonly kind: 'shared'; readonly owner: string; readonly id: string }
  | { readonly kind: 'dm'; readonly peerId: string }
  | { readonly kind: 'group'; readonly groupId: string }
  /** A plan, once for its home and all its tasks' conversations (`channels`); `at`: where it waits on you. */
  | { readonly kind: 'plan'; readonly plan: Plan; readonly project?: Project; readonly channels: readonly string[]; readonly at?: PlanNeed }
);

type ListSource = Source & Pick<AppState, 'projects' | 'shared' | 'network'>;

const counts = (x: Signal): boolean => x.level === 'needs' || x.unread > 0;

/** Every conversation with news or something waiting for you: what needs you first, then the latest. */
export function unreadEntries(state: ListSource): UnreadEntry[] {
  const out: UnreadEntry[] = [];
  for (const p of state.projects) {
    for (const ws of projectConversations(state, p)) {
      const signal = workspaceSignal(state, ws);
      if (counts(signal)) out.push({ kind: 'workspace', channel: `ws:${ws.id}`, name: ws.name, ws, ...(p.root ? { project: p } : {}), signal, ts: activityOf(state.log, `ws:${ws.id}`).lastTs ?? 0 });
    }
    // A plan is one entry, never its conversations one by one.
    for (const plan of projectPlans(state, p)) {
      const { at, ...signal } = planSignal(state, plan);
      if (!counts(signal)) continue;
      const channels = planConversations(state, plan.id).map((ws) => `ws:${ws}`);
      const ts = Math.max(0, ...channels.map((c) => activityOf(state.log, c).lastTs ?? 0));
      out.push({ kind: 'plan', channel: `plan:${plan.id}`, name: planTitle(plan), plan, ...(p.root ? { project: p } : {}), channels, ...(at ? { at } : {}), signal, ts });
    }
  }
  for (const w of state.shared) {
    const signal = signalOf(state, `ws:${w.id}`);
    if (counts(signal)) out.push({ kind: 'shared', channel: `ws:${w.id}`, name: w.name, owner: w.owner, id: w.id, signal, ts: activityOf(state.log, `ws:${w.id}`).lastTs ?? 0 });
  }
  if (state.network.enabled) {
    for (const f of state.network.friends) {
      if (f.unread > 0) out.push({ kind: 'dm', channel: `dm:${f.peerId}`, name: f.name, peerId: f.peerId, signal: { level: 'unread', unread: f.unread, working: false, tip: plural(f.unread, 'message') }, ts: f.last?.ts ?? 0 });
    }
    for (const g of state.network.groups) {
      if (g.active && g.unread > 0) out.push({ kind: 'group', channel: `group:${g.id}`, name: g.name, groupId: g.id, signal: { level: 'unread', unread: g.unread, working: false, tip: plural(g.unread, 'message') }, ts: g.last?.ts ?? 0 });
    }
  }
  const rank = (e: UnreadEntry): number => (e.signal.level === 'needs' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.ts - a.ts);
}

/**
 * The menu bar's "working" count: conversations where your own Claude is at work, read the way
 * the sidebar reads them (activityOf), so the two never disagree about what runs.
 */
export function workingCount(state: Pick<AppState, 'log' | 'selfId'>): number {
  const mine = new Set(state.log.flatMap((l) => (l.type === 'agent' && l.owner === state.selfId ? [l.channel] : [])));
  return [...mine].filter((channel) => activityOf(state.log, channel).running).length;
}

/**
 * The Dock badge and the menu-bar count: one per conversation in the Unread section (however
 * many messages or questions it holds), plus unread notifications and waiting approvals that
 * aren't about one of those, plus people at the door. Nothing is counted twice.
 */
export function dockCount(state: ListSource & Pick<AppState, 'inbox' | 'knocks'>): number {
  const entries = unreadEntries(state);
  const listed = new Set(entries.flatMap((e) => (e.kind === 'plan' ? e.channels : [e.channel])));
  const inListed = (channel: string | undefined): boolean => channel !== undefined && listed.has(channel);
  const covered = new Set([...state.approvals.filter((a) => inListed(a.channel)).map((a) => a.id), ...state.questions.filter((q) => inListed(q.channel)).map((q) => q.qid)]);
  const notices = state.inbox.filter((n) => !n.read && !inListed(n.channel) && !(n.ref !== undefined && covered.has(n.ref)));
  const noted = new Set(notices.flatMap((n) => (n.ref === undefined ? [] : [n.ref])));
  const waiting = [...state.approvals.map((a) => a.id), ...state.questions.map((q) => q.qid)].filter((id) => !covered.has(id) && !noted.has(id)).length;
  return entries.length + notices.length + waiting + state.knocks.length;
}
