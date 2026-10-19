/// <reference path="./modules.d.ts" />
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type DHT from 'hyperdht';
import type { BootstrapNode } from 'hyperdht';
import type { Identity } from '../crypto.js';
import { DmBook } from './dms.js';
import { checkMessage, filesNote, parseExtras } from './extras.js';
import { readJson, writeJson } from './files.js';
import { FriendBook } from './friends.js';
import { MAX_TEXT } from './groups/engine.js';
import { GroupHub } from './groups/hub.js';
import { InvitationBook, type InvitationRecord, newInvitation, parseTicket } from './invitations.js';
import { type MeshKeys, meshKeys } from './keys.js';
import { CLOSE, type MeshLink } from './link.js';
import { type Contacts, DEFAULT_TIMING, LinkManager, type LinkManagerOptions, type Timing } from './links.js';
import { type ViewContext, dmView, friendView, groupMessageView, groupView, invitationView } from './mesh-views.js';
import { PairingHost, pairWith } from './pairing.js';
import { ONLINE, current, loadPresence, savePresence, shown } from './presence.js';
import { NameSchema, type Profile } from './schemas.js';
import { type ChatExtras, type ChatFile, type FriendView, type GroupView, type InvitationView, type MessageView, type NetworkSummary, type Presence, dmConversation, groupConversation } from './views.js';
import { type LinkMessage, PROTO } from './wire.js';

/**
 * Your Mac on the klaud network: no server and no host. It listens at an address derived from
 * your identity, stays linked to your friends and the people in your groups (end-to-end
 * encrypted Noise links over the Hyperswarm DHT, relayed through a member's Mac when a direct
 * route can't be made), keeps your groups' logs in step, holds messages for friends who are
 * offline, and tells people your status.
 *
 * Files under `dir` (normally ~/.klaud): friends.json, invitations.json, outbox.json, dms/,
 * groups/, presence.json, reads.json. Keys never leave this process; what screens see is views.ts.
 */

export interface MeshOptions {
  readonly identity: Identity;
  readonly name: string;
  readonly dir: string;
  /** DHT bootstrap nodes (tests: a local testnet). Default: the public Hyperswarm network. */
  readonly bootstrap?: readonly BootstrapNode[];
  readonly host?: string;
  readonly timing?: Partial<Timing>;
  /** Relay tunnels for others and use them when direct links fail (default on). */
  readonly relay?: boolean;
  /** Tests: act as if there were no direct route to these people. */
  readonly blocked?: (peerId: string) => boolean;
}

/** What using an invitation got you. */
export type Accepted = { readonly kind: 'friend'; readonly peerId: string; readonly name: string } | { readonly kind: 'group'; readonly groupId: string; readonly name: string; readonly status: 'joined' | 'waiting' };

interface MeshEvents {
  /** Anything in the summary changed (people, presence, groups, invitations). */
  change: [];
  /** A message arrived, was sent, or changed status. */
  message: [MessageView];
  /** A gateway frame from a friend (core/gateway checks and answers it). */
  gateway: [string, unknown];
  /** A link to someone came up (what waited for them can go now). */
  link: [string];
  /** Someone's Claude started or stopped answering message `for` in a conversation. */
  live: [{ readonly conversation: string; readonly from: string; readonly for: string; readonly state: 'thinking' | 'idle' }];
  /** A chat file frame (f_get / f_data / f_err) from someone you're linked to (core/chat-files checks it). */
  file: [string, FileFrame];
}

/** The frames chat files travel in. */
export type FileFrame = Extract<LinkMessage, { t: 'f_get' | 'f_data' | 'f_err' }>;

const MAX_FRAME = 2 * 1024 * 1024;
const HISTORY_PAGE = 50;

