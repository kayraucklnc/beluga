import { spawn } from 'node:child_process';
import { chatOf } from '../core/chat/launch.js';
import { answerFriendOffer, sendFriendOffer } from '../core/friend-offers.js';
import { networkEnabled, networkOf, networkStatus, networkSwitchOf } from '../core/network.js';
import { systemOpen } from '../core/os-open.js';
import type { ChatFile } from '../net/mesh/views.js';
import { saveSettings } from '../core/settings.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `network.*` method does (see network-api.ts). Results are plain views: no keys, no secrets. */

type NetworkMethod = Extract<Method, `network.${string}`>;
type NetworkHandlers = { readonly [M in NetworkMethod]: (s: Session, ...args: Args<M>) => unknown };

const net = networkOf;

/** Turn the network on or off for this Beluga now, and next time. */
async function setEnabled(s: Session, on: boolean): Promise<ReturnType<typeof networkStatus>> {
  const sw = networkSwitchOf(s);
  if (!sw) throw new Error('Only the Beluga app (its daemon) can be on the network');
  saveSettings({ network: on });
  const effective = networkEnabled({ network: on });
  await sw.set(effective);
  if (effective !== on) throw new Error(on ? 'BELUGA_NETWORK=0 keeps the network off for this Beluga' : 'BELUGA_NETWORK=1 keeps the network on for this Beluga');
  return networkStatus(s);
}

/** Write in a conversation: the files must be here (added first), so friends can get them from you. */
function post(s: Session, conversation: string, body: { text: string; files?: readonly ChatFile[] | undefined; ask?: 'all' | readonly string[] | undefined }) {
  const chat = chatOf(s);
  const files = (body.files ?? []).map((f) => {
    if (!chat.files.store.has(f.sha)) throw new Error(`${f.name} isn’t ready to send: add it again`);
    return chat.files.info(f.sha) ?? f;
  });
  const extras = { ...(files.length ? { files } : {}), ...(body.ask ? { ask: { to: body.ask } } : {}) };
  return chat.mesh.post(conversation, body.text, Object.keys(extras).length ? extras : undefined);
}

/** Show a file in Finder, selected. */
function reveal(file: string): void {
  if (process.platform !== 'darwin') return systemOpen(file.replace(/\/[^/]*$/, ''));
  spawn('open', ['-R', file], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

export const NETWORK_HANDLERS = {
  'network.status': (s) => networkStatus(s),
  'network.setEnabled': (s, on) => setEnabled(s, on),
  'network.friends.list': (s) => net(s).summary().friends,
  'network.friends.invite': (s) => net(s).createInvite(),
  'network.friends.accept': (s, text) => net(s).accept(text),
  'network.friends.cancelInvite': (s, id) => net(s).cancelInvite(id),
  'network.friends.remove': (s, peerId) => net(s).removeFriend(peerId),
  'network.friends.addFromRoom': (s, peerId) => sendFriendOffer(s, net(s), peerId),
  'network.friends.answerOffer': (s, peerId, accept) => answerFriendOffer(s, accept ? net(s) : undefined, peerId, accept),
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
  'network.groups.delete': (s, groupId) => net(s).deleteGroup(groupId),
  'network.groups.rename': (s, groupId, name) => net(s).renameGroup(groupId, name),
  'network.groups.invite': (s, groupId, opts) => net(s).groupInvite(groupId, opts?.auto ? { auto: true } : {}),
  'network.groups.join': (s, text) => net(s).accept(text),
  'network.groups.approve': (s, groupId, peerId) => net(s).approve(groupId, peerId),
  'network.groups.decline': (s, groupId, peerId) => net(s).decline(groupId, peerId),
  'network.presence.set': (s, presence) => net(s).setPresence({ state: presence.state, ...(presence.note !== undefined ? { note: presence.note } : {}), ...(presence.until !== undefined ? { until: presence.until } : {}) }),
  'network.presence.get': (s) => net(s).getPresence(),
  'network.read': (s, conversation) => net(s).markRead(conversation),
  'network.post': (s, conversation, body) => post(s, conversation, body),
  'network.files.add': (s, paths) => chatOf(s).files.share(paths),
  'network.files.addData': (s, name, b64, part) => (part ? chatOf(s).files.sharePart(name, Buffer.from(b64, 'base64'), part) : chatOf(s).files.shareData(name, Buffer.from(b64, 'base64'))),
  'network.files.download': (s, sha, conversation) => chatOf(s).files.download(sha, conversation),
  'network.files.cancel': (s, sha) => chatOf(s).files.cancel(sha),
  'network.files.open': (s, sha) => systemOpen(chatOf(s).files.pathOf(sha)),
  'network.files.reveal': (s, sha) => reveal(chatOf(s).files.pathOf(sha)),
  'network.files.saveTo': (s, sha, target) => chatOf(s).files.saveTo(sha, target),
  'network.files.preview': (s, sha) => chatOf(s).files.preview(sha),
  'network.channels.main': (s) => chatOf(s).main.ensure(),
} satisfies NetworkHandlers;
