import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Mesh } from '../../net/mesh/mesh.js';
import { klaudHome } from '../home.js';
import { watchNetwork } from '../network.js';
import type { Session } from '../session.js';
import { loadSettings, saveSettings } from '../settings.js';
import type { Store } from '../store.js';
import { Gateway, type MeshNode } from './gateway.js';
import { attachGateway, detachGateway } from './registry.js';
import type { Pending } from './serve.js';

/**
 * Start the gateway for the daemon (the Mac app's klaud): tasks between Claudes over today's
 * room at once, and over the klaud network whenever it's on. The demo keeps its tasks in a
 * temporary folder; otherwise they live in ~/.klaud/tasks/.
 */

/** The mesh node as the gateway sees it. */
export function meshNode(mesh: Mesh): MeshNode {
  return {
    get peerId() {
      return mesh.peerId;
    },
    isFriend: (id) => mesh.isFriend(id),
    isLinked: (id) => mesh.isLinked(id),
    sendGateway: (id, payload) => mesh.sendGateway(id, payload),
    nameFor: (id) => mesh.nameFor(id),
    listen: ({ frame, link }) => {
      mesh.on('gateway', frame);
      mesh.on('link', link);
      return () => {
        mesh.off('gateway', frame);
        mesh.off('link', link);
      };
    },
  };
}

/** Ask through today's approval cards, with a way to take the question back (it's answered "no"). */
export function approvals(session: Pick<Session, 'host' | 'store'>): (kind: 'request' | 'tool', title: string, detail: string, peer: string) => Pending {
  return (kind, title, detail, peer) => {
    const before = new Set(session.store.getState().approvals.map((a) => a.id));
    const answer = session.host.ask(kind, title, detail, peer);
    // ask() shows its card right away: find it, so it can be withdrawn.
    const id = session.store.getState().approvals.find((a) => !before.has(a.id))?.id;
    return { answer, withdraw: () => void (id && session.host.answerApproval('no', id)) };
  };
}

export interface GatewayHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

export function launchGateway(host: GatewayHost): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'klaud-demo-tasks-')) : path.join(klaudHome(), 'tasks');
  let note = host.demo ? 'a review of the landing page, or anything in my projects' : (loadSettings().askMeFor ?? '');
  const projects = (): Array<{ name: string; root: string }> => (session.workspaces?.manager.list ?? []).filter((p) => p.root && !p.error).map((p) => ({ name: p.name, root: p.root }));
  const gateway = new Gateway({
    store,
    dir,
    scratch: dir,
    selfId: () => session.selfId,
    selfName: () => store.getState().self?.name ?? store.getState().network.self?.name ?? 'me',
    agent: () => session.backend,
    approve: approvals(session),
    setTrust: (peerId, level) => session.people.setTrust(peerId, level, true),
    serveShell: (from, ask, hooks) => session.peerRun.serveTask(from, ask, hooks),
    resume: (channel, prompt) => {
      const name = /^\[klaud\] (.+?) \(task/.exec(prompt)?.[1] ?? 'A reply came';
      store.dispatch({ type: 'system', text: `${name}. Claude continues with it.`, channel });
      session.runFor(session.selfId, channel, prompt);
    },
    projectRoot: (name) => projects().find((p) => p.name === name)?.root,
    projects: () => (store.getState().prefs.friendWorktrees === 'ask' ? projects().map((p) => p.name) : []),
    loadNote: () => note,
    saveNote: (text) => {
      note = text;
      if (!host.demo) saveSettings({ askMeFor: text || undefined });
    },
    notify: (e) => session.notifier.notify(e),
    room: () => ({
      present: (id) => {
        const state = store.getState();
        return state.status === 'connected' && state.peers.some((p) => p.peerId === id && !p.guest);
      },
      send: (id, frame) => session.send({ kind: 'gateway', frame }, { to: id }),
    }),
  });
  attachGateway(session, gateway);
  const offNetwork = watchNetwork(session, (service) => (service ? gateway.attachMesh(meshNode(service.mesh)) : gateway.detachMesh()));
  let peers = store.getState().peers;
  const offPeers = store.subscribe(() => {
    const now = store.getState().peers;
    if (now === peers) return;
    peers = now;
    gateway.roomChanged();
  });
  return () => {
    offNetwork();
    offPeers();
    detachGateway(session);
    gateway.stop();
    if (host.demo) rmSync(dir, { recursive: true, force: true });
  };
}
