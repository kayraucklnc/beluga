import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentBackend, RoomBridge } from '../agent/types.js';
import type { IncomingMessage, PeerClient } from '../net/peer-client.js';
import { type BodyInput, type BodyOf, CHUNK_BYTES, type FsEntry, MAX_TEXT, type PeerInfo, type Profile, type Usage } from '../protocol.js';
import { parseInput, parseLocation } from './mentions.js';
import { type ShareService, parseShareSpec } from './shares.js';
import { existsSync } from 'node:fs';
import { type Location, type Prefs, type Store, channelOf, peerName } from './store.js';
import { WorkspaceController } from './workspace-controller.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import type { Settings } from './settings.js';
import { type ZoomDir, zoom as zoomTerminal } from './zoom.js';
import { runCommand } from './commands.js';
import { DEFAULT_DOWNLOAD_DIR, downloadFile } from './downloads.js';

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
  /** Where downloads are saved (default ~/Downloads/klaude). */
  readonly downloadDir?: string;
  /** Persist a settings change (name, policy, theme…). */
  readonly saveSettings?: (patch: Partial<Settings>) => void;
  /** Open remote access and create an invite (klaude starts solo; this runs on first Invite). */
  readonly startInvite?: () => void;
  /** Projects and workspaces on this computer (omit to run without them). */
  readonly workspaces?: WorkspaceManager;
  /** Change the terminal's text size (injected so tests don't resize real windows). */
  readonly zoom?: (dir: ZoomDir) => Promise<{ ok: boolean; message: string }>;
}

