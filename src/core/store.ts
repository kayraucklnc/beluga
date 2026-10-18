import type { AgentEventKind, FsEntry, PeerInfo } from '../protocol.js';
import type { ConnectionStatus } from '../net/peer-client.js';
import type { Effort, NotifySettings, Settings, ThemeName, TrustLevel } from './settings.js';
import { NotifySettings as NotifySchema } from './settings.js';
import type { Review } from '../workspaces/git.js';
import type { Project, ProjectGroup } from '../workspaces/types.js';
import type { EnvChange } from '../workspaces/env.js';
import type { Bitmap } from '../image/bitmap.js';
import { type CollabAction, type CollabState, initialCollab, reduceCollab } from './collab-store.js';
import { type WorkAction, type WorkState, initialWork, reduceWork } from './work-store.js';

export type Policy = 'ask' | 'auto' | 'deny';

export interface SubAgent {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly string[];
  readonly status: 'running' | 'done' | 'failed';
  /** Sub-agent, or background work (a background terminal or agent). */
  readonly kind?: 'agent' | 'background';
}

export type LogItem =
  | { readonly id: string; readonly type: 'chat'; readonly channel: string; readonly from: string; readonly name: string; readonly text: string; readonly ts: number; readonly byAgent: boolean }
  | { readonly id: string; readonly type: 'system'; readonly channel: string; readonly text: string; readonly ts: number; readonly level: 'info' | 'warn' | 'error' }
  | {
      readonly id: string;
      readonly type: 'agent';
      readonly channel: string;
      readonly subagents: readonly SubAgent[];
      readonly requestId: string;
      readonly owner: string;
      readonly ownerName: string;
      readonly requesterName: string;
      readonly status: AgentEventKind;
      readonly text: string;
      readonly steps: readonly string[];
      readonly ts: number;
      /** When the run finished (done/error/denied). */
      readonly endTs?: number;
    }
  | ShellItem;

/** A command run on someone's computer (through their klaud), with its output. */
export interface ShellItem {
  readonly id: string;
  readonly type: 'shell';
  readonly channel: string;
  readonly ts: number;
  /** Whose computer it runs on. */
  readonly owner: string;
  readonly ownerName: string;
  /** "you" or "your Claude". */
  readonly by: string;
  readonly command: string;
  readonly cwd?: string;
  /** waiting (for them to approve) → running → done / failed / declined. */
  readonly status: 'waiting' | 'running' | 'done' | 'failed' | 'declined';
  readonly exitCode?: number;
  readonly output: string;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
  readonly error?: string;
  /** When it started running (after their approval). */
  readonly startTs?: number;
  readonly endTs?: number;
}

export interface Approval {
  readonly id: string;
  readonly kind: 'request' | 'tool';
  readonly title: string;
  readonly detail: string;
}

export interface Location {
  readonly owner: string;
  readonly share: string;
  readonly path: string;
}

export interface BrowserRow {
  readonly label: string;
  readonly dir: boolean;
  readonly target: Location | 'up';
  readonly size?: number;
}

export interface BrowserState {
  readonly at?: Location;
  readonly rows: readonly BrowserRow[];
  readonly cursor: number;
  readonly loading: boolean;
  readonly error?: string;
}

export interface ViewerState extends Location {
  readonly content: string;
  /** Decoded pixels when the file is an image. */
  readonly image?: Bitmap;
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly error?: string;
  readonly scroll: number;
  readonly by?: string;
}

export interface Focus extends Location {
  readonly actor: 'human' | 'agent';
  readonly ts: number;
}

export type HostingPhase = 'tunnel' | 'reachable' | 'ready' | 'local' | 'failed';

export interface Hosting {
  readonly phase: HostingPhase;
  readonly detail?: string;
  /** Whether the invite was actually placed on the clipboard. */
  readonly copied?: boolean;
}

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly level: 'info' | 'success' | 'warn' | 'error';
}

