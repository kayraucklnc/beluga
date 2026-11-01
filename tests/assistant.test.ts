import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAC_TOOL_NAMES, createMacToolDefs } from '../src/agent/mac-tools.js';
import { decideTool } from '../src/agent/policy.js';
import type { AgentBackend, AgentRunInput, MacTools } from '../src/agent/types.js';
import { MacAssistant, listWork } from '../src/core/assistant/assistant.js';
import { AgentHost } from '../src/core/agent-host.js';
import { pretendSystem } from '../src/core/gateway/demo-system.js';
import { isSecretPath } from '../src/core/shares.js';
import { Body } from '../src/protocol.js';
import { Store, initialState } from '../src/core/store.js';
import { ASSISTANT_CHANNEL } from '../src/shared/assistant.js';
import { readInline } from '../src/shared/render/inline-model.js';
import { waitFor } from './helpers.js';

/**
 * "Your Mac" (BLG-47, core/assistant): one conversation for the whole Mac. Its Claude runs in its
 * own folder with its own session, gets its tools (a screenshot that becomes an output, device
 * info, starting work), and what it says is kept across restarts.
 */

const ME = 'me';
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-assistant-'));

function assistant(store = new Store(initialState('room', 'auto')), dir = tmp(), extra: Partial<ConstructorParameters<typeof MacAssistant>[0]> = {}) {
  const sys = pretendSystem();
  const a = new MacAssistant({ store, dir, selfId: () => ME, system: sys, ...extra });
  return { a, store, dir, sys };
}

afterEach(() => vi.unstubAllEnvs());

