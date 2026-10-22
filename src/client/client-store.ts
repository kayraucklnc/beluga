import type { Intent } from '../core/intents.js';
import type { AppState, Attention, DomainState, ScreenState, WorkspaceTab } from '../core/store.js';
import { type ScreenAction, attentionOf, compose, initialScreen, intentToScreen, reconcileScreen, reduceScreen } from './screen.js';

/** Where a client's copy of the shared state comes from (the core's own store, or a replica fed by the daemon). */
export interface DomainSource {
  getState(): DomainState;
  subscribe(listener: () => void): () => void;
}

/** How long an open made ahead waits for the core's answer before that answer counts as new. */
const AHEAD_MS = 10_000;
const aheadKey = (id: string, tab: WorkspaceTab = 'chat'): string => `${id}\n${tab}`;

const sameAttention = (a: Attention, b: Attention): boolean =>
  a.files === b.files && a.front === b.front && a.shown.join('\n') === b.shown.join('\n') && a.visible.join('\n') === b.visible.join('\n');

/**
 * One client's view of klaud: the shared state plus this client's own screen, composed into
 * the AppState it draws. Screen actions apply here; everything else goes through the API.
 * Render-agnostic (the terminal UI and the Mac app both use it).
 */
export class ClientStore {
  private screen: ScreenState;
  private domain: DomainState;
  private composed: AppState;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private attention: Attention;
  /** Workspaces this screen opened itself, ahead of the core's answer (see openAhead): when each was. */
  private readonly ahead = new Map<string, number>();

  constructor(
    private readonly source: DomainSource,
    /** Tell the core what this screen looks at (unread counts, notifications). */
    private readonly onAttention: (attention: Attention) => void = () => undefined,
    screen: ScreenState = initialScreen,
  ) {
    this.screen = screen;
    this.domain = source.getState();
    this.composed = compose(this.domain, this.screen);
    this.attention = attentionOf(screen);
    this.onAttention(this.attention);
    this.unsubscribe = source.subscribe(() => this.onDomain());
  }

  getState = (): AppState => this.composed;

  /** The shared state alone. */
  getDomain = (): DomainState => this.domain;

  getScreen = (): ScreenState => this.screen;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Change this screen (go somewhere, open a dialog, move a cursor). */
  dispatch = (action: ScreenAction): void => {
    this.setScreen(reduceScreen(this.screen, action, this.domain));
  };

  /** Show what the core asked for. */
  applyIntent = (intent: Intent): void => {
    // The core's answer to an open this screen already showed: not again (a later click may have moved on since).
    if (intent.type === 'navigate' && intent.view.kind === 'workspace' && this.ahead.delete(aheadKey(intent.view.id, intent.view.tab))) return;
    const action = intentToScreen(intent, this.screen);
    if (action) this.dispatch(action);
  };

  /**
   * Show a workspace now, ahead of the core (asked to open it too, it answers with the same
   * navigation once it has caught up with everything else it's sending, which can be a while
   * when many Claudes stream). Its answer is then dropped, not shown again.
   */
  openAhead = (id: string, tab: WorkspaceTab): void => {
    const now = Date.now();
    // An answer that never came (the workspace went meanwhile) doesn't swallow a later one.
    for (const [key, at] of this.ahead) if (now - at > AHEAD_MS) this.ahead.delete(key);
    this.ahead.set(aheadKey(id, tab), now);
    this.dispatch({ type: 'view', view: { kind: 'workspace', id, tab } });
  };

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private onDomain(): void {
    const next = this.source.getState();
    if (next === this.domain) return;
    const prev = this.domain;
    this.domain = next;
    this.screen = reconcileScreen(prev, next, this.screen);
    this.publish();
  }

  private setScreen(next: ScreenState): void {
    if (next === this.screen) return;
    this.screen = next;
    const attention = attentionOf(next);
    if (!sameAttention(attention, this.attention)) {
      this.attention = attention;
      // In the same process this updates the domain right away (and we publish once, after).
      this.onAttention(attention);
      const latest = this.source.getState();
      if (latest !== this.domain) {
        const prev = this.domain;
        this.domain = latest;
        this.screen = reconcileScreen(prev, latest, this.screen);
      }
    }
    this.publish();
  }

  private publish(): void {
    this.composed = compose(this.domain, this.screen);
    for (const l of [...this.listeners]) l();
  }
}