export type Overlay = 'help' | 'settings' | 'welcome' | 'clear' | 'model' | 'inbox' | 'templates' | 'handoff';

/** Preferences mirrored from ~/.klaud/settings.json (every key here is a settings key). */
export interface Prefs {
  readonly theme: ThemeName;
  readonly mouse: boolean;
  readonly tunnel: Settings['tunnel'];
  /** 'never': your own Claude just works; 'ask': it asks before risky actions. */
  readonly selfApproval: 'never' | 'ask';
  readonly notify: NotifySettings;
  /** Default model for new conversations (undefined: Claude Code's default). */
  readonly model?: string;
  readonly effort?: Effort;
  readonly autoSetup: boolean;
  readonly contextMeter: boolean;
  readonly subagents: Settings['subagents'];
  readonly hiddenButtons: readonly string[];
  readonly friendWorktrees: Settings['friendWorktrees'];
  readonly shell?: string;
}

export interface Transfer {
  readonly id: string;
  readonly name: string;
  readonly from: string;
  readonly received: number;
  readonly total: number;
  readonly status: 'active' | 'done' | 'failed';
  readonly savedTo?: string;
  readonly error?: string;
}

/** What the main area shows. */
export type View =
  | { readonly kind: 'room' }
  | { readonly kind: 'files' }
  | { readonly kind: 'overview' }
  | { readonly kind: 'workspace'; readonly id: string; readonly tab: WorkspaceTab }
  /** Search every conversation. */
  | { readonly kind: 'search' }
  /** Disk space and Claude usage per workspace. */
  | { readonly kind: 'usage' }
  /** Shells of your own, in the current project's folder (or your home folder). */
  | { readonly kind: 'terminal' }
  /** A new chat that doesn't exist until you send the first message. */
  | { readonly kind: 'draft'; readonly projectId: string; readonly dir?: string; readonly back: View }
  /** A new worktree: your first message names it (via a small model) and starts the work. */
  | { readonly kind: 'draft_worktree'; readonly projectId: string; readonly back: View }
  /** Someone else's workspace that they shared with you. */
  | { readonly kind: 'shared'; readonly owner: string; readonly id: string; readonly tab: SharedTab };

/** Tabs of a workspace someone shared with you: the chat, its files, a read-only shell over them, and what changed. */
export type SharedTab = 'chat' | 'files' | 'terminal' | 'diff';

export type WorkspaceTab = 'chat' | 'files' | 'review' | 'terminal';

export interface ReviewState {
  readonly workspaceId: string;
  readonly data?: Review;
  readonly selected: number;
  readonly diff?: string;
  readonly diffScroll: number;
  readonly loading: boolean;
  readonly error?: string;
}

/** How full a conversation's context window is. */
export interface ContextInfo {
  readonly used: number;
  readonly window: number;
}

/** A compaction that just happened, kept briefly so the UI can animate it. */
export interface Compaction {
  readonly pre: number;
  readonly post: number;
  readonly at: number;
}

export const channelOf = (view: View): string =>
  view.kind === 'workspace' || view.kind === 'shared' ? `ws:${view.id}` : view.kind === 'draft' || view.kind === 'draft_worktree' ? 'draft' : 'room';