export class Mesh extends EventEmitter<MeshEvents> {
  private readonly friends: FriendBook;
  private readonly invitations: InvitationBook;
  private readonly dms: DmBook;
  private readonly groups: GroupHub;
  private readonly links: LinkManager;
  private readonly pairing: PairingHost;
  private readonly timing: Timing;
  private presence: Presence;
  private readonly theirPresence = new Map<string, Presence>();
  private readonly helloNames = new Map<string, string>();
  private reads: Record<string, number>;
  private allowed = new Map<string, Profile>();
  private wanted = new Map<string, Profile>();
  private byAddress = new Map<string, string>();
  private ticker: NodeJS.Timeout | undefined;
  private untilTimer: NodeJS.Timeout | undefined;
  private closed = false;
  /** Who you're pulling chat files from now (set by core/chat/files.ts). */
  private filesFrom: (peerId: string) => boolean = () => false;

  private constructor(
    private readonly opts: MeshOptions,
    private readonly keys: MeshKeys,
    private readonly node: DHT,
    NoiseStream: LinkManagerOptions['NoiseStream'],
  ) {
    super();
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.friends = new FriendBook(path.join(opts.dir, 'friends.json'));
    this.invitations = new InvitationBook(path.join(opts.dir, 'invitations.json'));
    this.dms = new DmBook(opts.dir);
    this.presence = loadPresence(this.file('presence.json'));
    const reads = readJson(this.file('reads.json'));
    this.reads = reads && typeof reads === 'object' ? Object.fromEntries(Object.entries(reads).filter(([, v]) => typeof v === 'number' && Number.isInteger(v) && v >= 0)) : {};
    this.groups = new GroupHub({
      keys,
      dir: path.join(opts.dir, 'groups'),
      myName: () => this.opts.name,
      linkOf: (peerId) => this.links.get(peerId),
      linked: () => this.links.linked(),
      onChange: () => this.contactsChanged(),
      trusted: (peerId) => this.friends.has(peerId),
      onMessages: (groupId, entries) => {
        const engine = this.groups.get(groupId);
        for (const entry of entries) this.emit('message', groupMessageView(this.ctx, groupId, engine ? engine.readMessage(entry) : { entry }));
        this.emit('change');
      },
    });
    const contacts: Contacts = {
      byAddress: (address) => this.byAddress.get(address),
      addressOf: (peerId) => this.allowed.get(peerId)?.card.address,
      wanted: () => [...this.wanted.keys()],
      allows: (peerId) => this.allowed.has(peerId),
    };
    this.links = new LinkManager({
      node,
      NoiseStream,
      keyPair: keys.keyPair,
      contacts,
      timing: this.timing,
      maxBytes: MAX_FRAME,
      relay: opts.relay ?? true,
      ...(opts.blocked ? { blocked: opts.blocked } : {}),
      relaysFor: (peerId) => this.relaysFor(peerId),
      onLink: (link) => this.linkUp(link),
      onUnlink: (peerId) => {
        this.theirPresence.delete(peerId);
        this.emit('change');
      },
      onMessage: (link, msg) => this.onMessage(link, msg),
      wantsFiles: (peerId) => this.filesFrom(peerId),
    });
    this.pairing = new PairingHost({
      node,
      book: this.invitations,
      me: () => this.profile,
      timeoutMs: this.timing.pairTimeoutMs,
      decide: (record, profile) => {
        if (profile.card.peerId === this.peerId) return { ok: false, reason: "That's your own invitation" };
        if (record.kind === 'group') return this.groups.decideJoin(record, profile);
        this.friends.add(profile.card, profile.name);
        this.contactsChanged();
        return { ok: true, kind: 'friend' };
      },
      onChange: () => this.emit('change'),
    });
    this.rebuildContacts();
  }