describe('Your Mac’s tools', () => {
  it('registers every tool under beluga_mac, and Beluga lets them run', () => {
    const defs = createMacToolDefs({} as MacTools);
    expect(defs.map((d) => `mcp__beluga_mac__${d.name}`)).toEqual(MAC_TOOL_NAMES);
    for (const name of MAC_TOOL_NAMES) expect(decideTool(name, {}, { cwd: '/tmp', roots: ['/tmp'], autoEdit: true })).toBe('allow');
  });

  it('a screenshot is saved in its scratch folder (one output) and comes back as an image for Claude', async () => {
    const { a, sys } = assistant();
    const shot = await a.tools().screenshot();
    expect(sys.ran.some((c) => c.startsWith('screencapture -x -t png -m'))).toBe(true);
    expect(shot.image?.mimeType).toBe('image/jpeg');
    expect(shot.image?.data.length).toBeGreaterThan(100);
    expect(shot.text).toMatch(/main display.*output/);
    const screens = path.join(a.workDir, '.beluga', 'scratch', 'screens');
    // Claude's smaller copy is gone: the picture is the one output.
    expect(readdirSync(screens)).toHaveLength(1);
    const outs = await a.outputs();
    expect(outs).toHaveLength(1);
    expect(outs[0]!.path).toMatch(/screens[\\/]screen-.*\.png$/);
    expect(outs[0]!.cwd).toBe(a.workDir);
  });

  it('a screenshot of one app’s window', async () => {
    const { a, sys } = assistant();
    const shot = await a.tools().screenshot('safari');
    expect(shot.text).toMatch(/Safari's window/);
    expect(sys.ran.some((c) => c.includes('-l4242'))).toBe(true);
  });

  it('device info is the gateway’s summary (no serial number)', async () => {
    const { a } = assistant();
    const info = await a.tools().deviceInfo();
    expect(info).toMatch(/MacBook Pro · Apple M4 Pro/);
    expect(info).not.toMatch(/C02SECRET/);
  });

  it('lists projects, worktrees with their ids, what runs, and starts a worktree by project name', async () => {
    const store = new Store(initialState('room', 'auto'));
    store.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'beluga', root: '/Users/k/beluga', base: 'main', workspaces: [{ id: 'wt-1', projectId: 'p1', projectRoot: '/Users/k/beluga', name: 'login', path: '/x', kind: 'worktree', branch: 'beluga/login', createdAt: 1, external: false }] }] as never });
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event: 'started', text: '', ts: 1, channel: 'ws:wt-1', itemId: 'i1' });
    expect(listWork(store)).toMatch(/beluga · \/Users\/k\/beluga[\s\S]*worktree "login" · id wt-1 · branch beluga\/login · agent working/);
    const started: unknown[] = [];
    const { a } = assistant(store, tmp(), {
      startWorktree: async (projectId, message, opts) => {
        started.push({ projectId, message, opts });
        return { id: 'wt-new', name: 'login-bug', branch: 'beluga/login-bug', base: 'origin/main' } as never;
      },
    });
    const said = await a.tools().startWorktree({ project: 'Beluga', message: 'Fix the login bug', plan: true });
    expect(started).toEqual([{ projectId: 'p1', message: 'Fix the login bug', opts: { plan: true } }]);
    expect(said).toMatch(/`worktree:wt-new`/);
    await expect(a.tools().startWorktree({ project: 'nope', message: 'x' })).rejects.toThrow(/no project called nope/);
  });

  it('archives a worktree by id or name, never a main folder or chat, and asks before stopping a working Claude (BLG-565)', async () => {
    const store = new Store(initialState('room', 'auto'));
    const ws = (id: string, name: string, kind: string, more: object = {}) => ({ id, projectId: 'p1', projectRoot: '/Users/k/beluga', name, path: `/x/${id}`, kind, createdAt: 1, external: false, ...more });
    store.dispatch({
      type: 'projects',
      projects: [{ id: 'p1', name: 'beluga', root: '/Users/k/beluga', base: 'main', workspaces: [ws('main-1', 'beluga', 'main'), ws('wt-1', 'login', 'worktree'), ws('wt-2', 'busy', 'worktree'), ws('wt-3', 'old', 'worktree', { archived: true })] }],
    } as never);
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event: 'started', text: '', ts: 1, channel: 'ws:wt-2', itemId: 'i1' });
    const archived: string[] = [];
    const { a } = assistant(store, tmp(), { archiveWorktree: async (id) => (archived.push(id), id !== 'wt-fail') });
    const tools = a.tools();
    expect(await tools.archiveWorktree({ worktree: 'wt-1' })).toMatch(/Archived the worktree "login" in beluga.*restored/);
    expect(await tools.archiveWorktree({ worktree: 'LOGIN' })).toMatch(/"login"/);
    await expect(tools.archiveWorktree({ worktree: 'main-1' })).rejects.toThrow(/main folder of beluga/);
    await expect(tools.archiveWorktree({ worktree: 'wt-3' })).rejects.toThrow(/already archived/);
    await expect(tools.archiveWorktree({ worktree: 'nope' })).rejects.toThrow(/no worktree nope.*list_work/);
    await expect(tools.archiveWorktree({ worktree: 'wt-2' })).rejects.toThrow(/still working.*ask the owner/);
    expect(archived).toEqual(['wt-1', 'wt-1']);
    expect(await tools.archiveWorktree({ worktree: 'wt-2', confirmed: true })).toMatch(/"busy"/);
    expect(archived).toEqual(['wt-1', 'wt-1', 'wt-2']);
    // Without the app it says so, and nothing is archived.
    await expect(assistant(store).a.tools().archiveWorktree({ worktree: 'wt-1' })).rejects.toThrow(/needs the Beluga app/);
  });

  it('when the archive fails it says so', async () => {
    const store = new Store(initialState('room', 'auto'));
    store.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'beluga', root: '/r', base: 'main', workspaces: [{ id: 'wt-1', projectId: 'p1', projectRoot: '/r', name: 'login', path: '/x', kind: 'worktree', createdAt: 1, external: false }] }] } as never);
    const { a } = assistant(store, tmp(), { archiveWorktree: async () => false });
    await expect(a.tools().archiveWorktree({ worktree: 'wt-1' })).rejects.toThrow(/Couldn't archive "login".*back in the sidebar/);
  });

  it('what it starts reads as links: worktree:, plan: and task: in its answer', () => {
    expect(readInline('worktree:wt-1a2b3c4d-5e6')).toEqual({ kind: 'worktree', id: 'wt-1a2b3c4d-5e6' });
    expect(readInline('plan:pl_0123456789ab')).toEqual({ kind: 'plan', id: 'pl_0123456789ab' });
    expect(readInline('task:blg-12')).toEqual({ kind: 'task', key: 'BLG-12' });
    expect(readInline('worktree:has spaces')).toBeUndefined();
  });
});

describe('Your Mac’s folder', () => {
  it('its work folder may go to the phone; its session and history stay secret', () => {
    vi.stubEnv('BELUGA_HOME', '/Users/k/.beluga');
    expect(isSecretPath('/Users/k/.beluga/assistant/work/.beluga/scratch/screens/screen.png')).toBe(false);
    expect(isSecretPath('/Users/k/.beluga/assistant/work/report.md')).toBe(false);
    expect(isSecretPath('/Users/k/.beluga/assistant/state.json')).toBe(true);
    expect(isSecretPath('/Users/k/.beluga/assistant/history.json')).toBe(true);
    expect(isSecretPath('/Users/k/.beluga/settings.json')).toBe(true);
    // Credentials are secret wherever they are.
    expect(isSecretPath('/Users/k/.beluga/assistant/work/.env')).toBe(true);
  });

  it('keeps its Claude session and its history across restarts', async () => {
    const dir = tmp();
    const first = assistant(undefined, dir);
    first.a.place().onSession('sess-1');
    first.store.dispatch({ type: 'chat', id: 'c1', from: ME, text: 'hello Mac', ts: 1, byAgent: false, channel: ASSISTANT_CHANNEL });
    await waitFor(() => existsSync(path.join(dir, 'chats', 'main', 'history.json')));
    first.a.stop();
    const again = assistant(undefined, dir);
    expect(again.a.place().resume).toBe('sess-1');
    expect(again.store.getState().log.filter((l) => l.channel === ASSISTANT_CHANNEL).map((l) => l.id)).toEqual(['c1']);
    again.a.forget();
    expect(again.a.place().resume).toBeUndefined();
    again.a.stop();
  });
});