export interface AppState extends CollabState, WorkState {
  readonly room: string;
  readonly view: View;
  readonly projects: readonly Project[];
  readonly projectGroups: readonly ProjectGroup[];
  /** Files with merge conflicts from the last merge attempt, per workspace. */
  readonly conflicts: Readonly<Record<string, readonly string[]>>;
  /** Workspaces open as tabs, in order. */
  readonly tabs: readonly string[];
  readonly review?: ReviewState;
  /** Unread message counts per channel. */
  readonly unread: Readonly<Record<string, number>>;
  /** Shared folders you've already seen in Shared files (see shareKeys); others count as new. */
  readonly seenShares: readonly string[];
  /** Context usage per conversation (channel). */
  readonly context: Readonly<Record<string, ContextInfo>>;
  readonly compactions: Readonly<Record<string, Compaction>>;
  /** Env changes found in a worktree that's about to be archived or deleted. */
  readonly envChanges: Readonly<Record<string, readonly EnvChange[]>>;
  readonly hosting?: Hosting;
  readonly toast?: Toast;
  readonly overlay?: Overlay;
  readonly invite?: string;
  readonly status: ConnectionStatus;
  readonly self?: PeerInfo;
  readonly peers: readonly PeerInfo[];
  readonly log: readonly LogItem[];
  readonly approvals: readonly Approval[];
  readonly browser: BrowserState;
  readonly viewer?: ViewerState;
  readonly follow?: string;
  readonly focus: Readonly<Record<string, Focus>>;
  /** Your default for people you haven't picked a trust level for. */
  readonly policy: Policy;
  /** Trust levels you picked per person (see core/trust.ts). */
  readonly levels: Readonly<Record<string, TrustLevel>>;
  /** How far each friend's requests may reach on this computer (default: shared folders only). */
  readonly access: Readonly<Record<string, 'folder' | 'full'>>;
  /** Directory listings used for /open autocomplete, keyed "owner:share/path". */
  readonly dirCache: Readonly<Record<string, readonly FsEntry[]>>;
  /** Recent downloads (newest last). */
  readonly transfers: readonly Transfer[];
  readonly prefs: Prefs;
}

export type Action =
  | { type: 'status'; status: ConnectionStatus }
  | { type: 'invite'; invite: string }
  | { type: 'room'; room: string }
  | { type: 'hosting'; hosting: Hosting }
  | { type: 'toast'; text: string; level?: Toast['level'] }
  | { type: 'toast_clear'; id: number }
  | { type: 'overlay'; overlay?: Overlay }
  | { type: 'welcome'; self: PeerInfo }
  | { type: 'peers'; peers: readonly PeerInfo[] }
  | { type: 'chat'; id: string; from: string; text: string; ts: number; byAgent: boolean; channel?: string }
  | { type: 'system'; text: string; level?: 'info' | 'warn' | 'error'; channel?: string }
  | { type: 'shell'; item: ShellItem }
  | { type: 'agent_event'; owner: string; requestId: string; requester: string; event: AgentEventKind; text: string; ts: number; channel?: string }
  | { type: 'projects'; projects: readonly Project[]; groups?: readonly ProjectGroup[] }
  | { type: 'conflicts'; id: string; files: readonly string[] }
  | { type: 'view'; view: View }
  | { type: 'close_tab'; id: string }
  | { type: 'review'; review?: ReviewState }
  | { type: 'history'; channel: string; items: readonly LogItem[] }
  | { type: 'env_changes'; id: string; changes: readonly EnvChange[] }
  | { type: 'approval_add'; approval: Approval }
  | { type: 'approval_remove'; id: string }
  | { type: 'browser_root' }
  | { type: 'browser_loading'; at: Location }
  | { type: 'browser_entries'; at: Location; entries: readonly FsEntry[] }
  | { type: 'browser_error'; error: string }
  | { type: 'browser_cursor'; delta: number }
  | { type: 'viewer_open'; at: Location; by?: string }
  | { type: 'viewer_content'; at: Location; content: string; truncated: boolean }
  | { type: 'viewer_image'; at: Location; image: Bitmap }
  | { type: 'viewer_error'; at: Location; error: string }
  | { type: 'viewer_scroll'; delta: number; max?: number }
  | { type: 'viewer_close' }
  | { type: 'focus'; actorKey: string; focus: Focus }
  | { type: 'follow'; peerId?: string }
  | { type: 'policy'; policy: Policy }
  | { type: 'trust'; peerId: string; trusted: boolean }
  | { type: 'full_trust'; peerId: string; trusted: boolean }
  | { type: 'trust_level'; peerId: string; level?: TrustLevel }
  | { type: 'access'; peerId: string; scope: 'folder' | 'full' }
  | { type: 'dir_cache'; key: string; entries: readonly FsEntry[] }
  | { type: 'transfer'; transfer: Transfer }
  | { type: 'prefs'; prefs: Partial<Prefs> }
  | { type: 'clear'; channel?: string }
  | { type: 'context_reset'; channel: string }
  | CollabAction
  | WorkAction;