  /** Join the network: listen at your address, reopen your invitations, link up with everyone. */
  static async start(opts: MeshOptions): Promise<Mesh> {
    NameSchema.parse(opts.name);
    const keys = await meshKeys(opts.identity);
    // Native networking code loads only when the network is turned on (as in p2p.ts).
    const [DHTClass, NoiseStream] = await Promise.all([import('hyperdht').then((m) => m.default), import('@hyperswarm/secret-stream').then((m) => m.default)]);
    const node = new DHTClass({ keyPair: keys.keyPair, ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}), ...(opts.host ? { host: opts.host } : {}) });
    const mesh = new Mesh(opts, keys, node, NoiseStream);
    try {
      await mesh.links.listen();
      await Promise.all(mesh.invitations.all().map((r) => mesh.pairing.listen(r)));
    } catch (err) {
      await mesh.close();
      throw err;
    }
    mesh.ticker = setInterval(() => mesh.tick(), mesh.timing.syncMs);
    mesh.ticker.unref();
    mesh.scheduleUntil();
    mesh.links.refresh();
    return mesh;
  }

  get peerId(): string {
    return this.keys.identity.peerId;
  }

  /** Your network address (hex public key): where friends' Macs find yours. */
  get address(): string {
    return this.keys.card.address;
  }

  get profile(): Profile {
    return { card: this.keys.card, name: this.opts.name };
  }

  /** Everything screens show, without messages and without secrets. */
  summary(): NetworkSummary {
    return {
      enabled: true,
      self: { peerId: this.peerId, name: this.opts.name, presence: current(this.presence), appearOffline: current(this.presence).state === 'offline' },
      friends: this.friendViews(),
      groups: this.groupViews(),
      invitations: this.invitations.all().map(invitationView),
      pendingJoins: this.groups.joins.allAsked().map((a) => ({ groupId: a.groupId, name: a.name, since: a.since })),
    };
  }

  // ---- friends

  /** A one-time invitation to be friends: a link (a day, or `ttlMs`) and a code (an hour, or less). */
  async createInvite(opts: { ttlMs?: number; codeTtlMs?: number } = {}): Promise<InvitationView> {
    const record = newInvitation('friend', { ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}), ...(opts.codeTtlMs ? { codeTtlMs: opts.codeTtlMs } : {}) });
    await this.openInvitation(record);
    this.emit('change');
    return invitationView(record);
  }

  async cancelInvite(id: string): Promise<void> {
    await this.pairing.stop(id);
  }

  /** Use a friend or group invitation (a klaud:// link or a code). */
  async accept(text: string): Promise<Accepted> {
    const ticket = parseTicket(text);
    if (!ticket) throw new Error('That isn’t a klaud invitation: paste the klaud:// link or type the code (like K7QM-4XPA-R2TD)');
    const result = await pairWith(this.node, this.keys.keyPair, this.profile, ticket, this.timing.pairTimeoutMs);
    if (result.profile.card.peerId === this.peerId) throw new Error("That's your own invitation");
    if (result.kind === 'friend') {
      this.friends.add(result.profile.card, result.profile.name);
      this.contactsChanged();
      return { kind: 'friend', peerId: result.profile.card.peerId, name: result.profile.name };
    }
    if (!result.group) throw new Error('The invitation did not say which group');
    this.groups.asked(result);
    this.contactsChanged();
    return { kind: 'group', groupId: result.group.id, name: result.group.name, status: result.group.status };
  }

  removeFriend(peerId: string): void {
    if (!this.friends.remove(peerId)) throw new Error('Not a friend');
    this.dms.forget(peerId);
    this.contactsChanged();
  }

  // ---- direct messages

  sendDm(peerId: string, text: string, extras?: ChatExtras): MessageView {
    if (!this.friends.has(peerId)) throw new Error('You can only message friends');
    checkMessage(text, extras, MAX_TEXT);
    const dm = this.dms.compose(this.peerId, peerId, text, extras);
    this.links.get(peerId)?.send(dmFrame(dm));
    const view = dmView(this.ctx, peerId, dm, this.dms.status(peerId));
    this.emit('message', view);
    this.emit('change');
    return view;
  }

  dmHistory(peerId: string, opts: { before?: number; limit?: number } = {}): MessageView[] {
    return page(this.dmMessages(peerId), opts);
  }

  // ---- groups

  createGroup(name: string, friendIds: readonly string[] = []): GroupView {
    const profiles = friendIds.map((id) => this.friendProfile(id));
    const engine = this.groups.create(NameSchema.parse(name), profiles);
    return this.groupViewOf(engine.id)!;
  }

  sendGroup(groupId: string, text: string, extras?: ChatExtras): MessageView {
    const entries = this.groups.apply(groupId, (e) => e.send(text, extras));
    return groupMessageView(this.ctx, groupId, { entry: entries.at(-1)!, text, ...(extras ? { extras } : {}) });
  }

  /** Write in a conversation (`dm:<peerId>` or `group:<id>`). */
  post(conversation: string, text: string, extras?: ChatExtras): MessageView {
    if (conversation.startsWith('dm:')) return this.sendDm(conversation.slice(3), text, extras);
    if (conversation.startsWith('group:')) return this.sendGroup(conversation.slice(6), text, extras);
    throw new Error('No such conversation');
  }

  /** A conversation's messages, oldest first (all of them: what Claudes read, what files were shared in). */
  conversation(conversation: string): MessageView[] {
    if (conversation.startsWith('dm:')) return this.friends.has(conversation.slice(3)) ? this.dmMessages(conversation.slice(3)) : [];
    if (conversation.startsWith('group:')) return this.groupMessages(conversation.slice(6));
    return [];
  }

  /** Conversations you can write in now: friends' and the groups you're in. */
  conversations(): string[] {
    return [...this.friends.all().map((f) => dmConversation(f.peerId)), ...this.groups.list().filter((g) => g.isMember()).map((g) => groupConversation(g.id))];
  }

  /** Is `peerId` in this conversation with you now (your friend for a DM; both of you members of a group)? */
  shares(conversation: string, peerId: string): boolean {
    if (peerId === this.peerId) return false;
    if (conversation.startsWith('dm:')) return conversation.slice(3) === peerId && this.friends.has(peerId);
    const engine = conversation.startsWith('group:') ? this.groups.get(conversation.slice(6)) : undefined;
    return Boolean(engine?.isMember() && engine.isMember(peerId));
  }

  /** The others in a conversation with you now. */
  peopleIn(conversation: string): string[] {
    if (conversation.startsWith('dm:')) return this.shares(conversation, conversation.slice(3)) ? [conversation.slice(3)] : [];
    const engine = conversation.startsWith('group:') ? this.groups.get(conversation.slice(6)) : undefined;
    if (!engine?.isMember()) return [];
    return [...(engine.model?.members.keys() ?? [])].filter((p) => p !== this.peerId);
  }

  /** Every file shared in your conversations, with where and by whom (oldest first). */
  sharedFiles(): Array<{ readonly conversation: string; readonly from: string; readonly file: ChatFile }> {
    return this.conversations().flatMap((c) => this.conversation(c).flatMap((m) => (m.files ?? []).map((file) => ({ conversation: c, from: m.from, file }))));
  }

  /** Tell the others in a conversation that your Claude is answering message `id` (or stopped). */
  sendLive(conversation: string, id: string, state: 'thinking' | 'idle'): void {
    const g = conversation.startsWith('group:') ? conversation.slice(6) : undefined;
    for (const peerId of this.peopleIn(conversation)) this.links.get(peerId)?.send({ t: 'live', ...(g ? { g } : {}), for: id, state });
  }

  /** Say who you're pulling chat files from (their pieces get the file allowance on the link). */
  pullingFrom(fn: (peerId: string) => boolean): void {
    this.filesFrom = fn;
  }

  /** Send a chat file frame to someone linked now; false when they're not. */
  sendFile(peerId: string, frame: FileFrame): boolean {
    const link = this.links.get(peerId);
    if (!link?.isOpen) return false;
    link.send(frame);
    return true;
  }

  groupHistory(groupId: string, opts: { before?: number; limit?: number } = {}): MessageView[] {
    return page(this.groupMessages(groupId), opts);
  }

  addMember(groupId: string, friendId: string): void {
    const profile = this.friendProfile(friendId);
    this.groups.apply(groupId, (e) => e.addMember(profile));
  }

  removeMember(groupId: string, peerId: string): void {
    this.groups.apply(groupId, (e) => e.removeMember(peerId));
  }

  setAdmin(groupId: string, peerId: string, admin: boolean): void {
    this.groups.apply(groupId, (e) => e.setAdmin(peerId, admin));
  }

  leaveGroup(groupId: string): void {
    this.groups.apply(groupId, (e) => e.removeMember(this.peerId));
  }

  renameGroup(groupId: string, name: string): void {
    const valid = NameSchema.parse(name);
    this.groups.apply(groupId, (e) => e.rename(valid));
  }

  /** A link (and code) to join a group; `auto`: people get in without an admin approving. */
  async groupInvite(groupId: string, opts: { auto?: boolean } = {}): Promise<InvitationView> {
    if (!this.groups.need(groupId).isAdmin()) throw new Error('Only admins can invite people');
    const record = newInvitation('group', { groupId, ...(opts.auto ? { auto: true } : {}) });
    await this.openInvitation(record);
    this.emit('change');
    return invitationView(record);
  }

  approve(groupId: string, peerId: string): void {
    if (!this.groups.need(groupId).isAdmin()) throw new Error('Only admins can let people in');
    this.groups.approve(groupId, peerId);
  }

  decline(groupId: string, peerId: string): void {
    this.groups.decline(groupId, peerId);
  }

  // ---- the gateway (tasks between Claudes ride on friends' links)

  isFriend(peerId: string): boolean {
    return this.friends.has(peerId);
  }

  isLinked(peerId: string): boolean {
    return Boolean(this.links.get(peerId)?.isOpen);
  }

  nameFor(peerId: string): string {
    return this.nameOf(peerId);
  }

  /** Hand a gateway frame to a friend's link; false when they're not linked now. */
  sendGateway(peerId: string, payload: unknown): boolean {
    const link = this.links.get(peerId);
    if (!link?.isOpen || !this.friends.has(peerId)) return false;
    link.send({ t: 'gw', p: payload });
    return true;
  }

  // ---- status and reading

  setPresence(next: Presence): Presence {
    this.presence = savePresence(this.file('presence.json'), next);
    this.broadcastPresence();
    this.scheduleUntil();
    this.emit('change');
    return this.presence;
  }

  getPresence(): Presence {
    return current(this.presence);
  }

  /** Mark a conversation read (`dm:<peerId>` or `group:<id>`). */
  markRead(conversation: string): void {
    const messages = conversation.startsWith('dm:') ? this.dmMessages(conversation.slice(3)) : conversation.startsWith('group:') ? this.groupMessages(conversation.slice(6)) : [];
    const count = messages.filter((m) => !m.mine).length;
    if (this.reads[conversation] === count) return;
    this.reads = { ...this.reads, [conversation]: count };
    writeJson(this.file('reads.json'), this.reads);
    this.emit('change');
  }

  /** The latest messages of every conversation (for a screen's first draw). */
  recent(limit = HISTORY_PAGE): Record<string, MessageView[]> {
    const out: Record<string, MessageView[]> = {};
    for (const f of this.friends.all()) out[dmConversation(f.peerId)] = this.dmMessages(f.peerId).slice(-limit);
    for (const g of this.groups.list()) out[groupConversation(g.id)] = this.groupMessages(g.id).slice(-limit);
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    clearTimeout(this.untilTimer);
    await this.pairing.close();
    await this.links.close();
    // Give close frames a moment to leave, then drop the node.
    await new Promise((r) => setTimeout(r, 30));
    await this.node.destroy({ force: true }).catch(() => undefined);
  }

  // ---- inside

  private async openInvitation(record: InvitationRecord): Promise<void> {
    this.invitations.add(record);
    try {
      await this.pairing.listen(record);
    } catch (err) {
      this.invitations.remove(record.id);
      throw err;
    }
  }

  private get ctx(): ViewContext {
    return {
      me: this.peerId,
      link: (peerId) => this.links.get(peerId),
      presenceOf: (peerId) => this.theirPresence.get(peerId),
      nameOf: (peerId) => this.nameOf(peerId),
      readCount: (conversation) => this.reads[conversation] ?? 0,
    };
  }

  private file(name: string): string {
    return path.join(this.opts.dir, name);
  }

  private nameOf(peerId: string): string {
    return this.friends.get(peerId)?.name ?? this.allowed.get(peerId)?.name ?? this.helloNames.get(peerId) ?? 'someone';
  }

  private friendProfile(peerId: string): Profile {
    const f = this.friends.get(peerId);
    if (!f) throw new Error('Add them as a friend first (or send them the group’s invite link)');
    return { card: f.card, name: f.name };
  }

  private dmMessages(peerId: string): MessageView[] {
    const status = this.dms.status(peerId);
    return this.dms.history(peerId).map((dm) => dmView(this.ctx, peerId, dm, status));
  }

  private groupMessages(groupId: string): MessageView[] {
    const engine = this.groups.get(groupId);
    return engine ? engine.messages().map((m) => groupMessageView(this.ctx, groupId, m)) : [];
  }

  private friendViews(): FriendView[] {
    return this.friends.all().map((f) => friendView(this.ctx, f, this.dmMessages(f.peerId)));
  }

  private groupViewOf(groupId: string): GroupView | undefined {
    const engine = this.groups.get(groupId);
    return engine ? groupView(this.ctx, engine, this.groupMessages(groupId), this.groups.joins.requestsFor(groupId)) : undefined;
  }

  private groupViews(): GroupView[] {
    return this.groups.list().flatMap((g) => this.groupViewOf(g.id) ?? []);
  }

  private rebuildContacts(): void {
    const fromGroups = this.groups.people();
    const wanted = new Map<string, Profile>();
    const allowed = new Map<string, Profile>();
    const byAddress = new Map<string, string>();
    // One address, one person: friends first, so a card naming someone else's address can't take it over.
    const admit = (profile: Profile, want: boolean): void => {
      const { peerId, address } = profile.card;
      if (peerId === this.peerId || address === this.address || allowed.has(peerId)) return;
      if (byAddress.has(address)) return;
      byAddress.set(address, peerId);
      allowed.set(peerId, profile);
      if (want) wanted.set(peerId, profile);
    };
    for (const f of this.friends.all()) admit({ card: f.card, name: f.name }, true);
    for (const p of fromGroups.wanted.values()) admit(p, true);
    for (const p of fromGroups.allowed.values()) admit(p, false);
    this.wanted = wanted;
    this.allowed = allowed;
    this.byAddress = byAddress;
  }

  private contactsChanged(): void {
    this.rebuildContacts();
    if (!this.closed) this.links.refresh();
    this.emit('change');
  }

  /** Tunnel candidates for someone: people who share a group with them first. */
  private relaysFor(peerId: string): string[] {
    return this.groups
      .list()
      .filter((g) => g.isMember(peerId))
      .flatMap((g) => [...(g.model?.members.keys() ?? [])])
      .filter((p) => p !== peerId && p !== this.peerId);
  }

  private linkUp(link: MeshLink): void {
    link.send({ t: 'hello', proto: PROTO, name: this.opts.name, presence: shown(this.presence) });
    this.groups.linkUp(link);
    for (const dm of this.dms.waiting(link.peerId)) link.send(dmFrame(dm));
    this.emit('link', link.peerId);
    this.emit('change');
  }

  private onMessage(link: MeshLink, msg: LinkMessage): void {
    if (this.groups.handle(link, msg)) return;
    const from = link.peerId;
    switch (msg.t) {
      case 'hello':
        if (Math.floor(msg.proto) !== PROTO) {
          link.close(CLOSE.version, 'different protocol version');
          return;
        }
        // The name they go by now (shown for people in your groups; friends keep the name you know them by).
        this.helloNames.set(from, msg.name);
        this.theirPresence.set(from, msg.presence);
        this.emit('change');
        return;
      case 'presence':
        this.theirPresence.set(from, msg.presence);
        this.emit('change');
        return;
      case 'dm': {
        if (!this.friends.has(from)) return;
        const x = parseExtras(msg.x);
        if (!msg.text.trim() && !x?.files?.length) return;
        const text = x?.files?.length && msg.text === filesNote(x.files) ? '' : msg.text;
        const dm = { id: msg.id, from, to: this.peerId, text, ts: msg.ts, ...(x ? { x } : {}) };
        if (this.dms.receive(dm)) {
          this.emit('message', dmView(this.ctx, from, dm, this.dms.status(from)));
          this.emit('change');
        }
        link.send({ t: 'dm_ack', id: msg.id });
        return;
      }
      case 'gw':
        if (this.friends.has(from)) this.emit('gateway', from, msg.p);
        return;
      case 'live': {
        const conversation = msg.g ? groupConversation(msg.g) : dmConversation(from);
        if (this.shares(conversation, from)) this.emit('live', { conversation, from, for: msg.for, state: msg.state });
        return;
      }
      case 'f_get':
      case 'f_data':
      case 'f_err':
        this.emit('file', from, msg);
        return;
      case 'dm_ack': {
        const dm = this.dms.delivered(from, msg.id);
        if (dm) {
          this.emit('message', dmView(this.ctx, from, dm, this.dms.status(from)));
          this.emit('change');
        }
        return;
      }
      default:
    }
  }

  private broadcastPresence(): void {
    const presence = shown(this.presence);
    for (const link of this.links.linked()) link.send({ t: 'presence', presence });
  }

  /** A status with an end time goes back to online by itself. */
  private scheduleUntil(): void {
    clearTimeout(this.untilTimer);
    const until = this.presence.until;
    if (until === undefined || this.closed) return;
    this.untilTimer = setTimeout(() => {
      if (this.presence.until !== until) return;
      this.presence = savePresence(this.file('presence.json'), ONLINE);
      this.broadcastPresence();
      this.emit('change');
    }, Math.max(0, until - Date.now()));
    this.untilTimer.unref();
  }

  private tick(): void {
    if (this.closed) return;
    this.groups.tick();
    for (const dm of this.dms.expire()) this.emit('message', dmView(this.ctx, dm.to, dm, this.dms.status(dm.to)));
    this.links.refresh();
  }
}

/** A direct message as it goes over the link. */
const dmFrame = (dm: { id: string; text: string; ts: number; x?: ChatExtras }): LinkMessage => ({ t: 'dm', id: dm.id, text: dm.text.trim() || !dm.x?.files?.length ? dm.text : filesNote(dm.x.files), ts: dm.ts, ...(dm.x ? { x: dm.x } : {}) });

/** A page of a conversation: the `limit` messages before `before` (default: the latest). */
function page(messages: readonly MessageView[], opts: { before?: number; limit?: number }): MessageView[] {
  const before = opts.before;
  const upTo = before === undefined ? messages.length : messages.findIndex((m) => m.ts >= before);
  const end = upTo < 0 ? messages.length : upTo;
  const limit = Math.min(Math.max(opts.limit ?? HISTORY_PAGE, 1), 500);
  return messages.slice(Math.max(0, end - limit), end);
}
