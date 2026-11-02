import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState, type DomainState } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { type AgentRef, AgentRequestBody, type PeerInfo } from '../src/protocol.js';
import { matchTags, roomAgentTags, withTag } from '../src/shared/agent-tags.js';
import { suggest } from '../src/ui/suggest.js';
import { waitFor } from './helpers.js';

/** BLG-520: see and tag each person's agents in the room ("@codex", "@bob:codex"). */

const claude: AgentRef = { runtime: 'claude', label: 'Claude', model: 'opus' };
const codex: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5' };
const local: AgentRef = { runtime: 'local', label: 'Local', model: 'qwen3' };

describe('roomAgentTags', () => {
  const peers: PeerInfo[] = [
    { peerId: 'me', name: 'kay', agent: true, shares: [], agents: [claude], defaultAgent: claude },
    { peerId: 'b', name: 'bob', agent: true, shares: [], agents: [claude, codex], defaultAgent: claude },
    { peerId: 'm', name: 'mia', agent: true, shares: [], agents: [codex, local], defaultAgent: codex },
    { peerId: 'o', name: 'old', agent: true, shares: [] },
    { peerId: 'c', name: 'cat', agent: false, shares: [], agents: [codex] },
  ];
  const mine = [
    { id: 'claude', label: 'Claude', available: true },
    { id: 'codex', label: 'Codex', available: true },
    { id: 'local', label: 'Local model', available: false },
  ];

  it('lists your agents that run here and each person’s their card lists, with marks', () => {
    const tags = roomAgentTags(peers, 'me', mine);
    expect(tags.map((t) => [t.tag, t.mark])).toEqual([
      ['@codex', 'codex'],
      ['@bob:claude', 'claudeCode'],
      ['@bob:codex', 'codex'],
      ['@mia:codex', 'codex'],
      ['@mia:local', 'localModel'],
      // An older Mac lists no agents: its one agent, Claude.
      ['@old:claude', 'claudeCode'],
    ]);
    expect(tags.find((t) => t.tag === '@codex')?.hint).toBe('your Codex, on this Mac');
    expect(tags.find((t) => t.tag === '@mia:codex')?.hint).toBe("mia's Codex, on their Mac · @mia asks it too");
    // Agents someone doesn't run never show: no "@bob:local", nothing for cat (agent off), no "@local" (not set up here).
    expect(tags.some((t) => t.tag === '@bob:local' || t.tag === '@local' || t.tag.startsWith('@cat'))).toBe(false);
  });

  it('the Mac composer lists them after @ beside the old forms', () => {
    const ctx = { peers, selfId: 'me', agentTags: roomAgentTags(peers, 'me', mine) };
    const labels = (buffer: string) => suggest(buffer, ctx).map((s) => s.label);
    expect(labels('@co')).toEqual(['@codex']);
    expect(labels('@bob:')).toEqual(['@bob:claude', '@bob:codex']);
    expect(labels('@mi')).toEqual(['@mia:codex', '@mia:local']);
    expect(labels('@cl')).toContain('@claude:bob');
    expect(suggest('@bob:co', ctx)[0]).toMatchObject({ label: '@bob:codex', mark: 'codex', value: '@bob:codex ', kind: 'claude' });
    // Without tags (a worktree's box), nothing changes.
    expect(suggest('@co', { peers, selfId: 'me' })).toEqual([]);
  });

  it('the phone’s chips: what matches what is typed, and picking one fills it in', () => {
    const tags = roomAgentTags(peers, 'me', mine);
    expect(matchTags('ask @bo', tags).map((t) => t.tag)).toEqual(['@bob:claude', '@bob:codex']);
    expect(matchTags('@', tags)).toHaveLength(6);
    expect(matchTags('@bob:codex', tags)).toEqual([]);
    expect(matchTags('no tag here', tags)).toEqual([]);
    expect(withTag('ask @bo', '@bob:codex')).toBe('ask @bob:codex ');
    expect(withTag('@', '@codex')).toBe('@codex ');
  });
});

describe('the room ask carries the agent (protocol)', () => {
  const base = { kind: 'agent_request', requestId: 'r1', prompt: 'hi', channel: 'room' } as const;
  it('keeps a named agent and drops a malformed one alone', () => {
    expect(AgentRequestBody.parse({ ...base, agent: codex }).agent).toEqual(codex);
    const bad = AgentRequestBody.parse({ ...base, agent: { runtime: 7 } });
    expect(bad.agent).toBeUndefined();
    expect(bad.prompt).toBe('hi');
  });
});

// ---- Two (and three) Macs in one room

const keys = deriveKeys(generateSecret());
let hub: Hub;
const sessions: Session[] = [];
const clients: PeerClient[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  for (const c of clients.splice(0)) c.close();
  await hub?.close();
});

interface Mac {
  session: Session;
  state: () => DomainState;
  runs: AgentRunInput[];
}

