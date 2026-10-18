import type { Action, Overlay, Toast, View } from './store.js';

/**
 * What the core asks a screen to do: go somewhere, open a dialog, say something briefly, or
 * close a workspace's tab. Screens are the clients' own business (each one has its own), so
 * the core never changes them directly; it sends intents, to the client whose request caused
 * them when there is one, else to every client.
 */
export type Intent =
  /** `unless`: leave the screen alone when it already shows this kind of view. */
  | { readonly type: 'navigate'; readonly view: View; readonly unless?: View['kind'] }
  | { readonly type: 'overlay'; readonly overlay: Overlay }
  | { readonly type: 'toast'; readonly text: string; readonly level: Toast['level'] }
  /** A workspace (yours, or one shared with you) is gone: close its tab, and leave it if it's showing. */
  | { readonly type: 'close_tab'; readonly id: string };

export type IntentListener = (intent: Intent) => void;

/** Delivers intents to whoever shows them (the terminal UI, or the daemon's connected clients). */
export class IntentBus {
  private readonly listeners = new Set<IntentListener>();

  emit = (intent: Intent): void => {
    for (const l of [...this.listeners]) l(intent);
  };

  subscribe = (listener: IntentListener): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}

/** The store action that shows an intent on a screen kept in the same store (the terminal UI). */
export function intentAction(intent: Intent, current: View): Action | undefined {
  switch (intent.type) {
    case 'navigate':
      return intent.unless === current.kind ? undefined : { type: 'view', view: intent.view };
    case 'overlay':
      return { type: 'overlay', overlay: intent.overlay };
    case 'toast':
      return { type: 'toast', text: intent.text, level: intent.level };
    case 'close_tab':
      return { type: 'close_tab', id: intent.id };
  }
}
