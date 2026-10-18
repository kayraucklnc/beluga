import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BootstrapNode } from 'hyperdht';
import type { Identity } from '../net/crypto.js';
import { Mesh } from '../net/mesh/mesh.js';
import type { Timing } from '../net/mesh/links.js';
import type { Store } from './store.js';

/**
 * The klaud network as a core service: starts your Mac's mesh node (src/net/mesh) next to
 * today's rooms, mirrors what it knows into the shared state for screens, and answers the
 * `network.*` API. Off unless turned on (settings `network: true`, or KLAUD_NETWORK=1), and only
 * one klaud process per computer runs it (a lock file), so it can't disturb rooms.
 */

const OFF = 'The klaud network is off. Turn it on with "network": true in ~/.klaud/settings.json (or start with KLAUD_NETWORK=1).';

export const networkEnabled = (settings: { readonly network?: boolean }): boolean => process.env.KLAUD_NETWORK === '1' || (settings.network === true && process.env.KLAUD_NETWORK !== '0');

export interface NetworkService {
  readonly mesh: Mesh;
  stop(): Promise<void>;
}

export interface NetworkOptions {
  readonly store: Store;
  readonly identity: Identity;
  readonly name: string;
  /** Where the network keeps its files (normally ~/.klaud). */
  readonly dir: string;
  readonly bootstrap?: readonly BootstrapNode[];
  readonly host?: string;
  readonly timing?: Partial<Timing>;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Only one process may be your Mac on the network at a time (two would fight over one address). */
const held = new Set<string>();

function lock(dir: string): () => void {
  const file = path.join(dir, 'network.lock');
  if (held.has(file)) throw new Error('This klaud is already on the network');
  let holder: number | undefined;
  let exists = false;
  try {
    const text = readFileSync(file, 'utf8');
    exists = true;
    holder = Number(text.trim()) || undefined;
  } catch {
    holder = undefined;
  }
  if (holder && holder !== process.pid && isAlive(holder)) throw new Error(`Another klaud (process ${holder}) is already on the network`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A stale lock (its process is gone) is replaced; two starting at once can't both win ('wx').
  if (exists) rmSync(file, { force: true });
  try {
    writeFileSync(file, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
  } catch {
    throw new Error('Another klaud is starting on the network');
  }
  held.add(file);
  return () => {
    held.delete(file);
    try {
      if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  };
}

/** Start the network and keep the store's `network` in step with it. */
export async function startNetwork(opts: NetworkOptions): Promise<NetworkService> {
  const unlock = lock(opts.dir);
  let mesh: Mesh;
  try {
    mesh = await Mesh.start({ identity: opts.identity, name: opts.name, dir: opts.dir, ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}), ...(opts.host ? { host: opts.host } : {}), ...(opts.timing ? { timing: opts.timing } : {}) });
  } catch (err) {
    unlock();
    throw err;
  }
  const { store } = opts;
  // Many changes arrive together (a sync batch): one summary per turn of the event loop.
  let queued = false;
  const push = (): void => {
    if (queued) return;
    queued = true;
    setImmediate(() => {
      queued = false;
      if (!stopped) store.dispatch({ type: 'net_summary', summary: mesh.summary() });
    });
  };
  // A conversation a screen shows is read as messages arrive.
  const readShown = (): void => {
    for (const c of store.getState().attention.shown) if (c.startsWith('dm:') || c.startsWith('group:')) mesh.markRead(c);
  };
  let stopped = false;
  mesh.on('change', push);
  mesh.on('message', (message) => {
    store.dispatch({ type: 'net_message', message });
    if (store.getState().attention.shown.includes(message.conversation)) mesh.markRead(message.conversation);
  });
  const offAction = store.onAction((action) => {
    if (action.type === 'attention') readShown();
  });
  store.dispatch({ type: 'net_messages', messages: mesh.recent() });
  store.dispatch({ type: 'net_summary', summary: mesh.summary() });
  readShown();
  const service: NetworkService = {
    mesh,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      offAction();
      await mesh.close();
      unlock();
      store.dispatch({ type: 'net_off' });
    },
  };
  return service;
}

const services = new WeakMap<object, NetworkService>();

/** Make the network reachable from the API handlers of this session. */
export const attachNetwork = (session: object, service: NetworkService): void => void services.set(session, service);
export const detachNetwork = (session: object): void => void services.delete(session);

/** The network of this session, or a clear error when it's off. */
export function networkOf(session: object): Mesh {
  const service = services.get(session);
  if (!service) throw new Error(OFF);
  return service.mesh;
}

export const networkStatus = (session: object): { enabled: boolean; peerId?: string; address?: string } => {
  const mesh = services.get(session)?.mesh;
  return mesh ? { enabled: true, peerId: mesh.peerId, address: mesh.address } : { enabled: false };
};

export interface NetworkHost {
  readonly session: object;
  readonly store: Store;
  readonly identity: Identity;
  readonly name: string;
  /** Where the network keeps its files (normally ~/.klaud). */
  readonly dir: string;
  /** Demo mode: a simulated network (bob and mia) instead of the real one. */
  readonly demo: boolean;
  readonly warn: (text: string) => void;
}

/**
 * Bring the network up for a core when it's turned on (in the background: rooms and screens
 * don't wait for it). Returns how to stop it.
 */
export function launchNetwork(host: NetworkHost, settings: { readonly network?: boolean }): () => Promise<void> {
  if (!networkEnabled(settings)) return async () => undefined;
  let stopped = false;
  const name = host.name.trim().slice(0, 64) || 'klaud';
  const starting = (host.demo ? import('./network-demo.js').then((m) => m.startDemoNetwork(host.store, name)) : startNetwork({ store: host.store, identity: host.identity, name, dir: host.dir }))
    .then((service) => {
      if (stopped) {
        void service.stop();
        return undefined;
      }
      attachNetwork(host.session, service);
      return service;
    })
    .catch((err: unknown) => {
      host.warn(`The klaud network didn't start: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
  return async () => {
    stopped = true;
    const service = await starting;
    if (!service) return;
    detachNetwork(host.session);
    await service.stop();
  };
}
