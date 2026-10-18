import { readdirSync } from 'node:fs';
import path from 'node:path';
import { canonical } from '../files.js';
import type { InvitationRecord } from '../invitations.js';
import type { MeshKeys } from '../keys.js';
import type { MeshLink } from '../link.js';
import type { PairResult, PairingDecision } from '../pairing.js';
import type { Entry, Profile } from '../schemas.js';
import type { LinkMessage } from '../wire.js';
import { GroupEngine } from './engine.js';
import { JOIN_TTL_MS, Joins } from './joins.js';
import { GroupLog, PROBE_PENDING_BYTES } from './log.js';

/**
 * All your groups on this Mac, and keeping them in step with the other members:
 * - when a link comes up (and every so often), each side says what its newest entries are
 *   (`g_heads`); whoever is missing something asks (`g_sync`) and gets it oldest first, in
 *   bounded batches (`g_entries`), so coming back after a week catches up from anyone online;
 * - anything new (written here or received) is passed on to every linked member except the
 *   one it came from (gossip), so it reaches people you can't link to directly.
 * Entries are only sent to people who are members (someone removed only learns of their removal).
 */

const BATCH = 200;
const BATCH_BYTES = 512 * 1024;
const MAX_PROBES = 20;
const MAX_PROBES_PER_PEER = 4;
/** A group being fetched that never turned out to include you is dropped after this long. */
const PROBE_TTL_MS = 2 * 60 * 1000;
/** The most groups one Mac keeps. */
const MAX_GROUPS = 500;

interface Probe {
  readonly engine: GroupEngine;
  readonly from: string;
  readonly at: number;
}

export interface GroupHubOptions {
  readonly keys: MeshKeys;
  readonly dir: string;
  readonly myName: () => string;
  readonly linkOf: (peerId: string) => MeshLink | undefined;
  readonly linked: () => readonly MeshLink[];
  /** Who's in a group, its name or the requests changed (contacts may need a refresh). */
  readonly onChange: () => void;
  /** New messages in a group (written here or received). */
  readonly onMessages: (groupId: string, entries: readonly Entry[]) => void;
  /** Someone who may put you in a group without you asking (a friend). */
  readonly trusted: (peerId: string) => boolean;
}

export class GroupHub {
  private readonly engines = new Map<string, GroupEngine>();
  /** Groups someone says you're in, being fetched before they're kept. */
  private readonly probes = new Map<string, Probe>();
  readonly joins: Joins;

  constructor(private readonly opts: GroupHubOptions) {
    this.joins = new Joins(path.join(opts.dir, 'joins.json'));
    let files: string[] = [];
    try {
      files = readdirSync(opts.dir).filter((f) => /^[0-9a-f]{32}\.jsonl$/.test(f));
    } catch {
      // No groups yet.
    }
    for (const f of files) {
      const id = f.slice(0, 32);
      const engine = new GroupEngine(opts.keys, GroupLog.load(id, this.file(id)));
      if (engine.model) this.engines.set(id, engine);
    }
  }

  list = (): GroupEngine[] => [...this.engines.values()];
  get = (id: string): GroupEngine | undefined => this.engines.get(id);

  need(id: string): GroupEngine {
    const engine = this.engines.get(id);
    if (!engine) throw new Error('No such group');
    return engine;
  }

  create(name: string, members: readonly Profile[]): GroupEngine {
    const engine = GroupEngine.create(this.opts.keys, name, this.opts.myName(), (id) => this.file(id));
    this.engines.set(engine.id, engine);
    for (const m of members) engine.addMember(m);
    this.gossip(engine, engine.log.ordered());
    this.opts.onChange();
    return engine;
  }

  /** Change a group as you (add, remove, rename, send…), then pass it on. */
  apply(id: string, change: (engine: GroupEngine) => Entry | readonly Entry[]): Entry[] {
    const engine = this.need(id);
    const out = change(engine);
    const entries = Array.isArray(out) ? [...out] : [out as Entry];
    this.gossip(engine, entries);
    this.settled(engine, entries);
    return entries;
  }

