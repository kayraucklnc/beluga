import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CAPABILITIES } from '../src/agent/runtime/claude/index.js';
import { CODEX_CAPABILITIES } from '../src/agent/runtime/codex/index.js';
import { routeSideCall } from '../src/agent/runtime/router.js';
import { type AgentRuntime, CompletionError, type CompletionRequest, type RuntimeStatus } from '../src/agent/runtime/types.js';
import { sideCalls } from '../src/agent/side-calls.js';
import type { AgentBackend } from '../src/agent/types.js';
import { MacAssistant } from '../src/core/assistant/assistant.js';
import { agentForAsk } from '../src/core/gateway/serve.js';
import { detectNotices } from '../src/core/notify.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { type Action, type DomainState, Store, initialState, reduce } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { PeerClient } from '../src/net/peer-client.js';
import type { AgentRef, PeerInfo } from '../src/protocol.js';
import { classifyRun } from '../src/shared/run-failure.js';

/** BLG-503: work outside a conversation runs on the agent it says, and names the one that ran. */

const CLAUDE: AgentRef = { runtime: 'claude', label: 'Claude' };
const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5-codex' };
const LOCAL: AgentRef = { runtime: 'local', label: 'Local model', model: 'ollama/qwen3' };

const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-outside-')));

/** A runtime whose one-shot call answers from a script, and keeps every request. */
function fake(id: string, answer: (req: CompletionRequest) => string | Error, status?: RuntimeStatus['state']) {
  const asked: CompletionRequest[] = [];
  const complete = async (req: CompletionRequest): Promise<string> => {
    asked.push(req);
    const said = answer(req);
    if (said instanceof Error) throw said;
    return said;
  };
  const rt: AgentRuntime = {
    id,
    label: id,
    capabilities: id === 'codex' ? CODEX_CAPABILITIES : CLAUDE_CAPABILITIES,
    create: (opts) => ({ run: async () => `${id} ran`, ...sideCalls(complete, opts.cwd, opts.model) }) as AgentBackend,
    complete,
    ...(status ? { status: async () => ({ state: status, models: [] }) } : {}),
  };
  return { rt, asked };
}

function session(runtimes: readonly AgentRuntime[]) {
  const store = new Store(initialState('room'));
  const root = tmp();
  const client = new PeerClient({ url: 'ws://127.0.0.1:1', keys: deriveKeys(generateSecret()), profile: { name: 'kay', shares: [], agent: true } });
  const s = new Session({
    client,
    store,
    shares: new ShareService([]),
    agentCwd: root,
    runtime: { runtimes: (id = 'claude') => runtimes.find((r) => r.id === id), options: { cwd: root, autoEdit: false, additionalDirectories: [] } },
  });
  const pick = (agent: AgentRef): void => store.dispatch({ type: 'prefs', prefs: { defaultAgent: agent } });
  return { s, store, pick };
}

const named = (req: CompletionRequest): string => (req.system.includes('worktrees') ? 'Fix Login Redirect' : 'nothing');

describe('routeSideCall', () => {
  const claude = fake('claude', () => 'claude-name');
  const claudeBackend = sideCalls(claude.rt.complete, '/c');

  it('runs on your agent, then on Claude only when it failed, else the plain answer', async () => {
    const ok = fake('codex', named);
    expect(await routeSideCall({ own: { complete: ok.rt.complete, cwd: '/r' }, claude: () => claudeBackend }, (on) => on.nameTask?.('x'), 'plain')).toBe('fix-login-redirect');
    const broken = fake('codex', () => new CompletionError('failed'));
    claude.asked.length = 0;
    expect(await routeSideCall({ own: { complete: broken.rt.complete, cwd: '/r' }, claude: () => claudeBackend }, (on) => on.nameTask?.('fix it'), 'plain')).toBe('claude-name');
    expect(claude.asked).toHaveLength(1);
    expect(await routeSideCall({ own: { complete: broken.rt.complete, cwd: '/r' } }, (on) => on.nameTask?.('fix it'), 'plain')).toBe('plain');
    expect(await routeSideCall({}, (on) => on.titlePlan?.('x'), 'plain')).toBe('plain');
  });
});