const LOG_LIMIT = 1000;
const TRANSFER_LIMIT = 20;

/** Strip terminal control sequences from peer-supplied text (keeps newlines and tabs). */
// eslint-disable-next-line no-control-regex
/** Strip control characters (terminal escapes) and invisible bidi/zero-width marks from remote text. */
export const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200D\u202A-\u202E\u2066-\u2069]/g, '');
const MAX_STEPS = 6;

export const DEFAULT_PREFS: Prefs = {
  theme: 'calm',
  mouse: true,
  tunnel: 'auto',
  selfApproval: 'never',
  notify: NotifySchema.parse({}),
  autoSetup: true,
  contextMeter: true,
  subagents: 'full',
  hiddenButtons: [],
  friendWorktrees: 'ask',
};

/** The preference fields out of saved settings. */
export function prefsFrom(settings: Partial<Settings>): Prefs {
  const picked = Object.fromEntries(Object.keys(DEFAULT_PREFS).concat(['model', 'effort', 'shell']).filter((k) => settings[k as keyof Settings] !== undefined).map((k) => [k, settings[k as keyof Settings]]));
  return { ...DEFAULT_PREFS, ...picked };
}

export function initialState(room: string, policy: Policy = 'ask', prefs: Partial<Prefs> = DEFAULT_PREFS): AppState {
  return {
    room,
    view: { kind: 'room' },
    projects: [],
    projectGroups: [],
    conflicts: {},
    tabs: [],
    unread: {},
    seenShares: [],
    context: {},
    compactions: {},
    envChanges: {},
    status: 'connecting',
    peers: [],
    log: [],
    approvals: [],
    browser: { rows: [], cursor: 0, loading: false },
    focus: {},
    policy,
    levels: {},
    access: {},
    dirCache: {},
    transfers: [],
    prefs: { ...DEFAULT_PREFS, ...prefs },
    ...initialCollab,
    ...initialWork,
  };
}

let seq = 0;
const nextId = (): string => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

export const peerName = (state: AppState, peerId: string): string =>
  state.peers.find((p) => p.peerId === peerId)?.name ?? (state.self?.peerId === peerId ? state.self.name : peerId.slice(0, 6));

const sameLoc = (a: Location | undefined, b: Location): boolean =>
  Boolean(a) && a?.owner === b.owner && a.share === b.share && a.path === b.path;

/** Append, keeping at most LOG_LIMIT items per conversation (never trimming other conversations). */
function appendLog(log: readonly LogItem[], item: LogItem): readonly LogItem[] {
  const next = [...log, item];
  const inChannel = next.filter((l) => l.channel === item.channel).length;
  if (inChannel <= LOG_LIMIT) return next;
  const drop = next.findIndex((l) => l.channel === item.channel);
  return next.filter((_l, i) => i !== drop);
}

/** Every folder you can open: shared with the room, shared with just you, and workspaces you were invited into. */
function rootRows(state: AppState): BrowserRow[] {
  const name = (id: string) => state.peers.find((p) => p.peerId === id)?.name ?? 'someone';
  const room = state.peers.flatMap((p) =>
    p.shares.map((s) => ({ label: `${p.name} · ${s.name}${s.writable ? '' : ' (read-only)'}`, dir: true, target: { owner: p.peerId, share: s.name, path: '' } })),
  );
  const offers = state.offers.map((o) => ({ label: `${name(o.owner)} · ${o.name} (shared with you)`, dir: true, target: { owner: o.owner, share: o.name, path: '' } }));
  const workspaces = state.shared.map((w) => ({ label: `${name(w.owner)} · ${w.name} (workspace)`, dir: true, target: { owner: w.owner, share: w.share, path: '' } }));
  return [...room, ...offers, ...workspaces];
}

