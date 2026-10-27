import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AVATAR_MAX, AvatarBook, avatarMime } from '../../src/net/mesh/avatars.js';
import { type Crowd, befriend, crowd, settle } from './helpers.js';

/** A tiny PNG-looking picture (the signature is all the store checks), different per `seed`. */
const png = (seed: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const peer = (c: string): string => c.repeat(32);

describe('the avatar book', () => {
  it('keeps small pictures only, by checksum, and forgets what no one uses', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'avatars-'));
    const book = new AvatarBook(dir);
    expect(avatarMime(png('a'))).toBe('image/png');
    expect(() => book.setMine(Buffer.from('not a picture'))).toThrow(/PNG, JPEG/);
    expect(() => book.setMine(Buffer.concat([png('x'), Buffer.alloc(AVATAR_MAX)]))).toThrow();

    const first = book.setMine(png('one'));
    expect(first).toBe(sha(png('one')));
    expect(book.read(first!)?.mime).toBe('image/png');
    const second = book.setMine(png('two'));
    expect(book.has(first!)).toBe(false);
    expect(new AvatarBook(dir).mine).toBe(second);
    book.setMine(undefined);
    expect(book.mine).toBeUndefined();
    expect(readdirSync(dir)).toEqual(['index.json']);
  });

  it("takes someone's picture only if it's the one they announced and it checks out", () => {
    const book = new AvatarBook(mkdtempSync(path.join(tmpdir(), 'avatars-')));
    const pic = png('theirs');
    expect(book.receive(peer('a'), sha(pic), pic)).toBe(false);
    book.announce(peer('a'), sha(pic));
    expect(book.receive(peer('a'), sha(pic), png('other'))).toBe(false);
    expect(book.receive(peer('b'), sha(pic), pic)).toBe(false);
    expect(book.receive(peer('a'), sha(pic), pic)).toBe(true);
    expect(book.has(sha(pic))).toBe(true);
    book.announce(peer('a'), undefined);
    expect(book.has(sha(pic))).toBe(false);
  });
});

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

describe('profile pictures over the network', () => {
  it('reach friends once per change and stay while their owner is away', async () => {
    const ann = await net.add('ann');
    const bob = await net.add('bob');
    await befriend(ann, bob);
    const pic = png('ann-face');
    const set = ann.mesh.setAvatar(pic)!;
    expect(ann.mesh.summary().self?.avatar).toBe(set);
    await settle(() => bob.friend(ann.identity.peerId)?.avatar === set);
    expect(Buffer.from(bob.mesh.avatar(set)!.b64, 'base64')).toEqual(pic);

    await ann.stop();
    await settle(() => bob.friend(ann.identity.peerId)?.online === false);
    expect(bob.friend(ann.identity.peerId)?.avatar).toBe(set);
    await bob.stop();
    await bob.start();
    expect(bob.friend(ann.identity.peerId)?.avatar).toBe(set);

    await ann.start();
    const next = ann.mesh.setAvatar(png('ann-new'));
    await settle(() => bob.friend(ann.identity.peerId)?.avatar === next);
    ann.mesh.setAvatar(undefined);
    await settle(() => bob.friend(ann.identity.peerId)?.avatar === undefined);
  }, 60_000);
});
