import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RoomBridge } from '../agent/types.js';
import type { PeerInfo } from '../protocol.js';
import type { Session } from './session.js';

/** Where your Claude writes reports, and how they're announced to the room. */
export async function writeReport(session: Session, cwd: string, title: string, markdown: string): Promise<string> {
  const dir = path.join(cwd, '.klaud', 'reports');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'report';
  const file = path.join(dir, `${stamp}-${slug}.md`);
  await fs.writeFile(file, markdown.startsWith('#') ? markdown : `# ${title}\n\n${markdown}`, 'utf8');
  const hit = session.locateShared(file);
  if (hit) {
    session.send({ kind: 'report', share: hit.share, path: hit.path, title }, { keep: true });
    session.send({ kind: 'focus', owner: session.selfId, share: hit.share, path: hit.path, actor: 'agent' });
  }
  return hit ? `${hit.share}/${hit.path}` : file;
}

/** What your Claude may do to the room, exposed to it as MCP tools (see agent/tools.ts). */
export function createRoomBridge(session: Session, cwd: () => string): RoomBridge {
  const requirePeer = (name: string): PeerInfo => {
    const peer = session.findPeer(name);
    if (!peer) throw new Error(`No peer named "${name}". Call list_peers first.`);
    return peer;
  };
  return {
    selfName: () => session.store.getState().self?.name ?? 'me',
    sendChat: (text) => session.sendChat(text, true, session.host.currentChannel),
    listPeers: () => session.store.getState().peers,
    askAgent: (name, prompt) => {
      const peer = requirePeer(name);
      if (!peer.agent) return Promise.reject(new Error(`${peer.name} has no agent online`));
      // Their Claude may send files back for you: accept them without asking.
      session.remote.expectFrom(peer.peerId);
      return session.askPeerAgent(peer.peerId, peer.name, prompt);
    },
    listPeerFiles: (name, share, p) => session.files.listFiles({ owner: requirePeer(name).peerId, share, path: p }),
    readPeerFile: async (name, share, p) => (await session.files.readFile({ owner: requirePeer(name).peerId, share, path: p })).content,
    writeReport: (title, markdown) => writeReport(session, cwd(), title, markdown),
    reportUsage: (usage) => session.updateUsage(usage),
    getPeerFile: (name, file, saveTo, why) => session.remote.getFile(requirePeer(name).peerId, file, saveTo, why),
    sendFile: (name, file, note) => session.remote.sendFile(requirePeer(name).peerId, file, note),
  };
}
