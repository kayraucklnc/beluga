import type { NotifySettings } from './settings.js';
import { type AppState, type LogItem, type Store, channelOf } from './store.js';

/** The groups you can switch on or off in Settings → Notifications. */
export type NoticeKind = 'done' | 'needsYou' | 'problems' | 'people' | 'pr';

export interface NoticeEvent {
  readonly kind: NoticeKind;
  readonly title: string;
  readonly body: string;
  /** Conversation it's about (opening the notice goes there). */
  readonly channel?: string;
}

/** Runs that end like this were your own doing, so they're not worth a notification. */
const QUIET_ERRORS = /^(Interrupted by a newer message|Cancelled by owner|Stopped by owner)/;
const RECENT_LOG = 200;

type AgentItem = Extract<LogItem, { type: 'agent' }>;
const isFinal = (s: AgentItem['status']): boolean => s === 'done' || s === 'error' || s === 'denied';

const firstLine = (text: string, max = 140): string => {
  const line = text.split('\n').map((l) => l.replace(/[*_`#>]/g, '').trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** "add-auth", "the group chat", or a shared workspace's name. */
export function placeName(state: AppState, channel: string): string {
  if (channel === 'room') return state.peers.length > 1 ? 'the group chat' : 'your chat';
  const id = channel.slice(3);
  const ws = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) ?? state.shared.find((w) => w.id === id);
  return ws?.name ?? 'a workspace';
}

function finishedRuns(prev: AppState, next: AppState): NoticeEvent[] {
  if (prev.log === next.log) return [];
  const before = new Map<string, AgentItem>();
  for (const l of prev.log.slice(-RECENT_LOG)) if (l.type === 'agent') before.set(l.id, l);
  const selfId = next.self?.peerId;
  const selfName = next.self?.name;
  const out: NoticeEvent[] = [];
  for (const item of next.log.slice(-RECENT_LOG)) {
    if (item.type !== 'agent' || !isFinal(item.status)) continue;
    const old = before.get(item.id);
    if (!old || isFinal(old.status)) continue;
    const mine = item.owner === selfId;
    // A friend's Claude matters when it was working for you.
    if (!mine && item.requesterName !== selfName) continue;
    const who = mine ? 'Claude' : `${item.ownerName}'s Claude`;
    const where = placeName(next, item.channel);
    if (item.status === 'done') out.push({ kind: 'done', title: `${who} finished in ${where}`, body: firstLine(item.text) || 'Done', channel: item.channel });
    else if (!QUIET_ERRORS.test(item.text)) out.push({ kind: 'problems', title: `${who} stopped in ${where}`, body: firstLine(item.text) || item.status, channel: item.channel });
  }
  return out;
}

/**
 * What happened between two states that you'd want to hear about: Claude finished or
 * stopped, needs an answer or approval, a merge conflict, someone joined or invited you.
 */
export function detectNotices(prev: AppState, next: AppState): NoticeEvent[] {
  const out = finishedRuns(prev, next);
  if (prev.approvals !== next.approvals) {
    const seen = new Set(prev.approvals.map((a) => a.id));
    for (const a of next.approvals) if (!seen.has(a.id)) out.push({ kind: 'needsYou', title: a.title, body: firstLine(a.detail) });
  }
  if (prev.questions !== next.questions) {
    const seen = new Set(prev.questions.map((q) => q.qid));
    for (const q of next.questions) {
      if (seen.has(q.qid)) continue;
      const where = placeName(next, q.channel);
      out.push(
        q.question.kind === 'plan'
          ? { kind: 'needsYou', title: `Claude has a plan for ${where}`, body: 'Approve it, or say what to change', channel: q.channel }
          : { kind: 'needsYou', title: `Claude asks in ${where}`, body: firstLine(q.question.questions[0]?.question ?? ''), channel: q.channel },
      );
    }
  }
  if (prev.conflicts !== next.conflicts) {
    for (const [id, files] of Object.entries(next.conflicts)) {
      if (!files.length || prev.conflicts[id]?.length) continue;
      out.push({ kind: 'problems', title: `Merge conflict in ${placeName(next, `ws:${id}`)}`, body: `${files.length} file(s): ${files.slice(0, 3).join(', ')}`, channel: `ws:${id}` });
    }
  }
  // People: only after you're in (the first peer list is everyone already there).
  if (prev.self && prev.peers !== next.peers && prev.peers.length) {
    const seen = new Set(prev.peers.map((p) => p.peerId));
    for (const p of next.peers) if (!seen.has(p.peerId) && p.peerId !== next.self?.peerId) out.push({ kind: 'people', title: `${p.name} joined`, body: p.agent ? 'They brought their Claude' : 'Say hi in the group chat', channel: 'room' });
  }
  if (prev.shared !== next.shared) {
    const seen = new Set(prev.shared.map((w) => `${w.owner}:${w.id}`));
    for (const w of next.shared) {
      if (seen.has(`${w.owner}:${w.id}`)) continue;
      const owner = next.peers.find((p) => p.peerId === w.owner)?.name ?? 'Someone';
      out.push({ kind: 'people', title: `${owner} invited you to ${w.name}`, body: w.role === 'contribute' ? 'You can work there with their Claude' : 'You can follow along', channel: `ws:${w.id}` });
    }
  }
  return out;
}

export interface NotifierDeps {
  readonly store: Store;
  /** Show a desktop notification. */
  readonly desktop: (n: { title: string; body: string; sound: boolean }) => void;
  /** Coalesce bursts: at most one desktop notification per this many ms (default 1500). */
  readonly burstMs?: number;
}

/**
 * Watches the room and your workspaces, keeps an inbox of what happened while you were
 * looking elsewhere, and raises desktop notifications for it. Nothing is announced
 * about the conversation you're looking at while klaud is in front.
 */
export class Notifier {
  private prev: AppState;
  private readonly unsubscribe: () => void;
  private queue: NoticeEvent[] = [];
  private timer?: NodeJS.Timeout;
  private lastSent = 0;

  constructor(private readonly deps: NotifierDeps) {
    this.prev = deps.store.getState();
    this.unsubscribe = deps.store.subscribe(() => this.onChange());
  }

  stop(): void {
    this.unsubscribe();
    clearTimeout(this.timer);
  }

  /** Raise a notification directly (pull requests, setup scripts, handoffs). */
  notify(event: NoticeEvent): void {
    this.handle([event], this.deps.store.getState(), true);
  }

  private onChange(): void {
    const next = this.deps.store.getState();
    const prev = this.prev;
    this.prev = next;
    if (prev === next) return;
    // Opening a conversation reads its notices.
    if (prev.view !== next.view || prev.away !== next.away) this.markSeen(next);
    const events = detectNotices(prev, next);
    if (events.length) this.handle(events, next);
  }

  private markSeen(state: AppState): void {
    if (state.away) return;
    const channel = channelOf(state.view);
    if (state.inbox.some((n) => !n.read && n.channel === channel)) this.deps.store.dispatch({ type: 'notice_read', channel });
  }

  private handle(events: readonly NoticeEvent[], state: AppState, direct = false): void {
    const prefs = state.prefs.notify;
    const visible = channelOf(state.view);
    for (const e of events) {
      if (!enabled(prefs, e.kind)) continue;
      // You're looking right at it: a direct notice (it isn't in the chat) still shows as a toast.
      if (!state.away && e.channel !== undefined && e.channel === visible) {
        if (direct) this.deps.store.dispatch({ type: 'toast', text: `${e.title}${e.body ? `: ${e.body}` : ''}`, level: e.kind === 'problems' ? 'warn' : 'info' });
        continue;
      }
      this.deps.store.dispatch({ type: 'notice_add', notice: { kind: e.kind, title: e.title, body: e.body, channel: e.channel } });
      if (prefs.desktop) this.queue.push(e);
    }
    this.flush();
  }

  private flush(): void {
    if (!this.queue.length || this.timer) return;
    const wait = Math.max(0, this.lastSent + (this.deps.burstMs ?? 1500) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const batch = this.queue;
      this.queue = [];
      if (!batch.length) return;
      this.lastSent = Date.now();
      const sound = this.deps.store.getState().prefs.notify.sound;
      const first = batch[0]!;
      this.deps.desktop(
        batch.length === 1
          ? { title: first.title, body: first.body, sound }
          : { title: `${batch.length} updates in klaud`, body: batch.map((e) => e.title).slice(0, 4).join(' · '), sound },
      );
    }, wait);
    this.timer.unref?.();
  }
}

export const enabled = (prefs: NotifySettings, kind: NoticeKind): boolean => prefs[kind];
