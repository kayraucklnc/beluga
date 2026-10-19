import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../../src/net/crypto.js';
import { type MeshKeys, meshKeys, verifyCard } from '../../src/net/mesh/keys.js';
import { GroupEngine } from '../../src/net/mesh/groups/engine.js';
import { signEntry } from '../../src/net/mesh/groups/entry.js';
import { GroupLog } from '../../src/net/mesh/groups/log.js';
import type { Profile } from '../../src/net/mesh/schemas.js';

const person = async (name: string): Promise<{ keys: MeshKeys; profile: Profile }> => {
  const keys = await meshKeys(generateIdentity());
  return { keys, profile: { card: keys.card, name } };
};

/** A copy of a group on someone else's Mac, filled with everything `from` has. */
const copyOf = (keys: MeshKeys, from: GroupEngine): GroupEngine => {
  const engine = new GroupEngine(keys, new GroupLog(from.id));
  engine.ingest(from.log.ordered());
  return engine;
};

const sync = (a: GroupEngine, b: GroupEngine): void => {
  b.ingest(a.log.missingFor(b.log.heads(), 10_000).entries);
  a.ingest(b.log.missingFor(a.log.heads(), 10_000).entries);
};

const texts = (g: GroupEngine): (string | undefined)[] => g.messages().map((m) => m.text);

describe('mesh keys', () => {
  it('are the same every time for the same identity, and the card checks out', async () => {
    const identity = generateIdentity();
    const a = await meshKeys(identity);
    const b = await meshKeys(identity);
    expect(a.card).toEqual(b.card);
    expect(a.keyPair.publicKey.toString('hex')).toBe(a.card.address);
    expect(verifyCard(a.card)).toBe(true);
    expect(verifyCard({ ...a.card, address: 'ab'.repeat(32) })).toBe(false);
    const other = await meshKeys(generateIdentity());
    expect(verifyCard({ ...a.card, publicKey: other.card.publicKey })).toBe(false);
  });
});

