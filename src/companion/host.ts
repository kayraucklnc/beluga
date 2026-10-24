/// <reference path="../net/mesh/modules.d.ts" />
import { createHash, hkdfSync } from 'node:crypto';
import type DHT from 'hyperdht';
import type { BootstrapNode, KeyPair, NoiseSocket, Server } from 'hyperdht';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { attachmentsDir, chipText, importImageFitting, registerAttachment } from '../core/attachments.js';
import type { DomainState } from '../core/store.js';
import type { CallOutcome } from '../daemon/dispatch.js';
import type { Identity } from '../net/crypto.js';
import { type MessageSocket, fromStream } from '../net/transport.js';
import { phoneMay } from './coverage.js';
import { type DeviceBook, type DeviceRecord, deviceId } from './devices.js';
import { FileServer, RefTable, type Thumbnailer } from './files.js';
import { ProjectIcons, type SmallIcon } from './icons.js';
import type { MergeBook } from './merge.js';
import { DevicePairing, type PairingInfo } from './pair.js';
import { Uploads } from './uploads.js';
import { Reach, type RelayTunnel } from './reach.js';
import { pathNote } from './diagnose.js';
import {
  COMPANION_PROTO,
  type CompanionSlice,
  type DialAttempt,
  type LinkPath,
  KEEPALIVE_MS,
  type MacFrame,
  MAX_COMPANION_FRAME,
  type MergeView,
  type NeedsYou,
  type PhoneFrame,
  type Topic,
  VIEW_COALESCE_MS,
  VIEW_TURNS,
  parsePhoneFrame,
} from './protocol.js';
import { type Delivery, NO_PUSH, type Nudge, type Pusher, deliver } from './push.js';
import { type ConvOutput, type ViewContext, channelOf, chatMessages, convTopic, convTurns, needsYou, viewOf } from './views.js';

/**
 * Your Mac's side of the phone link (docs/companion.md, "The link"). Its own DHT node listens at
 * the companion address (derived from your identity, 'companion-v1': stable, and separate from
 * the network's address so it works whether the network is on or not). The firewall lets in only
 * the link keys of phones you paired and haven't removed; the Noise handshake pins both ends.
 *
 * Per phone: hello (an incompatible version is closed with 4002), the topics on its screen (each
 * sent as a whole view when its hash changes, at most every VIEW_COALESCE_MS), calls through the
 * allowlist (coverage.ts) to the same API handlers screens use, files by ref (files.ts), and a
 * nudge in place of a push while it's linked.
 *
 * No DHT node runs unless a phone is paired or a pairing is open: people without a phone pay nothing.
 */

/** Close codes on the link (the phone shows why). */
export const COMPANION_CLOSE = { hello: 4001, version: 4002, removed: 4010, quiet: 4008 } as const;
/** The oldest phone protocol this Mac answers (a major behind, for one release, once there is one). */
export const COMPANION_MIN = { major: COMPANION_PROTO.major, minor: 0 } as const;
/** What a phone may send in one frame (a photo it attaches, in base64, plus room). */
const MAX_IN_BYTES = 8 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const MAX_TOPICS = 16;

