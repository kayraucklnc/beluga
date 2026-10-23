import type { Intent } from '../core/intents.js';
import { planById } from '../core/plans/model.js';
import {
  type Action,
  type AppState,
  type Attention,
  type DomainState,
  type Location,
  type Overlay,
  type ScreenState,
  type Toast,
  type View,
  clean,
  initialState,
  reduceDomain,
  shownChannel,
  stampAction,
} from '../core/store.js';

/**
 * One screen's own state (see ScreenState in core/store.ts): each client keeps its own, so the
 * terminal UI and the Mac app can look at different things while sharing everything else.
 * Pure and render-agnostic: both clients use it.
 */
export type ScreenAction =
  | { type: 'view'; view: View }
  | { type: 'close_tab'; id: string }
  | { type: 'toast'; text: string; level?: Toast['level'] }
  | { type: 'toast_clear'; id: number }
  | { type: 'overlay'; overlay?: Overlay }
  | { type: 'away'; away: boolean }
  | { type: 'browser_cursor'; delta: number }
  | { type: 'viewer_scroll'; delta: number; max?: number }
  | { type: 'review_scroll'; delta: number }
  | { type: 'search_cursor'; cursor: number };

const SCREEN_ACTIONS: ReadonlySet<string> = new Set(['view', 'close_tab', 'toast', 'toast_clear', 'overlay', 'away', 'browser_cursor', 'viewer_scroll', 'review_scroll', 'search_cursor']);

export const isScreenAction = (action: { readonly type: string }): action is ScreenAction => SCREEN_ACTIONS.has(action.type);

export const initialScreen: ScreenState = { view: { kind: 'room' }, tabs: [], away: false, browserCursor: 0, viewerScroll: 0, diffScroll: 0, searchCursor: 0 };

const clamp = (n: number, max: number): number => Math.min(Math.max(0, max), Math.max(0, n));

export function reduceScreen(screen: ScreenState, action: ScreenAction, domain: DomainState): ScreenState {
  switch (action.type) {
    case 'view': {
      const tabs = action.view.kind === 'workspace' && !screen.tabs.includes(action.view.id) ? [...screen.tabs, action.view.id] : screen.tabs;
      return { ...screen, view: action.view, tabs };
    }
    case 'close_tab': {
      const tabs = screen.tabs.filter((t) => t !== action.id);
      const v = screen.view;
      const view: View = v.kind === 'workspace' && v.id === action.id ? { kind: 'overview' } : v.kind === 'shared' && v.id === action.id ? { kind: 'room' } : v;
      return tabs === screen.tabs && view === v ? screen : { ...screen, tabs, view };
    }
    case 'toast':
      return { ...screen, toast: { id: (screen.toast?.id ?? 0) + 1, text: clean(action.text), level: action.level ?? 'info' } };
    case 'toast_clear':
      return screen.toast?.id === action.id ? { ...screen, toast: undefined } : screen;
    case 'overlay':
      return { ...screen, overlay: action.overlay };
    case 'away':
      return screen.away === action.away ? screen : { ...screen, away: action.away };
    case 'browser_cursor':
      return { ...screen, browserCursor: clamp(screen.browserCursor + action.delta, domain.browser.rows.length - 1) };
    case 'viewer_scroll': {
      if (!domain.viewer) return screen;
      const max = action.max ?? domain.viewer.content.split('\n').length - 1;
      return { ...screen, viewerScroll: clamp(screen.viewerScroll + action.delta, max) };
    }
    case 'review_scroll':
      return { ...screen, diffScroll: Math.max(0, screen.diffScroll + action.delta) };
    case 'search_cursor':
      return { ...screen, searchCursor: clamp(action.cursor, domain.search.hits.length - 1) };
  }
}

const sameLoc = (a: Location | undefined, b: Location | undefined): boolean => a === b || (Boolean(a && b) && a?.owner === b?.owner && a?.share === b?.share && a?.path === b?.path);

/**
 * Keep a screen's cursors right when the shared state changes under it: a new folder starts at
 * its top, another file or diff at its start, fresh search results at the first one.
 */
export function reconcileScreen(prev: DomainState, next: DomainState, screen: ScreenState): ScreenState {
  if (prev === next) return screen;
  let out = screen;
  if (!sameLoc(prev.browser.at, next.browser.at) || (!next.browser.at && prev.browser.rows !== next.browser.rows && prev.browser.at)) out = { ...out, browserCursor: 0 };
  else if (out.browserCursor > Math.max(0, next.browser.rows.length - 1)) out = { ...out, browserCursor: Math.max(0, next.browser.rows.length - 1) };
  if (!sameLoc(prev.viewer, next.viewer)) out = { ...out, viewerScroll: 0 };
  if (prev.review?.workspaceId !== next.review?.workspaceId || prev.review?.selected !== next.review?.selected) out = { ...out, diffScroll: 0 };
  if (prev.search.hits !== next.search.hits) out = { ...out, searchCursor: 0 };
  return out;
}