describe('group log', () => {
  it('merges concurrent writes the same way on every copy', async () => {
    const [ann, bob, cat] = await Promise.all([person('ann'), person('bob'), person('cat')]);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    a.addMember(bob.profile);
    a.addMember(cat.profile);
    const b = copyOf(bob.keys, a);
    const c = copyOf(cat.keys, a);
    // Everyone writes at once, without seeing each other.
    a.send('from ann');
    b.send('from bob');
    c.send('from cat');
    a.rename('ann names it');
    b.rename('bob names it');
    // Different sync orders…
    sync(a, b);
    sync(b, c);
    sync(c, a);
    sync(a, b);
    // …same log, same order, same group.
    const order = (g: GroupEngine): string[] => g.log.ordered().map((e) => e.id);
    expect(order(b)).toEqual(order(a));
    expect(order(c)).toEqual(order(a));
    expect(b.model!.name).toBe(a.model!.name);
    expect(c.model!.name).toBe(a.model!.name);
    expect(texts(a).sort()).toEqual(['from ann', 'from bob', 'from cat']);
    expect(texts(b)).toEqual(texts(a));
    expect(texts(c)).toEqual(texts(a));
  });

  it('settles conflicting removals by the shared order: the first one wins', async () => {
    const [ann, bob, cat] = await Promise.all([person('ann'), person('bob'), person('cat')]);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    a.addMember(bob.profile);
    a.addMember(cat.profile);
    a.setAdmin(bob.keys.identity.peerId, true);
    const b = copyOf(bob.keys, a);
    // Two admins remove each other at the same time.
    a.removeMember(bob.keys.identity.peerId);
    b.removeMember(ann.keys.identity.peerId);
    sync(a, b);
    const c = copyOf(cat.keys, a);
    const members = (g: GroupEngine): string[] => [...g.model!.members.keys()].sort();
    expect(members(a)).toEqual(members(b));
    expect(members(c)).toEqual(members(a));
    expect(members(a)).toHaveLength(2);
    // Someone is still an admin.
    expect([...a.model!.members.values()].some((m) => m.admin)).toBe(true);
  });

  it("ignores what non-admins do to membership, and what outsiders write", async () => {
    const [ann, bob, eve] = await Promise.all([person('ann'), person('bob'), person('eve')]);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    a.addMember(bob.profile);
    const b = copyOf(bob.keys, a);
    // bob isn't an admin: his add does nothing once it reaches anyone.
    b.write('member_add', { member: eve.profile });
    sync(a, b);
    expect(a.isMember(eve.keys.identity.peerId)).toBe(false);
    expect(() => b.addMember(eve.profile)).toThrow(/Only admins/);
  });

  it('refuses tampered and forged entries', async () => {
    const [ann, bob, eve] = await Promise.all([person('ann'), person('bob'), person('eve')]);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    a.addMember(bob.profile);
    const [, msg] = a.send('hello');
    const fresh = new GroupEngine(bob.keys, new GroupLog(a.id));
    const entries = a.log.ordered();
    // A changed body: the id no longer matches.
    const changed = { ...msg!, body: { ...(msg!.body as object), n: 5 } };
    expect(fresh.ingest([...entries.filter((e) => e.id !== msg!.id), changed]).rejected).toBe(1);
    // A re-hashed entry signed by someone else in ann's name.
    const forged = signEntry(eve.keys.identity, { ...msg!, author: ann.keys.identity.peerId, body: msg!.body });
    expect(fresh.ingest([forged]).rejected).toBe(1);
    // A wrong Lamport clock.
    const skewed = signEntry(ann.keys.identity, { group: a.id, author: ann.keys.identity.peerId, lamport: 99, parents: [entries[0]!.id], type: 'rename', ts: 1, body: { name: 'x' } });
    expect(fresh.ingest([skewed]).rejected).toBe(1);
    // Another group's entry.
    const other = GroupEngine.create(ann.keys, 'other', 'ann');
    expect(fresh.ingest([other.log.ordered()[0]]).rejected).toBe(1);
    // The genuine message is accepted and readable.
    fresh.ingest([msg]);
    expect(texts(fresh)).toEqual(['hello']);
  });

  it('keeps out-of-order entries until their parents arrive', async () => {
    const [ann, bob] = await Promise.all([person('ann'), person('bob')]);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    a.addMember(bob.profile);
    a.send('one');
    a.send('two');
    const all = a.log.ordered();
    const b = new GroupEngine(bob.keys, new GroupLog(a.id));
    expect(b.ingest([...all].reverse().slice(0, 2)).added).toHaveLength(0);
    expect(b.log.missing().length).toBeGreaterThan(0);
    expect(b.ingest(all).added).toHaveLength(all.length);
    expect(texts(b)).toEqual(['one', 'two']);
  });

  it("rotates keys when someone is removed: they can't read what comes after", async () => {
    const [ann, bob, cat] = await Promise.all([person('ann'), person('bob'), person('cat')]);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    a.addMember(bob.profile);
    a.addMember(cat.profile);
    a.send('before');
    const b = copyOf(bob.keys, a);
    expect(texts(b)).toEqual(['before']);
    a.removeMember(bob.keys.identity.peerId);
    const sent = a.send('after');
    expect(sent[0]!.type).toBe('sender_key');
    // Even if bob got every entry, he couldn't read the new one.
    b.ingest(a.log.ordered());
    expect(texts(b)).toEqual(['before', undefined]);
    expect(b.read(sent[1]!)).toBeUndefined();
    const c = copyOf(cat.keys, a);
    expect(texts(c)).toEqual(['before', 'after']);
  });

  it('a new member reads what is sent after they join', async () => {
    const [ann, bob] = await Promise.all([person('ann'), person('bob')]);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    a.send('private');
    a.addMember(bob.profile);
    a.send('welcome');
    const b = copyOf(bob.keys, a);
    expect(texts(b)).toEqual([undefined, 'welcome']);
  });

  it('survives a restart from its file, and can keep sending', async () => {
    const [ann, bob] = await Promise.all([person('ann'), person('bob')]);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-log-'));
    const file = (id: string): string => path.join(dir, `${id}.jsonl`);
    const a = GroupEngine.create(ann.keys, 'team', 'ann', file);
    a.addMember(bob.profile);
    a.send('one');
    const again = new GroupEngine(ann.keys, GroupLog.load(a.id, file(a.id)));
    expect(again.log.size).toBe(a.log.size);
    expect(again.send('two')).toHaveLength(1); // same chain: no new key needed
    expect(texts(again)).toEqual(['one', 'two']);
    const ns = again.messages().map((m) => (m.entry.body as { n: number }).n);
    expect(ns).toEqual([0, 1]);
  });
});


