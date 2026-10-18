import type { Card } from '../keys.js';
import type { Body, Entry, Profile } from '../schemas.js';
import { bodyOf } from './entry.js';

/**
 * What a group's log adds up to: its name, who's in it, who's an admin, the sending keys and
 * the messages. Every copy applies the same entries in the same order (see byOrder) with the
 * same rules, so every member's Mac agrees on all of it:
 * - the creator is the first admin; only admins add or remove people and make admins;
 * - anyone may leave (remove themselves) and rename the group;
 * - entries by someone who isn't a member at that point in the order change nothing;
 * - if the last admin leaves, the longest-standing member becomes admin;
 * - someone removed can't write their way back in from an old copy (see buildModel).
 */

export interface Member {
  readonly card: Card;
  readonly name: string;
  readonly admin: boolean;
  /** Position of the entry that added them (older members first). */
  readonly since: number;
}

export interface Chain {
  readonly entry: Entry;
  readonly author: string;
  readonly basis: string;
  readonly body: Body<'sender_key'>;
  /** The highest message number used on it so far. */
  top: number;
}

/** How far a message number may jump ahead of the chain's last one. */
export const MAX_SKIP = 1_000;
/** The most people in one group (every change re-seals keys for each of them). */
export const MAX_MEMBERS = 100;

/** Chains are per author: `author:chain`. */
export const chainKey = (author: string, chain: string): string => `${author}:${chain}`;

export interface GroupModel {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly members: ReadonlyMap<string, Member>;
  /** Everyone who was ever added (names and keys for old messages). */
  readonly known: ReadonlyMap<string, Profile>;
  /** People removed (or who left), with the entry that did it. */
  readonly removed: ReadonlyMap<string, Entry>;
  /** The last change to who's in the group: sending keys made before it are replaced. */
  readonly basis: string;
  /** Sending keys by `author:chain` (see chainKey). */
  readonly chains: ReadonlyMap<string, Chain>;
  /** Messages by people who were members when they wrote them, in order. */
  readonly messages: readonly Entry[];
}

interface Draft {
  id: string;
  name: string;
  createdAt: number;
  members: Map<string, Member>;
  known: Map<string, Profile>;
  removed: Map<string, Entry>;
  basis: string;
  chains: Map<string, Chain>;
  messages: Entry[];
}

const isAdmin = (d: Draft, peerId: string): boolean => d.members.get(peerId)?.admin === true;

function ensureAdmin(d: Draft): void {
  const members = [...d.members.values()];
  if (!members.length || members.some((m) => m.admin)) return;
  const eldest = members.reduce((a, b) => (b.since < a.since ? b : a));
  d.members.set(eldest.card.peerId, { ...eldest, admin: true });
}

function applyMembership(d: Draft, e: Entry, index: number): void {
  switch (e.type) {
    case 'member_add': {
      const { member } = bodyOf(e, 'member_add');
      if (!isAdmin(d, e.author) || d.members.has(member.card.peerId) || d.members.size >= MAX_MEMBERS) return;
      d.members.set(member.card.peerId, { card: member.card, name: member.name, admin: false, since: index });
      d.known.set(member.card.peerId, member);
      d.removed.delete(member.card.peerId);
      d.basis = e.id;
      return;
    }
    case 'member_remove': {
      const { peerId } = bodyOf(e, 'member_remove');
      if (!d.members.has(peerId) || !(isAdmin(d, e.author) || e.author === peerId)) return;
      d.members.delete(peerId);
      d.removed.set(peerId, e);
      ensureAdmin(d);
      d.basis = e.id;
      return;
    }
    case 'admin_add':
    case 'admin_remove': {
      const { peerId } = bodyOf(e, e.type);
      const target = d.members.get(peerId);
      if (!target || !isAdmin(d, e.author)) return;
      d.members.set(peerId, { ...target, admin: e.type === 'admin_add' });
      ensureAdmin(d);
      return;
    }
    default:
  }
}

function apply(d: Draft, e: Entry, index: number): void {
  if (e.type === 'create') return;
  if (!d.members.has(e.author)) return;
  switch (e.type) {
    case 'rename':
      d.name = bodyOf(e, 'rename').name;
      return;
    case 'sender_key': {
      const body = bodyOf(e, 'sender_key');
      const key = chainKey(e.author, body.chain);
      // A chain id is the author's own: nobody can take over someone else's.
      if (!d.chains.has(key)) d.chains.set(key, { entry: e, author: e.author, basis: body.basis, body, top: -1 });
      return;
    }
    case 'message': {
      const body = bodyOf(e, 'message');
      const chain = d.chains.get(chainKey(e.author, body.chain));
      // Only on a chain of theirs, and not far ahead of their last message (each step costs a hash).
      if (!chain || body.n > chain.top + MAX_SKIP) return;
      chain.top = Math.max(chain.top, body.n);
      d.messages.push(e);
      return;
    }
    default:
      applyMembership(d, e, index);
  }
}

function run(ordered: readonly Entry[], skip: ReadonlySet<string>): Draft | undefined {
  const genesis = ordered[0];
  if (!genesis || genesis.type !== 'create') return undefined;
  const created = bodyOf(genesis, 'create');
  if (created.creator.card.peerId !== genesis.author) return undefined;
  const d: Draft = {
    id: genesis.id.slice(0, 32),
    name: created.name,
    createdAt: genesis.ts,
    members: new Map([[genesis.author, { card: created.creator.card, name: created.creator.name, admin: true, since: 0 }]]),
    known: new Map([[genesis.author, created.creator]]),
    removed: new Map(),
    basis: genesis.id,
    chains: new Map(),
    messages: [],
  };
  ordered.forEach((e, i) => {
    if (i > 0 && !skip.has(e.id)) apply(d, e, i);
  });
  return d;
}

/** The entry and everything it was written after. */
function ancestry(byId: ReadonlyMap<string, Entry>, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const p of byId.get(next)?.parents ?? []) stack.push(p);
  }
  return seen;
}

/** Entries by removed people that their removal didn't come after: written from a stale copy. */
function backdated(ordered: readonly Entry[], removed: ReadonlyMap<string, Entry>): Set<string> {
  const byId = new Map(ordered.map((e) => [e.id, e]));
  const out = new Set<string>();
  for (const [peerId, removal] of removed) {
    const before = ancestry(byId, removal.id);
    for (const e of ordered) if (e.author === peerId && !before.has(e.id)) out.add(e.id);
  }
  return out;
}

/**
 * Build the group from its entries, already in order (see byOrder). The first must create it.
 * Removal wins: once someone is out, what they wrote without having seen their removal (from
 * a copy that didn't have it yet, or on purpose) doesn't count, so nobody can write themselves
 * back in "before" they were removed.
 */
export function buildModel(ordered: readonly Entry[]): GroupModel | undefined {
  let skip = new Set<string>();
  let d = run(ordered, skip);
  // Dropping someone's entries can change who's removed: repeat until it settles (a few rounds at most).
  for (let round = 0; d && round < 4; round++) {
    const next = backdated(ordered, d.removed);
    if (next.size === skip.size && [...next].every((id) => skip.has(id))) break;
    skip = next;
    d = run(ordered, skip);
  }
  return d;
}