describe('a run in Your Mac', () => {
  // Your messages to your own Claude are parsed on the way (session's loopback): a channel the
  // protocol refused meant the phone's and the Mac's messages here never reached Claude.
  it('its messages, requests and events are valid bodies', () => {
    const channel = ASSISTANT_CHANNEL;
    const parsed = (b: object) => (Body.parse(b) as { channel?: string }).channel;
    expect(parsed({ kind: 'agent_request', requestId: 'r0', prompt: 'hi', channel })).toBe(channel);
    expect(parsed({ kind: 'agent_event', requestId: 'r0', requester: ME, event: 'started', text: '', channel })).toBe(channel);
    expect(parsed({ kind: 'chat', text: 'hi', channel })).toBe(channel);
    expect(() => Body.parse({ kind: 'chat', text: 'hi', channel: 'mac:other' })).toThrow();
  });

  function host(mac: MacAssistant | undefined, store: Store) {
    const runs: AgentRunInput[] = [];
    const sent: Array<{ event?: string; text?: string }> = [];
    const agent: AgentBackend = {
      async run(input) {
        runs.push(input);
        return 'done';
      },
    };
    const h = new AgentHost({
      store,
      selfId: () => ME,
      send: (body) => {
        sent.push(body as never);
        return true;
      },
      agent: () => agent,
      shares: {} as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => false } as never,
      people: {} as never,
      questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
      toast: () => undefined,
      system: () => undefined,
      approvalTimeoutMs: () => 60_000,
      refreshUsage: async () => undefined,
      workspaces: { place: () => undefined, refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
      ...(mac ? { assistant: (channel: string, from: string) => mac.forRun(channel, from) ?? mac.forChat(channel, from) } : {}),
    });
    return { h, runs, sent };
  }

  it('runs in its own folder with its tools and brief, as your own Claude', async () => {
    const { a, store } = assistant();
    const { h, runs } = host(a, store);
    await h.onAgentRequest(ME, { kind: 'agent_request', requestId: 'r1', prompt: 'screenshot please', viaAgent: false, channel: ASSISTANT_CHANNEL, urgent: false, plan: false });
    await waitFor(() => runs.length === 1);
    expect(runs[0]!.place?.cwd).toBe(a.workDir);
    expect(runs[0]!.place?.askOnly).toBeUndefined();
    expect(runs[0]!.macTools?.screenshot).toBeTypeOf('function');
    expect(runs[0]!.macBrief).toMatch(/Your Mac/);
    expect(runs[0]!.scope).toBe('full');
  });

  it('nobody else can ask it', async () => {
    const { a, store } = assistant();
    const { h, runs } = host(a, store);
    await h.onAgentRequest('bob', { kind: 'agent_request', requestId: 'r2', prompt: 'hi', viaAgent: false, channel: ASSISTANT_CHANNEL, urgent: false, plan: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toHaveLength(0);
    expect(a.forRun(ASSISTANT_CHANNEL, 'bob')).toBeUndefined();
  });

  it('your own ask in a friends’ chat is a real turn in its folder, with its tools, and its answer comes back (BLG-207)', async () => {
    const { a, store } = assistant();
    const { h, runs } = host(a, store);
    const channel = 'dm:bob-peer-0000000000000000000000001';
    const answer = await h.runChat(channel, 'ask bob for the log');
    expect(answer).toBe('done');
    expect(runs[0]).toMatchObject({ channel, scope: 'full', prompt: 'ask bob for the log' });
    expect(runs[0]!.place?.cwd).toBe(a.workDir);
    expect(runs[0]!.place?.resume).toBeUndefined();
    expect(runs[0]!.macBrief).toMatch(/Beluga chat with friends/);
    expect(Body.parse({ kind: 'agent_event', requestId: 'r0', requester: ME, event: 'done', text: '', channel })).toMatchObject({ channel });
    // Nobody else gets a turn with tools there.
    expect(a.forChat(channel, 'bob')).toBeUndefined();
    expect(a.forChat('ws:abc', ME)).toBeUndefined();
  });

  it('without the Beluga app it says so', async () => {
    const store = new Store(initialState('room', 'auto'));
    const { h, runs, sent } = host(undefined, store);
    await h.onAgentRequest(ME, { kind: 'agent_request', requestId: 'r3', prompt: 'hi', viaAgent: false, channel: ASSISTANT_CHANNEL, urgent: false, plan: false });
    await waitFor(() => sent.some((b) => b.event === 'error'));
    expect(runs).toHaveLength(0);
    expect(sent.find((b) => b.event === 'error')?.text).toMatch(/needs the Beluga app/);
  });
});
