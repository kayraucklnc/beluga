import type { NotifySettings } from './settings.js';
import { type DomainState, type LogItem, type Store } from './store.js';
import { dndActive } from '../shared/quiet.js';

/** The groups you can switch on or off in Settings → Notifications. */
export type NoticeKind = 'done' | 'needsYou' | 'problems' | 'people' | 'pr' | 'mentions' | 'background';

/** What exactly happened, when the kind alone doesn't say (screens pick an icon by it). */
export type NoticeTag = 'approval' | 'question' | 'plan' | 'conflict' | 'joined' | 'left' | 'invited' | 'mention' | 'message' | 'task' | 'test';

export interface NoticeEvent {
  readonly kind: NoticeKind;
  readonly tag?: NoticeTag;
  /** The approval or question it's about. */
  readonly ref?: string;
  readonly title: string;
  readonly body: string;
  /** Conversation it's about (opening the notice goes there). */
  readonly channel?: string;
  /** Into the inbox, but no desktop notification (you're on Do Not Disturb or appearing offline). */
  readonly quiet?: boolean;
}

/** A desktop notification: what it says, and where clicking it goes (when it's about one place). */
export interface DesktopNote {
  readonly title: string;
  readonly body: string;
  readonly sound: boolean;
  readonly channel?: string;
}

/** Runs that end like this were your own doing, so they're not worth a notification. */
const QUIET_ERRORS = /^(Interrupted by a newer message|Cancelled by owner|Stopped by owner)/;
const RECENT_LOG = 200;

type AgentItem = Extract<LogItem, { type: 'agent' }>;
type ChatItem = Extract<LogItem, { type: 'chat' }>;
/** More new messages than this in one step is history arriving, not someone talking to you. */
const MESSAGE_BURST = 3;
const isFinal = (s: AgentItem['status']): boolean => s === 'done' || s === 'error' || s === 'denied';

