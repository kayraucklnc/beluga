import { mkdtempSync, realpathSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput, RoomBridge } from '../src/agent/types.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState, type AppState, type Policy } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { waitFor } from './helpers.js';

const keys = deriveKeys(generateSecret());
let hub: Hub;
const sessions: Session[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  await hub?.close();
});

type Script = (input: AgentRunInput, bridge: RoomBridge) => Promise<string>;

interface Peer {
  session: Session;
  state: () => AppState;
  runs: AgentRunInput[];
  bridge: RoomBridge;
  root: string;
  quit: { called: boolean };
  toasts: string[];
  copied: string[];
}

function peer(name: string, opts: { policy?: Policy; script?: Script; agent?: boolean; files?: Record<string, string> } = {}): Peer {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `klaude-${name}-`)));
  for (const [file, content] of Object.entries(opts.files ?? {})) writeFileSync(path.join(root, file), content);
  const shares = new ShareService([{ name: 'proj', root, writable: true }]);
  const store = new Store(initialState('test', opts.policy ?? 'ask'));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name, shares: shares.infos, agent: opts.agent !== false }, reconnect: false });
  const runs: AgentRunInput[] = [];
  let bridge!: RoomBridge;
  const quit = { called: false };
  const toasts: string[] = [];
  const copied: string[] = [];
  let lastToast: unknown;
  store.subscribe(() => {
    const t = store.getState().toast;
    if (t && t !== lastToast) toasts.push(t.text);
    lastToast = t;
  });
  const session = new Session({
    zoom: async (dir) => ({ ok: true, message: `zoom ${dir}` }),
    copy: async (text) => {
      if (text.includes('FAIL')) throw new Error('no clipboard');
      copied.push(text);
    },
    client,
    store,
    shares,
    agentCwd: root,
    requestTimeoutMs: 2000,
    agentTimeoutMs: 2000,
    onQuit: () => (quit.called = true),
    downloadDir: path.join(root, 'downloads'),
    createAgent:
      opts.agent === false
        ? undefined
        : (b): AgentBackend => {
            bridge = b;
            return {
              run: async (input) => {
                runs.push(input);
                return opts.script ? opts.script(input, b) : `echo: ${input.prompt}`;
              },
            };
          },
  });
  session.start();
  sessions.push(session);
  return { session, state: store.getState, runs, get bridge() { return bridge; }, root, quit, toasts, copied };
}

const agentItems = (s: AppState) => s.log.filter((l) => l.type === 'agent');
const systemText = (s: AppState) => s.log.filter((l) => l.type === 'system').map((l) => (l.type === 'system' ? l.text : ''));

async function room(...peers: Peer[]): Promise<void> {
  await waitFor(() => peers.every((p) => p.state().peers.length === peers.length && p.state().self));
}