/** One key per folder listed at the top of Shared files (to tell which ones are new). */
export function shareKeys(state: Pick<AppState, 'peers' | 'offers' | 'shared' | 'self'>): string[] {
  return [
    ...state.peers.filter((p) => p.peerId !== state.self?.peerId).flatMap((p) => p.shares.map((s) => `${p.peerId}/${s.name}`)),
    ...state.offers.map((o) => `${o.owner}/${o.name}`),
    ...state.shared.map((w) => `${w.owner}/${w.share}`),
  ];
}

/** Folders shared since you last looked at Shared files (0 while you're there). */
export function newShares(state: AppState): number {
  if (state.view.kind === 'files') return 0;
  const seen = new Set(state.seenShares);
  return new Set(shareKeys(state).filter((k) => !seen.has(k))).size;
}

function reduceAgent(state: AppState, raw: Extract<Action, { type: 'agent_event' }>): AppState {
  const a = { ...raw, text: clean(raw.text) };
  const idx = state.log.findIndex((l) => l.type === 'agent' && l.requestId === a.requestId && l.owner === a.owner);
  const existing = idx >= 0 ? (state.log[idx] as Extract<LogItem, { type: 'agent' }>) : undefined;
  const base = existing ?? {
    id: nextId(),
    type: 'agent' as const,
    requestId: a.requestId,
    owner: a.owner,
    ownerName: peerName(state, a.owner),
    requesterName: peerName(state, a.requester),
    status: a.event,
    text: '',
    steps: [],
    subagents: [],
    channel: a.channel ?? 'room',
    ts: a.ts,
  };
  const updated = {
    ...base,
    status: a.event === 'text' || a.event === 'tool' || a.event === 'sub' ? 'started' : a.event,
    subagents: a.event === 'sub' ? applySub(base.subagents, a.text) : a.event === 'done' || a.event === 'error' ? base.subagents.map((s) => ({ ...s, status: 'done' as const })) : base.subagents,
    text:
      a.event === 'text'
        ? (base.text ? `${base.text}\n` : '') + a.text
        : a.event === 'done' || a.event === 'error' || a.event === 'denied'
          ? a.text || base.text
          : base.text,
    steps: a.event === 'tool' ? [...base.steps, a.text].slice(-MAX_STEPS) : base.steps,
    endTs: a.event === 'done' || a.event === 'error' || a.event === 'denied' ? a.ts : base.endTs,
  } satisfies LogItem;
  const log = existing ? state.log.map((l, i) => (i === idx ? updated : l)) : appendLog(state.log, updated);
  return bumpUnread({ ...state, log }, updated.channel, !existing);
}

/** Context meter updates and compactions don't create chat items; they update the meter. */
function reduceContext(state: AppState, a: Extract<Action, { type: 'agent_event' }>): AppState {
  const channel = a.channel ?? 'room';
  let data: { used?: number; window?: number; pre?: number; post?: number };
  try {
    data = JSON.parse(a.text) as typeof data;
  } catch {
    return state;
  }
  const window = data.window ?? state.context[channel]?.window ?? 200_000;
  if (a.event === 'context' && typeof data.used === 'number') {
    return { ...state, context: { ...state.context, [channel]: { used: data.used, window } } };
  }
  if (a.event === 'compact' && typeof data.pre === 'number') {
    const post = data.post ?? 0;
    const saved = data.pre > 0 ? Math.round((1 - post / data.pre) * 100) : 0;
    return {
      ...state,
      context: { ...state.context, [channel]: { used: post, window } },
      compactions: { ...state.compactions, [channel]: { pre: data.pre, post, at: a.ts } },
      log: appendLog(state.log, {
        id: nextId(),
        type: 'system',
        channel,
        text: `Context compacted: ${formatTokens(data.pre)} → ${formatTokens(post)} tokens (${saved}% freed)`,
        ts: a.ts,
        level: 'info',
      }),
    };
  }
  return state;
}