  /**
   * People to stay linked with (members of groups you're in, admins you asked to join), and
   * people to let in without dialing them (recently removed, so they can learn of it).
   */
  people(): { wanted: Map<string, Profile>; allowed: Map<string, Profile> } {
    const wanted = new Map<string, Profile>();
    const allowed = new Map<string, Profile>();
    const me = this.opts.keys.identity.peerId;
    for (const engine of this.engines.values()) {
      const model = engine.model;
      if (!model || !engine.isMember()) continue;
      for (const m of model.members.values()) if (m.card.peerId !== me) wanted.set(m.card.peerId, { card: m.card, name: m.name });
      for (const [peerId, entry] of model.removed) {
        const profile = model.known.get(peerId);
        if (profile && peerId !== me && entry.ts + JOIN_TTL_MS > Date.now()) allowed.set(peerId, profile);
      }
    }
    for (const a of this.joins.allAsked()) wanted.set(a.inviter.card.peerId, a.inviter);
    for (const [k, v] of wanted) allowed.set(k, v);
    return { wanted, allowed };
  }

  /** An invitation to one of your groups was used: let them in, or keep their request for an admin. */
  decideJoin(record: InvitationRecord, profile: Profile): PairingDecision {
    const engine = record.groupId ? this.engines.get(record.groupId) : undefined;
    if (!engine?.model || !engine.isMember()) return { ok: false, reason: "That group isn't here any more" };
    const group = { id: engine.id, name: engine.model.name };
    if (engine.isMember(profile.card.peerId)) return { ok: true, kind: 'group', group: { ...group, status: 'joined' } };
    // Someone who was removed needs an admin to let them back in, even with an automatic link.
    if (record.auto && engine.isAdmin() && !engine.model.removed.has(profile.card.peerId)) {
      this.apply(engine.id, (e) => e.addMember(profile));
      return { ok: true, kind: 'group', group: { ...group, status: 'joined' } };
    }
    this.joins.request({ groupId: engine.id, profile, ts: Date.now() });
    this.opts.onChange();
    return { ok: true, kind: 'group', group: { ...group, status: 'waiting' } };
  }

  approve(groupId: string, peerId: string): void {
    const request = this.joins.requestsFor(groupId).find((r) => r.profile.card.peerId === peerId);
    if (!request) throw new Error('Nobody by that name is waiting to join');
    if (!this.need(groupId).isMember(peerId)) this.apply(groupId, (e) => e.addMember(request.profile));
    this.joins.settle(groupId, peerId);
    this.opts.onChange();
  }

  decline(groupId: string, peerId: string): void {
    this.joins.settle(groupId, peerId);
    this.opts.onChange();
  }

  /** You used a group invitation: remember the admin to fetch the group from once you're in. */
  asked(result: PairResult): void {
    if (!result.group || this.engines.get(result.group.id)?.isMember()) return;
    this.joins.ask({ groupId: result.group.id, name: result.group.name, inviter: result.profile, since: Date.now() });
    this.opts.onChange();
  }

  /** A link came up: compare notes on every group you share. */
  linkUp(link: MeshLink): void {
    for (const engine of this.engines.values()) if (this.mayHear(engine, link.peerId)) this.sendHeads(engine, link);
    // Groups you asked to join: ask the admin for everything, in case you're in now.
    for (const a of this.joins.allAsked()) if (a.inviter.card.peerId === link.peerId) link.send({ t: 'g_sync', group: a.groupId, heads: [] });
  }

  /** Every so often: tell linked members what you have (catches anything gossip missed). */
  tick(): void {
    for (const [id, p] of this.probes) if (Date.now() - p.at > PROBE_TTL_MS) this.probes.delete(id);
    for (const link of this.opts.linked()) this.linkUp(link);
  }

  handle(link: MeshLink, msg: LinkMessage): boolean {
    switch (msg.t) {
      case 'g_heads': {
        const engine = this.engines.get(msg.group) ?? this.probe(msg.group, link.peerId);
        if (engine && msg.heads.some((h) => !engine.log.has(h))) link.send({ t: 'g_sync', group: msg.group, heads: engine.log.heads().slice(0, 64) });
        return true;
      }
      case 'g_sync':
        this.serveSync(link, msg.group, msg.heads);
        return true;
      case 'g_entries':
        this.receive(link, msg.group, msg.entries, msg.more === true);
        return true;
      default:
        return false;
    }
  }

  private file(id: string): string {
    return path.join(this.opts.dir, `${id}.jsonl`);
  }

