import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeJson } from '../../workspaces/store.js';
import { type NoticeEvent, mentionOf, placeName } from '../notify.js';
import { planById } from '../plans/model.js';
import type { Action, DomainState, LogItem, Store } from '../store.js';
import type { WorktreeEvent } from '../workspace-controller.js';
import { autoSettle } from './auto-settle.js';
import { channelsOf, handSourceOf, lastLogAt, triageFacts } from './facts.js';
import { type ChatTriage, type TriageEvent, applyTriage, handRaisedOf, settleRefusal, triageKey } from './model.js';

/**
 * Runs each chat's category in the daemon: saves the records, serves triage.*, reacts to messages
 * and turns, and ends snoozes on time. Off while `chatCategories` is off: no change, no file, no
 * timer. What was saved stays, so turning it on again restores it.
 */

export interface TriageServiceDeps {
  readonly store: Store;
  /** Where the records are saved (~/.beluga/triage.json). */
  readonly file: string;
  /** Raise a notification (a snooze ending by itself). */
  readonly notify: (event: NoticeEvent) => void;
  /** A workspace's saved chat, to seed when it was last active. */
  readonly history: (workspaceId: string) => readonly LogItem[];
  /** Worktree events (a merge into main here). */
  readonly onWorktree?: (listener: (event: WorktreeEvent) => void) => () => void;
  readonly now?: () => number;
}

const TICK_MAX_MS = 30_000;
const AUTO_SETTLE_MS = 60_000;
const SAVE_DELAY_MS = 1_000;
const FINAL: ReadonlySet<string> = new Set(['done', 'error', 'denied']);
const OFF_MESSAGE = 'Chat categories are off. Turn them on in Settings.';

const Record_ = z.object({
  settled: z.object({ at: z.number(), why: z.enum(['you', 'pr_merged', 'merged_here', 'idle']), pr: z.number().optional() }).optional(),
  snoozed: z.object({ at: z.number(), until: z.number(), seen: z.array(z.string()) }).optional(),
  backAt: z.number().optional(),
  autoSettle: z.literal(false).optional(),
  settledPr: z.number().optional(),
  holdIdle: z.literal(true).optional(),
  lastAt: z.number().optional(),
  mergedHere: z.literal(true).optional(),
  shared: z.literal(true).optional(),
});

export class TriageService {
  private on = false;
  private prev: DomainState;
  private saved?: DomainState['triage'];
  private saveTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  /** Deleted conversations go once, at load, when the projects are known. */
  private pruned = false;
  private lastAuto = 0;
  private readonly offs: Array<() => void> = [];

  constructor(private readonly deps: TriageServiceDeps) {
    this.prev = deps.store.getState();
    this.offs.push(deps.store.onAction((action) => this.onAction(action)));
    if (deps.onWorktree) this.offs.push(deps.onWorktree((event) => this.onWorktree(event)));
    if (this.prev.prefs.chatCategories) this.enable();
  }

  stop(): void {
    for (const off of this.offs) off();
    if (this.on) this.save();
    this.halt();
  }

  settle(channel: string): void {
    const key = this.keyOf(channel);
    const state = this.state();
    const refusal = settleRefusal(state.triage[key], triageFacts(state, key), 'you');
    if (refusal) throw new Error(refusal);
    this.apply(key, { kind: 'settle', at: this.now(), why: 'you' }, channelsOf(state, key));
  }

  unsettle(channel: string): void {
    this.apply(this.keyOf(channel), { kind: 'unsettle' });
  }

  snooze(channel: string, until: number): void {
    const key = this.keyOf(channel);
    const at = this.now();
    if (until <= at) throw new Error('Pick a time in the future.');
    this.apply(key, { kind: 'snooze', at, until, seen: handSourceOf(this.state(), key).openIds });
    this.arm();
  }

  wake(channel: string): void {
    this.apply(this.keyOf(channel), { kind: 'wake', at: this.now() });
  }

  setAutoSettle(channel: string, on: boolean): void {
    this.apply(this.keyOf(channel), { kind: 'auto_settle', on });
  }

  private onAction(action: Action): void {
    const prev = this.prev;
    const next = this.state();
    this.prev = next;
    if (next.prefs.chatCategories !== this.on) {
      if (this.on) this.disable();
      else this.enable();
      return;
    }
    if (!this.on) return;
    this.react(action, prev);
    if (this.state().triage !== this.saved) this.queueSave();
  }

