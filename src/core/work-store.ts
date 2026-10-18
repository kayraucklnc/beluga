import type { NoticeKind } from './notify.js';
import type { Settings } from './settings.js';

/** Something that happened while you were looking elsewhere (the inbox). */
export interface Notice {
  readonly id: number;
  readonly kind: NoticeKind;
  readonly title: string;
  readonly body: string;
  readonly channel?: string;
  readonly ts: number;
  readonly read: boolean;
}

/** A model you can pick for a conversation. */
export interface ModelChoice {
  /** Passed to Claude Code (an alias like "sonnet", or a full id); '' = Claude Code's default. */
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly efforts?: readonly string[];
}

/** A pull request for a worktree's branch, as `gh` reports it. */
export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly title: string;
  readonly draft: boolean;
  /** Combined CI state. */
  readonly checks: 'passing' | 'failing' | 'pending' | 'none';
  readonly review?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
}

export interface SetupRun {
  readonly status: 'running' | 'done' | 'failed';
  readonly command: string;
  readonly detail?: string;
}

export interface SearchHit {
  readonly channel: string;
  readonly place: string;
  readonly who: string;
  readonly text: string;
  /** Where the match starts in `text`. */
  readonly at: number;
  readonly ts: number;
  readonly archived?: boolean;
}

export interface SearchState {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly searched: number;
  readonly cursor: number;
}

/** A saved way to start a task. */
export interface Template {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  /** Plan first. */
  readonly plan?: boolean;
  readonly builtIn?: boolean;
}

export interface WorkState {
  readonly inbox: readonly Notice[];
  /** The terminal window klaud runs in is in the background (from focus reports). */
  readonly away: boolean;
  readonly models: readonly ModelChoice[];
  /** Folder size in bytes per workspace (worktrees and chats). */
  readonly disk: Readonly<Record<string, number>>;
  readonly prs: Readonly<Record<string, PullRequest>>;
  readonly setup: Readonly<Record<string, SetupRun>>;
  readonly search: SearchState;
  readonly templates: readonly Template[];
  /** Workspaces with a terminal session open (id → its title). */
  readonly terminals: Readonly<Record<string, string>>;
  /** You customized the pull request instructions. */
  readonly prCustom: boolean;
  /** The GitHub CLI is installed and signed in (undefined: not checked yet). */
  readonly gh?: boolean;
  /** People you picked a trust level for in earlier sessions. */
  readonly remembered: Settings['people'];
}

export type WorkAction =
  /** `ts` is stamped before reducing (see stampAction in store.ts). */
  | { type: 'notice_add'; notice: Omit<Notice, 'id' | 'ts' | 'read'>; ts?: number }
  | { type: 'notice_read'; channel?: string; id?: number }
  | { type: 'notice_clear' }
  | { type: 'away'; away: boolean }
  | { type: 'models'; models: readonly ModelChoice[] }
  | { type: 'disk'; sizes: Readonly<Record<string, number>> }
  | { type: 'pr'; id: string; pr?: PullRequest }
  | { type: 'setup'; id: string; run?: SetupRun }
  | { type: 'search'; search: Partial<SearchState> }
  | { type: 'templates'; templates: readonly Template[] }
  | { type: 'terminal'; id: string; title?: string }
  | { type: 'pr_custom'; custom: boolean }
  | { type: 'gh'; ok: boolean }
  | { type: 'remembered'; people: Settings['people'] };

export const FALLBACK_MODELS: readonly ModelChoice[] = [
  { value: '', label: 'Default', description: "Claude Code's choice" },
  { value: 'opus', label: 'Opus', description: 'most capable, for complex work' },
  { value: 'sonnet', label: 'Sonnet', description: 'fast and very capable' },
  { value: 'haiku', label: 'Haiku', description: 'fastest, for quick tasks' },
];

export const initialWork: WorkState = {
  inbox: [],
  away: false,
  models: FALLBACK_MODELS,
  disk: {},
  prs: {},
  setup: {},
  search: { query: '', hits: [], searched: 0, cursor: 0 },
  templates: [],
  terminals: {},
  prCustom: false,
  remembered: {},
};

const INBOX_LIMIT = 100;

const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const { [key]: _gone, ...rest } = record;
  return rest;
};

export function reduceWork(state: WorkState, action: WorkAction): WorkState {
  switch (action.type) {
    case 'notice_add': {
      const id = (state.inbox[0]?.id ?? 0) + 1;
      return { ...state, inbox: [{ ...action.notice, id, ts: action.ts ?? 0, read: false }, ...state.inbox].slice(0, INBOX_LIMIT) };
    }
    case 'notice_read':
      return {
        ...state,
        inbox: state.inbox.map((n) => (n.read || (action.id !== undefined ? n.id !== action.id : action.channel !== undefined && n.channel !== action.channel) ? n : { ...n, read: true })),
      };
    case 'notice_clear':
      return { ...state, inbox: [] };
    case 'away':
      return state.away === action.away ? state : { ...state, away: action.away };
    case 'models':
      return { ...state, models: action.models.length ? action.models : FALLBACK_MODELS };
    case 'disk':
      return { ...state, disk: { ...state.disk, ...action.sizes } };
    case 'pr':
      return { ...state, prs: action.pr ? { ...state.prs, [action.id]: action.pr } : without(state.prs, action.id) };
    case 'setup':
      return { ...state, setup: action.run ? { ...state.setup, [action.id]: action.run } : without(state.setup, action.id) };
    case 'search':
      return { ...state, search: { ...state.search, ...action.search } };
    case 'templates':
      return { ...state, templates: action.templates };
    case 'pr_custom':
      return { ...state, prCustom: action.custom };
    case 'gh':
      return { ...state, gh: action.ok };
    case 'remembered':
      return { ...state, remembered: action.people };
    case 'terminal':
      if (action.title !== undefined && state.terminals[action.id] === action.title) return state;
      return { ...state, terminals: action.title === undefined ? without(state.terminals, action.id) : { ...state.terminals, [action.id]: action.title } };
  }
}

export const unreadCount = (state: WorkState): number => state.inbox.filter((n) => !n.read).length;