  /** Someone may be sent this group's entries: a member, or someone recently removed (up to their removal). */
  private mayHear(engine: GroupEngine, peerId: string): boolean {
    return engine.isMember() && (engine.isMember(peerId) || engine.model?.removed.has(peerId) === true);
  }

  private sendHeads(engine: GroupEngine, link: MeshLink): void {
    link.send({ t: 'g_heads', group: engine.id, heads: engine.log.heads().slice(0, 64) });
  }

  /**
   * Start fetching a group you don't have: one you asked to join (from its admin), or one a
   * friend put you in. Bounded, and dropped if it never turns out to include you.
   */
  private probe(groupId: string, from: string): GroupEngine | undefined {
    const known = this.probes.get(groupId);
    if (known) return known.from === from ? known.engine : undefined;
    const asked = this.joins.askedFor(groupId)?.inviter.card.peerId === from;
    if (!asked && !this.opts.trusted(from)) return undefined;
    const fromPeer = [...this.probes.values()].filter((p) => p.from === from).length;
    if (this.probes.size >= MAX_PROBES || fromPeer >= MAX_PROBES_PER_PEER || this.engines.size >= MAX_GROUPS) return undefined;
    const engine = new GroupEngine(this.opts.keys, new GroupLog(groupId, undefined, PROBE_PENDING_BYTES));
    this.probes.set(groupId, { engine, from, at: Date.now() });
    return engine;
  }

  private serveSync(link: MeshLink, groupId: string, heads: readonly string[]): void {
    const engine = this.engines.get(groupId);
    if (!engine || !this.mayHear(engine, link.peerId)) return;
    const removal = engine.isMember(link.peerId) ? undefined : engine.model?.removed.get(link.peerId)?.id;
    const { entries, more } = engine.log.missingFor(heads, BATCH, removal);
    let bytes = 0;
    const batch = entries.filter((e) => (bytes += canonical(e).length) <= BATCH_BYTES || e === entries[0]);
    if (batch.length || more) link.send({ t: 'g_entries', group: groupId, entries: batch, more: more || batch.length < entries.length });
  }

  private receive(link: MeshLink, groupId: string, raws: readonly unknown[], more: boolean): void {
    // A group you don't have yet may be one you were just added to: fetch it (kept only if you're in it).
    const engine = this.engines.get(groupId) ?? this.probe(groupId, link.peerId);
    if (!engine) return;
    const { added } = engine.ingest(raws);
    if (more || engine.log.missing().length) link.send({ t: 'g_sync', group: groupId, heads: engine.log.heads().slice(0, 64) });
    if (!added.length) return;
    if (this.probes.get(groupId)?.engine === engine) {
      this.adoptProbe(engine);
      return;
    }
    this.gossip(engine, added, link.peerId);
    this.settled(engine, added);
  }

  /** A fetched group you turn out to be in is kept from now on. */
  private adoptProbe(probe: GroupEngine): void {
    if (!probe.model || !probe.isMember() || probe.log.missing().length) return;
    this.probes.delete(probe.id);
    const engine = new GroupEngine(this.opts.keys, probe.log.persistTo(this.file(probe.id)));
    this.engines.set(engine.id, engine);
    this.joins.joined(engine.id);
    this.settled(engine, engine.log.ordered());
    for (const link of this.opts.linked()) if (this.mayHear(engine, link.peerId)) this.sendHeads(engine, link);
  }

  private settled(engine: GroupEngine, entries: readonly Entry[]): void {
    const messages = entries.filter((e) => e.type === 'message');
    if (messages.length) this.opts.onMessages(engine.id, messages);
    if (entries.some((e) => e.type !== 'message' && e.type !== 'sender_key')) this.opts.onChange();
  }

  /** Pass entries on to every linked member (except where they came from). */
  private gossip(engine: GroupEngine, entries: readonly Entry[], except?: string): void {
    if (!entries.length) return;
    for (const link of this.opts.linked()) {
      if (link.peerId === except) continue;
      if (engine.isMember(link.peerId)) {
        for (let i = 0; i < entries.length; i += BATCH) link.send({ t: 'g_entries', group: engine.id, entries: entries.slice(i, i + BATCH) });
      } else if (engine.model?.removed.has(link.peerId)) {
        // They were just removed: let them know (they get nothing after it).
        this.sendHeads(engine, link);
      }
    }
  }
}
