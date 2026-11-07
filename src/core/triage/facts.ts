import { type DomainState, type LogItem, isRunning } from '../store.js';
import { planById } from '../plans/model.js';
import { planConversations } from '../plans/owner.js';
import { type HandSource, type TriageFacts, handRaisedOf } from './model.js';

/**
 * What the state says about a chat, for the pure rules in model.ts. `key` is a triage record's:
 * `ws:<id>`, or `plan:<id>`, which stands for all the plan's conversations. Browser-safe.
 */

export type FactSource = Pick<DomainState, 'log' | 'approvals' | 'questions' | 'claudeCode' | 'plans' | 'board'>;

interface RunFacts {
  readonly running: boolean;
  readonly waiting: readonly string[];
  readonly failedAt?: number;
  readonly lastAt?: number;
}

// The log is replaced, never changed, so one pass per log serves every chat.
const runIndex = new WeakMap<readonly LogItem[], ReadonlyMap<string, RunFacts>>();

/** The conversations a record stands for. A plan that's done folds nothing any more, but its home still talks while its PR waits. */
export function channelsOf(state: Pick<DomainState, 'plans' | 'board'>, key: string): readonly string[] {
  if (!key.startsWith('plan:')) return [key];
  const id = key.slice(5);
  const home = planById(state.plans, id)?.home;
  return [...new Set([...planConversations(state, id).map((ws) => `ws:${ws}`), ...(home?.startsWith('ws:') ? [home] : [])])];
}

export function handSourceOf(state: FactSource, key: string): HandSource {
  const channels = channelsOf(state, key);
  const runs = channels.flatMap((c) => runsOf(state.log).get(c) ?? []);
  const failed = runs.flatMap((r) => r.failedAt ?? []);
  return {
    openIds: [...state.approvals.filter((a) => a.channel !== undefined && channels.includes(a.channel)).map((a) => a.id), ...state.questions.filter((q) => q.channel !== undefined && channels.includes(q.channel)).map((q) => q.qid), ...runs.flatMap((r) => r.waiting)],
    planStuck: key.startsWith('plan:') && planStuck(state, key.slice(5)),
    ...(failed.length ? { failedAt: Math.max(...failed) } : {}),
  };
}

export function workingIn(state: FactSource, key: string): boolean {
  return channelsOf(state, key).some((c) => runsOf(state.log).get(c)?.running || state.claudeCode.sessions.some((x) => !x.own && `ws:${x.workspaceId}` === c && x.status === 'working'));
}

export function triageFacts(state: FactSource & Pick<DomainState, 'triage'>, key: string): TriageFacts {
  return { handRaised: handRaisedOf(state.triage[key], handSourceOf(state, key)), working: workingIn(state, key) };
}

/** The last thing the log holds of a conversation. */
export const lastLogAt = (log: readonly LogItem[], channel: string): number | undefined => runsOf(log).get(channel)?.lastAt;

/** A plan gave up by itself: a task stopped again after Beluga woke it, or a milestone is past every rescue step. */
function planStuck(state: Pick<DomainState, 'plans'>, planId: string): boolean {
  const plan = planById(state.plans, planId);
  if (plan?.status !== 'active') return false;
  return Object.values(plan.watch ?? {}).some((w) => w.needsYou) || Object.values(plan.rescue ?? {}).some((r) => r.yours);
}

function runsOf(log: readonly LogItem[]): ReadonlyMap<string, RunFacts> {
  const hit = runIndex.get(log);
  if (hit) return hit;
  const out = new Map<string, RunFacts>();
  for (const item of log) {
    const was = out.get(item.channel) ?? { running: false, waiting: [] };
    if (item.type !== 'agent') {
      out.set(item.channel, { ...was, lastAt: item.ts });
      continue;
    }
    out.set(item.channel, {
      running: was.running || isRunning(item.status),
      waiting: item.status === 'awaiting_approval' ? [...was.waiting, item.id] : was.waiting,
      lastAt: item.ts,
      ...(item.status === 'error' ? { failedAt: item.endTs ?? item.lastAt ?? item.ts } : was.failedAt !== undefined ? { failedAt: was.failedAt } : {}),
    });
  }
  runIndex.set(log, out);
  return out;
}
