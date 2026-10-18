import { networkEnabled, networkOf, networkStatus, networkSwitchOf } from '../core/network.js';
import { saveSettings } from '../core/settings.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `network.*` method does (see network-api.ts). Results are plain views: no keys, no secrets. */

type NetworkMethod = Extract<Method, `network.${string}`>;
type NetworkHandlers = { readonly [M in NetworkMethod]: (s: Session, ...args: Args<M>) => unknown };

const net = networkOf;

/** Turn the network on or off for this klaud now, and next time. */
async function setEnabled(s: Session, on: boolean): Promise<ReturnType<typeof networkStatus>> {
  const sw = networkSwitchOf(s);
  if (!sw) throw new Error('Only the klaud app (its daemon) can be on the network');
  saveSettings({ network: on });
  const effective = networkEnabled({ network: on });
  await sw.set(effective);
  if (effective !== on) throw new Error(on ? 'KLAUD_NETWORK=0 keeps the network off for this klaud' : 'KLAUD_NETWORK=1 keeps the network on for this klaud');
  return networkStatus(s);
}

export const NETWORK_HANDLERS = {
  'network.status': (s) => networkStatus(s),
  'network.setEnabled': (s, on) => setEnabled(s, on),
  'network.friends.list': (s) => net(s).summary().friends,
  'network.friends.invite': (s) => net(s).createInvite(),
  'network.friends.accept': (s, text) => net(s).accept(text),
  'network.friends.cancelInvite': (s, id) => net(s).cancelInvite(id),
  'network.friends.remove': (s, peerId) => net(s).removeFriend(peerId),
  'network.dm.send': (s, peerId, text) => net(s).sendDm(peerId, text),
  'network.dm.history': (s, peerId, page) => net(s).dmHistory(peerId, { ...(page?.before !== undefined ? { before: page.before } : {}), ...(page?.limit !== undefined ? { limit: page.limit } : {}) }),
  'network.groups.list': (s) => net(s).summary().groups,
  'network.groups.create': (s, name, members) => net(s).createGroup(name, members ?? []),
  'network.groups.send': (s, groupId, text) => net(s).sendGroup(groupId, text),
  'network.groups.history': (s, groupId, page) => net(s).groupHistory(groupId, { ...(page?.before !== undefined ? { before: page.before } : {}), ...(page?.limit !== undefined ? { limit: page.limit } : {}) }),
  'network.groups.addMember': (s, groupId, peerId) => net(s).addMember(groupId, peerId),
  'network.groups.removeMember': (s, groupId, peerId) => net(s).removeMember(groupId, peerId),
  'network.groups.setAdmin': (s, groupId, peerId, admin) => net(s).setAdmin(groupId, peerId, admin),
  'network.groups.leave': (s, groupId) => net(s).leaveGroup(groupId),
  'network.groups.rename': (s, groupId, name) => net(s).renameGroup(groupId, name),
  'network.groups.invite': (s, groupId, opts) => net(s).groupInvite(groupId, opts?.auto ? { auto: true } : {}),
  'network.groups.join': (s, text) => net(s).accept(text),
  'network.groups.approve': (s, groupId, peerId) => net(s).approve(groupId, peerId),
  'network.groups.decline': (s, groupId, peerId) => net(s).decline(groupId, peerId),
  'network.presence.set': (s, presence) => net(s).setPresence({ state: presence.state, ...(presence.note !== undefined ? { note: presence.note } : {}), ...(presence.until !== undefined ? { until: presence.until } : {}) }),
  'network.presence.get': (s) => net(s).getPresence(),
  'network.read': (s, conversation) => net(s).markRead(conversation),
} satisfies NetworkHandlers;