describe('Session', () => {
  it('chats and runs your own agent with @claude', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    kay.session.submit('hi bob');
    await waitFor(() => bob.state().log.some((l) => l.type === 'chat' && l.text === 'hi bob'));

    kay.session.submit('@claude summarize');
    await waitFor(() => agentItems(bob.state()).some((a) => a.type === 'agent' && a.status === 'done'));
    expect(agentItems(bob.state())[0]).toMatchObject({ ownerName: 'kay', requesterName: 'kay', text: 'echo: summarize' });
    expect(kay.runs[0]?.context).toContain('kay: hi bob');
  });

  it("asks the owner before running a friend's request, and honours 'always'", async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);

    kay.session.submit('@claude:bob check the api');
    await waitFor(() => bob.state().approvals.length === 1);
    expect(agentItems(kay.state())[0]).toMatchObject({ status: 'awaiting_approval' });
    expect(bob.session.answerApproval('always')).toBe(true);
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'done'));
    expect(bob.runs[0]?.requesterName).toBe('kay');
    expect(bob.state().trusted).toContain(kay.session.selfId);

    kay.session.submit('@claude:bob again');
    await waitFor(() => bob.runs.length === 2);
    expect(bob.state().approvals).toHaveLength(0);
  });

  it('reports declined and denied requests', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    const cat = peer('cat', { policy: 'deny' });
    const dan = peer('dan', { agent: false });
    await room(kay, bob, cat, dan);

    kay.session.submit('@claude:bob do it');
    await waitFor(() => bob.state().approvals.length === 1);
    bob.session.answerApproval('no');
    kay.session.submit('@claude:cat do it');
    kay.session.submit('@claude:dan do it');
    kay.session.submit('@claude:zed do it');
    await waitFor(() => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.status === 'denied').length === 3);
    expect(kay.toasts).toContain('Nobody named "zed" is here');
    expect(bob.runs).toHaveLength(0);
    expect(bob.session.answerApproval('yes')).toBe(false);
  });

  it('runs every agent with @claudes when policy is auto', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', { policy: 'auto' });
    const bob = peer('bob', { policy: 'auto' });
    await room(kay, bob);
    bob.session.submit('@claudes status?');
    await waitFor(() => kay.runs.length === 1 && bob.runs.length === 1);
    await waitFor(() => agentItems(bob.state()).filter((a) => a.type === 'agent' && a.status === 'done').length === 2);
  });

  it('streams agent text/tool events and approves tool use', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: async (input) => {
        input.onEvent('tool', 'Bash ls');
        const ok = await input.canUseTool('Bash', { command: 'ls' });
        input.onEvent('text', ok ? 'allowed' : 'blocked');
        const again = await input.canUseTool('Bash', { command: 'pwd' });
        return again ? 'finished' : 'nope';
      },
    });
    await room(kay);
    kay.session.submit('@claude list files');
    await waitFor(() => kay.state().approvals[0]?.kind === 'tool');
    expect(kay.state().approvals[0]?.detail).toBe('ls');
    kay.session.answerApproval('always');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'done'));
    expect(agentItems(kay.state())[0]).toMatchObject({ text: 'finished', steps: ['Bash ls'] });
  });

  it('surfaces agent failures and stop requests', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: (input) =>
        input.prompt === 'crash'
          ? Promise.reject(new Error('kaboom'))
          : new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    await room(kay);
    kay.session.submit('@claude crash');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'error' && a.text === 'kaboom'));
    kay.session.submit('@claude hang');
    await waitFor(() => kay.runs.length === 2);
    kay.session.submit(':stop');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.text === 'Stopped by owner'));
    kay.session.submit(':stop');
    expect(kay.toasts).toContain('Your Claude is not running anything');
  });

  it("browses and reads a friend's shared folder, live-reloading on change", async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob', { files: { 'README.md': 'v1', '.env': 'SECRET' } });
    await room(kay, bob);

    const bobRow = kay.state().browser.rows.findIndex((r) => r.label === 'bob:proj');
    kay.session.store.dispatch({ type: 'browser_cursor', delta: bobRow });
    await kay.session.browserEnter();
    expect(kay.state().browser.rows.map((r) => r.label)).toEqual(['..', 'README.md']);
    kay.session.store.dispatch({ type: 'browser_cursor', delta: 1 });
    await kay.session.browserEnter();
    expect(kay.state().viewer).toMatchObject({ content: 'v1', path: 'README.md' });
    await waitFor(() => bob.state().focus[kay.session.selfId]?.path === 'README.md');

    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(path.join(bob.root, 'README.md'), 'v2');
    await waitFor(() => kay.state().viewer?.content === 'v2', 5000);

    kay.session.submit(`:open bob:proj/.env`);
    await waitFor(() => kay.state().viewer?.error === 'That file is private');
    kay.session.submit(':open bob:proj/missing.md');
    await waitFor(() => kay.state().viewer?.error?.includes('ENOENT'));
    kay.session.submit(':open nope');
    expect(kay.toasts.some((t) => t.includes("Can't open"))).toBe(true);

    await kay.session.loadDir({ owner: bob.session.selfId, share: 'proj', path: '' });
    expect(kay.state().dirCache[`${bob.session.selfId}:proj/`]?.map((e) => e.name)).toEqual(['README.md']);
    await kay.session.loadDir({ owner: bob.session.selfId, share: 'proj', path: 'nope' }); // errors are ignored

    kay.session.store.dispatch({ type: 'browser_cursor', delta: -10 });
    await kay.session.browserEnter(); // '..' goes back to root
    expect(kay.state().browser.at).toBeUndefined();
    await kay.session.browseTo({ owner: bob.session.selfId, share: 'nope', path: '' });
    expect(kay.state().browser.error).toMatch(/No share/);
  });

  it('follows a friend and their agent like Google Docs', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob', {
      files: { 'a.md': 'A', 'b.md': 'B' },
      policy: 'auto',
      script: async (_input, bridge) => {
        const where = await bridge.writeReport('Audit Results', 'all good');
        return where;
      },
    });
    await room(kay, bob);
    await bob.session.openLocation({ owner: bob.session.selfId, share: 'proj', path: 'a.md' });
    kay.session.submit(':follow bob');
    await waitFor(() => kay.state().viewer?.content === 'A');
    expect(kay.state().viewer?.by).toBe('bob');

    await bob.session.openLocation({ owner: bob.session.selfId, share: 'proj', path: 'b.md' });
    await waitFor(() => kay.state().viewer?.content === 'B');

    kay.session.submit('@claude:bob audit');
    await waitFor(() => kay.state().viewer?.path.startsWith('.klaude/reports/') && kay.state().viewer?.content.includes('all good'));
    expect(kay.state().viewer?.by).toBe("bob's Claude");
    const reports = readdirSync(path.join(bob.root, '.klaude', 'reports'));
    expect(readFileSync(path.join(bob.root, '.klaude', 'reports', reports[0]!), 'utf8')).toBe('# Audit Results\n\nall good');
    expect(systemText(kay.state()).some((t) => t.includes("bob's Claude wrote a report. Open it with /open bob:proj/.klaude/reports/"))).toBe(true);

    kay.session.submit(':unfollow');
    expect(kay.state().follow).toBeUndefined();
    kay.session.submit('/follow zed');
    expect(kay.toasts).toContain('Nobody named "zed" is here');
  });

  it('lets agents talk to each other and browse peers through the bridge', async () => {
    hub = await startHub({ keys });
    const bob = peer('bob', { policy: 'auto', files: { 'notes.txt': 'bob notes' } });
    const nop = peer('nop', { agent: false });
    const kay = peer('kay', {
      script: async (_input, bridge) => {
        const peers = bridge.listPeers().map((p) => p.name).sort();
        const files = await bridge.listPeerFiles('bob', 'proj', '');
        const notes = await bridge.readPeerFile('bob', 'proj', 'notes.txt');
        const answer = await bridge.askAgent('bob', 'what do you think?');
        bridge.sendChat('agent says hi');
        await expect(bridge.askAgent('nop', 'x')).rejects.toThrow(/no agent/);
        await expect(bridge.readPeerFile('zed', 'proj', 'x')).rejects.toThrow(/No peer/);
        return JSON.stringify({ me: bridge.selfName(), peers, files: files.map((f) => f.name), notes, answer });
      },
    });
    await room(kay, bob, nop);
    kay.session.submit('@claude coordinate');
    const done = await waitFor(() => agentItems(kay.state()).find((a) => a.type === 'agent' && a.owner === kay.session.selfId && a.status === 'done'));
    expect(JSON.parse(done.type === 'agent' ? done.text : '')).toEqual({
      me: 'kay',
      peers: ['bob', 'kay', 'nop'],
      files: ['notes.txt'],
      notes: 'bob notes',
      answer: 'echo: what do you think?',
    });
    expect(bob.runs[0]).toMatchObject({ viaAgent: true, requesterName: 'kay' });
    await waitFor(() => bob.state().log.some((l) => l.type === 'chat' && l.byAgent && l.name === "kay's Claude"));
  });

  it('runs slash commands (and legacy colon commands)', async () => {
    hub = await startHub({ keys, roomName: "kay's room" });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    expect(kay.state().room).toBe("kay's room");
    for (const cmd of ['/people', '/policy', '/policy auto', ':trust bob', '/untrust bob', '/trust', '/y', '/wat', '/open', '/close']) {
      kay.session.submit(cmd);
    }
    expect(systemText(kay.state()).some((t) => t.startsWith('kay (you) · claude on · shares proj'))).toBe(true);
    for (const t of [
      'Policy is "ask". Use /policy ask, auto or deny',
      "Friends' requests for your Claude: auto",
      "bob's requests are auto-approved",
      "bob's requests need approval again",
      'Usage: /trust <name>',
      'Nothing to approve',
      'Unknown command /wat. Type /help (or // to send a message starting with /)',
      'Usage: /open <name>:<folder>/<file>',
    ]) {
      expect(kay.toasts).toContain(t);
    }
    expect(kay.state().policy).toBe('auto');
    kay.session.submit('/help');
    expect(kay.state().overlay).toBe('help');
    kay.session.submit('//not a command');
    await waitFor(() => bob.state().log.some((l) => l.type === 'chat' && l.text === '/not a command'));
    kay.session.submit('/clear');
    expect(kay.state().log).toHaveLength(0);
    kay.session.submit('/quit');
    expect(kay.quit.called).toBe(true);
  });

  it('copies the invite and the last Claude answer', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    await room(kay);
    kay.session.submit('/invite');
    await waitFor(() => kay.toasts.includes('No invite link available'));
    kay.session.store.dispatch({ type: 'hosting', hosting: { phase: 'tunnel' } });
    kay.session.submit('/invite');
    await waitFor(() => kay.toasts.includes('The invite link is still being created…'));
    kay.session.store.dispatch({ type: 'invite', invite: 'https://x.trycloudflare.com#abcdefghijklmnopqrstuvwx' });
    kay.session.submit('/invite');
    await waitFor(() => kay.copied.length === 1);
    expect(kay.copied[0]).toBe('klaude join https://x.trycloudflare.com#abcdefghijklmnopqrstuvwx');
    expect(kay.toasts).toContain('Invite copied. Paste it to a friend');

    kay.session.submit('/copy');
    await waitFor(() => kay.toasts.includes('No Claude answer to copy yet'));
    kay.session.submit('@claude hello');
    await waitFor(() => agentItems(kay.state()).some((a) => a.type === 'agent' && a.status === 'done'));
    kay.session.submit('/copy');
    await waitFor(() => kay.copied.includes('echo: hello'));

    kay.session.store.dispatch({ type: 'invite', invite: 'FAIL' });
    await kay.session.copyInvite(); // clipboard unavailable -> shown in chat instead
    expect(kay.toasts.at(-1)).toBe('Could not reach the clipboard. Copy it from the chat instead');
  });
});

