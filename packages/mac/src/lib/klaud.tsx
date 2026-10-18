import { createContext, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { AppState } from '@klaud/core/store.js';
import type { SocketClient } from '@klaud/ipc/socket-client.js';
import { type UiState, initialUi } from '@klaud/ui/keymap.js';
import type { MenuKind } from '@klaud/ui/menus.js';

/**
 * This window's own UI state. It uses the terminal UI's shape (UiState) for everything the
 * shared menus and actions touch (an open menu, the composer's text, what it's asking for),
 * plus a few things only this window has.
 */
export interface MacUi extends UiState {
  readonly palette: boolean;
  /** The Add Project sheet is open. */
  readonly addProject?: boolean;
  /** The notification centre (the bell in the toolbar) is open. */
  readonly notices: boolean;
  readonly settings?: SettingsPane;
  /** A sheet asking for one line of text (a name for a new group…). */
  readonly ask?: { readonly title: string; readonly placeholder: string; readonly onSubmit: (text: string) => void };
}

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

interface Klaud {
  readonly client: SocketClient;
  readonly ui: UiStore;
}

const Ctx = createContext<Klaud | null>(null);

export function KlaudProvider({ client, children }: { client: SocketClient; children: ReactNode }) {
  const ui = useRef(new UiStore()).current;
  const value = useMemo(() => ({ client, ui }), [client, ui]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKlaud(): Klaud {
  const k = useContext(Ctx);
  if (!k) throw new Error('useKlaud outside KlaudProvider');
  return k;
}

/** The shared state seen through this window (re-renders when the picked part changes). */
export function useApp<T>(pick: (s: AppState) => T): T {
  const { client } = useKlaud();
  return useSyncExternalStore(client.store.subscribe, () => pick(client.store.getState()));
}

export function useUi<T>(pick: (s: MacUi) => T): T {
  const { ui } = useKlaud();
  return useSyncExternalStore(ui.subscribe, () => pick(ui.get()));
}

export const useApi = () => useKlaud().client.api;

/** Say something briefly in this window. */
export function toast(client: SocketClient, text: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
  client.store.dispatch({ type: 'toast', text, level });
}