  private react(action: Action, prev: DomainState): void {
    switch (action.type) {
      case 'chat':
        return this.onChat(action);
      case 'agent_event':
        this.onRun(action, prev);
        if (FINAL.has(action.event)) this.settleWhatCan();
        return;
      case 'pr':
        return this.settleWhatCan();
      case 'approval_add':
        return this.handCheck(action.approval.channel, prev);
      case 'question_add':
        return this.handCheck(action.question.channel, prev);
      case 'plan_put':
        this.handCheck(`plan:${action.plan.id}`, prev);
        return this.settleWhatCan();
      case 'approval_remove': {
        const gone = prev.approvals.find((a) => a.id === action.id);
        // One that ran out of time was never answered.
        if (gone?.channel && !(gone.askedAt !== undefined && gone.timeoutMs !== undefined && gone.askedAt + gone.timeoutMs <= this.now())) this.applyIn(gone.channel, { kind: 'answer', at: this.now() });
        this.settleWhatCan();
        return;
      }
      case 'question_remove': {
        const gone = prev.questions.find((q) => q.qid === action.qid);
        if (gone?.channel && !action.unanswered) this.applyIn(gone.channel, { kind: 'answer', at: this.now() });
        this.settleWhatCan();
        return;
      }
      case 'projects':
        this.prune();
        this.seed();
        return;
      default:
        return;
    }
  }

  /** A merge into main here settles the chat, now or when it next can. */
  private onWorktree(event: WorktreeEvent): void {
    if (!this.on || event.kind !== 'merged') return;
    this.applyIn(`ws:${event.id}`, { kind: 'merged_here' });
    this.settleWhatCan();
    if (this.state().triage !== this.saved) this.queueSave();
  }

  private settleWhatCan(): void {
    const now = this.now();
    this.lastAuto = now;
    for (const { key, why, pr } of autoSettle(this.state(), now)) this.apply(key, { kind: 'settle', at: now, why, ...(pr !== undefined ? { pr } : {}) });
  }

  private onChat(action: Extract<Action, { type: 'chat' }>): void {
    const state = this.state();
    const key = triageKey(state, action.channel ?? 'room');
    // An old message arriving again (a friend coming back) isn't news.
    if (!key || action.ts < (state.triage[key]?.lastAt ?? 0)) return;
    const self = state.self;
    const mine = action.from === (self?.peerId ?? state.selfId);
    const at = action.ts;
    if (action.byAgent) return this.apply(key, { kind: 'agent_text', at });
    if (mine) return this.apply(key, { kind: 'own_message', at });
    this.apply(key, { kind: self && mentionOf(self.name).test(action.text) ? 'mention' : 'person_message', at });
  }

  private onRun(action: Extract<Action, { type: 'agent_event' }>, prev: DomainState): void {
    if (!action.channel) return;
    if (action.event === 'started' || action.event === 'queued') this.applyIn(action.channel, { kind: 'turn_start', at: action.ts });
    else if (FINAL.has(action.event)) this.applyIn(action.channel, { kind: 'turn_end', at: action.ts });
    this.handCheck(action.channel, prev);
  }

  /** A hand went up just now: it ends a snooze or a settle (what was already up doesn't). */
  private handCheck(channel: string | undefined, prev: DomainState): void {
    if (!channel) return;
    const state = this.state();
    const key = triageKey(state, channel);
    if (!key) return;
    const record = state.triage[key];
    if (!record?.snoozed && !record?.settled) return;
    if (handRaisedOf(record, handSourceOf(state, key)) && !handRaisedOf(record, handSourceOf(prev, key))) this.apply(key, { kind: 'hand_raised', at: this.now() });
  }

  private enable(): void {
    this.on = true;
    for (const [key, record] of Object.entries(this.load())) this.deps.store.dispatch({ type: 'triage_set', channel: key, record });
    this.saved = this.state().triage;
    this.prune();
    this.seed();
    this.wakeEnded();
    this.settleWhatCan();
    this.arm();
    if (this.state().triage !== this.saved) this.queueSave();
  }

  /**
   * Stored data stays, but what happened while it's off isn't watched: when each chat was last
   * active is seeded again on the next enable, so an idle rule never reads an old time.
   */
  private disable(): void {
    this.on = false;
    this.halt();
    const chats = Object.fromEntries(Object.entries(this.state().triage).map(([key, { lastAt: _stale, ...record }]) => [key, record]));
    writeJson(this.deps.file, { chats });
    this.saved = undefined;
    this.pruned = false;
  }

  private halt(): void {
    clearTimeout(this.tickTimer);
    clearTimeout(this.saveTimer);
    this.tickTimer = undefined;
    this.saveTimer = undefined;
  }