describe('Session hardening', () => {
  it(':stop cancels queued runs and pending tool approvals', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay', {
      script: async (input) => {
        await input.canUseTool('Bash', { command: 'sleep 100' });
        return 'should not matter';
      },
    });
    await room(kay);
    kay.session.submit('@claude first');
    kay.session.submit('@claude second');
    await waitFor(() => kay.state().approvals.length === 1);
    kay.session.stopAgent();
    await waitFor(() => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.status === 'error').length === 2);
    expect(kay.state().approvals).toHaveLength(0);
    expect(kay.runs).toHaveLength(1);
    expect(agentItems(kay.state()).map((a) => (a.type === 'agent' ? a.text : ''))).toContain('Cancelled by owner');
  });

  it('scopes "always" tool approval to one requester', async () => {
    hub = await startHub({ keys });
    const bob = peer('bob', {
      policy: 'auto',
      script: async (input) => ((await input.canUseTool('Bash', { command: 'ls' })) ? 'ran' : 'blocked'),
    });
    const kay = peer('kay');
    const cat = peer('cat');
    await room(bob, kay, cat);
    kay.session.submit('@claude:bob go');
    await waitFor(() => bob.state().approvals.length === 1);
    bob.session.answerApproval('always');
    await waitFor(() => bob.runs.length === 1 && bob.state().approvals.length === 0);
    kay.session.submit('@claude:bob again');
    await waitFor(() => agentItems(kay.state()).filter((a) => a.type === 'agent' && a.status === 'done').length === 2);
    expect(bob.state().approvals).toHaveLength(0);
    cat.session.submit('@claude:bob me too');
    await waitFor(() => bob.state().approvals.length === 1); // cat still needs approval
    bob.session.answerApproval('no');
  });

  it('builds agent context from its own chat log, not the requester', async () => {
    hub = await startHub({ keys });
    const bob = peer('bob', { policy: 'auto' });
    const kay = peer('kay');
    await room(bob, kay);
    kay.session.submit('the plan is X');
    await waitFor(() => bob.state().log.some((l) => l.type === 'chat'));
    kay.session.submit('@claude:bob thoughts?');
    await waitFor(() => bob.runs.length === 1);
    expect(bob.runs[0]?.context).toEqual(['kay: the plan is X', 'kay: @claude:bob thoughts?']);
  });

  it('downloads a file from a friend in encrypted chunks and tells the owner', async () => {
    hub = await startHub({ keys });
    const big = Buffer.alloc(600 * 1024, 7); // spans 3 chunks
    const kay = peer('kay');
    const bob = peer('bob', { files: { 'notes.md': 'hi from bob' } });
    writeFileSync(path.join(bob.root, 'blob.bin'), big);
    await room(kay, bob);
    const saved = await kay.session.download({ owner: bob.session.selfId, share: 'proj', path: 'blob.bin' });
    expect(saved).toBe(path.join(kay.root, 'downloads', 'bob', 'blob.bin'));
    expect(readFileSync(saved!).equals(big)).toBe(true);
    await waitFor(() => systemText(bob.state()).some((t) => t === 'kay is downloading proj/blob.bin'));
    expect(kay.toasts).toContain('Downloaded blob.bin');

    kay.session.submit('/get bob:proj/notes.md');
    await waitFor(() => kay.toasts.includes('Downloaded notes.md'));
    expect(await kay.session.download({ owner: bob.session.selfId, share: 'proj', path: '.env' })).toBeUndefined();
    expect(kay.toasts.at(-1)).toMatch(/Download failed/);
    expect(await kay.session.download({ owner: bob.session.selfId, share: 'proj', path: '' })).toBeUndefined();
    kay.session.submit('/get nope');
    kay.session.submit('/get');
    expect(kay.toasts).toContain('Usage: /get <name>:<folder>/<file>');
  });

  it('lets you keep your Claude private', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await room(kay, bob);
    bob.session.setClaudeSharing('deny');
    await waitFor(() => kay.state().peers.find((p) => p.name === 'bob')?.agent === false);
    expect(bob.state().policy).toBe('deny');
    bob.session.submit('/policy ask');
    await waitFor(() => kay.state().peers.find((p) => p.name === 'bob')?.agent === true);
  });

  it("runs friends' requests with their access level and shares plan usage", async () => {
    hub = await startHub({ keys });
    const bob = peer('bob', {
      policy: 'auto',
      script: async (_input, bridge) => {
        bridge.reportUsage({ fiveHour: { pct: 42 } });
        return 'ok';
      },
    });
    const kay = peer('kay');
    await room(bob, kay);
    kay.session.submit('@claude:bob hi');
    await waitFor(() => bob.runs.length === 1);
    expect(bob.runs[0]?.scope).toBe('folder');
    await waitFor(() => kay.state().peers.find((p) => p.name === 'bob')?.usage?.fiveHour?.pct === 42);

    bob.session.setAccess(kay.session.selfId, 'full');
    kay.session.submit('@claude:bob again');
    await waitFor(() => bob.runs.length === 2);
    expect(bob.runs[1]?.scope).toBe('full');
    bob.session.submit('@claude mine');
    await waitFor(() => bob.runs.length === 3);
    expect(bob.runs[2]?.scope).toBe('full'); // your own requests always have full reach
  });

  it('shows the access level in approval prompts', async () => {
    hub = await startHub({ keys });
    const bob = peer('bob');
    const kay = peer('kay');
    await room(bob, kay);
    kay.session.submit('@claude:bob look around');
    await waitFor(() => bob.state().approvals.length === 1);
    expect(bob.state().approvals[0]?.title).toBe('kay wants your Claude to run this (shared folders only)');
    bob.session.answerApproval('no');
  });

  it('renames and remembers settings changes', async () => {
    hub = await startHub({ keys });
    const saved: object[] = [];
    const kay = peer('kay');
    (kay.session as unknown as { opts: { saveSettings: (p: object) => void } }).opts.saveSettings = (p) => void saved.push(p);
    const bob = peer('bob');
    await room(kay, bob);
    kay.session.submit('/name kayra');
    await waitFor(() => bob.state().peers.some((p) => p.name === 'kayra'));
    kay.session.submit('/name !!!');
    expect(kay.toasts).toContain('Usage: /name <new name> (letters, numbers, . - _)');
    kay.session.submit('/theme mono');
    expect(kay.state().prefs.theme).toBe('mono');
    kay.session.submit('/theme neon');
    expect(kay.toasts).toContain('Themes: calm, light, contrast, mono');
    kay.session.setClaudeSharing('auto');
    expect(saved).toEqual([{ name: 'kayra' }, { theme: 'mono' }, { policy: 'auto' }]);
    kay.session.submit('/settings');
    expect(kay.state().overlay).toBe('settings');
  });

  it('changes text size via /zoom', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    await room(kay);
    kay.session.submit('/zoom in');
    kay.session.submit('/zoom smaller');
    kay.session.submit('/zoom reset');
    await waitFor(() => kay.toasts.includes('zoom reset'));
    expect(kay.toasts).toEqual(expect.arrayContaining(['zoom in', 'zoom out', 'zoom reset']));
  });
});
