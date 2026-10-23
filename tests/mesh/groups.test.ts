import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { groupConversation } from '../../src/net/mesh/views.js';
import type { MeshLink } from '../../src/net/mesh/link.js';
import { type Crowd, FAST, type Person, befriend, crowd, settle, texts } from './helpers.js';

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

const id = (p: Person): string => p.identity.peerId;

/** ann and four people she's friends with (who don't know each other), in one group. */
async function team(names: readonly string[]): Promise<{ people: Person[]; groupId: string }> {
  const people = await Promise.all(names.map((n) => net.add(n)));
  const [admin, ...rest] = people as [Person, ...Person[]];
  for (const p of rest) await befriend(admin, p);
  const group = admin.mesh.createGroup('launch', rest.map(id));
  // Everyone gets the group and links up with everyone else in it (they were strangers).
  for (const p of rest) await settle(() => p.group(group.id)?.active);
  for (const p of people) await settle(() => p.group(group.id)?.members.every((m) => m.online));
  return { people, groupId: group.id };
}

describe('groups without a host', () => {
  it('a group of five: everyone gets everyone’s messages; offline members catch up from anyone; it survives restarts', async () => {
    const { people, groupId } = await team(['ann', 'bob', 'cat', 'dan', 'eve']);
    const [ann, bob, cat, dan, eve] = people as [Person, Person, Person, Person, Person];
    expect(bob.group(groupId)).toMatchObject({ name: 'launch', admin: false, active: true });
    expect(bob.group(groupId)?.members.map((m) => m.name).sort()).toEqual(['ann', 'bob', 'cat', 'dan', 'eve']);
    expect(ann.group(groupId)?.members.find((m) => m.self)?.admin).toBe(true);

    for (const p of people) p.mesh.sendGroup(groupId, `hi from ${p.name}`);
    const all = people.map((p) => `hi from ${p.name}`).sort();
    for (const p of people) await settle(() => texts(p, groupId).length === 5);
    for (const p of people) expect(texts(p, groupId).sort()).toEqual(all);
    // Every copy has the same order.
    const order = texts(ann, groupId);
    for (const p of people) expect(texts(p, groupId)).toEqual(order);

    // dan goes offline; the others carry on.
    await dan.stop();
    await settle(() => ann.group(groupId)?.members.find((m) => m.peerId === id(dan))?.online === false);
    bob.mesh.sendGroup(groupId, 'while dan was away 1');
    cat.mesh.sendGroup(groupId, 'while dan was away 2');
    ann.mesh.renameGroup(groupId, 'launch week');
    await settle(() => eve.group(groupId)?.name === 'launch week' && texts(eve, groupId).length === 7);
    // ann (the admin) and bob go offline too: dan catches up from whoever is there.
    await ann.stop();
    await bob.stop();
    await dan.start();
    await settle(() => texts(dan, groupId).length === 7);
    expect(dan.group(groupId)?.name).toBe('launch week');
    expect(texts(dan, groupId)).toEqual(texts(eve, groupId));
    expect(dan.group(groupId)?.unread).toBeGreaterThan(0);
    dan.mesh.markRead(groupConversation(groupId));
    expect(dan.group(groupId)?.unread).toBe(0);
    await ann.start();
    await bob.start();
    await settle(() => texts(ann, groupId).length === 7 && texts(bob, groupId).length === 7);
    // The log is a file of signed entries on each Mac; message bodies are ciphertext.
    const file = readFileSync(path.join(dan.dir, 'groups', `${groupId}.jsonl`), 'utf8');
    expect(file).not.toContain('while dan was away');
    expect(file.trim().split('\n').length).toBeGreaterThan(7);
  }, 90_000);

  it('reaches members who can’t link to each other, through the ones who can (gossip)', async () => {
    const blocked = new Map<string, string>();
    const isBlocked = (me: () => string) => (peerId: string) => blocked.get(me()) === peerId;
    let fayId = '';
    let gusId = '';
    // No tunnels, and no periodic catch-up: only passing new entries on gets them across.
    const quiet = { relay: false, timing: { ...FAST, syncMs: 120_000 } };
    const fay = await net.add('fay', { blocked: isBlocked(() => fayId), ...quiet });
    const gus = await net.add('gus', quiet);
    const hal = await net.add('hal', { blocked: isBlocked(() => halId), ...quiet });
    fayId = id(fay);
    gusId = id(gus);
    const halId = id(hal);
    blocked.set(fayId, halId).set(halId, fayId);
    await befriend(fay, gus);
    await befriend(gus, hal);
    const group = gus.mesh.createGroup('relay-less', [fayId, halId]);
    await settle(() => fay.group(group.id)?.active && hal.group(group.id)?.active);
    // fay and hal never link…
    await settle(() => fay.group(group.id)?.members.find((m) => m.peerId === gusId)?.online);
    expect(fay.group(group.id)?.members.find((m) => m.peerId === halId)?.online).toBe(false);
    // …yet their messages reach each other through gus.
    fay.mesh.sendGroup(group.id, 'fay to all');
    hal.mesh.sendGroup(group.id, 'hal to all');
    await settle(() => texts(hal, group.id).includes('fay to all') && texts(fay, group.id).includes('hal to all'));
    expect(fay.group(group.id)?.members.find((m) => m.peerId === halId)?.online).toBe(false);
  }, 60_000);

  it('removing someone: they learn of it, are dropped, and can’t read what comes after', async () => {
    const { people, groupId } = await team(['ivy', 'jon', 'kim']);
    const [ivy, jon, kim] = people as [Person, Person, Person];
    ivy.mesh.sendGroup(groupId, 'before');
    await settle(() => texts(kim, groupId).includes('before'));
    ivy.mesh.removeMember(groupId, id(kim));
    await settle(() => kim.group(groupId)?.active === false);
    await settle(() => jon.group(groupId)?.members.length === 2);
    jon.mesh.sendGroup(groupId, 'after');
    await settle(() => texts(ivy, groupId).includes('after'));
    // kim keeps the history up to her removal and nothing after.
    expect(texts(kim, groupId)).toEqual(['before']);
    expect(kim.mesh.groupHistory(groupId).some((m) => m.text === 'after')).toBe(false);
    // jon and kim weren't friends: once she's out they're no longer linked.
    await settle(() => !jon.mesh.summary().groups.find((g) => g.id === groupId)?.members.some((m) => m.peerId === id(kim)));
    expect(() => kim.mesh.sendGroup(groupId, 'hello?')).toThrow(/not in this group/);
  }, 60_000);

  it('deleting a channel you left: gone from this Mac, not handed back by the others, back only if added again', async () => {
    const { people, groupId } = await team(['ray', 'sue']);
    const [ray, sue] = people as [Person, Person];
    ray.mesh.sendGroup(groupId, 'before');
    await settle(() => texts(sue, groupId).includes('before'));
    const conversation = groupConversation(groupId);
    sue.mesh.markRead(conversation);
    expect(() => sue.mesh.deleteGroup(groupId)).toThrow(/Leave the channel/);

    sue.mesh.leaveGroup(groupId);
    await settle(() => ray.group(groupId)?.members.length === 1);
    sue.mesh.deleteGroup(groupId);
    expect(sue.group(groupId)).toBeUndefined();
    expect(existsSync(path.join(sue.dir, 'groups', `${groupId}.jsonl`))).toBe(false);
    expect(Object.keys(sue.mesh.recent())).not.toContain(conversation);
    expect(JSON.parse(readFileSync(path.join(sue.dir, 'reads.json'), 'utf8'))).not.toHaveProperty(conversation);
    expect(() => sue.mesh.deleteGroup(groupId)).toThrow(/No such group/);

    // ray (a friend, who still has it) keeps talking and catching up: it doesn't come back.
    ray.mesh.sendGroup(groupId, 'after');
    await sue.stop();
    await sue.start();
    await new Promise((r) => setTimeout(r, 2_000));
    expect(sue.group(groupId)).toBeUndefined();

    // Added back by an admin: the channel returns, with what's said from then on.
    ray.mesh.addMember(groupId, id(sue));
    await settle(() => sue.group(groupId)?.active);
    ray.mesh.sendGroup(groupId, 'welcome back');
    await settle(() => texts(sue, groupId).includes('welcome back'));
  }, 60_000);

  it('a channel deleted while nobody heard you leave (and the goodbye given up on) stays deleted when they come back', async () => {
    const { people, groupId } = await team(['tom', 'uma']);
    const [tom, uma] = people as [Person, Person];
    await tom.stop();
    uma.mesh.leaveGroup(groupId);
    uma.mesh.deleteGroup(groupId);
    // As if the goodbye had expired before tom came back.
    await uma.stop();
    rmSync(path.join(uma.dir, 'groups', 'goodbyes.json'));
    await uma.start();
    // tom still has uma in it, and offers it back on every catch-up.
    await tom.start();
    await settle(() => tom.friend(id(uma))?.online);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(uma.group(groupId)).toBeUndefined();
    // Using tom's invite link brings it back from his copy (he never heard she left).
    const invite = await tom.mesh.groupInvite(groupId);
    expect(await uma.mesh.accept(invite.link)).toMatchObject({ kind: 'group', groupId, status: 'joined' });
    await settle(() => uma.group(groupId)?.active);
  }, 60_000);

  it('leaving while nobody is online: the first member you meet hears it, and passes it on', async () => {
    const { people, groupId } = await team(['vic', 'wes', 'xia']);
    const [vic, wes, xia] = people as [Person, Person, Person];
    // wes and xia aren't friends: only the group links them.
    expect(wes.friend(id(xia))).toBeUndefined();
    await vic.stop();
    await xia.stop();
    wes.mesh.leaveGroup(groupId);
    wes.mesh.deleteGroup(groupId);
    expect(JSON.parse(readFileSync(path.join(wes.dir, 'groups', 'goodbyes.json'), 'utf8'))).toHaveLength(1);
    // xia comes back first: wes dials her to say goodbye.
    await xia.start();
    await settle(() => xia.group(groupId)?.members.length === 2);
    expect(JSON.parse(readFileSync(path.join(wes.dir, 'groups', 'goodbyes.json'), 'utf8'))).toEqual([]);
    // vic learns it from xia.
    await vic.start();
    await settle(() => vic.group(groupId)?.members.length === 2);
    expect(wes.group(groupId)).toBeUndefined();
  }, 60_000);

  it('joins by invite link: automatically, or once an admin approves', async () => {
    const { people, groupId } = await team(['lea', 'max']);
    const [lea, max] = people as [Person, Person];
    const nia = await net.add('nia');
    const auto = await lea.mesh.groupInvite(groupId, { auto: true });
    expect(auto.link).toMatch(/^beluga:\/\/join#/);
    expect(await nia.mesh.accept(auto.link)).toMatchObject({ kind: 'group', groupId, status: 'joined' });
    await settle(() => nia.group(groupId)?.active);
    await settle(() => max.group(groupId)?.members.some((m) => m.peerId === id(nia) && m.online));
    nia.mesh.sendGroup(groupId, 'hello, I am nia');
    await settle(() => texts(max, groupId).includes('hello, I am nia'));

    // Asking: the request waits for an admin.
    const oli = await net.add('oli');
    const ask = await lea.mesh.groupInvite(groupId);
    expect(await oli.mesh.accept(ask.code)).toMatchObject({ kind: 'group', status: 'waiting' });
    expect(oli.mesh.summary().pendingJoins).toEqual([expect.objectContaining({ groupId })]);
    await settle(() => lea.group(groupId)?.requests.length === 1);
    expect(max.group(groupId)?.requests).toEqual([]); // only admins see requests
    expect(() => max.mesh.approve(groupId, id(oli))).toThrow(/Only admins/);
    lea.mesh.approve(groupId, id(oli));
    await settle(() => oli.group(groupId)?.active);
    expect(oli.mesh.summary().pendingJoins).toEqual([]);
    expect(lea.group(groupId)?.requests).toEqual([]);
    lea.mesh.sendGroup(groupId, 'welcome oli');
    await settle(() => texts(oli, groupId).includes('welcome oli'));
    // Messages from before oli joined stay unreadable for oli.
    expect(oli.mesh.groupHistory(groupId).find((m) => m.from === id(nia))?.status).toBe('locked');
    // Someone removed can't slip back in with an automatic link: an admin has to approve.
    lea.mesh.removeMember(groupId, id(nia));
    await settle(() => nia.group(groupId)?.active === false);
    expect(await nia.mesh.accept(auto.link)).toMatchObject({ kind: 'group', status: 'waiting' });
  }, 90_000);

  it('drops the link of someone who keeps sending forged entries', async () => {
    const { people, groupId } = await team(['pam', 'quin']);
    const [pam, quin] = people as [Person, Person];
    const linkTo = (p: Person, peerId: string): MeshLink => (p.mesh as unknown as { links: { get(id: string): MeshLink } }).links.get(peerId);
    const link = linkTo(quin, id(pam));
    const closed = new Promise<number>((resolve) => link.on('close', resolve));
    const forged = { id: 'ab'.repeat(32), group: groupId, author: id(quin), lamport: 1, parents: ['cd'.repeat(32)], type: 'rename', ts: 1, body: { name: 'x' }, sig: 'AA==' };
    for (let i = 0; i < 3; i++) link.send({ t: 'g_entries', group: groupId, entries: Array.from({ length: 100 }, () => forged) });
    expect(await closed).toBe(4029);
    // They link again (it isn't a ban), and the group still works.
    await settle(() => pam.group(groupId)?.members.every((m) => m.online));
    quin.mesh.sendGroup(groupId, 'still here');
    await settle(() => texts(pam, groupId).includes('still here'));
  }, 60_000);
});