  private load(): Readonly<Record<string, ChatTriage>> {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.deps.file, 'utf8'));
    } catch {
      return {};
    }
    const chats = (raw as { chats?: unknown } | null)?.chats;
    if (typeof chats !== 'object' || chats === null) return {};
    const out: Record<string, ChatTriage> = {};
    // One bad record doesn't cost the others.
    for (const [key, value] of Object.entries(chats)) {
      const record = Record_.safeParse(value);
      if (record.success) out[key] = record.data as ChatTriage;
    }
    return out;
  }

  /** Records of chats that were deleted. A friend's chat may only be away, and an empty list means the projects aren't in yet. */
  private prune(): void {
    const state = this.state();
    if (this.pruned || !state.projects.length) return;
    this.pruned = true;
    const ids = new Set(state.projects.flatMap((p) => p.workspaces).map((w) => w.id));
    for (const [key, record] of Object.entries(state.triage)) {
      if (record.shared) continue;
      const known = key.startsWith('plan:') ? !state.plans.plans.length || planById(state.plans, key.slice(5)) !== undefined : ids.has(key.slice(3));
      if (!known) this.deps.store.dispatch({ type: 'triage_set', channel: key });
    }
  }

  /**
   * When each chat without a time was last active: its last message, or when it was made. A worktree
   * Beluga didn't make has neither (createdAt 0), so its days count from now: 0 is never a time.
   */
  private seed(): void {
    const state = this.state();
    const seeds = new Map<string, number>();
    for (const ws of state.projects.flatMap((p) => p.workspaces)) {
      const key = triageKey(state, `ws:${ws.id}`);
      if (!key || state.triage[key]?.lastAt) continue;
      const at = Math.max(ws.createdAt, this.deps.history(ws.id).at(-1)?.ts ?? 0, lastLogAt(state.log, `ws:${ws.id}`) ?? 0);
      seeds.set(key, Math.max(at, seeds.get(key) ?? 0));
    }
    for (const [key, lastAt] of seeds) this.set(key, { ...state.triage[key], lastAt: lastAt || this.now() });
  }

  private tick(): void {
    this.tickTimer = undefined;
    if (!this.on) return;
    this.wakeEnded();
    if (this.now() - this.lastAuto >= AUTO_SETTLE_MS) this.settleWhatCan();
    if (this.state().triage !== this.saved) this.queueSave();
    this.arm();
  }

  /** The next look: when the next snooze ends, or sooner, so a Mac waking from sleep catches up. */
  private arm(): void {
    clearTimeout(this.tickTimer);
    const now = this.now();
    const ends = Object.values(this.state().triage).flatMap((r) => r.snoozed?.until ?? []);
    const delay = Math.max(0, Math.min(TICK_MAX_MS, ...ends.map((until) => until - now)));
    this.tickTimer = setTimeout(() => this.tick(), delay);
    this.tickTimer.unref?.();
  }

  private wakeEnded(): void {
    const now = this.now();
    for (const [key, record] of Object.entries(this.state().triage)) {
      if (record.snoozed && record.snoozed.until <= now) {
        this.apply(key, { kind: 'wake', at: now });
        this.tell(key, record.snoozed.until);
      }
    }
  }

  private tell(key: string, until: number): void {
    const state = this.state();
    const plan = key.startsWith('plan:') ? planById(state.plans, key.slice(5)) : undefined;
    const channel = plan?.home ?? key;
    this.deps.notify({ kind: state.prefs.notify.needsYou === false ? 'background' : 'needsYou', tag: 'woke', title: `${placeName(state, channel)} is back`, body: 'Its snooze ended', channel, key: `woke:${key}:${until}` });
  }

  private applyIn(channel: string, event: TriageEvent): void {
    const key = triageKey(this.state(), channel);
    if (key) this.apply(key, event);
  }

  private apply(key: string, event: TriageEvent, read?: readonly string[]): void {
    this.set(key, applyTriage(this.state().triage[key], event), read);
  }

  private set(key: string, record: ChatTriage, read?: readonly string[]): void {
    const state = this.state();
    if (!read?.length && (record === state.triage[key] || (!state.triage[key] && !Object.keys(record).length))) return;
    const shared = state.shared.some((w) => `ws:${w.id}` === key);
    this.deps.store.dispatch({ type: 'triage_set', channel: key, record: shared ? { ...record, shared: true } : record, ...(read?.length ? { read } : {}) });
  }

  private queueSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private save(): void {
    const chats = this.state().triage;
    if (chats === this.saved) return;
    writeJson(this.deps.file, { chats });
    this.saved = chats;
  }

  /** The record that speaks for this chat, or why it can't be sorted. */
  private keyOf(channel: string): string {
    if (!this.on) throw new Error(OFF_MESSAGE);
    const key = triageKey(this.state(), channel);
    if (!key) throw new Error('This chat has no category.');
    return key;
  }

  private state = (): DomainState => this.deps.store.getState();
  private now = (): number => this.deps.now?.() ?? Date.now();
}