export interface CompanionHostOptions {
  readonly identity: Identity;
  readonly store: { getState(): DomainState; subscribe(listener: () => void): () => void; dispatch(action: { type: 'companion'; companion: CompanionSlice['companion'] }): void };
  readonly devices: DeviceBook;
  /** An API call, as a screen's goes (daemon/dispatch.ts); `clientId` is the phone's. */
  readonly call: (clientId: string, method: string, args: readonly unknown[]) => Promise<CallOutcome>;
  readonly macName: () => string;
  readonly version: string;
  readonly thumbsDir: string;
  /** Where photos and files from the phone land (~/.beluga/attachments/phone). */
  readonly uploadsDir?: string;
  readonly thumbnail?: Thumbnailer;
  /** Outputs on disk per conversation (sub-agents', the scratch folder's), newest first. */
  readonly outputs?: (channel: string) => readonly ConvOutput[];
  /** A phone looks at these conversations: keep their outputs fresh. */
  readonly watching?: (channels: readonly string[], linked: boolean) => void;
  readonly pusher?: Pusher;
  /** How long since the Mac was last used (ms), when known. */
  readonly idleMs?: () => Promise<number | undefined>;
  /** Tests: a local testnet instead of the public DHT. */
  readonly dht?: { readonly bootstrap?: readonly BootstrapNode[]; readonly host?: string; /** Tests: turn away every direct connection (as a network with client isolation does). */ readonly refuseDirect?: boolean };
  /** The relay's tunnel (reach.ts): 'cloudflared' (the daemon's), a function (tests), or 'off' (the default). */
  readonly relay?: RelayTunnel;
  readonly coalesceMs?: number;
  readonly pairTtlMs?: number;
  readonly log?: (line: string) => void;
  /** Tests: deterministic refs. */
  readonly refs?: RefTable;
  /** Projects' small icons for the phone (default: made with sips next to the thumbnails). */
  readonly icons?: ProjectIcons;
}

/** The companion address's key pair: HKDF of your identity's seed, 'companion-v1'. */
export async function companionKeyPair(identity: Identity): Promise<KeyPair> {
  const DHTClass = (await import('hyperdht')).default;
  const d = identity.privateKey.export({ format: 'jwk' }).d;
  if (!d) throw new Error('Identity key has no private part');
  const seed = Buffer.from(hkdfSync('sha256', Buffer.from(d, 'base64url'), Buffer.from('beluga-companion'), Buffer.from('companion-v1'), 32));
  return DHTClass.keyPair(seed);
}

interface TopicState {
  rev: number;
  hash?: string;
  sentAt: number;
  timer?: NodeJS.Timeout;
}