/** In-flight requests remember who must answer, so other peers can't spoof responses. */
type Pending = { peer: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type AgentWaiter = { peer: string; resolve: (text: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const CONTEXT_LINES = 20;
const MAX_PENDING_APPROVALS = 20;
const SEEN_REQUESTS = 1000;
const FS_DEBOUNCE_MS = 250;
const DIR_CACHE_MS = 5_000;
const USAGE_REFRESH_MS = 10 * 60_000;
const WORKSPACE_REFRESH_MS = 30_000;

export const dirKey = (at: Location): string => `${at.owner}:${at.share}/${at.path}`;

/** Glue between the network, local shares, the agent, and UI state. */
export class Session {
  readonly bridge: RoomBridge;
  readonly workspaces?: WorkspaceController;
  /** Conversation the agent is currently working in (for its send_chat tool). */
  private currentChannel = 'room';
  private workspaceTimer?: NodeJS.Timeout;
  private readonly agent?: AgentBackend;
  private readonly pending = new Map<string, Pending>();
  private readonly agentWaiters = new Map<string, AgentWaiter>();
  private readonly approvals = new Map<string, (answer: 'yes' | 'no' | 'always') => void>();
  private readonly alwaysTools = new Set<string>();
  /** Requests waiting for the agent, run one at a time (urgent ones jump the line). */
  private waiting: Array<{ from: string; body: BodyOf<'agent_request'> }> = [];
  private pumping = false;
  private interruptedBy?: string;
  private current?: AbortController;
  /** Bumped by :stop so queued runs are cancelled too. */
  private generation = 0;
  private readonly seenRequests: string[] = [];
  private readonly toolApprovals = new Set<string>();
  /** Final agent events that could not be sent while disconnected. */
  private outbox: Array<{ body: BodyInput; opts: { to?: string; keep?: boolean } }> = [];
  private readonly fsTimers = new Map<string, NodeJS.Timeout>();
  private readonly dirFetched = new Map<string, number>();
  private usageTimer?: NodeJS.Timeout;
  private usageFetched = false;

  constructor(private readonly opts: SessionOptions) {
    this.bridge = this.createBridge();
    if (opts.workspaces) {
      this.workspaces = new WorkspaceController({
        manager: opts.workspaces,
        store: opts.store,
        shares: opts.shares,
        selfId: () => this.selfId,
        toast: (text, level) => this.toast(text, level),
        askClaude: (prompt, channel) => this.askOwnClaude(prompt, channel),
      });
    }
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
    this.usageTimer = setInterval(() => void this.refreshUsage(), USAGE_REFRESH_MS);
    this.usageTimer.unref();
    if (this.workspaces) {
      void this.workspaces.refresh();
      this.workspaceTimer = setInterval(() => void this.workspaces?.refresh(), WORKSPACE_REFRESH_MS);
      this.workspaceTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.current?.abort();
    this.opts.client.close();
    await this.opts.shares.close();
    clearInterval(this.usageTimer);
    clearInterval(this.workspaceTimer);
    this.workspaces?.stop();
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

  /** Handle a line from the composer. `urgent` (Alt/Ctrl+Enter) interrupts your Claude instead of queueing. */
  submit(raw: string, urgent = false): void {
    const state = this.store.getState();
    const parsed = parseInput(raw, this.selfId, state.peers);
    const channel = channelOf(state.view);
    // In a workspace, you're talking to your Claude working in that folder.
    if (channel !== 'room' && (parsed.kind === 'chat' || parsed.kind === 'agent')) {
      this.askOwnClaude(parsed.kind === 'agent' ? parsed.prompt : parsed.text, channel, urgent);
      return;
    }
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
        for (const target of parsed.targets) this.requestAgent(target, parsed.prompt, false, 'room', urgent && target === this.selfId);
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
      if (hosting && hosting.phase !== 'failed') return this.toast('The invite link is still being created…');
      if (!this.opts.startInvite) return this.toast('No invite link available', 'warn');
      this.opts.startInvite();
      this.toast('Opening a secure link for friends… it will be copied when ready');
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

  sendChat(text: string, byAgent: boolean, channel = 'room'): void {
    if (channel !== 'room') {
      // Workspace conversations stay on this computer.
      this.store.dispatch({ type: 'chat', id: randomUUID(), from: this.selfId, text: text.slice(0, MAX_TEXT), ts: Date.now(), byAgent, channel });
      return;
    }
    if (!this.send({ kind: 'chat', text: text.slice(0, MAX_TEXT), byAgent }, { keep: true })) {
      this.toast('Not connected, so the message was not sent', 'error');
    }
  }

  /** Ask an agent (ours or a peer's) to do something. Returns the request id. */
  requestAgent(target: string, prompt: string, viaAgent: boolean, channel = 'room', urgent = false): string {
    const requestId = randomUUID();
    this.send({ kind: 'agent_request', requestId, prompt: prompt.slice(0, MAX_TEXT), viaAgent, channel, urgent }, { to: target });
    return requestId;
  }

  /** Send a message to your own Claude in a workspace conversation. */
  askOwnClaude(prompt: string, channel: string, urgent = false): void {
    this.sendChat(prompt, false, channel);
    this.requestAgent(this.selfId, prompt, false, channel, urgent);
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
    const cancelled = this.waiting;
    this.waiting = [];
    for (const { from, body } of cancelled) this.emitAgent(body.requestId, from, 'error', 'Cancelled by owner', body.channel);
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
      if (!this.usageFetched) {
        this.usageFetched = true;
        void this.refreshUsage();
      }
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
        if (body.channel !== 'room' && from !== this.selfId) return; // workspace chats are private for now
        this.store.dispatch({ type: 'chat', id, from, text: body.text, ts, byAgent: body.byAgent, channel: body.channel });
        return;
      case 'focus':
        return this.onFocus(from, ts, body);
      case 'agent_request':
        return this.onAgentRequest(from, body);
      case 'agent_event':
        return this.onAgentEvent(from, ts, body);
      case 'fs_list':
      case 'fs_read':
      case 'fs_fetch':
        if (!this.opts.shares.canAccess(body.share, from, this.selfId)) {
          const reply = body.kind === 'fs_list' ? 'fs_list_result' : body.kind === 'fs_read' ? 'fs_read_result' : 'fs_chunk';
          this.send({ kind: reply, reqId: body.reqId, ok: false, error: 'That folder is not shared with you' }, { to: from });
          return;
        }
        return this.serveFs(from, body);
      case 'fs_list_result':
      case 'fs_read_result':
      case 'fs_chunk':
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

  private serveFs(from: string, body: BodyOf<'fs_list'> | BodyOf<'fs_read'> | BodyOf<'fs_fetch'>): Promise<void> {
    if (body.kind === 'fs_fetch') return this.serveChunk(from, body);
    if (body.kind === 'fs_list') {
      return this.reply(from, body.reqId, async () => ({ kind: 'fs_list_result', reqId: body.reqId, ok: true, entries: await this.opts.shares.list(body.share, body.path) }), 'fs_list_result');
    }
    this.opts.shares.watchFile(body.share, body.path);
    return this.reply(from, body.reqId, async () => ({ kind: 'fs_read_result', reqId: body.reqId, ok: true, ...(await this.opts.shares.read(body.share, body.path)) }), 'fs_read_result');
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

  private settle(from: string, reqId: string, body: BodyOf<'fs_list_result'> | BodyOf<'fs_read_result'> | BodyOf<'fs_chunk'>): void {
    const p = this.pending.get(reqId);
    if (!p || p.peer !== from) return;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    if (body.ok) p.resolve(body);
    else p.reject(new Error(body.error ?? 'Request failed'));
  }

  /** Owner side of a download: send one encrypted chunk, and tell the owner who is downloading. */
  private async serveChunk(from: string, body: BodyOf<'fs_fetch'>): Promise<void> {
    try {
      const { data, total } = await this.opts.shares.readChunk(body.share, body.path, body.offset, CHUNK_BYTES);
      if (body.offset === 0) this.system(`${peerName(this.store.getState(), from)} is downloading ${body.share}/${body.path}`);
      this.send({ kind: 'fs_chunk', reqId: body.reqId, ok: true, data: data.toString('base64'), offset: body.offset, total }, { to: from });
    } catch (err) {
      this.send({ kind: 'fs_chunk', reqId: body.reqId, ok: false, error: errorText(err) }, { to: from });
    }
  }

  /** Download a file from a friend's share into ~/Downloads/klaude/<friend>/. */
  async download(at: Location): Promise<string | undefined> {
    const from = peerName(this.store.getState(), at.owner);
    if (!at.path || at.path.endsWith('/')) {
      this.toast('Pick a file to download, not a folder', 'warn');
      return undefined;
    }
    this.toast(`Downloading ${at.path} from ${from}…`);
    try {
      const saved = await downloadFile(at, from, (to, b) => this.request(to, b), this.store, this.opts.downloadDir ?? DEFAULT_DOWNLOAD_DIR);
      this.system(`Saved ${at.path} from ${from} → ${saved}`);
      this.toast(`Downloaded ${path.basename(saved)}`, 'success');
      return saved;
    } catch (err) {
      this.toast(`Download failed: ${errorText(err)}`, 'error');
      return undefined;
    }
  }

  downloadSpec(spec: string): void {
    const loc = parseLocation(spec, this.store.getState().peers);
    if (!loc) return this.toast(`Can't find "${spec}". Use /get <name>:<folder>/<file>`, 'warn');
    void this.download(loc);
  }

  /** Choose whether people in the room may use your Claude (from onboarding or /policy). */
  setClaudeSharing(policy: 'ask' | 'auto' | 'deny'): void {
    this.store.dispatch({ type: 'policy', policy });
    this.updateProfile({ agent: this.hasAgent && policy !== 'deny' });
    this.opts.saveSettings?.({ policy });
  }

  /** Change your display name for this room and future ones. */
  rename(raw: string | undefined): void {
    const name = (raw ?? '').replace(/[^\w.-]/g, '').slice(0, 32);
    if (!name) {
      this.toast('Usage: /name <new name> (letters, numbers, . - _)', 'warn');
      return;
    }
    this.updateProfile({ name });
    this.opts.saveSettings?.({ name });
    this.toast(`You're now ${name}`, 'success');
  }

  /** Make the terminal's text bigger or smaller, without needing a keyboard shortcut. */
  async zoom(dir: ZoomDir): Promise<void> {
    const result = await (this.opts.zoom ?? zoomTerminal)(dir);
    this.toast(result.message, result.ok ? 'success' : 'warn');
  }

  /** Update a display preference and remember it. */
  setPrefs(prefs: Partial<Prefs>): void {
    this.store.dispatch({ type: 'prefs', prefs });
    this.opts.saveSettings?.(prefs);
  }

  /** Share a folder with the room (read-only unless `writable`). */
  shareFolder(dir: string, writable = false): void {
    const spec = parseShareSpec(`${dir}${writable ? ':rw' : ''}`, process.cwd());
    if (!existsSync(spec.root)) return this.toast(`${spec.root} doesn't exist`, 'warn');
    this.opts.shares.upsert(spec);
    this.updateProfile({ shares: this.opts.shares.infos });
    this.toast(`Sharing ${spec.name} with the room${writable ? ' (your Claude may edit it)' : ' (read-only)'}`, 'success');
  }

  unshareFolder(name: string): void {
    this.opts.shares.remove(name);
    this.updateProfile({ shares: this.opts.shares.infos });
    this.toast(`Stopped sharing ${name}`);
  }

  /** Give a friend access to only your shared folders, or your whole computer. */
  setAccess(peerId: string, scope: 'folder' | 'full'): void {
    this.store.dispatch({ type: 'access', peerId, scope });
  }

  private updateProfile(patch: Partial<Profile>): void {
    this.opts.client.updateProfile({ ...this.opts.client.currentProfile, ...patch });
  }

  /** Merge new plan-usage numbers and share them with the room. */
  updateUsage(update: Partial<Usage>): void {
    const prev = this.opts.client.currentProfile.usage;
    this.updateProfile({ usage: { ...prev, ...update, updatedAt: Date.now() } });
  }

  /** Ask the agent backend for fresh plan usage (no prompt is sent). */
  async refreshUsage(): Promise<void> {
    const usage = await this.agent?.refreshUsage?.().catch(() => undefined);
    if (usage) this.updateUsage(usage);
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

  private emitAgent(requestId: string, requester: string, event: BodyOf<'agent_event'>['event'], text = '', channel = 'room'): void {
    const final = event === 'done' || event === 'error' || event === 'denied';
    const body: BodyInput = { kind: 'agent_event', requestId, requester, event, text: text.slice(0, 60_000), channel };
    // Workspace conversations are private: events go only to you, never to the room.
    const opts = channel === 'room' ? { keep: final } : { to: this.selfId };
    if (!this.send(body, opts) && final) this.outbox = [...this.outbox, { body, opts }].slice(-50);
  }

  private async onAgentRequest(from: string, body: BodyOf<'agent_request'>): Promise<void> {
    // Drop replays of a request we've already seen.
    const key = `${from}:${body.requestId}`;
    if (this.seenRequests.includes(key)) return;
    this.seenRequests.push(key);
    if (this.seenRequests.length > SEEN_REQUESTS) this.seenRequests.shift();
    if (!this.agent) {
      this.emitAgent(body.requestId, from, 'denied', 'No agent is running on this machine.', body.channel);
      return;
    }
    if (body.channel !== 'room' && from !== this.selfId) {
      this.emitAgent(body.requestId, from, 'denied', "That workspace isn't shared with you.", body.channel);
      return;
    }
    const allowed = await this.authorizeRequest(from, body);
    if (!allowed) {
      this.emitAgent(body.requestId, from, 'denied', 'Request declined by the machine owner.', body.channel);
      return;
    }
    this.enqueue(from, body);
  }

  /**
   * Queue a request. Normal requests wait their turn (and say so); urgent ones from you
   * interrupt the current run and go next, continuing the same conversation.
   */
  private enqueue(from: string, body: BodyOf<'agent_request'>): void {
    const urgent = body.urgent && from === this.selfId;
    if (urgent) {
      this.waiting.unshift({ from, body });
      if (this.current) {
        this.interruptedBy = body.requestId;
        this.current.abort();
      }
    } else {
      this.waiting.push({ from, body });
      if (this.current || this.waiting.length > 1) this.emitAgent(body.requestId, from, 'queued', 'Waiting for the current task to finish', body.channel);
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let next = this.waiting.shift(); next; next = this.waiting.shift()) {
        await this.runAgent(next.from, next.body).catch((err: unknown) => this.system(`Agent run failed: ${errorText(err)}`, 'error'));
      }
    } finally {
      this.pumping = false;
    }
  }

  private async authorizeRequest(from: string, body: BodyOf<'agent_request'>): Promise<boolean> {
    if (from === this.selfId) return true;
    const state = this.store.getState();
    if (state.policy === 'deny') return false;
    if (state.policy === 'auto' || state.trusted.includes(from)) return true;
    const name = peerName(state, from);
    this.emitAgent(body.requestId, from, 'awaiting_approval', `Waiting for ${state.self?.name ?? 'owner'} to approve`, body.channel);
    const reach = state.access[from] === 'full' ? 'whole computer' : 'shared folders only';
    const answer = await this.ask('request', `${name}${body.viaAgent ? "'s Claude" : ''} wants your Claude to run this (${reach})`, body.prompt);
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
    const place = this.workspaces?.place(body.channel);
    if (body.channel !== 'room' && !place) {
      this.emitAgent(body.requestId, from, 'error', 'That workspace is archived or missing.', body.channel);
      if (this.current === controller) this.current = undefined;
      return;
    }
    this.currentChannel = body.channel;
    this.emitAgent(body.requestId, from, 'started', '', body.channel);
    try {
      const final = await agent.run({
        prompt: body.prompt,
        requesterName,
        viaAgent: body.viaAgent,
        context: this.recentChat(body.channel),
        ...(place ? { place } : {}),
        scope: from === this.selfId ? 'full' : (this.store.getState().access[from] ?? 'folder'),
        signal: controller.signal,
        onEvent: (kind, text) => this.emitAgent(body.requestId, from, kind, text, body.channel),
        onFileTouched: (abs) => this.announceAgentFocus(abs),
        canUseTool: (toolName, input) => this.authorizeTool(from, requesterName, toolName, input),
      });
      if (controller.signal.aborted) throw new Error('aborted');
      this.emitAgent(body.requestId, from, 'done', final || '(done)', body.channel);
    } catch (err) {
      const reason = this.interruptedBy ? 'Interrupted by a newer message' : controller.signal.aborted ? 'Stopped by owner' : errorText(err);
      this.interruptedBy = undefined;
      this.emitAgent(body.requestId, from, 'error', reason, body.channel);
    } finally {
      if (this.current === controller) this.current = undefined;
      this.currentChannel = 'room';
      void this.refreshUsage();
      if (body.channel !== 'room') void this.workspaces?.refresh();
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
    this.store.dispatch({ type: 'agent_event', owner: from, requestId: body.requestId, requester: body.requester, event: body.event, text: body.text, ts, channel: body.channel });
    const waiter = this.agentWaiters.get(body.requestId);
    if (!waiter || waiter.peer !== from || !['done', 'error', 'denied'].includes(body.event)) return;
    clearTimeout(waiter.timer);
    this.agentWaiters.delete(body.requestId);
    if (body.event === 'done') waiter.resolve(body.text);
    else waiter.reject(new Error(body.text || body.event));
  }

  private recentChat(channel = 'room'): string[] {
    const state = this.store.getState();
    return state.log
      .filter((l) => l.type === 'chat' && l.channel === channel)
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
      sendChat: (text) => this.sendChat(text, true, this.currentChannel),
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
      reportUsage: (usage) => this.updateUsage(usage),
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
