import type { BodyInput, BodyOf } from '../protocol.js';
import type { Accepted, Mesh } from '../net/mesh/mesh.js';
import type { NoticeEvent } from './notify.js';
import type { Store } from './store.js';

/**
 * Friend requests between people in the same room (BLG-202): rooms fold into friends. "Add as
 * friend" on someone in your room makes a one-time friend invitation only they may use and sends
 * it to them over the room; their Beluga shows "kay wants to add you as a friend" (on the Mac and
 * on the phone, as something that needs them), and Accept uses the invitation, pairing your Macs
 * on the Beluga network. The link never reaches the shared state: it's kept here, per store.
 */

/** What a friend request needs from the session it travels through. */
export interface OfferHost {
  readonly store: Store;
  send(body: BodyInput, opts: { to?: string }): boolean;
  notify?(event: NoticeEvent): void;
}

/** How long a friend request sent in a room lasts (its invitation's link). */
export const OFFER_TTL_MS = 24 * 60 * 60_000;

/** Requests you got, by who sent them: the invitation links (secrets), never in the shared state. */
const links = new WeakMap<Store, Map<string, { readonly link: string; readonly expiresAt: number }>>();
const linksOf = (store: Store): Map<string, { readonly link: string; readonly expiresAt: number }> => {
  let map = links.get(store);
  if (!map) links.set(store, (map = new Map()));
  return map;
};

const nameIn = (store: Store, peerId: string): string => store.getState().peers.find((p) => p.peerId === peerId)?.name ?? 'Someone';

const isFriend = (store: Store, peerId: string): boolean => store.getState().network.friends.some((f) => f.peerId === peerId);

/** Ask someone in your room to be friends: → their name. */
export async function sendFriendOffer(host: OfferHost, mesh: Pick<Mesh, 'createInvite' | 'cancelInvite'>, peerId: string): Promise<{ name: string }> {
  const state = host.store.getState();
  const peer = state.peers.find((p) => p.peerId === peerId);
  if (!peer) throw new Error('They aren’t in this room any more');
  if (peerId === state.self?.peerId) throw new Error('That’s you');
  // Guests came with a project link: they only reach what they were invited to.
  if (peer.guest || state.guests[peerId]) throw new Error(`${peer.name} came in with a project link. Send them a friend link instead`);
  if (isFriend(host.store, peerId)) throw new Error(`${peer.name} is already your friend`);
  const invite = await mesh.createInvite({ ttlMs: OFFER_TTL_MS, for: peerId });
  if (!host.send({ kind: 'friend_offer', link: invite.link, expiresAt: invite.expiresAt }, { to: peerId })) {
    await mesh.cancelInvite(invite.id).catch(() => undefined);
    throw new Error(`Couldn’t reach ${peer.name} in the room. Try again in a moment`);
  }
  host.store.dispatch({ type: 'net_offer', offer: { peerId, name: peer.name.slice(0, 64), dir: 'out', at: Date.now(), expiresAt: invite.expiresAt } });
  return { name: peer.name };
}

/** Someone in the room sent you a friend request: keep its link here, show it, and tell you. */
export function receiveFriendOffer(host: OfferHost, from: string, body: BodyOf<'friend_offer'>): void {
  const state = host.store.getState();
  if (from === state.self?.peerId || isFriend(host.store, from) || body.expiresAt <= Date.now()) return;
  const name = nameIn(host.store, from).slice(0, 64);
  const map = linksOf(host.store);
  const fresh = !map.has(from);
  map.set(from, { link: body.link, expiresAt: body.expiresAt });
  host.store.dispatch({ type: 'net_offer', offer: { peerId: from, name, dir: 'in', at: Date.now(), expiresAt: body.expiresAt } });
  if (fresh) host.notify?.({ kind: 'needsYou', tag: 'invited', title: `${name} wants to add you as a friend`, body: 'Accept to talk, share and ask each other’s agents over the Beluga network', need: `friend:${from}`, key: `friend-offer:${from}:${body.expiresAt}` });
}

/** Accept (you're friends once your Macs pair) or turn down someone's friend request. */
export async function answerFriendOffer(host: OfferHost, mesh: Pick<Mesh, 'accept'> | undefined, from: string, accept: boolean): Promise<Accepted | undefined> {
  const map = linksOf(host.store);
  const offer = map.get(from);
  const gone = (): void => {
    map.delete(from);
    host.store.dispatch({ type: 'net_offer_gone', peerId: from, dir: 'in' });
  };
  if (!accept) return void gone();
  if (!offer) {
    gone();
    throw new Error('That friend request is gone. Ask them to send it again');
  }
  if (!mesh) throw new Error('Turn on talking with friends first');
  if (offer.expiresAt <= Date.now()) {
    gone();
    throw new Error('That friend request expired. Ask them to send it again');
  }
  const result = await mesh.accept(offer.link, { from });
  gone();
  return result;
}
