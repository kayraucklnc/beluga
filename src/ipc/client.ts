import type { ClientStore } from '../client/client-store.js';
import type { Intent } from '../core/intents.js';
import type { PtyLink } from '../terminal/emulator.js';
import type { Args, Method } from './api.js';
import type { Result } from './handlers.js';

/**
 * How a screen talks to klaud, whether klaud runs in the same process (the terminal UI on its
 * own) or in the daemon (several screens at once, the Mac app). Browser-safe.
 */
export interface KlaudClient {
  /** Which kind of screen this is. */
  readonly kind: ClientKind;
  /** The shared state plus this screen's own (what it draws). */
  readonly store: ClientStore;
  /** Every API method, grouped: `client.api.workspaces.open(id, 'chat')`. */
  readonly api: ApiProxy;
  /** Call one API method by name. */
  call<M extends Method>(method: M, ...args: Args<M>): Promise<Result<M>>;
  /** What the core asks this screen to do beyond its state (the store already shows navigation, dialogs and toasts). */
  onIntent(listener: (intent: Intent) => void): () => void;
  /** Attach to a terminal program by key (bytes both ways). */
  attachTerminal(key: string): PtyLink;
  /** Folder this screen was started in (new stand-alone chats run here). */
  readonly launchDir: string;
  /** Detach (the core keeps running for other screens). */
  close(): void;
}

export type ClientKind = 'tui' | 'mac' | 'test';

type Group<M> = M extends `${infer G}.${string}` ? G : never;
type NameIn<M, G extends string> = M extends `${G}.${infer N}` ? N : never;

/** The API as nested objects: `api.workspaces.open(...)` calls 'workspaces.open'. */
export type ApiProxy = {
  readonly [G in Group<Method>]: {
    readonly [N in NameIn<Method, G>]: `${G}.${N}` extends infer M extends Method ? (...args: Args<M>) => Promise<Result<M>> : never;
  };
};

export type Call = <M extends Method>(method: M, ...args: Args<M>) => Promise<Result<M>>;

/** Build the grouped API over a call function (calls are made lazily by name). */
export function apiProxy(call: (method: Method, args: readonly unknown[]) => Promise<unknown>): ApiProxy {
  const groups = new Map<string, Record<string, unknown>>();
  return new Proxy({} as ApiProxy, {
    get: (_target, group) => {
      if (typeof group !== 'string') return undefined;
      let methods = groups.get(group);
      if (!methods) {
        methods = new Proxy({} as Record<string, unknown>, {
          get: (_t, name) => (typeof name === 'string' ? (...args: unknown[]) => call(`${group}.${name}` as Method, args) : undefined),
        });
        groups.set(group, methods);
      }
      return methods;
    },
  });
}
