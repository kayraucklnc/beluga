import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunInput, RoomBridge } from '../../src/agent/types.js';
import { gatewayOf } from '../../src/core/gateway/registry.js';
import { launchGateway } from '../../src/core/gateway/launch.js';
import { runShell } from '../../src/core/peer-run.js';
import { Session } from '../../src/core/session.js';
import { ShareService } from '../../src/core/shares.js';
import { type DomainState, Store, initialState } from '../../src/core/store.js';
import { deriveKeys, generateSecret } from '../../src/net/crypto.js';
import { type Hub, startHub } from '../../src/net/hub.js';
import { PeerClient } from '../../src/net/peer-client.js';
import { waitFor } from '../helpers.js';

/**
 * The gateway over today's rooms: two real sessions in a room (a hub), each with the gateway
 * the daemon starts. Covers the wiring: room frames, today's approval cards, run_on through
 * PeerRun's gates, and a new turn of your Claude when an answer comes back.
 */

const keys = deriveKeys(generateSecret());
let hub: Hub;
const sessions: Session[] = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  for (const s of stops.splice(0)) s();
  for (const s of sessions.splice(0)) await s.stop();
  await hub?.close();
});

interface Peer {
  session: Session;
  state: () => DomainState;
  root: string;
  ran: string[];
  runs: AgentRunInput[];
  bridge: RoomBridge;
}

function peer(name: string): Peer {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `klaud-gwroom-${name}-`)));
  const shares = new ShareService([{ name: 'proj', root, writable: false }]);
  const store = new Store(initialState('test', 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name, shares: shares.infos, agent: true }, reconnect: false });
  const ran: string[] = [];
  const runs: AgentRunInput[] = [];
  let bridge!: RoomBridge;
  const session = new Session({
    client,
    store,
    shares,
    agentCwd: root,
    requestTimeoutMs: 2000,
    createAgent: (b) => {
      bridge = b;
      return {
        run: async (input) => {
          runs.push(input);
          return input.prompt.includes('<request>') ? `${name} did it` : `continuing: ${input.prompt.slice(0, 40)}`;
        },
      };
    },
    runShell: async (command, cwd, timeoutMs) => {
      ran.push(`${command} @ ${cwd}`);
      return runShell(command, cwd, timeoutMs);
    },
  });
  session.start();
  sessions.push(session);
  stops.push(launchGateway({ session, store, demo: true }));
  return { session, state: store.getState, root, ran, runs, get bridge() { return bridge; } };
}

async function room(...peers: Peer[]): Promise<void> {
  await waitFor(() => peers.every((p) => p.state().peers.length === peers.length && p.state().self));
}

const idOf = (p: Peer): string => p.session.selfId;
const gw = (p: Peer) => gatewayOf(p.session)!;

describe('tasks between Claudes in a room', () => {
  it('asks with today’s approval card, runs their Claude, and answers only the requester', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    const zoe = peer('zoe');
    await room(kay, bob, zoe);
    kay.session.people.setTrust(idOf(bob), 'trusted', true);
    // Cards: each tells the others what it offers.
    await waitFor(() => kay.state().gateway.cards[idOf(bob)]?.trust === 'ask');
    const t = gw(kay).ask({ person: 'bob', ask: 'check the README for typos', by: 'agent', conversation: 'room' });
    await waitFor(() => bob.state().approvals.length === 1);
    expect(bob.state().approvals[0]?.title).toBe("kay's Claude wants to: check the README for typos");
    expect(bob.state().inbox.some((n) => n.title === "kay's Claude wants to: check the README for typos")).toBe(true);
    bob.session.answerApproval('yes');
    await waitFor(() => gw(kay).get(t.id)?.state === 'done', 5000);
    expect(gw(kay).get(t.id)?.result?.summary).toBe('bob did it');
    // zoe saw nothing of it.
    expect(zoe.state().gateway.tasks).toHaveLength(0);
    expect(zoe.state().log.some((l) => JSON.stringify(l).includes('README for typos'))).toBe(false);
  });

  // Not on Windows: the temp folder is under home there, so it shows as ~\….
  it.skipIf(process.platform === 'win32')('run_on: full trust runs, trusted asks (the request card), secrets never, blocked is declined', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    kay.session.people.setTrust(idOf(bob), 'full', true);
    bob.session.people.setTrust(idOf(kay), 'full', true);
    const quick = gw(kay).ask({ person: 'bob', kind: 'run', ask: 'echo hi from bob', command: 'echo hi from bob', by: 'agent' });
    await waitFor(() => gw(kay).get(quick.id)?.state === 'done', 5000);
    expect(bob.state().approvals).toHaveLength(0);
    expect(bob.ran[0]).toBe(`echo hi from bob @ ${os.homedir()}`);
    expect(gw(kay).get(quick.id)?.result).toMatchObject({ status: 'done', data: { exitCode: 0 } });
    expect(gw(kay).get(quick.id)?.result?.summary).toContain('hi from bob');

    bob.session.people.setTrust(idOf(kay), 'trusted', true);
    const asked = gw(kay).ask({ person: 'bob', kind: 'run', ask: 'to see the folder', command: 'pwd', by: 'agent' });
    await waitFor(() => bob.state().approvals.length === 1);
    expect(bob.state().approvals[0]?.title).toBe("kay's Claude wants to run on your Mac: pwd");
    expect(bob.state().approvals[0]?.detail).toContain('$ pwd');
    expect(bob.state().approvals[0]?.task).toBe(asked.id);
    await waitFor(() => gw(kay).get(asked.id)?.state === 'awaiting_approval');
    bob.session.answerApproval('yes');
    await waitFor(() => gw(kay).get(asked.id)?.state === 'done', 5000);
    expect(gw(kay).get(asked.id)?.result?.summary).toContain(bob.root);

    // Secrets never, whatever the trust.
    const secret = gw(kay).ask({ person: 'bob', kind: 'run', ask: 'cat .env', command: 'cat .env', by: 'agent' });
    await waitFor(() => gw(kay).get(secret.id)?.state === 'failed', 5000);
    expect(gw(kay).get(secret.id)?.result?.summary).toContain('secrets');

    bob.session.people.setTrust(idOf(kay), 'blocked', true);
    const blocked = gw(kay).ask({ person: 'bob', kind: 'run', ask: 'ls', command: 'ls', by: 'agent' });
    await waitFor(() => gw(kay).get(blocked.id)?.state === 'declined', 5000);
    expect(bob.ran).toHaveLength(2);
  });

  it('when your Claude’s turn already ended, the answer starts a new turn in that conversation', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    kay.session.people.setTrust(idOf(bob), 'trusted', true);
    bob.session.people.setTrust(idOf(kay), 'trusted', true);
    const t = gw(kay).ask({ person: 'bob', ask: 'what is the staging URL?', by: 'agent', conversation: 'room' });
    await waitFor(() => gw(kay).get(t.id)?.delivered, 5000);
    // Kay's own Claude ran again, in the room, with bob's answer marked as data.
    await waitFor(() => kay.runs.length === 1, 5000);
    expect(kay.runs[0]!.prompt).toContain("bob's Claude replied");
    expect(kay.runs[0]!.prompt).toContain('<task_result from="bob"');
    expect(kay.runs[0]!.requesterName).toBe('kay');
    expect(kay.state().log.some((l) => l.type === 'system' && l.text.includes("bob's Claude replied. Claude continues with it."))).toBe(true);
  });
});