const firstLine = (text: string, max = 140): string => {
  const line = text.split('\n').map((l) => l.replace(/[*_`#>]/g, '').trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** "add-auth", "the group chat", or a shared workspace's name. */
export function placeName(state: DomainState, channel: string): string {
  if (channel === 'room') return state.peers.length > 1 ? 'the group chat' : 'your chat';
  const id = channel.slice(3);
  const ws = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) ?? state.shared.find((w) => w.id === id);
  return ws?.name ?? 'a workspace';
}

function finishedRuns(prev: DomainState, next: DomainState): NoticeEvent[] {
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
  return [...out, ...finishedTasks(next, before)];
}

/** A task your Claude started in the background (a test run, a build) ending while it works on. */
function finishedTasks(next: DomainState, before: ReadonlyMap<string, AgentItem>): NoticeEvent[] {
  const out: NoticeEvent[] = [];
  for (const item of next.log.slice(-RECENT_LOG)) {
    // A run that just ended marks what's left as done: that's the run finishing, not its tasks.
    if (item.type !== 'agent' || item.owner !== next.self?.peerId || isFinal(item.status)) continue;
    const old = before.get(item.id);
    if (!old || old.subagents === item.subagents) continue;
    for (const task of item.subagents) {
      if (task.kind !== 'background' || task.status === 'running') continue;
      if (old.subagents.find((t) => t.id === task.id)?.status !== 'running') continue;
      const verb = task.status === 'done' ? 'finished' : 'failed';
      out.push({ kind: 'background', tag: 'task', title: `A background task ${verb} in ${placeName(next, item.channel)}`, body: firstLine(task.title), channel: item.channel });
    }
  }
  return out;
}

/** A new worktree's setup (npm install…) finished. Failed ones are announced as problems where they run. */
function finishedSetups(prev: DomainState, next: DomainState): NoticeEvent[] {
  if (prev.setup === next.setup) return [];
  return Object.entries(next.setup)
    .filter(([id, run]) => run.status === 'done' && prev.setup[id]?.status === 'running')
    .map(([id, run]) => ({ kind: 'background', tag: 'task', title: `${placeName(next, `ws:${id}`)} is set up`, body: run.command, channel: `ws:${id}` }));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Someone mentions you by name, or writes in the room when it's just the two of you. */
function messagesForYou(prev: DomainState, next: DomainState): NoticeEvent[] {
  const self = next.self;
  if (prev.log === next.log || !prev.self || !self) return [];
  const seen = new Set(prev.log.slice(-RECENT_LOG).map((l) => l.id));
  const fresh = next.log.slice(-RECENT_LOG).filter((l): l is ChatItem => l.type === 'chat' && !seen.has(l.id));
  if (!fresh.length || fresh.length > MESSAGE_BURST) return [];
  const mention = new RegExp(`(^|[^\\w@])@${escapeRe(self.name)}(?![\\w-])`, 'i');
  const others = next.peers.filter((p) => p.peerId !== self.peerId);
  const out: NoticeEvent[] = [];
  for (const m of fresh) {
    if (m.from === self.peerId || m.byAgent) continue;
    const where = placeName(next, m.channel);
    if (mention.test(m.text)) out.push({ kind: 'mentions', tag: 'mention', title: `${m.name} mentioned you in ${where}`, body: firstLine(m.text), channel: m.channel });
    else if (m.channel === 'room' && others.length === 1 && others[0]?.peerId === m.from) out.push({ kind: 'mentions', tag: 'message', title: `${m.name} wrote to you`, body: firstLine(m.text), channel: m.channel });
  }
  return out;
}

/** Messages older than this arriving (a group catching up after days away) aren't news any more. */
const STALE_MESSAGE_MS = 12 * 60 * 60_000;

/**
 * A friend writes to you, or someone writes in one of your groups (the klaud network). Quiet
 * while your status is Do Not Disturb or you appear offline: the inbox still has them.
 */
function networkMessages(prev: DomainState, next: DomainState, now: number): NoticeEvent[] {
  const before = prev.network;
  const after = next.network;
  // The first messages after the network starts are history, not news.
  if (before.messages === after.messages || !before.enabled || !after.self) return [];
  const self = after.self;
  const quiet = self.appearOffline || self.presence.state === 'dnd';
  const mention = new RegExp(`(^|[^\\w@])@${escapeRe(self.name)}(?![\\w-])`, 'i');
  const out: NoticeEvent[] = [];
  for (const [conversation, list] of Object.entries(after.messages)) {
    const old = before.messages[conversation];
    if (old === list) continue;
    const seen = new Set((old ?? []).map((m) => m.id));
    const fresh = list.filter((m) => !seen.has(m.id) && !m.mine && m.status !== 'locked' && now - m.ts < STALE_MESSAGE_MS);
    if (fresh.length > MESSAGE_BURST * 4) continue;
    const group = conversation.startsWith('group:') ? after.groups.find((g) => `group:${g.id}` === conversation) : undefined;
    for (const m of fresh) {
      const title = group ? (mention.test(m.text) ? `${m.name} mentioned you in ${group.name}` : `${m.name} in ${group.name}`) : m.name;
      out.push({ kind: 'mentions', tag: group && mention.test(m.text) ? 'mention' : 'message', title, body: firstLine(m.text), channel: conversation, ...(quiet ? { quiet: true } : {}) });
    }
  }
  return out;
}

/**
 * What happened between two states that you'd want to hear about: Claude finished or
 * stopped, needs an answer or approval, a merge conflict, someone joined or invited you.
 */
export function detectNotices(prev: DomainState, next: DomainState, now = Date.now()): NoticeEvent[] {
  const out = [...finishedRuns(prev, next), ...finishedSetups(prev, next), ...messagesForYou(prev, next), ...networkMessages(prev, next, now)];
  if (prev.approvals !== next.approvals) {
    const seen = new Set(prev.approvals.map((a) => a.id));
    for (const a of next.approvals) if (!seen.has(a.id)) out.push({ kind: 'needsYou', tag: 'approval', ref: a.id, title: a.title, body: firstLine(a.detail) });
  }
  if (prev.questions !== next.questions) {
    const seen = new Set(prev.questions.map((q) => q.qid));
    for (const q of next.questions) {
      if (seen.has(q.qid)) continue;
      const where = placeName(next, q.channel);
      out.push(
        q.question.kind === 'plan'
          ? { kind: 'needsYou', tag: 'plan', ref: q.qid, title: `Claude has a plan for ${where}`, body: 'Approve it, or say what to change', channel: q.channel }
          : { kind: 'needsYou', tag: 'question', ref: q.qid, title: `Claude asks in ${where}`, body: firstLine(q.question.questions[0]?.question ?? ''), channel: q.channel },
      );
    }
  }
  if (prev.conflicts !== next.conflicts) {
    for (const [id, files] of Object.entries(next.conflicts)) {
      if (!files.length || prev.conflicts[id]?.length) continue;
      out.push({ kind: 'problems', tag: 'conflict', title: `Merge conflict in ${placeName(next, `ws:${id}`)}`, body: `${files.length} file(s): ${files.slice(0, 3).join(', ')}`, channel: `ws:${id}` });
    }
  }
  // People: only after you're in (the first peer list is everyone already there).
  if (prev.self && prev.peers !== next.peers && prev.peers.length) {
    const seen = new Set(prev.peers.map((p) => p.peerId));
    const still = new Set(next.peers.map((p) => p.peerId));
    const selfId = next.self?.peerId;
    for (const p of next.peers) if (!seen.has(p.peerId) && p.peerId !== selfId) out.push({ kind: 'people', tag: 'joined', title: `${p.name} joined`, body: p.agent ? 'They brought their Claude' : 'Say hi in the group chat', channel: 'room' });
    // Only while you're still in the room: losing the room isn't news about each person.
    if (next.status === 'connected' && next.peers.some((p) => p.peerId === selfId)) {
      for (const p of prev.peers) if (!still.has(p.peerId) && p.peerId !== selfId) out.push({ kind: 'people', tag: 'left', title: `${p.name} left`, body: p.agent ? 'Their Claude left with them' : 'They left the room', channel: 'room' });
    }
  }
  if (prev.shared !== next.shared) {
    const seen = new Set(prev.shared.map((w) => `${w.owner}:${w.id}`));
    for (const w of next.shared) {
      if (seen.has(`${w.owner}:${w.id}`)) continue;
      const owner = next.peers.find((p) => p.peerId === w.owner)?.name ?? 'Someone';
      out.push({ kind: 'people', tag: 'invited', title: `${owner} invited you to ${w.name}`, body: w.role === 'contribute' ? 'You can work there with their Claude' : 'You can follow along', channel: `ws:${w.id}` });
    }
  }
  return out;
}

export interface NotifierDeps {
  readonly store: Store;
  /** Show a desktop notification. */
  readonly desktop: (n: DesktopNote) => void;
  /** A short message on screen (for notices about what you're looking at). */
  readonly toast?: (text: string, level: 'info' | 'warn') => void;
  /** Coalesce bursts: at most one desktop notification per this many ms (default 1500). */
  readonly burstMs?: number;
  readonly now?: () => number;
}

/** Whether a notice that made the inbox also goes to the desktop right now (Settings → Notifications). */
export function desktopAllowed(state: Pick<DomainState, 'prefs' | 'attention'>, now = Date.now()): boolean {
  const prefs = state.prefs.notify;
  if (!prefs.desktop || dndActive(prefs, now)) return false;
  return !(prefs.onlyAway && state.attention.front);
}

/**
 * Watches the room and your workspaces, keeps an inbox of what happened while you were
 * looking elsewhere, and raises desktop notifications for it. Nothing is announced
 * about a conversation a screen in front is showing (see Attention in store.ts).
 */
export class Notifier {
  private prev: DomainState;
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

  /** Show a test notification whatever the settings say (you asked for it). */
  test(): void {
    const e: NoticeEvent = { kind: 'done', tag: 'test', title: 'Notifications work', body: 'This is how klaud tells you Claude finished or needs you' };
    this.deps.store.dispatch({ type: 'notice_add', notice: { kind: e.kind, tag: e.tag, title: e.title, body: e.body } });
    this.queue.push(e);
    this.flush();
  }

  private onChange(): void {
    const next = this.deps.store.getState();
    const prev = this.prev;
    this.prev = next;
    if (prev === next) return;
    // Opening a conversation reads its notices; answering something reads the notice about it.
    if (prev.attention !== next.attention) this.markSeen(next);
    if (prev.approvals !== next.approvals || prev.questions !== next.questions) this.markAnswered(next);
    const events = detectNotices(prev, next, this.now());
    if (events.length) this.handle(events, next);
  }

  private markSeen(state: DomainState): void {
    for (const channel of state.attention.visible) {
      if (state.inbox.some((n) => !n.read && n.channel === channel)) this.deps.store.dispatch({ type: 'notice_read', channel });
    }
  }

  private markAnswered(state: DomainState): void {
    const open = new Set([...state.approvals.map((a) => a.id), ...state.questions.map((q) => q.qid)]);
    for (const n of state.inbox) if (!n.read && n.ref !== undefined && !open.has(n.ref)) this.deps.store.dispatch({ type: 'notice_read', id: n.id });
  }

  private handle(events: readonly NoticeEvent[], state: DomainState, direct = false): void {
    const prefs = state.prefs.notify;
    const desktop = desktopAllowed(state, this.now());
    for (const e of events) {
      if (!enabled(prefs, e.kind)) continue;
      // A screen in front shows it: a direct notice (it isn't in the chat) still shows as a toast.
      if (e.channel !== undefined && state.attention.visible.includes(e.channel)) {
        if (direct) this.deps.toast?.(`${e.title}${e.body ? `: ${e.body}` : ''}`, e.kind === 'problems' ? 'warn' : 'info');
        continue;
      }
      const { kind, tag, ref, title, body, channel } = e;
      this.deps.store.dispatch({ type: 'notice_add', notice: { kind, ...(tag ? { tag } : {}), ...(ref ? { ref } : {}), title, body, channel } });
      if (desktop && !e.quiet) this.queue.push(e);
    }
    this.flush();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private flush(): void {
    if (!this.queue.length || this.timer) return;
    const wait = Math.max(0, this.lastSent + (this.deps.burstMs ?? 1500) - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const batch = this.queue;
      this.queue = [];
      if (!batch.length) return;
      this.lastSent = this.now();
      this.deps.desktop(combine(batch, this.deps.store.getState().prefs.notify.sound));
    }, wait);
    this.timer.unref?.();
  }
}

/** One desktop notification for a burst; clicking it goes where they all are, if that's one place. */
export function combine(batch: readonly NoticeEvent[], sound: boolean): DesktopNote {
  const first = batch[0]!;
  const channel = first.channel !== undefined && batch.every((e) => e.channel === first.channel) ? { channel: first.channel } : {};
  if (batch.length === 1) return { title: first.title, body: first.body, sound, ...channel };
  return { title: `${batch.length} updates in klaud`, body: batch.map((e) => e.title).slice(0, 4).join(' · '), sound, ...channel };
}

/** Whether you want to hear about this kind (missing in old settings: yes). */
export const enabled = (prefs: NotifySettings, kind: NoticeKind): boolean => prefs[kind] !== false;
