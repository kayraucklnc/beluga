import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaHome } from '../home.js';
import { watchNetwork } from '../network.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { FriendShares } from './service.js';

/**
 * Sharing with friends for the daemon, whenever the network is on (core/friend-share/service.ts).
 * The demo keeps its files in a temporary folder; otherwise they live in ~/.beluga.
 */

const services = new WeakMap<object, FriendShares>();

/** This session's sharing with friends, or undefined while the network is off. */
export const friendSharesOf = (session: object): FriendShares | undefined => services.get(session);

/** This session's sharing with friends, or a clear error while the network is off. */
export function needFriendShares(session: object): FriendShares {
  const service = services.get(session);
  if (!service) throw new Error('Sharing with friends needs the Beluga network: turn it on in Settings › Network');
  return service;
}

export interface FriendShareHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

export function launchFriendShares(host: FriendShareHost): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-share-')) : belugaHome();
  let current: FriendShares | undefined;
  const off = watchNetwork(session, (service) => {
    current?.stop();
    services.delete(session);
    current = undefined;
    if (!service) return;
    current = new FriendShares({ session, store, mesh: service.mesh, dir, ...(host.demo ? { copies: path.join(dir, 'copies') } : {}) });
    current.start();
    services.set(session, current);
  });
  return () => {
    off();
    current?.stop();
    services.delete(session);
    if (host.demo) rmSync(dir, { recursive: true, force: true });
  };
}