/** One linked phone. */
class PhoneLink {
  readonly clientId: string;
  hello?: Extract<PhoneFrame, { t: 'hello' }>;
  topics = new Map<Topic, TopicState>();
  inFront = true;
  heard = Date.now();
  /** It came through the relay (an older app doesn't say how it came). */
  overRelay = false;
  private readonly beat: NodeJS.Timeout;
  private readonly helloTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly device: DeviceRecord,
    readonly socket: MessageSocket,
    private readonly host: CompanionHost,
  ) {
    this.clientId = `phone:${deviceId(device.cert)}`;
    socket.on('message', (text) => {
      this.heard = Date.now();
      try {
        this.onFrame(text);
      } catch (err) {
        host.logLine(`phone frame failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    socket.on('ping', () => (this.heard = Date.now()));
    socket.on('pong', () => (this.heard = Date.now()));
    socket.on('error', () => undefined);
    socket.on('close', () => this.finish());
    this.helloTimer = setTimeout(() => this.close(COMPANION_CLOSE.hello, 'no hello'), HELLO_TIMEOUT_MS);
    this.helloTimer.unref();
    // The phone pings every KEEPALIVE_MS; three missed and it's gone (a phone that slept without a bye).
    this.beat = setInterval(() => {
      if (Date.now() - this.heard > KEEPALIVE_MS * 3) socket.terminate();
    }, KEEPALIVE_MS);
    this.beat.unref();
  }

  get deviceId(): string {
    return deviceId(this.device.cert);
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.isOpen;
  }

  send(frame: MacFrame): void {
    if (this.isOpen) this.socket.send(JSON.stringify(frame));
  }

  close(code: number, reason: string): void {
    this.send({ t: 'bye', reason });
    this.socket.close(code, reason);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    clearInterval(this.beat);
    for (const t of this.topics.values()) clearTimeout(t.timer);
    this.host.unlinked(this);
  }

  private onFrame(text: string): void {
    const frame = parsePhoneFrame(text);
    if (!frame) return;
    if (!this.hello) {
      if (frame.t !== 'hello') return;
      clearTimeout(this.helloTimer);
      // Too new for this Mac, or older than it still answers: say so rather than misbehave.
      if (frame.v.major > COMPANION_PROTO.major) return this.close(COMPANION_CLOSE.version, 'Update Beluga on your Mac');
      if (frame.v.major < COMPANION_MIN.major) return this.close(COMPANION_CLOSE.version, 'Update the Beluga app');
      this.hello = frame;
      const state = this.host.state();
      const relay = this.host.relayUrl();
      this.send({ t: 'welcome', v: { ...COMPANION_PROTO }, min: { ...COMPANION_MIN }, mac: this.host.macInfo(), me: { name: (state.self?.name ?? state.network.self?.name ?? 'me').slice(0, 64), peerId: state.selfId || 'me' }, ...(relay ? { relay } : {}) });
      this.host.helloed(this, frame.app, frame.via);
      this.subscribe(frame.topics);
      return;
    }
    switch (frame.t) {
      case 'hello':
        return;
      case 'sub':
        return this.subscribe(frame.topics);
      case 'call':
        return void this.host.phoneCall(this, frame.method, frame.args).then((r) => this.send({ t: 'result', id: frame.id, ...r, ...(r.ok ? {} : { error: r.error.slice(0, 2000) }) }));
      case 'get':
        return void this.host.files
          .piece(frame.ref, frame.variant, frame.off)
          .then((p) => this.send({ t: 'chunk', id: frame.id, ...p }))
          .catch((err: unknown) => this.send({ t: 'result', id: frame.id, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 2000) }));
      case 'put':
        return void this.host.uploads
          .piece(this.deviceId, frame)
          .then((value) => this.send({ t: 'result', id: frame.id, ok: true, value }))
          .catch((err: unknown) => this.send({ t: 'result', id: frame.id, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 2000) }));
      case 'push':
        return this.host.setPush(this, { platform: frame.platform, token: frame.token, relayKey: frame.relayKey });
      case 'focus':
        this.inFront = frame.on;
        return;
      case 'bye':
        this.socket.close(1000, 'bye');
        return;
    }
  }

  /** The topics on the phone's screen now: new ones are sent at once, gone ones forgotten. */
  subscribe(topics: readonly Topic[]): void {
    const wanted = new Set(topics.slice(0, MAX_TOPICS));
    for (const [t, st] of this.topics) {
      if (wanted.has(t)) continue;
      clearTimeout(st.timer);
      this.topics.delete(t);
    }
    for (const t of wanted) if (!this.topics.has(t)) this.topics.set(t, { rev: 0, sentAt: 0 });
    this.host.watched();
    for (const t of wanted) this.schedule(t);
  }

  /** Send a topic's view soon: at once if it's been quiet, else when its coalescing window ends. */
  schedule(topic: Topic): void {
    const st = this.topics.get(topic);
    if (!st || st.timer || !this.hello) return;
    const wait = Math.max(0, st.sentAt + this.host.coalesceMs - Date.now());
    st.timer = setTimeout(() => {
      st.timer = undefined;
      if (this.topics.get(topic) === st) this.sendView(topic, st);
    }, wait);
    st.timer.unref();
  }

  private sendView(topic: Topic, st: TopicState): void {
    const data = this.host.render(topic);
    if (data === undefined) return;
    const json = JSON.stringify(data);
    const hash = createHash('sha256').update(json).digest('base64');
    st.sentAt = Date.now();
    if (hash === st.hash) return;
    st.hash = hash;
    st.rev += 1;
    this.send({ t: 'view', topic, rev: st.rev, data });
  }
}

export class CompanionHost {
  readonly files: FileServer;
  readonly uploads: Uploads;
  readonly coalesceMs: number;
  readonly icons: ProjectIcons;
  private readonly refs: RefTable;
  private readonly pairing: DevicePairing;
  private readonly links = new Set<PhoneLink>();
  private node?: DHT;
  private server?: Server;
  private starting?: Promise<DHT>;
  private keyPair?: KeyPair;
  private offs: Array<() => void> = [];
  private stopped = false;
  private ctx: ViewContext;
  /** What needs you (by id) and which runs the phone started, to tell it when something new happens. */
  private seenNeeds?: Set<string>;
  private phoneRuns = new Map<string, boolean>();
  private changeTimer?: NodeJS.Timeout;
  readonly reach: Reach;

  constructor(private readonly opts: CompanionHostOptions) {
    this.reach = new Reach({
      tunnel: opts.relay ?? 'off',
      ...(opts.log ? { log: opts.log } : {}),
      // The relay's URL goes in the pairing link (its QR redraws) and in each welcome.
      onChange: () => this.publish(),
    });
    this.coalesceMs = opts.coalesceMs ?? VIEW_COALESCE_MS;
    this.refs = opts.refs ?? new RefTable();
    this.uploads = new Uploads(opts.uploadsDir ?? path.join(attachmentsDir(), 'phone'));
    this.files = new FileServer({ refs: this.refs, thumbsDir: opts.thumbsDir, ...(opts.thumbnail ? { thumbnail: opts.thumbnail } : {}) });
    this.icons = opts.icons ?? new ProjectIcons({ dir: path.join(path.dirname(opts.thumbsDir), 'icons'), root: (id) => this.state().projects.find((p) => p.id === id)?.root, changed: () => this.refreshViews() });
    this.ctx = { refs: this.refs, mac: { name: opts.macName(), version: opts.version }, ...(opts.outputs ? { outputs: opts.outputs } : {}), icons: (id) => this.icons.sumFor(id), merges: (id) => this.mergeState.get(id) };
    this.pairing = new DevicePairing({
      node: () => this.ensureNode(),
      identity: opts.identity,
      devices: opts.devices,
      address: () => this.address(),
      macName: () => opts.macName(),
      onChange: () => {
        this.publish();
        void this.sync();
      },
      ...(opts.pairTtlMs ? { ttlMs: opts.pairTtlMs } : {}),
      relay: this.reach.server,
      relayUrl: () => this.reach.relayUrl(),
      ...(opts.dht?.refuseDirect ? { refuseDirect: true } : {}),
    });
  }

  /** The relay's URL now, if its tunnel is up. */
  relayUrl(): string | undefined {
    return this.reach.relayUrl();
  }

  /** Start following the state and the paired phones (a DHT node only runs when there's a phone or a pairing). */
  async start(): Promise<void> {
    this.keyPair = await companionKeyPair(this.opts.identity);
    this.offs.push(
      this.opts.store.subscribe(() => this.changed()),
      this.opts.devices.onChange(() => {
        this.publish();
        void this.sync();
      }),
    );
    this.publish();
    // What waits for you now is the baseline: phones hear about what comes after.
    await this.notice();
    await this.sync();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    clearTimeout(this.changeTimer);
    await this.pairing.cancel('Beluga on your Mac is shutting down');
    for (const link of [...this.links]) link.close(COMPANION_CLOSE.quiet, 'Beluga on your Mac is shutting down');
    await this.shutdownNode();
  }

  /** The companion address (hex): where paired phones dial. */
  address(): string {
    if (!this.keyPair) throw new Error('The companion host has not started');
    return this.keyPair.publicKey.toString('hex');
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  state(): DomainState {
    return this.opts.store.getState();
  }

  macInfo(): { name: string; version: string } {
    return { name: this.opts.macName().slice(0, 100), version: this.opts.version.slice(0, 40) };
  }

  logLine(line: string): void {
    this.opts.log?.(`companion: ${line}`);
  }

  // ---- the API (companion-handlers.ts)

  pairStart(): Promise<PairingInfo> {
    return this.pairing.start();
  }

  pairApprove(): { id: string } {
    return { id: this.pairing.approve() };
  }

  async pairCancel(): Promise<void> {
    await this.pairing.cancel();
  }

  /** Remove a phone: its certificate goes, its link drops now, and its key is refused from then on. */
  removeDevice(id: string, reason = 'This phone was removed on your Mac'): boolean {
    const gone = this.opts.devices.remove(id);
    for (const link of [...this.links]) if (link.deviceId === id) link.close(COMPANION_CLOSE.removed, reason);
    return Boolean(gone);
  }

  /** Turns of a conversation (or messages of a chat) before one the phone has. */
  older(topic: string, before: string, limit?: number): unknown {
    const state = this.state();
    if (topic.startsWith('conv:')) return convTurns(state, this.ctx, topic.slice(5), { before, ...(limit ? { limit } : { limit: VIEW_TURNS }) });
    if (topic.startsWith('chat:')) return chatMessages(state, this.ctx, topic.slice(5), { before, ...(limit ? { limit } : {}) });
    throw new Error('Nothing older there');
  }

  /** Merges started from the phone, per worktree (merge.ts): their conversations' views show where each stands. */
  readonly merges: MergeBook = {
    get: (id) => this.mergeState.get(id),
    set: (id, m) => {
      if (m) this.mergeState.set(id, m);
      else this.mergeState.delete(id);
      this.refreshViews();
    },
  };
  private readonly mergeState = new Map<string, MergeView>();

  /** A project's small icon by the checksum a view handed out (companion.icon). */
  icon(sum: string): SmallIcon {
    const icon = this.icons.get(sum);
    if (!icon) throw new Error('That icon is no longer offered');
    return icon;
  }

  // ---- asking from the phone (companion-api.ts)

  /** The phone a call comes from (`phone:<device id>`), if it's one that's paired. */
  private deviceOf(caller: string): string | undefined {
    const id = caller.startsWith('phone:') ? caller.slice(6) : undefined;
    return id && this.opts.devices.get(id) ? id : undefined;
  }

  private async must(caller: string, method: string, args: readonly unknown[]): Promise<unknown> {
    const out = await this.opts.call(caller, method, args);
    if (!out.ok) throw new Error(out.error);
    return out.value;
  }

  /** The files a phone attached: pictures as chips (as pasted images are), other files named by their path here. */
  private async attach(caller: string, refs: readonly string[] | undefined): Promise<{ chips: string[]; paths: string[] }> {
    if (!refs?.length) return { chips: [], paths: [] };
    const device = this.deviceOf(caller);
    if (!device) throw new Error('Only the phone that sent a file can attach it');
    const ups = await this.uploads.resolve(device, refs);
    const chips: string[] = [];
    const paths: string[] = [];
    for (const up of ups) {
      if (up.image) {
        // Where pasted images go, made smaller when they're too big for Claude (a phone photo often is).
        const file = await importImageFitting(up.path);
        const { size } = await stat(file);
        chips.push(chipText(registerAttachment(file, size).n));
      } else paths.push(up.path);
    }
    return { chips, paths };
  }

  /** Ask your Mac: a new chat in a project (as New Chat there), or a message in a conversation you can write in → its topic. */
  async ask(caller: string, a: { target: { project: string } | { topic: string }; text: string; files?: readonly string[] | undefined }): Promise<{ topic: string }> {
    let channel: string;
    if ('project' in a.target) {
      const title = a.text.replace(/\s+/g, ' ').trim().slice(0, 40) || 'From my phone';
      const id = await this.must(caller, 'workspaces.newChat', [a.target.project, title]);
      if (typeof id !== 'string') throw new Error('Couldn’t start a chat in that project');
      channel = `ws:${id}`;
    } else {
      channel = a.target.topic.slice('conv:'.length);
      const conv = viewOf(this.state(), this.ctx, a.target.topic as Topic) as { canSend?: boolean } | undefined;
      if (!conv?.canSend) throw new Error('You can’t write in that conversation');
    }
    const { chips, paths } = await this.attach(caller, a.files);
    let text = [a.text.trim(), chips.join(' '), paths.length ? `Files from my phone:\n${paths.map((p) => `- ${p}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    if (chips.length) text = String(await this.must(caller, 'attachments.expand', [text, channel]));
    await this.must(caller, 'session.submit', [text, { channel }]);
    this.phoneRuns.set(channel, false);
    const topic = convTopic(channel);
    if (!topic) throw new Error('That conversation can’t be shown on the phone');
    return { topic };
  }

  /** Write in a friends' chat, with files from the phone (taken in as chat files are on the Mac). */
  async post(caller: string, a: { conversation: string; text: string; files?: readonly string[] | undefined; ask?: 'all' | readonly string[] | undefined }): Promise<unknown> {
    const { all } = a.files?.length ? await this.attachFiles(caller, a.files) : { all: [] as string[] };
    const files = all.length ? await this.must(caller, 'network.files.add', [all]) : undefined;
    return this.must(caller, 'network.post', [a.conversation, { text: a.text, ...(files ? { files } : {}), ...(a.ask ? { ask: a.ask } : {}) }]);
  }

  private async attachFiles(caller: string, refs: readonly string[]): Promise<{ all: string[] }> {
    const device = this.deviceOf(caller);
    if (!device) throw new Error('Only the phone that sent a file can attach it');
    return { all: (await this.uploads.resolve(device, refs)).map((u) => u.path) };
  }

  /** Ask a friend's Claude yourself, as from their card on the Mac (their approval and trust rules apply) → its conversation. */
  async askPerson(caller: string, a: { peerId: string; text: string; needs?: readonly string[] | undefined; project?: string | undefined }): Promise<{ topic: string; task: string }> {
    const task = (await this.must(caller, 'gateway.ask', [a.peerId, a.text, { ...(a.needs?.length ? { needs: a.needs } : {}), ...(a.project ? { project: a.project } : {}) }])) as { id?: unknown };
    if (typeof task?.id !== 'string') throw new Error('That didn’t reach them');
    return { topic: `conv:task:${task.id}`, task: task.id };
  }

  /** The calling phone signs out: its certificate goes (never another phone's), then its link closes. */
  signOut(caller: string): { signedOut: true } {
    const id = this.deviceOf(caller);
    if (!id) throw new Error('Only a phone can sign itself out; remove phones on the Mac');
    // After the answer has gone out.
    const t = setTimeout(() => {
      this.removeDevice(id, 'Signed out');
      void this.uploads.drop(id);
    }, 200);
    t.unref();
    return { signedOut: true };
  }

  // ---- links

  /** A call from a phone: only what the allowlist says it may, then exactly as a screen's call. */
  async phoneCall(link: PhoneLink, method: string, args: readonly unknown[]): Promise<CallOutcome> {
    if (!phoneMay(method)) return { ok: false, error: `${method} is only on your Mac` };
    // A conversation asked from the phone: tell it when its answer is done.
    if (method === 'session.submit') {
      const channel = (args[1] as { channel?: unknown } | null | undefined)?.channel;
      this.phoneRuns.set(typeof channel === 'string' ? channel : 'room', false);
    }
    const out = await this.opts.call(link.clientId, method, args);
    if ((method === 'workspaces.startChat' || method === 'workspaces.startWorktree') && out.ok && typeof out.value === 'string') this.phoneRuns.set(`ws:${out.value}`, false);
    // A plan asked from the phone: its head Claude's draft is done (to approve) when its first run ends.
    const home = method === 'plans.create' && out.ok ? (out.value as { home?: unknown } | null)?.home : undefined;
    if (typeof home === 'string') this.phoneRuns.set(home, false);
    return out;
  }

  render(topic: Topic): unknown {
    const state = this.state();
    let data = viewOf(state, this.ctx, topic);
    // A view must fit in a frame: a long conversation sends fewer turns (the rest: companion.older).
    let size = data === undefined ? 0 : Buffer.byteLength(JSON.stringify(data));
    while (size > MAX_COMPANION_FRAME - 4096 && data && typeof data === 'object' && 'turns' in data) {
      const conv = data as { turns: unknown[]; more: boolean };
      if (conv.turns.length <= 1) return undefined;
      data = { ...conv, turns: conv.turns.slice(Math.ceil(conv.turns.length / 2)), more: true };
      size = Buffer.byteLength(JSON.stringify(data));
    }
    if (size > MAX_COMPANION_FRAME - 4096) {
      this.logLine(`the ${topic} view is too big for the link`);
      return undefined;
    }
    return data;
  }

  helloed(link: PhoneLink, app: string, via?: { path: LinkPath; tried: readonly DialAttempt[] }): void {
    // How it came, in words for Settings › Phone (kept with the device until its next link).
    const path = via?.path ?? (link.overRelay ? 'relay' : undefined);
    const note = path ? pathNote(path, via?.tried ?? []) : undefined;
    this.opts.devices.update(link.deviceId, { lastSeen: Date.now(), app: app.slice(0, 40), ...(path ? { path } : {}), ...(note ? { note } : {}) });
    this.publish();
  }

  unlinked(link: PhoneLink): void {
    this.links.delete(link);
    if (this.opts.devices.get(link.deviceId)) this.opts.devices.update(link.deviceId, { lastSeen: Date.now() });
    this.publish();
    this.watched();
  }

  setPush(link: PhoneLink, push: NonNullable<DeviceRecord['push']>): void {
    this.opts.devices.update(link.deviceId, { push });
  }

  /** The conversations phones have open (their outputs are kept fresh). */
  watched(): void {
    const channels = new Set<string>();
    for (const link of this.links) for (const t of link.topics.keys()) {
      const ch = channelOf(t);
      if (ch) channels.add(ch);
    }
    this.opts.watching?.([...channels], [...this.links].some((l) => l.isOpen));
  }

  private accept(stream: NoiseSocket, overRelay = false): void {
    const socket = fromStream(stream, { maxBytes: MAX_IN_BYTES, open: true });
    socket.on('error', () => undefined);
    const device = this.opts.devices.byLink(stream.remotePublicKey.toString('hex'));
    if (!device || this.stopped) return socket.terminate();
    const link = new PhoneLink(device, socket, this);
    link.overRelay = overRelay;
    this.links.add(link);
    this.publish();
  }

  // ---- the state, views and nudges

  /** Something views show changed outside the shared state (outputs on disk): send what's due. */
  refreshViews(): void {
    this.changed();
  }

  /** The shared state changed: views on phones' screens are due (coalesced), and maybe a nudge. */
  private changed(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      if (this.stopped) return;
      for (const link of this.links) for (const t of link.topics.keys()) link.schedule(t);
      void this.notice();
    }, Math.min(100, this.coalesceMs));
    this.changeTimer.unref();
  }

  /** New things to tell phones about: something that needs you, or a run asked from the phone that finished. */
  private async notice(): Promise<void> {
    if (!this.opts.devices.size) {
      this.seenNeeds = undefined;
      return;
    }
    const state = this.state();
    const items = needsYou(state);
    // What was already waiting when the first phone was paired (or Beluga started) isn't news.
    const seen = this.seenNeeds;
    const fresh = seen ? items.filter((n) => !seen.has(n.id)) : [];
    this.seenNeeds = new Set(items.map((n) => n.id));
    const nudges: Nudge[] = fresh.map((n: NeedsYou) => ({ kind: 'needsYou', title: n.title.slice(0, 200), body: (n.detail ?? n.from ?? '').slice(0, 1000), ...(n.topic ? { topic: n.topic } : {}), priority: 'high' }));
    for (const [channel, wasRunning] of [...this.phoneRuns]) {
      const last = [...state.log].reverse().find((l) => l.channel === channel && l.type === 'agent');
      const running = last?.type === 'agent' && !['done', 'error', 'denied', 'interrupted', 'answered'].includes(last.status);
      if (running) this.phoneRuns.set(channel, true);
      else if (wasRunning && last?.type === 'agent') {
        this.phoneRuns.delete(channel);
        const topic = convTopic(channel);
        nudges.push({ kind: 'done', title: last.status === 'done' || last.status === 'answered' ? 'Claude answered' : 'Claude stopped', body: last.text.replace(/```[\s\S]*?(```|$)/g, '(code)').slice(0, 300), ...(topic ? { topic } : {}), priority: 'normal', collapse: `done:${channel}` });
      }
    }
    if (!nudges.length) return;
    let idle: number | undefined;
    let idleAsked = false;
    for (const record of this.opts.devices.all()) {
      const id = deviceId(record.cert);
      const linked = [...this.links].filter((l) => l.deviceId === id && l.hello);
      for (const nudge of nudges) {
        const onScreen = new Set<string>(linked.flatMap((l) => [...l.topics.keys()]));
        const pre: Delivery = deliver(nudge, { linked: linked.length > 0, onScreen, inFront: linked.some((l) => l.inFront), macFront: state.attention.front, canPush: Boolean(record.push), macIdleMs: 0 });
        if (pre === 'nudge') {
          for (const l of linked) l.send({ t: 'nudge', kind: nudge.kind, title: nudge.title, body: nudge.body, ...(nudge.topic ? { topic: nudge.topic } : {}) });
          continue;
        }
        if (linked.length || !record.push) continue;
        // Not linked: a push, unless you're at the Mac (asked once, only when it matters).
        if (!idleAsked) {
          idleAsked = true;
          idle = await this.opts.idleMs?.().catch(() => undefined);
        }
        const how = deliver(nudge, { linked: false, onScreen, inFront: false, macFront: state.attention.front, canPush: true, ...(idle !== undefined ? { macIdleMs: idle } : {}) });
        if (how === 'push') await (this.opts.pusher ?? NO_PUSH).push({ deviceId: id, ...record.push, box: record.cert.box }, nudge).catch((err: unknown) => this.logLine(`push failed: ${String(err)}`));
      }
    }
  }

  /** The shared state's `companion` slice: the phones (who's linked, last seen) and the pairing. */
  private publish(): void {
    if (this.stopped) return;
    const linked = new Set([...this.links].filter((l) => l.isOpen).map((l) => l.deviceId));
    const pairing = this.pairing.info();
    this.opts.store.dispatch({ type: 'companion', companion: { devices: this.opts.devices.views(linked), ...(pairing ? { pairing } : {}) } });
  }

  // ---- the DHT node

  /** Run the node and the server while there's a phone or a pairing; stop them when there's neither. */
  private async sync(): Promise<void> {
    if (this.stopped) return;
    const wanted = this.opts.devices.size > 0 || this.pairing.isOpen;
    if (wanted) {
      await this.ensureNode().catch((err: unknown) => this.logLine(`could not start: ${String(err)}`));
      // A pairing that just opened gets its relay record too.
      void this.reach.publish();
    } else if (this.node) await this.shutdownNode();
  }

  private ensureNode(): Promise<DHT> {
    if (this.node && this.server) return Promise.resolve(this.node);
    this.starting ??= (async () => {
      const DHTClass = (await import('hyperdht')).default;
      const keyPair = this.keyPair ?? (await companionKeyPair(this.opts.identity));
      this.keyPair = keyPair;
      const node = new DHTClass({ ...(this.opts.dht?.bootstrap ? { bootstrap: this.opts.dht.bootstrap } : {}), ...(this.opts.dht?.host ? { host: this.opts.dht.host } : {}) });
      await node.ready();
      // Only phones you paired (and haven't removed) get through; `true` turns a connection away.
      const firewall = (remote: Buffer): boolean => !this.opts.devices.byLink(remote.toString('hex'));
      const server = node.createServer({ firewall: this.opts.dht?.refuseDirect ? () => true : firewall }, (stream: NoiseSocket) => this.accept(stream));
      await server.listen(keyPair);
      // The same, through the relay: the companion key answers there behind the same firewall.
      this.reach.server.add({ keyPair, firewall, accept: (stream) => this.accept(stream, true) });
      await this.reach.start().catch((err: unknown) => this.logLine(`no relay: ${String(err)}`));
      this.reach.publishOn(node, () => [keyPair, ...this.pairing.keyPairs()]);
      this.node = node;
      this.server = server;
      return node;
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async shutdownNode(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const { node, server } = this;
    this.node = undefined;
    this.server = undefined;
    await this.reach.stop().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await node?.destroy().catch(() => undefined);
  }
}
