import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentBackend, RoomBridge } from '../agent/types.js';
import type { IncomingMessage, PeerClient } from '../net/peer-client.js';
import { type BodyInput, type BodyOf, type FsEntry, MAX_TEXT, type PeerInfo } from '../protocol.js';
import { parseInput, parseLocation } from './mentions.js';
import { type ShareService } from './shares.js';
import { type Location, type Store, peerName } from './store.js';
import { runCommand } from './commands.js';

export interface SessionOptions {
  readonly client: PeerClient;
  readonly store: Store;
  readonly shares: ShareService;
  /** Factory so the backend can receive this session's RoomBridge. */
  readonly createAgent?: (bridge: RoomBridge) => AgentBackend;
  readonly agentCwd: string;
  readonly requestTimeoutMs?: number;
  readonly agentTimeoutMs?: number;
  readonly onQuit?: () => void;
  /** Clipboard writer (injected so tests don't touch the real clipboard). */
  readonly copy?: (text: string) => Promise<unknown>;
}

/** In-flight requests remember who must answer, so other peers can't spoof responses. */
type Pending = { peer: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type AgentWaiter = { peer: string; resolve: (text: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const CONTEXT_LINES = 20;
const MAX_PENDING_APPROVALS = 20;
const SEEN_REQUESTS = 1000;
const FS_DEBOUNCE_MS = 250;
const DIR_CACHE_MS = 5_000;

export const dirKey = (at: Location): string => `${at.owner}:${at.share}/${at.path}`;

/** Glue between the network, local shares, the agent, and UI state. */
export class Session {
  readonly bridge: RoomBridge;
  private readonly agent?: AgentBackend;
  private readonly pending = new Map<string, Pending>();
  private readonly agentWaiters = new Map<string, AgentWaiter>();
  private readonly approvals = new Map<string, (answer: 'yes' | 'no' | 'always') => void>();
  private readonly alwaysTools = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private current?: AbortController;
  /** Bumped by :stop so queued runs are cancelled too. */
  private generation = 0;
  private readonly seenRequests: string[] = [];
  private readonly toolApprovals = new Set<string>();
  /** Final agent events that could not be sent while disconnected. */
  private outbox: Array<{ body: BodyInput; opts: { to?: string; keep?: boolean } }> = [];
  private readonly fsTimers = new Map<string, NodeJS.Timeout>();
  private readonly dirFetched = new Map<string, number>();

  constructor(private readonly opts: SessionOptions) {
    this.bridge = this.createBridge();
    this.agent = opts.createAgent?.(this.bridge);
    this.wire();
  }

  get store(): Store {
    return this.opts.store;
  }

  get selfId(): string {
    return this.opts.client.peerId;
  }

  get hasAgent(): boolean {
    return Boolean(this.agent);
  }

  start(): void {
    this.opts.shares.watch(
      (share, relPath) => this.queueFsChanged(share, relPath),
      (message) => this.system(message, 'warn'),
    );
    this.opts.client.connect();
  }

  async stop(): Promise<void> {
    this.current?.abort();
    this.opts.client.close();
    await this.opts.shares.close();
    for (const t of this.fsTimers.values()) clearTimeout(t);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Session closed'));
    }
    for (const w of this.agentWaiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('Session closed'));
    }
    this.pending.clear();
    this.agentWaiters.clear();
  }

  /** Coalesce bursts of file events (builds, git checkouts) into one message per file. */
  private queueFsChanged(share: string, relPath: string): void {
    const key = `${share}/${relPath}`;
    clearTimeout(this.fsTimers.get(key));
    this.fsTimers.set(
      key,
      setTimeout(() => {
        this.fsTimers.delete(key);
        this.send({ kind: 'fs_changed', share, path: relPath });
      }, FS_DEBOUNCE_MS),
    );
  }

  quit(): void {
    this.opts.onQuit?.();
  }

  // -------------------------------------------------------------------------
  // User actions
  // -------------------------------------------------------------------------

  submit(raw: string): void {
    const state = this.store.getState();
    const parsed = parseInput(raw, this.selfId, state.peers);
    switch (parsed.kind) {
      case 'empty':
        return;
      case 'command':
        runCommand(this, parsed.name, parsed.args);
        return;
      case 'chat':
        this.sendChat(parsed.text, false);
        return;
      case 'agent':
        this.sendChat(parsed.text, false);
        for (const name of parsed.unknown) this.toast(`Nobody named "${name}" is here`, 'warn');
        for (const target of parsed.targets) this.requestAgent(target, parsed.prompt, false);
        if (parsed.targets.length === 0 && parsed.unknown.length === 0) this.toast('No Claude is online', 'warn');
        return;
    }
  }

  system(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.store.dispatch({ type: 'system', text, level });
  }

  toast(text: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
    this.store.dispatch({ type: 'toast', text, level });
  }

  async copyInvite(): Promise<void> {
    const { invite, hosting } = this.store.getState();
    if (!invite) {
      this.toast(hosting && hosting.phase !== 'failed' ? 'The invite link is still being created…' : 'No invite link available', 'warn');
      return;
    }
    await this.copyOrShow(`klaude join ${invite}`, 'Invite copied. Paste it to a friend');
  }

  async copyLastAnswer(): Promise<void> {
    const last = [...this.store.getState().log].reverse().find((l) => l.type === 'agent' && l.status === 'done');
    if (!last || last.type !== 'agent') {
      this.toast('No Claude answer to copy yet', 'warn');
      return;
    }
    await this.copyOrShow(last.text, `Copied ${last.ownerName}'s Claude answer`);
  }

  private async copyOrShow(text: string, success: string): Promise<void> {
    try {
      await (this.opts.copy ?? (async () => { throw new Error('no clipboard'); }))(text);
      this.toast(success, 'success');
    } catch {
      this.system(text);
      this.toast('Could not reach the clipboard. Copy it from the chat instead', 'warn');
    }
  }

  sendChat(text: string, byAgent: boolean): void {
    if (!this.send({ kind: 'chat', text: text.slice(0, MAX_TEXT), byAgent }, { keep: true })) {
      this.toast('Not connected, so the message was not sent', 'error');
    }
  }

  /** Ask an agent (ours or a peer's) to do something. Returns the request id. */
  requestAgent(target: string, prompt: string, viaAgent: boolean): string {
    const requestId = randomUUID();
    this.send({ kind: 'agent_request', requestId, prompt: prompt.slice(0, MAX_TEXT), viaAgent }, { to: target });
    return requestId;
  }

  async openLocation(at: Location, opts: { by?: string; broadcast?: boolean } = {}): Promise<void> {
    this.store.dispatch({ type: 'viewer_open', at, by: opts.by });
    if (opts.broadcast !== false) {
      this.send({ kind: 'focus', owner: at.owner, share: at.share, path: at.path, actor: 'human' });
    }
    await this.loadViewer(at);
  }

  openSpec(spec: string): void {
    const loc = parseLocation(spec, this.store.getState().peers);
    if (!loc) {
      this.toast(`Can't open "${spec}". Use /open <name>:<folder>/<file>`, 'warn');
      return;
    }
    void this.openLocation(loc);
  }

  /** Fetch a directory for /open autocomplete (cached for a few seconds). */
  async loadDir(at: Location): Promise<void> {
    const key = dirKey(at);
    const last = this.dirFetched.get(key);
    if (last && Date.now() - last < DIR_CACHE_MS) return;
    this.dirFetched.set(key, Date.now());
    try {
      this.store.dispatch({ type: 'dir_cache', key, entries: await this.listFiles(at) });
    } catch {
      // Not a folder (yet): nothing to suggest.
    }
  }

  async browseTo(at: Location): Promise<void> {
    this.store.dispatch({ type: 'browser_loading', at });
    try {
      const entries = await this.listFiles(at);
      this.store.dispatch({ type: 'browser_entries', at, entries });
    } catch (err) {
      this.store.dispatch({ type: 'browser_error', error: errorText(err) });
    }
  }

  /** Activate the row under the cursor in the file browser. */
  async browserEnter(): Promise<void> {
    const { browser } = this.store.getState();
    const row = browser.rows[browser.cursor];
    if (!row) return;
    if (row.target === 'up') return this.browserUp();
    if (row.dir) return this.browseTo(row.target);
    return this.openLocation(row.target);
  }

  async browserUp(): Promise<void> {
    const at = this.store.getState().browser.at;
    if (!at) return;
    if (!at.path) {
      this.store.dispatch({ type: 'browser_root' });
      return;
    }
    await this.browseTo({ ...at, path: at.path.split('/').slice(0, -1).join('/') });
  }

  follow(name: string | undefined): void {
    if (!name) {
      this.store.dispatch({ type: 'follow', peerId: undefined });
      this.toast('Stopped following');
      return;
    }
    const peer = this.findPeer(name);
    if (!peer) return this.toast(`Nobody named "${name}" is here`, 'warn');
    this.store.dispatch({ type: 'follow', peerId: peer.peerId });
    this.toast(`Following ${peer.name} and their Claude. /unfollow to stop`, 'success');
    const state = this.store.getState();
    const latest = [state.focus[peer.peerId], state.focus[`${peer.peerId}:agent`]]
      .filter((f) => f !== undefined)
      .sort((a, b) => b.ts - a.ts)[0];
    if (latest) void this.openLocation(latest, { by: peer.name, broadcast: false });
  }

  answerApproval(answer: 'yes' | 'no' | 'always', id?: string): boolean {
    const target = id ?? this.store.getState().approvals[0]?.id;
    const resolve = target ? this.approvals.get(target) : undefined;
    if (!target || !resolve) return false;
    this.approvals.delete(target);
    this.store.dispatch({ type: 'approval_remove', id: target });
    resolve(answer);
    return true;
  }

  stopAgent(): void {
    if (!this.current) {
      this.toast('Your Claude is not running anything');
      return;
    }
    this.generation++;
    this.current.abort();
    for (const id of [...this.toolApprovals]) this.answerApproval('no', id);
    this.toast('Stopping your Claude (queued requests cancelled)', 'warn');
  }

  findPeer(name: string): PeerInfo | undefined {
    const lower = name.toLowerCase().replace(/^@/, '');
    return this.store.getState().peers.find((p) => p.name.toLowerCase() === lower);
  }

  // -------------------------------------------------------------------------
  // Networking
  // -------------------------------------------------------------------------

  send(body: BodyInput, opts: { to?: string; keep?: boolean } = {}): boolean {
    try {
      return this.opts.client.send(body, opts);
    } catch (err) {
      this.system(`Could not send ${body.kind}: ${errorText(err)}`, 'error');
      return false;
    }
  }

  private wire(): void {
    const { client, store } = this.opts;
    client.on('status', (status) => store.dispatch({ type: 'status', status }));
    client.on('welcome', (self, room) => {
      store.dispatch({ type: 'welcome', self });
      if (room) store.dispatch({ type: 'room', room });
      const queued = this.outbox;
      this.outbox = [];
      for (const item of queued) this.send(item.body, item.opts);
    });
    client.on('peers', (peers) => store.dispatch({ type: 'peers', peers }));
    client.on('error', (message) => this.system(message, 'error'));
    client.on('message', (msg) => {
      this.handle(msg).catch((err: unknown) => this.system(`Error handling ${msg.body.kind}: ${errorText(err)}`, 'error'));
    });
  }

  private async handle({ id, from, ts, body }: IncomingMessage): Promise<void> {
    switch (body.kind) {
      case 'chat':
        this.store.dispatch({ type: 'chat', id, from, text: body.text, ts, byAgent: body.byAgent });
        return;
      case 'focus':
        return this.onFocus(from, ts, body);
      case 'agent_request':
        return this.onAgentRequest(from, body);
      case 'agent_event':
        return this.onAgentEvent(from, ts, body);
      case 'fs_list':
        return this.reply(from, body.reqId, async () => ({ kind: 'fs_list_result', reqId: body.reqId, ok: true, entries: await this.opts.shares.list(body.share, body.path) }), 'fs_list_result');
      case 'fs_read':
        return this.reply(from, body.reqId, async () => ({ kind: 'fs_read_result', reqId: body.reqId, ok: true, ...(await this.opts.shares.read(body.share, body.path)) }), 'fs_read_result');
      case 'fs_list_result':
      case 'fs_read_result':
        this.settle(from, body.reqId, body);
        return;
      case 'fs_changed': {
        const viewer = this.store.getState().viewer;
        if (viewer && viewer.owner === from && viewer.share === body.share && viewer.path === body.path) {
          await this.loadViewer(viewer);
        }
        return;
      }
      case 'report':
        this.system(`${peerName(this.store.getState(), from)}'s Claude wrote a report. Open it with /open ${peerName(this.store.getState(), from)}:${body.share}/${body.path}`);
        return;
    }
  }

  private async onFocus(from: string, ts: number, body: BodyOf<'focus'>): Promise<void> {
    const key = body.actor === 'agent' ? `${from}:agent` : from;
    const focus = { owner: body.owner, share: body.share, path: body.path, actor: body.actor, ts };
    this.store.dispatch({ type: 'focus', actorKey: key, focus });
    const state = this.store.getState();
    if (state.follow === from && from !== this.selfId) {
      const by = `${peerName(state, from)}${body.actor === 'agent' ? "'s Claude" : ''}`;
      await this.openLocation(focus, { by, broadcast: false });
    }
  }

  private async reply(to: string, reqId: string, fn: () => Promise<BodyInput>, kind: 'fs_list_result' | 'fs_read_result'): Promise<void> {
    try {
      this.send(await fn(), { to });
    } catch (err) {
      this.send({ kind, reqId, ok: false, error: errorText(err) }, { to });
    }
  }

  private request<T>(to: string, body: BodyInput & { reqId: string }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(body.reqId);
        reject(new Error('Peer did not respond in time'));
      }, this.opts.requestTimeoutMs ?? 15_000);
      this.pending.set(body.reqId, { peer: to, resolve: resolve as (v: unknown) => void, reject, timer });
      if (!this.send(body, { to })) {
        clearTimeout(timer);
        this.pending.delete(body.reqId);
        reject(new Error('Not connected'));
      }
    });
  }

  private settle(from: string, reqId: string, body: BodyOf<'fs_list_result'> | BodyOf<'fs_read_result'>): void {
    const p = this.pending.get(reqId);
    if (!p || p.peer !== from) return;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    if (body.ok) p.resolve(body);
    else p.reject(new Error(body.error ?? 'Request failed'));
  }

  async listFiles(at: Location): Promise<readonly FsEntry[]> {
    const res = await this.request<BodyOf<'fs_list_result'>>(at.owner, { kind: 'fs_list', reqId: randomUUID(), share: at.share, path: at.path });
    return res.entries ?? [];
  }

  async readFile(at: Location): Promise<{ content: string; truncated: boolean }> {
    const res = await this.request<BodyOf<'fs_read_result'>>(at.owner, { kind: 'fs_read', reqId: randomUUID(), share: at.share, path: at.path });
    return { content: res.content ?? '', truncated: res.truncated ?? false };
  }

  private async loadViewer(at: Location): Promise<void> {
    try {
      const { content, truncated } = await this.readFile(at);
      this.store.dispatch({ type: 'viewer_content', at, content, truncated });
    } catch (err) {
      this.store.dispatch({ type: 'viewer_error', at, error: errorText(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Agent hosting (requests that target *this* machine)
  // -------------------------------------------------------------------------

  private emitAgent(requestId: string, requester: string, event: BodyOf<'agent_event'>['event'], text = ''): void {
    const final = event === 'done' || event === 'error' || event === 'denied';
    const body: BodyInput = { kind: 'agent_event', requestId, requester, event, text: text.slice(0, 60_000) };
    if (!this.send(body, { keep: final }) && final) this.outbox = [...this.outbox, { body, opts: { keep: true } }].slice(-50);
  }

  private async onAgentRequest(from: string, body: BodyOf<'agent_request'>): Promise<void> {
    // Drop replays of a request we've already seen.
    const key = `${from}:${body.requestId}`;
    if (this.seenRequests.includes(key)) return;
    this.seenRequests.push(key);
    if (this.seenRequests.length > SEEN_REQUESTS) this.seenRequests.shift();
    if (!this.agent) {
      this.emitAgent(body.requestId, from, 'denied', 'No agent is running on this machine.');
      return;
    }
    const allowed = await this.authorizeRequest(from, body);
    if (!allowed) {
      this.emitAgent(body.requestId, from, 'denied', 'Request declined by the machine owner.');
      return;
    }
    const generation = this.generation;
    this.queue = this.queue
      .then(() =>
        generation === this.generation
          ? this.runAgent(from, body)
          : this.emitAgent(body.requestId, from, 'error', 'Cancelled by owner'),
      )
      .catch((err: unknown) => this.system(`Agent run failed: ${errorText(err)}`, 'error'));
  }

  private async authorizeRequest(from: string, body: BodyOf<'agent_request'>): Promise<boolean> {
    if (from === this.selfId) return true;
    const state = this.store.getState();
    if (state.policy === 'deny') return false;
    if (state.policy === 'auto' || state.trusted.includes(from)) return true;
    const name = peerName(state, from);
    this.emitAgent(body.requestId, from, 'awaiting_approval', `Waiting for ${state.self?.name ?? 'owner'} to approve`);
    const answer = await this.ask('request', `${name}${body.viaAgent ? "'s Claude" : ''} wants your Claude to run this`, body.prompt);
    if (answer === 'always') this.store.dispatch({ type: 'trust', peerId: from, trusted: true });
    return answer !== 'no';
  }

  private ask(kind: 'request' | 'tool', title: string, detail: string): Promise<'yes' | 'no' | 'always'> {
    if (this.approvals.size >= MAX_PENDING_APPROVALS) return Promise.resolve('no');
    const id = randomUUID();
    if (kind === 'tool') this.toolApprovals.add(id);
    return new Promise((resolve) => {
      this.approvals.set(id, (answer) => {
        this.toolApprovals.delete(id);
        resolve(answer);
      });
      this.store.dispatch({ type: 'approval_add', approval: { id, kind, title, detail } });
    });
  }

  private async runAgent(from: string, body: BodyOf<'agent_request'>): Promise<void> {
    const agent = this.agent as AgentBackend;
    const controller = new AbortController();
    this.current = controller;
    const requesterName = peerName(this.store.getState(), from);
    this.emitAgent(body.requestId, from, 'started');
    try {
      const final = await agent.run({
        prompt: body.prompt,
        requesterName,
        viaAgent: body.viaAgent,
        context: this.recentChat(),
        signal: controller.signal,
        onEvent: (kind, text) => this.emitAgent(body.requestId, from, kind, text),
        onFileTouched: (abs) => this.announceAgentFocus(abs),
        canUseTool: (toolName, input) => this.authorizeTool(from, requesterName, toolName, input),
      });
      if (controller.signal.aborted) throw new Error('aborted');
      this.emitAgent(body.requestId, from, 'done', final || '(done)');
    } catch (err) {
      this.emitAgent(body.requestId, from, 'error', controller.signal.aborted ? 'Stopped by owner' : errorText(err));
    } finally {
      if (this.current === controller) this.current = undefined;
    }
  }

  private async authorizeTool(requester: string, requesterName: string, toolName: string, input: Record<string, unknown>): Promise<boolean> {
    // "Always" is scoped to one requester and one tool, never global.
    const scope = `${requester}:${toolName}`;
    if (this.alwaysTools.has(scope)) return true;
    const detail = typeof input.command === 'string' ? input.command : JSON.stringify(input);
    const answer = await this.ask('tool', `Your Claude (working for ${requesterName}) wants to use ${toolName}`, detail);
    if (answer === 'always') this.alwaysTools.add(scope);
    return answer !== 'no';
  }

  private announceAgentFocus(absPath: string): void {
    const hit = this.opts.shares.locate(absPath);
    if (hit) this.send({ kind: 'focus', owner: this.selfId, share: hit.share, path: hit.path, actor: 'agent' });
  }

  private onAgentEvent(from: string, ts: number, body: BodyOf<'agent_event'>): void {
    this.store.dispatch({ type: 'agent_event', owner: from, requestId: body.requestId, requester: body.requester, event: body.event, text: body.text, ts });
    const waiter = this.agentWaiters.get(body.requestId);
    if (!waiter || waiter.peer !== from || !['done', 'error', 'denied'].includes(body.event)) return;
    clearTimeout(waiter.timer);
    this.agentWaiters.delete(body.requestId);
    if (body.event === 'done') waiter.resolve(body.text);
    else waiter.reject(new Error(body.text || body.event));
  }

  private recentChat(): string[] {
    const state = this.store.getState();
    return state.log
      .filter((l) => l.type === 'chat')
      .slice(-CONTEXT_LINES)
      .map((l) => (l.type === 'chat' ? `${l.name}: ${l.text}`.slice(0, 1000) : ''));
  }

  // -------------------------------------------------------------------------
  // Bridge exposed to the agent as MCP tools
  // -------------------------------------------------------------------------

  private requirePeer(name: string): PeerInfo {
    const peer = this.findPeer(name);
    if (!peer) throw new Error(`No peer named "${name}". Call list_peers first.`);
    return peer;
  }

  private createBridge(): RoomBridge {
    return {
      selfName: () => this.store.getState().self?.name ?? 'me',
      sendChat: (text) => this.sendChat(text, true),
      listPeers: () => this.store.getState().peers,
      askAgent: (name, prompt) => {
        const peer = this.requirePeer(name);
        if (!peer.agent) return Promise.reject(new Error(`${peer.name} has no agent online`));
        return new Promise<string>((resolve, reject) => {
          const requestId = this.requestAgent(peer.peerId, prompt, true);
          const timer = setTimeout(() => {
            this.agentWaiters.delete(requestId);
            reject(new Error(`${peer.name}'s Claude did not finish in time`));
          }, this.opts.agentTimeoutMs ?? 15 * 60_000);
          this.agentWaiters.set(requestId, { peer: peer.peerId, resolve, reject, timer });
        });
      },
      listPeerFiles: (name, share, p) => this.listFiles({ owner: this.requirePeer(name).peerId, share, path: p }),
      readPeerFile: async (name, share, p) => (await this.readFile({ owner: this.requirePeer(name).peerId, share, path: p })).content,
      writeReport: (title, markdown) => this.writeReport(title, markdown),
    };
  }

  private async writeReport(title: string, markdown: string): Promise<string> {
    const dir = path.join(this.opts.agentCwd, '.klaude', 'reports');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'report';
    const file = path.join(dir, `${stamp}-${slug}.md`);
    await fs.writeFile(file, markdown.startsWith('#') ? markdown : `# ${title}\n\n${markdown}`, 'utf8');
    const hit = this.opts.shares.locate(file);
    if (hit) {
      this.send({ kind: 'report', share: hit.share, path: hit.path, title }, { keep: true });
      this.send({ kind: 'focus', owner: this.selfId, share: hit.share, path: hit.path, actor: 'agent' });
    }
    return hit ? `${hit.share}/${hit.path}` : file;
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
