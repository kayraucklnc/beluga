import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DmBook } from '../../src/net/mesh/dms.js';
import { dmConversation } from '../../src/net/mesh/views.js';
import { type Crowd, befriend, crowd, settle } from './helpers.js';

// Deleting, editing and clearing direct messages (BLG-425).

describe('DmBook changes', () => {
  const dirs: string[] = [];
  const book = (dir = mkdtempSync(path.join(tmpdir(), 'dms-'))): { dir: string; b: DmBook } => {
    dirs.push(dir);
    return { dir, b: new DmBook(dir) };
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('deletes, edits and clears, and reads it all back after a restart', () => {
    const { dir, b } = book();
    const a = b.compose('me', 'pal', 'first');
    const c = b.compose('me', 'pal', 'second');
    b.receive({ id: 'theirs-000001', from: 'pal', to: 'me', text: 'hi', ts: 3 });
    // Only your own can go from their Mac, or be edited.
    expect(() => b.delete('pal', 'theirs-000001', true)).toThrow(/own/);
    expect(() => b.edit('pal', 'theirs-000001', 'no')).toThrow(/own/);

    expect(b.delete('pal', a.id, false)).toBeUndefined();
    const { dm, change } = b.edit('pal', c.id, 'second, fixed');
    expect(dm).toMatchObject({ text: 'second, fixed' });
    expect(change).toMatchObject({ to: 'pal', id: c.id, text: 'second, fixed' });
    // Not delivered yet: the outbox carries the new text.
    expect(b.waiting('pal').find((o) => o.id === c.id)?.text).toBe('second, fixed');

    const again = new DmBook(dir);
    expect(again.history('pal').map((m) => m.text)).toEqual(['second, fixed', 'hi']);
    expect(again.pendingChanges('pal')).toHaveLength(1);
    // A resend of a deleted message stays gone.
    expect(again.receive({ id: 'theirs-000001', from: 'pal', to: 'me', text: 'hi', ts: 3 })).toBe(false);

    expect(again.clear('pal')).toBe(2);
    expect(new DmBook(dir).history('pal')).toEqual([]);
  });

  it('deleting for both of you takes it off the outbox and queues one change per message', () => {
    const { b } = book();
    const m = b.compose('me', 'pal', 'oops');
    b.edit('pal', m.id, 'oops 2');
    const change = b.delete('pal', m.id, true);
    expect(change).toMatchObject({ id: m.id });
    expect(change?.text).toBeUndefined();
    expect(b.waiting('pal')).toEqual([]);
    expect(b.pendingChanges('pal')).toHaveLength(1);
    b.changeDelivered('pal', m.id, change!.at);
    expect(b.pendingChanges('pal')).toEqual([]);
  });

  it("takes a friend's changes to their own messages only, and never an older edit", () => {
    const { b } = book();
    const mine = b.compose('me', 'pal', 'mine');
    b.receive({ id: 'theirs-000001', from: 'pal', to: 'me', text: 'v1', ts: 1 });
    expect(b.changed('pal', { id: mine.id, at: 5 })).toBeNull();
    expect(b.changed('pal', { id: 'theirs-000001', text: 'v3', at: 30 })).toMatchObject({ text: 'v3', edited: 30 });
    expect(b.changed('pal', { id: 'theirs-000001', text: 'v2', at: 20 })).toBeNull();
    expect(b.changed('pal', { id: 'theirs-000001', at: 40 })).toBeUndefined();
    expect(b.changed('pal', { id: 'theirs-000001', at: 40 })).toBeNull();
    expect(b.history('pal').map((m) => m.text)).toEqual(['mine']);
  });
});

describe('direct message changes between two Macs', () => {
  let net: Crowd;
  beforeAll(async () => {
    net = await crowd();
  }, 30_000);
  afterAll(async () => {
    await net?.close();
  });

  it('an edit and a delete reach your friend, even when they were offline', async () => {
    const ann = await net.add('ann');
    const bob = await net.add('bob');
    await befriend(ann, bob);
    const toBob = dmConversation(bob.identity.peerId);
    const fromAnn = (): string[] => bob.mesh.dmHistory(ann.identity.peerId).map((m) => m.text);
    const keep = ann.mesh.sendDm(bob.identity.peerId, 'see you at 5');
    const drop = ann.mesh.sendDm(bob.identity.peerId, 'wrong chat');
    await settle(() => fromAnn().length === 2);

    const edited = ann.mesh.editMessage(toBob, keep.id, 'see you at 6');
    expect(edited).toMatchObject({ text: 'see you at 6', edited: expect.any(Number) });
    await settle(() => fromAnn()[0] === 'see you at 6');
    expect(bob.mesh.dmHistory(ann.identity.peerId)[0]?.edited).toBe(edited.edited);
    // Bob can't edit Ann's words, nor delete them from her Mac.
    expect(() => bob.mesh.editMessage(dmConversation(ann.identity.peerId), keep.id, 'hack')).toThrow();
    expect(() => bob.mesh.deleteMessage(dmConversation(ann.identity.peerId), keep.id, true)).toThrow();

    await bob.stop();
    await settle(() => ann.friend(bob.identity.peerId)?.online === false);
    ann.mesh.deleteMessage(toBob, drop.id, true);
    expect(ann.mesh.dmHistory(bob.identity.peerId).map((m) => m.text)).toEqual(['see you at 6']);
    await bob.start();
    await settle(() => fromAnn().length === 1);
    expect(fromAnn()).toEqual(['see you at 6']);

    // Clearing is only for this Mac.
    bob.mesh.clearConversation(dmConversation(ann.identity.peerId));
    expect(fromAnn()).toEqual([]);
    expect(bob.friend(ann.identity.peerId)?.unread).toBe(0);
    expect(ann.mesh.dmHistory(bob.identity.peerId)).toHaveLength(1);
  }, 60_000);

  it("deleting a friend's message here leaves theirs, and channels say they can't yet", async () => {
    const cat = await net.add('cat');
    const dan = await net.add('dan');
    await befriend(cat, dan);
    const m = dan.mesh.sendDm(cat.identity.peerId, 'hello');
    await settle(() => cat.mesh.dmHistory(dan.identity.peerId).length === 1);
    expect(cat.friend(dan.identity.peerId)?.unread).toBe(1);
    cat.mesh.deleteMessage(dmConversation(dan.identity.peerId), m.id);
    expect(cat.mesh.dmHistory(dan.identity.peerId)).toEqual([]);
    expect(cat.friend(dan.identity.peerId)?.unread).toBe(0);
    expect(dan.mesh.dmHistory(cat.identity.peerId)).toHaveLength(1);
    expect(() => cat.mesh.deleteMessage(`group:${'0'.repeat(32)}`, m.id)).toThrow(/channels/);
  }, 60_000);
});
