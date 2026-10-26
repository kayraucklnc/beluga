import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meshNode } from '../../src/core/gateway/launch.js';
import { MESH_FEATURES, TASK_FEATURES, cannotTake, shortVersion } from '../../src/net/mesh/features.js';
import { person } from '../../src/net/mesh/mesh-views.js';
import { node } from '../gateway/helpers.js';
import { type Crowd, befriend, crowd, settle } from './helpers.js';

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

describe('what a friend’s Beluga says about itself', () => {
  it('friends see each other’s version and features, kept while they’re away', async () => {
    const ann = await net.add('ann', { app: '0.6.2+mac.1.3.0' });
    const bob = await net.add('bob', { app: '0.6.2+mac.1.2.0' });
    await befriend(ann, bob);
    await settle(() => bob.friend(ann.identity.peerId)?.beluga);
    expect(bob.friend(ann.identity.peerId)?.beluga).toEqual({ version: '0.6.2+mac.1.3.0', can: [...MESH_FEATURES] });
    // Taking requests is said as it starts (and stops), without a new link.
    ann.mesh.offer(TASK_FEATURES, true);
    await settle(() => bob.friend(ann.identity.peerId)?.beluga?.can.includes('task.file'));
    ann.mesh.offer(TASK_FEATURES, false);
    await settle(() => !bob.friend(ann.identity.peerId)?.beluga?.can.includes('task.file'));
    await ann.stop();
    await settle(() => bob.friend(ann.identity.peerId)?.online === false);
    expect(bob.friend(ann.identity.peerId)?.beluga?.version).toBe('0.6.2+mac.1.3.0');
    await ann.start();
  }, 60_000);

  it('a request their Mac can’t take fails at once, saying why', async () => {
    const pat = await node(net, 'pat');
    const quinn = await node(net, 'quinn');
    await befriend(pat.person, quinn.person);
    await settle(() => pat.store.getState().network.friends.find((f) => f.peerId === quinn.id)?.beluga?.can.includes('task.ask'));
    // Quinn's Beluga stops taking requests (the network on its own, not the Mac app).
    quinn.gw.detachMesh();
    await settle(() => !pat.store.getState().network.friends.find((f) => f.peerId === quinn.id)?.beluga?.can.includes('task.ask'));
    expect(() => pat.gw.ask({ person: 'quinn', ask: 'hi', by: 'person' })).toThrow(/quinn's Beluga isn't taking requests/);
    quinn.gw.attachMesh(meshNode(quinn.person.mesh));
    await settle(() => pat.store.getState().network.friends.find((f) => f.peerId === quinn.id)?.beluga?.can.includes('task.ask'));
    expect(pat.gw.ask({ person: 'quinn', ask: 'hi', by: 'person' }).state).toBe('sent');
    // who_can tells your Claude which Beluga they're on.
    expect(pat.gw.whoCan().find((c) => c.peerId === quinn.id)?.beluga).toBe('unknown');
  }, 60_000);
});

describe('features', () => {
  it('says what an older Beluga can’t take, and nothing for Macs that never said', () => {
    expect(cannotTake('Ata', undefined, 'task.file')).toBeUndefined();
    expect(cannotTake('Ata', { version: '1.4.0', can: ['task.ask', 'task.file'] }, 'task.file')).toBeUndefined();
    expect(cannotTake('Ata', { version: '0.6.2+mac.1.1.0', can: ['task.ask'] }, 'task.file')).toBe("Ata's Beluga 1.1.0 can't take file requests yet. Ask Ata to update Beluga.");
    expect(cannotTake('Ata', { version: '1.1.0', can: ['chat.files'] }, 'task.ask')).toMatch(/isn't taking requests right now/);
    // A Mac that quit said it stopped taking requests on its way out: that waits for it to be back.
    expect(cannotTake('Ata', { version: '1.1.0', can: ['chat.files'] }, 'task.ask', false)).toBeUndefined();
    expect(cannotTake('Ata', { version: '1.1.0', can: ['task.ask'] }, 'task.file', false)).toMatch(/can't take file requests yet/);
    expect(shortVersion('0.6.2+mac.1.2.0')).toBe('1.2.0');
    expect(shortVersion('0.6.2')).toBe('0.6.2');
  });

  it('a friend on another network version shows who needs to update, not just offline', () => {
    const ctx = { me: 'me', link: () => undefined, presenceOf: () => undefined, nameOf: () => 'Ata', readCount: () => 0, updateOf: () => 'them' as const };
    expect(person(ctx, 'ata', 'Ata')).toMatchObject({ online: false, update: 'them' });
  });
});
