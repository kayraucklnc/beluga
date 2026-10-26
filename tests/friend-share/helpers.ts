import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentBackend, AgentRunInput } from '../../src/agent/types.js';
import { FriendShares } from '../../src/core/friend-share/service.js';
import { Session } from '../../src/core/session.js';
import { ShareService } from '../../src/core/shares.js';
import { Store, initialState } from '../../src/core/store.js';
import { deriveKeys, generateSecret } from '../../src/net/crypto.js';
import { PeerClient } from '../../src/net/peer-client.js';
import type { WorkspaceManager } from '../../src/workspaces/manager.js';
import type { Crowd, Person } from '../mesh/helpers.js';

/**
 * One simulated Mac sharing with friends: a mesh node on the local testnet, a Session (its room
 * is unreachable, as when nobody hosts), and core/friend-share between them. `restart` is quitting
 * Beluga and opening it again: same identity and files.
 */
export interface Mac {
  readonly name: string;
  readonly person: Person;
  readonly session: Session;
  readonly store: Store;
  readonly id: string;
  readonly runs: AgentRunInput[];
  shares: FriendShares;
  /** Hold every run of its Claude until open() is called. */
  hold(): void;
  open(): void;
  stop(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

export async function mac(net: Crowd, name: string, opts: { workspaces?: WorkspaceManager } = {}): Promise<Mac> {
  const person = await net.add(name);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `beluga-fs-${name}-`)));
  const shares = new ShareService([]);
  const store = new Store(initialState('test', 'ask'));
  // No room: a port nothing listens on, and no retries (nobody hosts).
  const client = new PeerClient({ url: 'ws://127.0.0.1:9', keys: deriveKeys(generateSecret()), profile: { name, shares: [], agent: true }, reconnect: false, identity: person.identity });
  const runs: AgentRunInput[] = [];
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const agent: AgentBackend = {
    run: async (input) => {
      runs.push(input);
      if (gate) await gate;
      return `echo: ${input.prompt.slice(-200)}`;
    },
  };
  const session = new Session({ client, store, shares, agentCwd: root, requestTimeoutMs: 3000, copy: async () => undefined, zoom: async () => ({ ok: true, message: '' }), ...(opts.workspaces ? { workspaces: opts.workspaces } : {}), createAgent: () => agent });
  session.start();
  if (opts.workspaces) await session.workspaces?.refresh();
  // Network summaries reach the store as the daemon's network service does it.
  const sync = (): void => store.dispatch({ type: 'net_summary', summary: person.mesh.summary() });
  const boot = (): FriendShares => {
    person.mesh.on('change', sync);
    sync();
    const s = new FriendShares({ session, store, mesh: person.mesh, dir: person.dir });
    s.start();
    return s;
  };
  const m: Mac = {
    name,
    person,
    session,
    store,
    id: person.identity.peerId,
    runs,
    shares: boot(),
    hold: () => {
      gate = new Promise((r) => (release = r));
    },
    open: () => {
      release?.();
      gate = undefined;
    },
    stop: async () => {
      m.shares.stop();
      person.mesh.off('change', sync);
      await person.stop();
    },
    start: async () => {
      await person.start();
      m.shares = boot();
    },
    close: async () => {
      m.shares.stop();
      await session.stop();
    },
  };
  return m;
}