describe('side calls follow your default agent, decided per call', () => {
  it('Claude by default; Codex once picked; Claude when Codex fails', async () => {
    const claude = fake('claude', named);
    let codexWorks = true;
    const codex = fake('codex', (req) => (codexWorks ? named(req) : new CompletionError('failed')));
    const { s, pick } = session([claude.rt, codex.rt]);
    expect(await s.nameTask('please fix the login redirect')).toBe('fix-login-redirect');
    expect([claude.asked.length, codex.asked.length]).toEqual([1, 0]);
    pick(CODEX);
    expect(await s.nameTask('please fix the login redirect')).toBe('fix-login-redirect');
    expect([claude.asked.length, codex.asked.length]).toEqual([1, 1]);
    // 'haiku' is left for Codex to map to its small model (codex/complete.ts).
    expect(codex.asked[0]?.model).toBe('haiku');
    codexWorks = false;
    expect(await s.nameTask('please fix the login redirect')).toBe('fix-login-redirect');
    expect([claude.asked.length, codex.asked.length]).toEqual([2, 2]);
  });

  it("never sends a local model's side call to Claude unless Claude is signed in", async () => {
    const out = fake('claude', named, 'signed_out');
    const a = session([out.rt]);
    a.pick(LOCAL);
    expect(await a.s.nameTask('grow the cache')).toBe('grow-cache');
    expect(await a.s.titlePlan('x')).toBeUndefined();
    expect(out.asked).toHaveLength(0);
    const signedIn = fake('claude', named, 'ready');
    const b = session([signedIn.rt]);
    b.pick(LOCAL);
    expect(await b.s.nameTask('grow the cache')).toBe('fix-login-redirect');
    expect(signedIn.asked).toHaveLength(1);
  });

  it('answers a friends’ chat on your agent, named by the one that answered', async () => {
    const claude = fake('claude', () => 'from claude');
    let codexWorks = true;
    const codex = fake('codex', () => (codexWorks ? 'from codex' : new CompletionError('failed')));
    const { s, store, pick } = session([claude.rt, codex.rt]);
    store.dispatch({ type: 'prefs', prefs: { model: 'opus' } });
    pick(CODEX);
    const req = { system: 's', prompt: 'p', images: [], model: 'gpt-5-codex', signal: new AbortController().signal };
    expect(await s.answerChat(req)).toEqual({ text: 'from codex', agent: CODEX });
    codexWorks = false;
    expect(await s.answerChat(req)).toEqual({ text: 'from claude', agent: { ...CLAUDE, model: 'opus' } });
    // Claude got Settings' (Claude's) model, never Codex's.
    expect(claude.asked.at(-1)?.model).toBe('opus');
  });
});

describe('backendFor', () => {
  it('makes a local model’s backend (a dialogue with a local participant runs)', () => {
    const { s } = session([fake('claude', named).rt]);
    expect(s.backendFor('local')).toBeDefined();
    expect(s.backendFor('nope')).toBeUndefined();
  });
});

describe("a friend's ask on one of your agents", () => {
  const listed = [CODEX, CLAUDE, LOCAL];
  it('runs on the one they asked for when it runs here, else on your default and says so', () => {
    expect(agentForAsk(undefined, CODEX, listed)).toEqual({ agent: CODEX });
    expect(agentForAsk(CLAUDE, CODEX, listed, () => true)).toEqual({ agent: CLAUDE });
    expect(agentForAsk(CLAUDE, CODEX, listed)).toEqual({ agent: CODEX, note: 'Claude isn’t set up here, so Codex does it' });
    expect(agentForAsk({ runtime: 'gemini', label: 'Gemini' }, CODEX, listed, () => true).agent).toEqual(CODEX);
    expect(agentForAsk({ runtime: 'local', label: 'Local model' }, CODEX, listed, (a) => a.runtime === 'local')).toEqual({ agent: LOCAL });
  });
});

describe('Your Mac runs on your default agent', () => {
  it('puts it on the place, and resumes only a session of that same agent', () => {
    const store = new Store(initialState('room'));
    const a = new MacAssistant({ store, dir: tmp(), selfId: () => 'me' });
    const place = a.place();
    expect(place.agent).toEqual(CLAUDE);
    place.onSession('claude-session');
    expect(a.place().resume).toBe('claude-session');
    store.dispatch({ type: 'prefs', prefs: { defaultAgent: CODEX } });
    expect(a.place().agent).toEqual(CODEX);
    expect(a.place().resume).toBeUndefined();
    expect(a.forChat('dm:bob', 'me')?.place.agent).toEqual(CODEX);
    a.stop();
  });
});

describe('Codex usage limits', () => {
  const now = new Date(2026, 9, 31, 10, 0).getTime();
  it('read as usage_limit with the reset time', () => {
    const plus = "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:15 PM.";
    expect(classifyRun({ result: plus }, now)).toMatchObject({ kind: 'usage_limit', resetsAt: new Date(2026, 9, 31, 15, 15).getTime() });
    expect(classifyRun({ result: "You've hit your usage limit. Try again at Nov 2nd, 2026 9:05 AM." }, now).resetsAt).toBe(new Date(2026, 10, 2, 9, 5).getTime());
    expect(classifyRun({ result: "You've hit your usage limit. Try again in 2 hours 30 minutes." }, now).resetsAt).toBe(now + 150 * 60_000);
    expect(classifyRun({ result: 'Quota exceeded', errorInfo: 'usageLimitExceeded' }, now)).toMatchObject({ kind: 'usage_limit' });
  });
});

describe('notifications name the agent that ran', () => {
  const me: PeerInfo = { peerId: 'me', name: 'kay', agent: true, shares: [] };
  const apply = (s: DomainState, ...actions: Action[]): DomainState => actions.reduce(reduce, s);
  it("a question names the conversation's agent, not your default", () => {
    const s0 = apply(initialState('room'), { type: 'peers', peers: [me] }, { type: 'welcome', self: me }, { type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'me', event: 'started', text: '', ts: 1, channel: 'room', agent: CODEX });
    const s1 = apply(s0, { type: 'question_add', question: { qid: 'q1', requestId: 'r1', owner: 'me', channel: 'room', picked: {}, question: { kind: 'question', questions: [{ question: 'Which db?', header: '', options: [], multiSelect: false }] } } });
    expect(detectNotices(s0, s1)[0]?.title).toBe('Codex asks in your chat');
  });
});
