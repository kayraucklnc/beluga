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

const sameAttention = (a: Attention, b: Attention): boolean =>
  a.files === b.files && a.front === b.front && a.shown.join('\n') === b.shown.join('\n') && a.visible.join('\n') === b.visible.join('\n');

/**
 * One client's view of Beluga: the shared state plus this client's own screen, composed into
 * the AppState it draws. Screen actions apply here; everything else goes through the API.
 * Render-agnostic.
 */
export class ClientStore {
  private screen: ScreenState;
  private domain: DomainState;
  private composed: AppState;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private attention: Attention;
  /** Opens this screen made itself, ahead of the core's answer (see openAhead), by request id: which workspace and tab, and when. */
  private readonly ahead = new Map<string, { id: string; tab: WorkspaceTab; at: number }>();
  private nextReq = 0;
  private readonly reqPrefix = Math.random().toString(36).slice(2, 10);

  constructor(
    private readonly source: DomainSource,
    /** Tell the core what this screen looks at (unread counts, notifications). */
    private readonly onAttention: (attention: Attention) => void = () => undefined,
    screen: ScreenState = initialScreen,
  ) {
    this.screen = screen;
    this.domain = source.getState();
    this.composed = compose(this.domain, this.screen);
    this.attention = attentionOf(screen, this.domain);
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
    // Only the answer itself (its request id, workspace and tab): any other navigation always shows.
    if (intent.type === 'navigate' && this.answered(intent)) return;
    const action = intentToScreen(intent, this.screen);
    if (action) this.dispatch(action);
  };

  /**
   * Show a workspace now, ahead of the core (asked to open it too, it answers with the same
   * navigation once it has caught up with everything else it's sending, which can be a while
   * when many Claudes stream). Its answer is then dropped, not shown again. → the request id to
   * send with the open (workspaces.open's `req`), which the answer echoes.
   */
  openAhead = (id: string, tab: WorkspaceTab): string => {
    this.expire(Date.now());
    const req = `${this.reqPrefix}-${++this.nextReq}`;
    this.ahead.set(req, { id, tab, at: Date.now() });
    this.dispatch({ type: 'view', view: { kind: 'workspace', id, tab } });
    return req;
  };

  /** Whether a navigation is the answer to an open made ahead (same request, workspace and tab, within AHEAD_MS); settles it. */
  private answered(intent: Extract<Intent, { type: 'navigate' }>): boolean {
    this.expire(Date.now());
    const { req, view } = intent;
    if (!req || view.kind !== 'workspace') return false;
    const open = this.ahead.get(req);
    if (!open || open.id !== view.id || open.tab !== view.tab) return false;
    this.ahead.delete(req);
    return true;
  }

  /** An answer that never came (the workspace went meanwhile, the daemon restarted) is forgotten, never left waiting. */
  private expire(now: number): void {
    for (const [req, { at }] of this.ahead) if (now - at > AHEAD_MS) this.ahead.delete(req);
  }

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
    // On a plan's page, what it shows follows the plan (its tasks' conversations come and go).
    if (this.screen.view.kind === 'plan') this.tellAttention();
    this.publish();
  }

  /** Tell the core what this screen looks at now, when that changed. */
  private tellAttention(): boolean {
    const attention = attentionOf(this.screen, this.domain);
    if (sameAttention(attention, this.attention)) return false;
    this.attention = attention;
    this.onAttention(attention);
    return true;
  }

  private setScreen(next: ScreenState): void {
    if (next === this.screen) return;
    this.screen = next;
    // In the same process this updates the domain right away (and we publish once, after).
    if (this.tellAttention()) {
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