export const formatTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Apply one sub-agent event (JSON from the runner) to the list. */
function applySub(list: readonly SubAgent[], json: string): readonly SubAgent[] {
  let e: { id?: string; phase?: string; title?: string; step?: string; kind?: 'agent' | 'background'; failed?: boolean };
  try {
    e = JSON.parse(json) as typeof e;
  } catch {
    return list;
  }
  if (!e.id) return list;
  const existing = list.find((s) => s.id === e.id);
  if (e.phase === 'start' && !existing) return [...list, { id: e.id, title: e.title ?? 'sub-agent', steps: [], status: 'running', kind: e.kind ?? 'agent' }];
  return list.map((s) => {
    if (s.id !== e.id) return s;
    if (e.phase === 'step' && e.step) return { ...s, steps: [...s.steps, e.step].slice(-MAX_STEPS) };
    if (e.phase === 'done') return { ...s, status: e.failed ? 'failed' : 'done', steps: e.step ? [...s.steps, e.step].slice(-MAX_STEPS) : s.steps };
    return s;
  });
}

/** The conversation a view shows, if any (Overview, Search, Terminal… show none, so the chat's unread count stays). */
const shownChannel = (view: View): string | undefined => (view.kind === 'room' || view.kind === 'workspace' || view.kind === 'shared' ? channelOf(view) : undefined);