/** What a client draws: the shared state seen through one screen. */
export function compose(domain: DomainState, screen: ScreenState): AppState {
  const live = new Set(domain.projects.flatMap((p) => p.workspaces.map((w) => w.id)));
  return {
    ...domain,
    view: screen.view,
    tabs: screen.tabs.filter((t) => live.has(t)),
    toast: screen.toast,
    overlay: screen.overlay,
    away: screen.away,
    browser: { ...domain.browser, cursor: Math.min(screen.browserCursor, Math.max(0, domain.browser.rows.length - 1)) },
    viewer: domain.viewer ? { ...domain.viewer, scroll: screen.viewerScroll } : undefined,
    review: domain.review ? { ...domain.review, diffScroll: screen.diffScroll } : undefined,
    search: { ...domain.search, cursor: screen.searchCursor },
  };
}

/** The screen part of what a client draws (the inverse of compose). */
export function screenOf(state: AppState): ScreenState {
  return {
    view: state.view,
    tabs: state.tabs,
    ...(state.toast ? { toast: state.toast } : {}),
    ...(state.overlay ? { overlay: state.overlay } : {}),
    away: state.away,
    browserCursor: state.browser.cursor,
    viewerScroll: state.viewer?.scroll ?? 0,
    diffScroll: state.review?.diffScroll ?? 0,
    searchCursor: state.search.cursor,
  };
}

/** What this screen is looking at, for unread counts and notifications. */
export function attentionOf(screen: ScreenState, domain?: Pick<DomainState, 'plans' | 'board'>): Attention {
  const view = screen.view;
  // A plan's page shows its own conversation: what's new there is seen. Its tasks' chats keep their
  // marks on the page (each one says which task has news) until you open them.
  const plan = view.kind === 'plan' && domain ? planById(domain.plans, view.id) : undefined;
  if (plan) {
    return { shown: [plan.home], visible: screen.away ? [] : [plan.home], files: false, front: !screen.away };
  }
  const shown = shownChannel(view);
  // Overview, Search, Terminal… show no conversation: nothing is visible there, but the window is in front.
  return { shown: shown ? [shown] : [], visible: screen.away || !shown ? [] : [shown], files: view.kind === 'files', front: !screen.away };
}

/** The screen action that shows an intent from the core. */
export function intentToScreen(intent: Intent, screen: ScreenState): ScreenAction | undefined {
  switch (intent.type) {
    case 'navigate':
      return intent.unless === screen.view.kind ? undefined : { type: 'view', view: intent.view };
    case 'overlay':
      return { type: 'overlay', overlay: intent.overlay };
    case 'toast':
      return { type: 'toast', text: intent.text, level: intent.level };
    case 'close_tab':
      return { type: 'close_tab', id: intent.id };
    case 'quit':
      return undefined;
  }
}

/** A client's state for tests and one-screen setups: the domain with one screen on top. */
export function initialAppState(...args: Parameters<typeof initialState>): AppState {
  return compose(withAttention(initialState(...args), initialScreen), initialScreen);
}

/**
 * Apply a domain or screen action to what one screen draws, keeping the screen in step with
 * the domain the way a client does (attention included). For tests and single-screen use.
 */
export function reduceApp(state: AppState, input: Action | ScreenAction): AppState {
  const screen = screenOf(state);
  const domain = domainOf(state);
  if (isScreenAction(input)) {
    const next = reduceScreen(screen, input, domain);
    if (next === screen) return state;
    return compose(withAttention(domain, next), next);
  }
  const action = stampAction(input as Action);
  const after = reduceDomain(domain, action);
  if (after === domain) return state;
  const next = reconcileScreen(domain, after, screen);
  // On a plan's page, its tasks' conversations come and go with the plan.
  return compose(next.view.kind === 'plan' ? withAttention(after, next) : after, next);
}

/** Tell the domain what this (only) screen looks at. */
function withAttention(domain: DomainState, screen: ScreenState): DomainState {
  const attention = attentionOf(screen, domain);
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
  const now = domain.attention;
  if (same(now.shown, attention.shown) && same(now.visible, attention.visible) && now.files === attention.files) return domain;
  return reduceDomain(domain, { type: 'attention', attention });
}

/** The domain part of what a client draws. */
export function domainOf(state: AppState): DomainState {
  const { view: _v, tabs: _t, toast: _to, overlay: _o, away: _a, ...rest } = state;
  const { cursor: _c, ...browser } = state.browser;
  const { cursor: _sc, ...search } = state.search;
  const viewer = state.viewer ? (({ scroll: _s, ...v }) => v)(state.viewer) : undefined;
  const review = state.review ? (({ diffScroll: _d, ...r }) => r)(state.review) : undefined;
  return { ...rest, browser, search, viewer, review } as DomainState;
}
