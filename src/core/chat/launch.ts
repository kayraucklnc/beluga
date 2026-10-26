import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asks } from '../../net/mesh/extras.js';
import type { Mesh } from '../../net/mesh/mesh.js';
import { assistantOf } from '../assistant/registry.js';
import { belugaHome } from '../home.js';
import { watchNetwork } from '../network.js';
import type { Session } from '../session.js';
import { loadSettings, saveSettings } from '../settings.js';
import type { Store } from '../store.js';
import { trustOf } from '../trust.js';
import { ChatClaude } from './claude.js';
import { ChatFiles } from './files.js';
import { MainChannel } from './main-channel.js';

/**
 * Chats for the daemon (the Mac app's Beluga), whenever the network is on: files in chats,
 * Claudes called into chats, and your main channel. The demo keeps its files in a temporary
 * folder; otherwise they live in ~/.beluga/chat-files/.
 */

export interface Chat {
  readonly mesh: Mesh;
  readonly files: ChatFiles;
  readonly claude: ChatClaude;
  readonly main: MainChannel;
  stop(): void;
}

const chats = new WeakMap<object, Chat>();

/** This session's chats, or a clear error while the network is off. */
export function chatOf(session: object): Chat {
  const chat = chats.get(session);
  if (!chat) throw new Error('Turn on talking with friends first');
  return chat;
}

export interface ChatHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

/** Start chats on a mesh: files, Claudes and the main channel, all mirrored into the store. */
export function startChat(opts: { mesh: Mesh; store: Store; session?: Session; dir: string; loadMain: () => string | undefined; saveMain: (id: string) => void }): Chat {
  const { mesh, store, session } = opts;
  const files = new ChatFiles({ mesh, dir: path.join(opts.dir, 'chat-files'), onState: (patch) => store.dispatch({ type: 'net_files', files: patch }) });
  const nameOf = (peerId: string): string => (peerId === mesh.peerId ? (mesh.summary().self?.name ?? 'you') : mesh.nameFor(peerId));
  const claude = new ChatClaude({
    mesh,
    files,
    answer: session?.backend?.answerChat ? (req) => session.backend!.answerChat!(req) : undefined,
    // You asking your own Claude: a real turn with its tools, in this chat (BLG-207).
    // It works in Your Mac's folder: only where that is (the Mac app's daemon).
    ...(session?.backend ? { act: (conversation: string, prompt: string) => session.host.runChat(conversation, prompt), canAct: () => Boolean(assistantOf(session)) } : {}),
    policy: () => store.getState().prefs.chatClaude,
    trustOf: (peerId) => trustOf(store.getState(), peerId),
    model: () => store.getState().prefs.model,
    handledFile: path.join(opts.dir, 'chat-claude.json'),
    onLive: (conversation, id, state) => store.dispatch({ type: 'net_live', conversation, state, live: { peerId: mesh.peerId, name: nameOf(mesh.peerId), for: id, since: Date.now() } }),
    onProblem: (conversation, text) => session?.notifier.notify({ kind: 'problems', title: 'Your Claude couldn’t answer', body: text, channel: conversation }),
  });
  // Someone's Claude is answering: only for an ask you have that called their Claude in.
  const onLive = (e: { conversation: string; from: string; for: string; state: 'thinking' | 'idle' }): void => {
    const known = store.getState().network.messages[e.conversation]?.some((m) => m.id === e.for && asks(m, e.from));
    if (known || e.state === 'idle') store.dispatch({ type: 'net_live', conversation: e.conversation, state: e.state, live: { peerId: e.from, name: nameOf(e.from), for: e.for, since: Date.now() } });
  };
  mesh.on('live', onLive);
  const main = new MainChannel(mesh, opts.loadMain, (id) => {
    opts.saveMain(id);
    store.dispatch({ type: 'net_main', groupId: id });
  });
  // New friends join your main channel; it shows as main once it exists.
  let friends = mesh.summary().friends.length;
  const onChange = (): void => {
    const now = mesh.summary().friends.length;
    if (now !== friends) {
      friends = now;
      main.sync();
    }
  };
  mesh.on('change', onChange);
  store.dispatch({ type: 'net_main', groupId: main.id });
  main.sync();
  return {
    mesh,
    files,
    claude,
    main,
    stop: () => {
      claude.stop();
      files.stop();
      mesh.off('live', onLive);
      mesh.off('change', onChange);
    },
  };
}

export function launchChat(host: ChatHost): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-chat-')) : belugaHome();
  let demoMain: string | undefined;
  let current: Chat | undefined;
  const off = watchNetwork(session, (service) => {
    if (current) {
      current.stop();
      chats.delete(session);
      current = undefined;
    }
    if (!service) return;
    current = startChat({
      mesh: service.mesh,
      store,
      session,
      dir,
      loadMain: () => (host.demo ? demoMain : loadSettings().mainChannel),
      saveMain: (id) => {
        if (host.demo) demoMain = id;
        else saveSettings({ mainChannel: id });
      },
    });
    chats.set(session, current);
  });
  return () => {
    off();
    current?.stop();
    chats.delete(session);
    if (host.demo) rmSync(dir, { recursive: true, force: true });
  };
}