/** Count new messages in conversations you're not looking at. */
function bumpUnread(state: AppState, channel: string, isNew: boolean): AppState {
  if (!isNew || channel === shownChannel(state.view)) return state;
  return { ...state, unread: { ...state.unread, [channel]: (state.unread[channel] ?? 0) + 1 } };
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'status':
      return { ...state, status: action.status };
    case 'invite':
      return { ...state, invite: action.invite };
    case 'room':
      return { ...state, room: clean(action.room) };
    case 'hosting':
      return { ...state, hosting: action.hosting };
    case 'toast':
      return { ...state, toast: { id: (state.toast?.id ?? 0) + 1, text: clean(action.text), level: action.level ?? 'info' } };
    case 'toast_clear':
      return state.toast?.id === action.id ? { ...state, toast: undefined } : state;
    case 'overlay':
      return { ...state, overlay: action.overlay };
    case 'welcome':
      return { ...state, self: action.self };
    case 'peers': {
      const browser = state.browser.at ? state.browser : { ...state.browser, rows: rootRows({ ...state, peers: action.peers }), cursor: 0 };
      const ids = new Set(action.peers.map((p) => p.peerId));
      const follow = state.follow && ids.has(state.follow) ? state.follow : undefined;
      // Trust is re-applied from your saved choices when someone comes back (see Session).
      const levels = Object.fromEntries(Object.entries(state.levels).filter(([id]) => ids.has(id)));
      const access = Object.fromEntries(Object.entries(state.access).filter(([id]) => ids.has(id)));
      return { ...state, peers: action.peers, browser, follow, levels, access };
    }
    case 'chat':
      return bumpUnread({
        ...state,
        log: appendLog(state.log, {
          id: action.id,
          type: 'chat',
          channel: action.channel ?? 'room',
          from: action.from,
          name: peerName(state, action.from) + (action.byAgent ? "'s Claude" : ''),
          text: clean(action.text),
          ts: action.ts,
          byAgent: action.byAgent,
        }),
      }, action.channel ?? 'room', true);
    case 'system':
      return {
        ...state,
        log: appendLog(state.log, { id: nextId(), type: 'system', channel: action.channel ?? 'room', text: clean(action.text), ts: Date.now(), level: action.level ?? 'info' }),
      };
    case 'conflicts': {
      const { [action.id]: _old, ...rest } = state.conflicts;
      return { ...state, conflicts: action.files.length ? { ...rest, [action.id]: action.files } : rest };
    }
    case 'projects':
      return { ...state, projects: action.projects, projectGroups: action.groups ?? state.projectGroups, tabs: state.tabs.filter((t) => action.projects.some((p) => p.workspaces.some((w) => w.id === t))) };
    case 'view': {
      const tabs = action.view.kind === 'workspace' && !state.tabs.includes(action.view.id) ? [...state.tabs, action.view.id] : state.tabs;
      const channel = shownChannel(action.view) ?? '';
      const { [channel]: _seen, ...unread } = state.unread;
      // Opening (or leaving) Shared files counts every folder there as seen.
      const seenShares = action.view.kind === 'files' || state.view.kind === 'files' ? shareKeys(state) : state.seenShares;
      return { ...state, view: action.view, tabs, unread, seenShares };
    }
    case 'close_tab': {
      const tabs = state.tabs.filter((t) => t !== action.id);
      const view = state.view.kind === 'workspace' && state.view.id === action.id ? ({ kind: 'overview' } as const) : state.view;
      return { ...state, tabs, view };
    }
    case 'review':
      return { ...state, review: action.review };
    case 'env_changes':
      return { ...state, envChanges: { ...state.envChanges, [action.id]: action.changes } };
    case 'history': {
      const others = state.log.filter((l) => l.channel !== action.channel);
      return { ...state, log: [...action.items.slice(-LOG_LIMIT).map((i) => ({ ...i, channel: action.channel })), ...others] };
    }
    case 'shell': {
      const item = { ...action.item, command: clean(action.item.command), output: clean(action.item.output), ...(action.item.cwd ? { cwd: clean(action.item.cwd) } : {}), ...(action.item.error ? { error: clean(action.item.error) } : {}) };
      const idx = state.log.findIndex((l) => l.id === item.id);
      if (idx >= 0) return { ...state, log: state.log.map((l, i) => (i === idx ? item : l)) };
      return bumpUnread({ ...state, log: appendLog(state.log, item) }, item.channel, true);
    }
    case 'agent_event':
      if (action.event === 'usage') return state;
      if (action.event === 'context' || action.event === 'compact') return reduceContext(state, action);
      return reduceAgent(state, action);
    case 'approval_add':
      return {
        ...state,
        approvals: [...state.approvals, { ...action.approval, title: clean(action.approval.title), detail: clean(action.approval.detail) }],
      };
    case 'approval_remove':
      return { ...state, approvals: state.approvals.filter((a) => a.id !== action.id) };
    case 'browser_root':
      return { ...state, browser: { rows: rootRows(state), cursor: 0, loading: false } };
    case 'browser_loading':
      return { ...state, browser: { ...state.browser, at: action.at, loading: true, error: undefined } };
    case 'browser_entries': {
      if (!sameLoc(state.browser.at, action.at)) return state;
      const rows: BrowserRow[] = [
        { label: '..', dir: true, target: 'up' },
        ...action.entries.map((e) => ({
          label: e.name,
          dir: e.dir,
          size: e.size,
          target: { ...action.at, path: action.at.path ? `${action.at.path}/${e.name}` : e.name },
        })),
      ];
      return { ...state, browser: { at: action.at, rows, cursor: 0, loading: false } };
    }
    case 'browser_error':
      return { ...state, browser: { ...state.browser, loading: false, error: action.error } };
    case 'browser_cursor': {
      const max = Math.max(0, state.browser.rows.length - 1);
      const cursor = Math.min(max, Math.max(0, state.browser.cursor + action.delta));
      return { ...state, browser: { ...state.browser, cursor } };
    }
    case 'viewer_open': {
      const keep = sameLoc(state.viewer, action.at) ? state.viewer : undefined;
      return {
        ...state,
        viewer: { ...action.at, content: keep?.content ?? '', truncated: keep?.truncated ?? false, loading: true, scroll: keep?.scroll ?? 0, by: action.by },
      };
    }
    case 'viewer_image':
      if (!state.viewer || !sameLoc(state.viewer, action.at)) return state;
      return { ...state, viewer: { ...state.viewer, image: action.image, content: '', truncated: false, loading: false, error: undefined } };
    case 'viewer_content':
      if (!state.viewer || !sameLoc(state.viewer, action.at)) return state;
      return { ...state, viewer: { ...state.viewer, content: clean(action.content), truncated: action.truncated, loading: false, error: undefined } };
    case 'viewer_error':
      if (!state.viewer || !sameLoc(state.viewer, action.at)) return state;
      return { ...state, viewer: { ...state.viewer, loading: false, error: action.error } };
    case 'viewer_scroll': {
      if (!state.viewer) return state;
      const max = action.max ?? state.viewer.content.split('\n').length - 1;
      const scroll = Math.min(Math.max(0, max), Math.max(0, state.viewer.scroll + action.delta));
      return { ...state, viewer: { ...state.viewer, scroll } };
    }
    case 'viewer_close':
      return { ...state, viewer: undefined };
    case 'focus':
      return { ...state, focus: { ...state.focus, [action.actorKey]: action.focus } };
    case 'follow':
      return { ...state, follow: action.peerId };
    case 'full_trust':
      // Taking back full trust only changes someone who had it.
      if (!action.trusted && state.levels[action.peerId] !== 'full') return state;
      return reduce(state, { type: 'trust_level', peerId: action.peerId, level: action.trusted ? 'full' : 'ask' });
    case 'trust_level': {
      const { [action.peerId]: _old, ...rest } = state.levels;
      return { ...state, levels: action.level ? { ...rest, [action.peerId]: action.level } : rest };
    }
    case 'access':
      return { ...state, access: { ...state.access, [action.peerId]: action.scope } };
    case 'policy':
      return { ...state, policy: action.policy };
    case 'trust':
      if (!action.trusted && state.levels[action.peerId] !== 'trusted') return state;
      return reduce(state, { type: 'trust_level', peerId: action.peerId, level: action.trusted ? (state.levels[action.peerId] === 'full' ? 'full' : 'trusted') : 'ask' });
    case 'prefs':
      return { ...state, prefs: { ...state.prefs, ...action.prefs } };
    case 'transfer': {
      const others = state.transfers.filter((t) => t.id !== action.transfer.id);
      return { ...state, transfers: [...others, action.transfer].slice(-TRANSFER_LIMIT) };
    }
    case 'dir_cache':
      return { ...state, dirCache: { ...state.dirCache, [action.key]: action.entries } };
    case 'clear': {
      const channel = action.channel ?? channelOf(state.view);
      return { ...state, log: state.log.filter((l) => l.channel !== channel) };
    }
    case 'question_add':
    case 'question_pick':
    case 'question_remove':
    case 'room_open':
    case 'shared_add':
    case 'shared_remove':
    case 'member_set':
    case 'roster':
    case 'plan_mode':
    case 'peer_gone':
    case 'shared_clear':
    case 'trust_prompt':
    case 'granted':
    case 'link_set':
    case 'link_remove':
    case 'guest_set':
    case 'knock':
    case 'guest_shell':
    case 'offer': {
      const next = { ...state, ...reduceCollab(state, action) };
      // The Shared files list updates live while you're looking at it.
      return next.browser.at ? next : { ...next, browser: { ...next.browser, rows: rootRows(next) } };
    }
    case 'notice_add':
    case 'notice_read':
    case 'notice_clear':
    case 'away':
    case 'models':
    case 'disk':
    case 'pr':
    case 'setup':
    case 'search':
    case 'templates':
    case 'terminal':
    case 'pr_custom':
    case 'gh':
    case 'remembered':
      return { ...state, ...reduceWork(state, action) };
    case 'context_reset': {
      const { [action.channel]: _gone, ...context } = state.context;
      return { ...state, context };
    }
    default:
      return state;
  }
}

/** Minimal observable store; the UI subscribes via useSyncExternalStore. */
export class Store {
  private state: AppState;
  private readonly listeners = new Set<() => void>();

  constructor(initial: AppState) {
    this.state = initial;
  }

  getState = (): AppState => this.state;

  dispatch = (action: Action): void => {
    const next = reduce(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
