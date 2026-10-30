import { describe, expect, it } from 'vitest';
import { AgentRef, Body, CLAUDE_AGENT, PeerInfo, WelcomePayload, defaultAgentOf } from '../src/protocol.js';
import { ChatMessageView } from '../src/companion/protocol.js';
import { DEMO_AGENTS } from '../src/core/demo-agents.js';
import { Store, initialState } from '../src/core/store.js';
import { parseExtras } from '../src/net/mesh/extras.js';

const codex: AgentRef = { runtime: 'codex', model: 'gpt-5', label: 'Codex' };
const oldPeer = { name: 'bob', shares: [], agent: true, peerId: 'p-bob' };

describe('AgentRef on the wire (BLG-434)', () => {
  it('parses a peer from an older Mac, without agents, as Claude', () => {
    const p = PeerInfo.parse(oldPeer);
    expect(p.agents).toBeUndefined();
    expect(defaultAgentOf(p)).toEqual(CLAUDE_AGENT);
    // A whole welcome from an older hub: every peer parses.
    expect(WelcomePayload.parse({ peers: [oldPeer, { ...oldPeer, peerId: 'p-mia', name: 'mia' }], history: [] }).peers).toHaveLength(2);
  });

  it('keeps a peer’s agents and default, and an unknown runtime still parses', () => {
    const p = PeerInfo.parse({ ...oldPeer, agents: [CLAUDE_AGENT, codex, { runtime: 'aider', label: 'Aider' }], defaultAgent: codex });
    expect(p.agents).toHaveLength(3);
    expect(defaultAgentOf(p)).toEqual(codex);
    expect(defaultAgentOf({ agents: [codex] })).toEqual(codex);
  });

  it('refuses a malformed agent instead of trusting it', () => {
    expect(AgentRef.safeParse({ runtime: 'Codex!', label: 'x' }).success).toBe(false);
    expect(AgentRef.safeParse({ runtime: 'codex', label: '' }).success).toBe(false);
  });

  it('chat and agent_event bodies validate with and without the agent', () => {
    expect(Body.parse({ kind: 'chat', text: 'hi', byAgent: true })).not.toHaveProperty('agent');
    expect(Body.parse({ kind: 'chat', text: 'hi', byAgent: true, agent: codex })).toMatchObject({ agent: codex });
    const ev = { kind: 'agent_event', requestId: 'r1', requester: 'p-me', event: 'started' };
    expect(Body.parse(ev)).not.toHaveProperty('agent');
    expect(Body.parse({ ...ev, agent: codex })).toMatchObject({ agent: codex });
  });

  it('a friend-chat answer keeps its agent; a malformed one is dropped, never the answer', () => {
    expect(parseExtras({ claude: { for: 'm1', agent: codex } })?.claude).toEqual({ for: 'm1', agent: codex });
    expect(parseExtras({ claude: { for: 'm1', agent: { runtime: 'BAD RUNTIME' } } })?.claude).toEqual({ for: 'm1' });
    expect(parseExtras({ claude: { for: 'm1' } })?.claude).toEqual({ for: 'm1' });
  });

  it('the phone’s message view takes the agent, and an older Mac’s message without it', () => {
    const m = { id: 'm1', from: 'mia', mine: false, claude: true, text: 'hi', ts: 1 };
    expect(ChatMessageView.parse(m)).not.toHaveProperty('agent');
    expect(ChatMessageView.parse({ ...m, agent: codex }).agent).toEqual(codex);
  });

  it('demo friends run different agents', () => {
    expect(defaultAgentOf(DEMO_AGENTS.bob).runtime).toBe('claude');
    expect(defaultAgentOf(DEMO_AGENTS.mia).runtime).toBe('codex');
    for (const a of Object.values(DEMO_AGENTS)) expect(PeerInfo.parse({ ...oldPeer, ...a }).agents).toEqual(a.agents);
  });
});

describe('the store records which agent wrote and ran (BLG-434)', () => {
  it('a chat message by an agent keeps its AgentRef; a person’s never gets one', () => {
    const store = new Store(initialState('room', 'ask'));
    store.dispatch({ type: 'chat', id: 'c1', from: 'p-bob', text: 'done', ts: 1, byAgent: true, agent: codex });
    store.dispatch({ type: 'chat', id: 'c2', from: 'p-bob', text: 'hi', ts: 2, byAgent: false, agent: codex });
    store.dispatch({ type: 'chat', id: 'c3', from: 'p-bob', text: 'old', ts: 3, byAgent: true });
    const [a, b, c] = store.getState().log;
    expect(a).toMatchObject({ id: 'c1', agent: codex });
    expect(b).not.toHaveProperty('agent');
    expect(c).not.toHaveProperty('agent');
  });

  it('a run card keeps the agent from its events', () => {
    const store = new Store(initialState('room', 'ask'));
    const ev = { type: 'agent_event' as const, owner: 'p-mia', requestId: 'r1', requester: 'p-me', ts: 1 };
    store.dispatch({ ...ev, event: 'queued', text: '' });
    store.dispatch({ ...ev, event: 'started', text: '', agent: codex });
    store.dispatch({ ...ev, event: 'done', text: 'ok' });
    const card = store.getState().log.find((l) => l.type === 'agent');
    expect(card).toMatchObject({ status: 'done', agent: codex });
  });
});