/** A Mac whose card lists `agents` (its first the default); every runtime runs here (the test's backend). */
function mac(name: string, agents: readonly AgentRef[]): Mac {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `beluga-tags-${name}-`)));
  const shares = new ShareService([{ name: 'proj', root, writable: true }]);
  const store = new Store(initialState('test', 'auto'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name, shares: shares.infos, agent: true, agents: [...agents], defaultAgent: agents[0] }, reconnect: false });
  const runs: AgentRunInput[] = [];
  const backend: AgentBackend = {
    run: async (input) => {
      runs.push(input);
      return `${name}: ${input.prompt}`;
    },
  };
  const session = new Session({ client, store, shares, agentCwd: root, requestTimeoutMs: 2000, agentTimeoutMs: 2000, createAgent: () => backend });
  session.start();
  sessions.push(session);
  return { session, state: store.getState, runs };
}

const answers = (s: DomainState) => s.log.flatMap((l) => (l.type === 'agent' && l.status === 'done' ? [l] : []));
const systemLines = (s: DomainState) => s.log.flatMap((l) => (l.type === 'system' ? [l.text] : []));

describe('a room message naming an agent runs that agent on that person’s Mac', () => {
  it('@bob:codex runs bob’s Codex (with its model); the answer is named Codex', async () => {
    hub = await startHub({ keys });
    const kay = mac('kay', [claude]);
    const bob = mac('bob', [claude, codex]);
    await waitFor(() => kay.state().peers.length === 2 && bob.state().peers.length === 2);
    kay.session.submit('@bob:codex check the api');
    await waitFor(() => answers(kay.state()).length === 1);
    expect(bob.runs[0]?.model).toBe('gpt-5');
    expect(answers(kay.state())[0]).toMatchObject({ ownerName: 'bob', agent: { runtime: 'codex', label: 'Codex' }, text: 'bob: check the api' });
    expect(systemLines(kay.state()).filter((t) => /answers/.test(t))).toEqual([]);

    // "@bob" alone stays his default (Claude), as before.
    kay.session.submit('@bob and now');
    await waitFor(() => answers(kay.state()).length === 2);
    expect(answers(kay.state())[1]?.agent).toMatchObject({ runtime: 'claude' });
  });

  it('an agent their card doesn’t list: their default answers, and the room says so', async () => {
    hub = await startHub({ keys });
    const kay = mac('kay', [claude]);
    const mia = mac('mia', [claude]);
    await waitFor(() => kay.state().peers.length === 2 && mia.state().peers.length === 2);
    // The composer would note it too; written anyway (an old draft, a typo) it still goes.
    kay.session.requestAgent(mia.session.selfId, 'review', false, 'room', false, undefined, undefined, codex);
    await waitFor(() => answers(kay.state()).length === 1);
    expect(answers(kay.state())[0]?.agent).toMatchObject({ runtime: 'claude' });
    await waitFor(() => systemLines(kay.state()).includes('mia’s Codex isn’t set up on their Mac, so their Claude answers'));
  });

  it('your own @codex runs your Codex here', async () => {
    hub = await startHub({ keys });
    const kay = mac('kay', [claude]);
    const bob = mac('bob', [claude]);
    await waitFor(() => kay.state().peers.length === 2 && bob.state().peers.length === 2);
    kay.session.submit('@codex tidy the readme');
    await waitFor(() => answers(kay.state()).length === 1);
    expect(kay.runs).toHaveLength(1);
    expect(answers(kay.state())[0]).toMatchObject({ ownerName: 'kay', agent: { runtime: 'codex' } });
    // bob sees whose agent it was too.
    await waitFor(() => answers(bob.state())[0]?.agent?.runtime === 'codex');
  });

  it('an older Mac ignores the agent: its default answers, and the room says why', async () => {
    hub = await startHub({ keys });
    const kay = mac('kay', [claude]);
    // An older Beluga: answers every ask with its default and never says which one was named.
    const old = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'old', shares: [], agent: true, agents: [claude, codex], defaultAgent: claude }, reconnect: false });
    clients.push(old);
    old.on('message', (msg) => {
      if (msg.body.kind !== 'agent_request') return;
      const base = { kind: 'agent_event', requestId: msg.body.requestId, requester: msg.from, channel: 'room', agent: claude } as const;
      old.send({ ...base, event: 'started', text: '' }, { keep: true });
      old.send({ ...base, event: 'done', text: 'done by Claude' }, { keep: true });
    });
    old.connect();
    await waitFor(() => kay.state().peers.length === 2);
    kay.session.submit('@old:codex hi');
    await waitFor(() => answers(kay.state()).length === 1);
    expect(answers(kay.state())[0]?.agent).toMatchObject({ runtime: 'claude' });
    await waitFor(() => systemLines(kay.state()).some((t) => t === 'old’s Mac can’t pick an agent by name yet (an older Beluga), so their Claude answers'));
  });
});