describe('group log against a hostile member', () => {
  it("a removed admin can't write themselves (or a friend) back in from an old copy", async () => {
    const [ann, bob, cat, eve] = await Promise.all([person('ann'), person('bob'), person('cat'), person('eve')]);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    a.addMember(bob.profile);
    a.addMember(cat.profile);
    a.setAdmin(bob.keys.identity.peerId, true);
    const staleBob = copyOf(bob.keys, a);
    a.removeMember(bob.keys.identity.peerId);
    // bob, from his copy without the removal, adds eve and makes her an admin, and writes a message.
    staleBob.addMember(eve.profile);
    staleBob.setAdmin(eve.keys.identity.peerId, true);
    staleBob.send('back-dated');
    sync(a, staleBob);
    expect(a.isMember(eve.keys.identity.peerId)).toBe(false);
    expect(a.isMember(bob.keys.identity.peerId)).toBe(false);
    expect(texts(a)).toEqual([]);
    // The next key ann makes is sealed only for the real members.
    const [keyEntry] = a.send('real');
    expect(Object.keys((keyEntry!.body as { keys: object }).keys).sort()).toEqual([ann.keys.identity.peerId, cat.keys.identity.peerId].sort());
    const c = copyOf(cat.keys, a);
    expect([...c.model!.members.keys()].sort()).toEqual([...a.model!.members.keys()].sort());
  });

  it("a member can't take over someone else's sending key", async () => {
    const [ann, bob, cat] = await Promise.all([person('ann'), person('bob'), person('cat')]);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    a.addMember(bob.profile);
    a.addMember(cat.profile);
    const [annKey] = a.send('from ann');
    const b = copyOf(bob.keys, a);
    const annChain = (annKey!.body as { chain: string }).chain;
    b.write('sender_key', { chain: annChain, basis: b.model!.basis, keys: {} });
    sync(a, b);
    const c = copyOf(cat.keys, a);
    expect(texts(c)).toEqual(['from ann']);
    a.send('still readable');
    sync(a, c);
    expect(texts(c)).toEqual(['from ann', 'still readable']);
  });

  it('ignores message numbers far ahead of the chain (each step costs a hash)', async () => {
    const [ann, bob] = await Promise.all([person('ann'), person('bob')]);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    a.addMember(bob.profile);
    const [keyEntry] = a.send('first');
    const chain = (keyEntry!.body as { chain: string }).chain;
    const huge = a.write('message', { chain, n: 999_999, iv: 'AAAAAAAAAAAAAAAA', ct: 'AA==', tag: 'AAAAAAAAAAAAAAAAAAAAAA==' });
    expect(a.model!.messages.some((m) => m.id === huge.id)).toBe(false);
    const started = Date.now();
    expect(copyOf(bob.keys, a).messages().map((m) => m.text)).toEqual(['first']);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a plain member can't conjure up new authors", async () => {
    const [ann, bob, eve] = await Promise.all([person('ann'), person('bob'), person('eve')]);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    a.addMember(bob.profile);
    const b = copyOf(bob.keys, a);
    b.write('member_add', { member: eve.profile });
    sync(a, b);
    // eve's entries can't even be checked on ann's copy: they wait, unkept.
    const fake = signEntry(eve.keys.identity, { group: a.id, author: eve.keys.identity.peerId, lamport: a.log.ordered().at(-1)!.lamport + 1, parents: a.log.heads(), type: 'rename', ts: 1, body: { name: 'pwned' } });
    expect(a.ingest([fake]).added).toEqual([]);
    expect(a.log.has(fake.id)).toBe(false);
  });

  it('refuses cards with an unusable box key, and absurdly nested entries', async () => {
    const ann = await person('ann');
    expect(verifyCard({ ...ann.keys.card, box: '00'.repeat(32) })).toBe(false);
    const a = GroupEngine.create(ann.keys, 'team', 'ann');
    let deep: unknown = 'x';
    for (let i = 0; i < 10_000; i++) deep = [deep];
    const nested = { ...a.log.ordered()[0]!, body: { name: 'n', creator: ann.profile, nonce: 'x', extra: deep } };
    expect(new GroupEngine(ann.keys, new GroupLog(a.id)).ingest([nested]).rejected).toBe(1);
  });
});
