import { createContext, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { AppState } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { type UiState, initialUi } from '@beluga/ui/keymap.js';
import type { MenuKind } from '@beluga/ui/menus.js';
import { onWindowActive, windowActive } from './window-active.js';

/**
 * This window's own UI state. It uses the shared shape (UiState) for everything the
 * shared menus and actions touch (an open menu, the composer's text, what it's asking for),
 * plus a few things only this window has.
 */
export interface MacUi extends UiState {
  readonly palette: boolean;
  /** The Add Project sheet is open. */
  readonly addProject?: boolean;
  /**
   * A project unfolded by clicking its row: it folds again when you go elsewhere, unless you
   * opened one of its worktrees or chats (then it stays open).
   */
  readonly peek?: string;
  /** The notification centre (the bell in the toolbar) is open. */
  readonly notices: boolean;
  readonly settings?: SettingsPane;
  /** A sheet asking for one line of text (a name for a new group…). */
  readonly ask?: { readonly title: string; readonly placeholder: string; readonly onSubmit: (text: string) => void };
  /** Who the next message is for (a chip in the composer): a person, their Claude, or yours. */
  readonly to?: Recipient;
}

/** "To bob", "To bob's Claude", "To your Claude": the message goes to them (see recipientPrefix). */
export interface Recipient {
  readonly peerId: string;
  readonly name: string;
  readonly claude: boolean;
  /** Yourself (your own Claude). */
  readonly self?: boolean;
}

/** What a message addressed to `to` starts with when it's sent (how Beluga reads who it's for). */
export const recipientPrefix = (to: Recipient): string => (to.claude ? (to.self ? '@claude ' : `@claude:${to.name} `) : `@${to.name} `);

/** "bob's Claude", "your Claude", "bob". */
export const recipientLabel = (to: Recipient): string => (to.claude ? (to.self ? 'your Claude' : `${to.name}’s Claude`) : to.name);

export type SettingsPane = 'general' | 'appearance' | 'claude' | 'notifications' | 'workspaces' | 'terminal' | 'environment' | 'people' | 'about';

type Listener = () => void;

export class UiStore {
  private state: MacUi = { ...initialUi, palette: false, notices: false };
  private readonly listeners = new Set<Listener>();

  get = (): MacUi => this.state;

  patch = (patch: Partial<MacUi>): void => {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  };

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  openMenu = (menu: MenuKind): void => this.patch({ menu: { menu, selected: 0 } });
}

interface Beluga {
  readonly client: SocketClient;
  readonly ui: UiStore;
}

const Ctx = createContext<Beluga | null>(null);

export function BelugaProvider({ client, children }: { client: SocketClient; children: ReactNode }) {
  const ui = useRef(new UiStore()).current;
  const value = useMemo(() => ({ client, ui }), [client, ui]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBeluga(): Beluga {
  const k = useContext(Ctx);
  if (!k) throw new Error('useBeluga outside BelugaProvider');
  return k;
}

/** While you're not looking at Beluga, views catch up with the shared state at most this often. */
const AWAY_MS = 1000;
const views = new WeakMap<object, (listener: () => void) => () => void>();

/**
 * How this window's views hear the shared state change: at once while you're looking at Beluga;
 * while you're not (lib/window-active.ts), at most once a second, so a Claude streaming for hours
 * doesn't redraw a window nobody's watching (KLD-40). Looking back catches up at once. The Dock,
 * tray and notifications listen to the store itself and never wait.
 */
function viewSubscribe(store: { subscribe: (listener: () => void) => () => void }): (listener: () => void) => () => void {
  const known = views.get(store);
  if (known) return known;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    for (const l of [...listeners]) l();
  };
  store.subscribe(() => {
    if (windowActive()) flush();
    else timer ??= setTimeout(flush, AWAY_MS);
  });
  onWindowActive(() => {
    if (windowActive() && timer) flush();
  });
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  views.set(store, subscribe);
  return subscribe;
}

/**
 * The shared state seen through this window (re-renders when the picked part changes). A pick
 * that builds something new each time (a filtered list) passes `equal` (e.g. sameItems, lib/stable.ts):
 * while it says the new pick is the same, the view keeps the old one and isn't drawn again.
 */
export function useApp<T>(pick: (s: AppState) => T, equal?: (a: T, b: T) => boolean): T {
  const { client } = useBeluga();
  const last = useRef<{ readonly value: T } | undefined>(undefined);
  return useSyncExternalStore(viewSubscribe(client.store), () => {
    const next = pick(client.store.getState());
    if (!equal) return next;
    if (last.current && equal(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  });
}

export function useUi<T>(pick: (s: MacUi) => T): T {
  const { ui } = useBeluga();
  return useSyncExternalStore(ui.subscribe, () => pick(ui.get()));
}

export const useApi = () => useBeluga().client.api;

/** Say something briefly in this window. */
export function toast(client: SocketClient, text: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
  client.store.dispatch({ type: 'toast', text, level });
}
