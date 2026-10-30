import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskRequest, TaskResult } from '../../src/core/gateway/protocol.js';
import { describeForClaude } from '../../src/core/gateway/result.js';
import { ShareService } from '../../src/core/shares.js';
import { Store, initialState } from '../../src/core/store.js';
import { WorkspaceSharing } from '../../src/core/workspace-sharing.js';
import { type AgentRef, AgentRequestBody, WsInviteBody, WsRequestBody } from '../../src/protocol.js';
import { placeAgent } from '../../src/shared/agent-picker.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { node, task } from './helpers.js';

/** BLG-448: work on someone else's Mac carries and shows the agent that actually runs there: theirs. */

const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5-codex' };
const CLAUDE: AgentRef = { runtime: 'claude', label: 'Claude' };

describe('the agent of a place', () => {
  it("is the place's own pick, else the owner's default, with the place's model", () => {
    expect(placeAgent({ agent: { runtime: 'codex', label: 'Codex' }, model: 'gpt-5' }, CLAUDE)).toEqual({ runtime: 'codex', label: 'Codex', model: 'gpt-5' });
    expect(placeAgent({ model: 'opus' }, CLAUDE)).toEqual({ runtime: 'claude', label: 'Claude', model: 'opus' });
    expect(placeAgent({}, CODEX)).toEqual(CODEX);
    expect(placeAgent({ agent: { runtime: 'claude', label: 'Claude' } }, CODEX)).toEqual(CLAUDE);
  });
});

describe('a joined worktree', () => {
  it("keeps the owner's agent from the invite, so its header and messages name it", () => {
    const store = new Store(initialState('room'));
    store.dispatch({ type: 'identity', selfId: 'me', isHost: false });
    const sharing = new WorkspaceSharing({ store, selfId: () => 'me', send: () => true, shares: new ShareService([]), toast: () => undefined, intend: () => undefined });
    const body = WsInviteBody.parse({ kind: 'ws_invite', ws: { id: 'w1', name: 'api', project: 'landing', agent: CODEX }, role: 'contribute', share: 'ws-w1', history: [] });
    sharing.onInvite('bob', body);
    expect(store.getState().shared.find((w) => w.id === 'w1')?.agent).toEqual(CODEX);
    // An older Mac sends none: it runs Claude.
    sharing.onInvite('bob', WsInviteBody.parse({ ...body, ws: { id: 'w2', name: 'web', project: 'landing' } }));
    expect(store.getState().shared.find((w) => w.id === 'w2')?.agent).toBeUndefined();
  });
});

describe('the requester never picks the runtime on a peer’s machine', () => {
  it('drops any agent or runtime a request names, before it reaches the owner', () => {
    const named = { agent: CODEX, runtime: 'codex', model: 'gpt-5' };
    expect(AgentRequestBody.parse({ kind: 'agent_request', requestId: 'r1', prompt: 'hi', channel: 'room', ...named })).not.toHaveProperty('agent');
    expect(AgentRequestBody.parse({ kind: 'agent_request', requestId: 'r1', prompt: 'hi', channel: 'room', ...named })).not.toHaveProperty('runtime');
    expect(WsRequestBody.parse({ kind: 'ws_request', reqId: 'q1', project: 'landing', task: 'fix it', ...named })).not.toHaveProperty('agent');
    const req = TaskRequest.parse({ t: 'task_request', id: 't_aaaaaaaaaaaa', from: 'kay0000000', to: 'bob0000000', kind: 'ask', ask: 'hi', ts: 1, ...named });
    expect(req).not.toHaveProperty('agent');
    expect(req).not.toHaveProperty('runtime');
    expect(req).not.toHaveProperty('model');
  });
});

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

describe("a friend's answer", () => {
  it('records which of their agents produced it, shown to the asker', async () => {
    const kay = await node(net, 'kay');
    const bob = await node(net, 'bob');
    await befriend(kay.person, bob.person);
    // Bob answers with Codex; kay's own agent is Claude, and that changes nothing on bob's Mac.
    bob.store.dispatch({ type: 'welcome', self: { peerId: bob.id, name: 'bob', shares: [], agent: true, defaultAgent: CODEX } });
    kay.store.dispatch({ type: 'welcome', self: { peerId: kay.id, name: 'kay', shares: [], agent: true, defaultAgent: CLAUDE } });
    bob.trust(kay.id, 'full');
    kay.trust(bob.id, 'trusted');
    const t = kay.gw.ask({ person: 'bob', ask: 'what time is it', by: 'agent', conversation: 'ws:abc' });
    await settle(() => task(kay, t.id)?.state === 'done');
    expect(task(kay, t.id)?.result?.agent).toEqual(CODEX);
    expect(task(bob, t.id)?.result?.agent).toEqual(CODEX);
    expect(describeForClaude(task(kay, t.id)!)).toContain("answered by: bob's Codex (GPT-5-codex)");
    // An older Mac's result has none.
    expect(TaskResult.parse({ t: 'task_result', id: 't_aaaaaaaaaaaa', status: 'done', summary: 'ok', ts: 1 }).agent).toBeUndefined();
  }, 30_000);
});
