import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatMessages } from '../../src/companion/views.js';
import type { NoticeEvent } from '../../src/core/notify.js';
import { parseExtras } from '../../src/net/mesh/extras.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Node, node, task } from './helpers.js';

/**
 * Both people see a task between them (BLG-208): its card is posted in their DM (or the channel it
 * was asked from), each side draws it from its own task book, and the one whose Claude ran it hears
 * when it's done.
 */

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

const cardIn = (n: Node, conversation: string, id: string) => n.person.mesh.conversation(conversation).find((m) => m.task?.id === id);

describe('a task’s card in the chat both people share', () => {
  it('goes in the DM on both Macs, with words for older ones; the result updates it and tells the one who ran it', async () => {
    const heard: NoticeEvent[] = [];
    const kay = await node(net, 'kayC');
    const bob = await node(net, 'bobC', { notify: (e) => void heard.push(e) });
    await befriend(kay.person, bob.person);
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    const t = kay.gw.ask({ person: 'bobC', ask: 'tidy the hero copy', summary: 'tidy the hero copy', by: 'agent', conversation: 'ws:abc' });
    expect(task(kay, t.id)?.chat).toBe(`dm:${bob.id}`);
    // Kay's own DM with bob holds the card at once; bob's when it arrives.
    expect(cardIn(kay, `dm:${bob.id}`, t.id)).toMatchObject({ mine: true, text: "kayC's Claude asked bobC's Claude: tidy the hero copy", task: { id: t.id, role: 'request' } });
    await settle(() => cardIn(bob, `dm:${kay.id}`, t.id));
    expect(cardIn(bob, `dm:${kay.id}`, t.id)?.text).toBe("kayC's Claude asked bobC's Claude: tidy the hero copy");
    await settle(() => task(kay, t.id)?.state === 'done');
    expect(task(bob, t.id)?.chat).toBe(`dm:${kay.id}`);
    // The result posts nothing more: the card is the one message.
    expect(kay.person.mesh.conversation(`dm:${bob.id}`).filter((m) => m.task)).toHaveLength(1);
    await settle(() => heard.some((e) => e.tag === 'task' && /finished/.test(e.title)));
    expect(heard.find((e) => /finished/.test(e.title))).toMatchObject({ title: "Your Claude's work for kayC finished", channel: `dm:${kay.id}` });
  }, 60_000);

  it('goes in the channel it was asked from when they’re in it; someone else there sees only the words', async () => {
    const kay = await node(net, 'kayG');
    const bob = await node(net, 'bobG');
    const cat = await node(net, 'catG');
    await befriend(kay.person, bob.person);
    await befriend(kay.person, cat.person);
    await befriend(bob.person, cat.person);
    const g = kay.person.mesh.createGroup('crew', [bob.id, cat.id]);
    const chat = `group:${g.id}`;
    await settle(() => bob.person.mesh.shares(chat, kay.id) && cat.person.mesh.shares(chat, kay.id));
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    const t = kay.gw.ask({ person: 'bobG', ask: 'check the build', by: 'person', conversation: chat });
    expect(task(kay, t.id)?.chat).toBe(chat);
    await settle(() => task(bob, t.id)?.chat === chat);
    await settle(() => cardIn(bob, chat, t.id) && cardIn(cat, chat, t.id));
    expect(cardIn(cat, chat, t.id)?.text).toBe("kayG asked bobG's Claude: check the build");
    expect(task(cat, t.id)).toBeUndefined();
    // Nothing in their DM.
    expect(cardIn(kay, `dm:${bob.id}`, t.id)).toBeUndefined();
  }, 60_000);

  it('a channel the friend isn’t in puts the card in your DM instead', async () => {
    const kay = await node(net, 'kayH');
    const bob = await node(net, 'bobH');
    await befriend(kay.person, bob.person);
    kay.trust(bob.id, 'trusted');
    const t = kay.gw.ask({ person: 'bobH', ask: 'hello', by: 'person', conversation: 'group:0123456789abcdef0123456789abcdef' });
    expect(task(kay, t.id)?.chat).toBe(`dm:${bob.id}`);
  }, 60_000);
});

describe('the card on the wire and on the phone', () => {
  it('older Macs drop the task extra and keep the words; malformed ones are dropped', () => {
    expect(parseExtras({ task: { id: 't_abcdefghijk', role: 'request' } })).toEqual({ task: { id: 't_abcdefghijk', role: 'request' } });
    expect(parseExtras({ task: { id: 'nope', role: 'request' } })).toBeUndefined();
  });

  it('the phone gets a simple card: title, where it is, the summary', async () => {
    const kay = await node(net, 'kayP');
    const bob = await node(net, 'bobP');
    await befriend(kay.person, bob.person);
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    const t = kay.gw.ask({ person: 'bobP', ask: 'say hi', by: 'person' });
    await settle(() => task(kay, t.id)?.state === 'done');
    const state = kay.store.getState();
    const conversation = `dm:${bob.id}`;
    const messages = { ...state.network.messages, [conversation]: kay.person.mesh.conversation(conversation) };
    const ctx = { refs: { output: () => undefined } } as unknown as Parameters<typeof chatMessages>[1];
    const view = chatMessages({ ...state, network: { ...state.network, messages } }, ctx, conversation).messages.find((m) => m.task);
    expect(view?.task).toMatchObject({ id: t.id, title: 'To bobP’s Claude', ask: 'say hi', state: 'Done', tone: 'ok', summary: 'Done: say hi' });
  }, 60_000);
});
