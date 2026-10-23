import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.js';
import { createClaudeBackend } from '../agent/runner.js';
import { createMockBackend } from '../agent/mock.js';
import { findConversation } from '../agent/claude-sessions.js';
import { otherTools } from '../agent/other-tools.js';
import { copyNative, pasteText } from '../core/clipboard.js';
import { DEFAULT_LINK } from '../core/project-invites.js';
import { type SessionOptions, Session } from '../core/session.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { ShareService } from '../core/shares.js';
import { networkSwitch } from '../core/network.js';
import { launchBoard } from '../core/board/launch.js';
import { launchChat } from '../core/chat/launch.js';
import { launchGateway } from '../core/gateway/launch.js';
import { launchEarnings } from '../core/stripe-launch.js';
import { launchClaudeCode } from '../core/claude-code/launch.js';
import { Store, initialState, prefsFrom } from '../core/store.js';
import { createDemoFolders, createDemoWorkspaces, seedDemoContext, startDemoFriend, startDemoGuest } from '../demo.js';
import { type Identity, deriveKeys, generateSecret, loadIdentity } from '../net/crypto.js';
import { type GuestAccess, type GuestGate, type Hub, startHub } from '../net/hub.js';
import { P2P_SCHEME, decodeInvite, encodeInvite, findInvite, isDirect, toWsUrl } from '../net/invite.js';
import { PeerClient } from '../net/peer-client.js';
import { closeAllTunnels, offersDirect, openTunnel, waitUntilReachable } from '../net/tunnel.js';
import { TerminalManager } from '../terminal/index.js';
import { WorkspaceManager } from '../workspaces/manager.js';
import { belugaHome } from '../workspaces/store.js';
import { belugaEnv } from '../core/beluga-env.js';

/**
 * Everything Beluga is apart from its screens: your identity, the room (hosted or joined),
 * remote access, projects, terminals and the Session that ties them together. The terminal UI
 * builds one in its own process; `beluga daemon` builds one and serves it to every screen.
 */

interface Room {
  readonly url: string;
  /** Joiners: the relay to use when a direct connection can't be made. */
  readonly fallbackUrl?: string;
  /** Changes when the host replaces the invite link. */
  secret: string;
  readonly room: string;
  readonly hub?: Hub;
  readonly invite?: string;
  /** The host's signing identity (its peer id is marked as host in the room). */
  readonly identity?: Identity;
  /** Where friends reach the room, once remote access is up: direct (`p2p://`) or a relay, plus an optional fallback relay. */
  reach?: { url: string; relay?: string };
}

const roomInvite = (room: Room): string | undefined => (room.reach ? encodeInvite({ ...room.reach, secret: room.secret }) : undefined);

function lanAddress(): string | undefined {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
}

async function hostRoom(config: Config, identity: Identity): Promise<Room> {
  const secret = generateSecret();
  const room = `${config.name}'s room`;
  const lan = config.lan || config.tunnel === 'none';
  // The host's peer id comes from its own key, so nobody else can claim to be the host.
  const hub = await startHub({ keys: deriveKeys(secret), port: config.port, host: lan ? '0.0.0.0' : '127.0.0.1', roomName: room, hostId: identity.peerId });
  return { url: `ws://127.0.0.1:${hub.port}`, secret, room, hub, identity };
}

async function resolveJoinInvite(config: Config): Promise<string> {
  if (config.invite) return config.invite;
  const found = findInvite((await pasteText()) ?? '');
  if (!found) throw new Error('No invite given and none found on your clipboard. Copy the link your friend sent, then run: beluga join');
  return found;
}

async function joinRoom(config: Config): Promise<Room> {
  const code = await resolveJoinInvite(config);
  const invite = decodeInvite(code);
  const relayHost = (url: string): string => new URL(url.replace(/^ws/, 'http')).host;
  const label = isDirect(invite.url) ? (invite.relay ? relayHost(invite.relay) : `direct ${invite.url.slice(P2P_SCHEME.length, P2P_SCHEME.length + 6)}…`) : relayHost(invite.url);
  return { url: invite.url, ...(invite.relay ? { fallbackUrl: invite.relay } : {}), secret: invite.secret, room: label, invite: encodeInvite(invite) };
}

type Announce = (phase: 'ready' | 'local') => Promise<void>;

/** Start accepting direct connections; the invite is ready as soon as the host is on the DHT (~1-2s). */
async function publishDirect(room: Room, hub: Hub, announce: Announce): Promise<boolean> {
  try {
    room.reach = { url: `${P2P_SCHEME}${await hub.listenP2P()}` };
    await announce('ready');
    return true;
  } catch {
    return false;
  }
}

/**
 * `auto` with a direct invite already out: bring up a relay in the background for friends
 * whose network blocks direct connections, and add it to the invite once it answers.
 */
async function addFallbackRelay(room: Room, session: Session, isClosing: () => boolean): Promise<void> {
  const store = session.store;
  const update = async (next: Room['reach']): Promise<void> => {
    const before = roomInvite(room);
    room.reach = next;
    const after = roomInvite(room);
    if (isClosing() || !after) return;
    store.dispatch({ type: 'invite', invite: after });
    // Refresh the clipboard only if it still holds the link we put there.
    if (before && (await pasteText().catch(() => undefined))?.trim() === `beluga join ${before}`) await copyNative(`beluga join ${after}`).catch(() => false);
  };
  try {
    const tunnel = await openTunnel('auto', room.hub?.port ?? 0, {
      onDied: () => {
        if (!isClosing() && room.reach) void update({ url: room.reach.url });
      },
    });
    if (!tunnel || isClosing() || !(await waitUntilReachable(tunnel.publicUrl)) || !room.reach) return;
    await update({ ...room.reach, relay: toWsUrl(tunnel.publicUrl) });
  } catch {
    // The direct invite still works; it just has no fallback.
  }
}

/** Bring remote access up in the background so the UI appears instantly. */
async function publish(config: Config, room: Room, session: Session, isClosing: () => boolean): Promise<void> {
  const store = session.store;
  const port = room.hub?.port ?? 0;
  const lanReach = (): boolean => {
    const ip = lanAddress();
    if (ip) room.reach = { url: `ws://${ip}:${port}` };
    return Boolean(ip);
  };
  const announce: Announce = async (phase) => {
    const invite = roomInvite(room);
    if (isClosing() || !invite) return;
    store.dispatch({ type: 'invite', invite });
    store.dispatch({ type: 'hosting', hosting: { phase } });
    // Only auto-copy with a real clipboard tool; never silently push secrets through the terminal.
    const copied = await copyNative(`beluga join ${invite}`).catch(() => false);
    if (!isClosing()) store.dispatch({ type: 'hosting', hosting: { phase, copied } });
  };

  if (config.tunnel === 'none') {
    if (lanReach()) await announce('local');
    else store.dispatch({ type: 'hosting', hosting: { phase: 'failed', detail: 'No network address found.' } });
    return;
  }
  store.dispatch({ type: 'hosting', hosting: { phase: 'tunnel' } });
  if (offersDirect(config.tunnel) && room.hub) {
    if (await publishDirect(room, room.hub, announce)) {
      if (config.tunnel === 'auto') void addFallbackRelay(room, session, isClosing);
      return;
    }
    if (config.tunnel === 'p2p') {
      store.dispatch({ type: 'hosting', hosting: { phase: 'failed', detail: 'Could not reach the peer-to-peer network. Check your connection, or switch Remote access to Cloudflare in /settings.' } });
      return;
    }
    // auto: no direct connections today, so fall back to the relay alone.
  }
  try {
    const tunnel = await openTunnel(config.tunnel, port, {
      onProgress: (detail) => store.dispatch({ type: 'hosting', hosting: { phase: 'tunnel', detail } }),
      onDied: (reason) => {
        if (isClosing()) return;
        store.dispatch({ type: 'hosting', hosting: { phase: 'failed', detail: `${reason}. Restart beluga host to get a new invite.` } });
        session.toast('Remote access stopped: the tunnel closed', 'error');
      },
    });
    if (!tunnel || isClosing()) return;
    store.dispatch({ type: 'hosting', hosting: { phase: 'reachable' } });
    if (!(await waitUntilReachable(tunnel.publicUrl))) throw new Error('The tunnel never became reachable');
    room.reach = { url: toWsUrl(tunnel.publicUrl) };
    await announce('ready');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const fallback = config.lan && lanReach();
    if (fallback) await announce('local');
    store.dispatch({
      type: 'hosting',
      hosting: { phase: 'failed', detail: `${reason}. ${fallback ? 'Friends on your Wi-Fi can still join with /invite.' : 'Restart with --lan to invite people on your Wi-Fi.'}` },
    });
  }
}

/** What only a screen (or the process showing it) can do for the core. */
export type CoreHooks = Pick<SessionOptions, 'copy' | 'desktopNotify' | 'zoom' | 'open' | 'shutdown'>;

export interface Core {
  readonly config: Config;
  readonly session: Session;
  readonly store: Store;
  readonly terminals: TerminalManager;
  /** The room's name (one room per core). */
  readonly room: string;
  /** Where its workspaces' records and saved conversations are kept. */
  readonly workspacesHome: string;
  /** Start everything: the connection, timers, remote access when asked for, the demo's friends. */
  start(): void;
  /** Leave the room and stop everything. */
  stop(): Promise<void>;
}

/** Build Beluga's core for this config (hosting a room, or joining one). */
export async function buildCore(input: Config, hooks: CoreHooks, opts: { readonly network?: boolean } = {}): Promise<Core> {
  let config = input;
  const demo = config.mode === 'demo' ? createDemoFolders() : undefined;
  if (demo) config = { ...config, tunnel: 'none', policyChosen: true, shares: [{ name: 'landing', root: demo.mine, writable: true }] };
  // Your own key, kept between runs: friends recognize you, and the trust they gave you comes back.
  const identity = loadIdentity(path.join(belugaHome(), 'identity.json'));
  const saved = loadSettings();
  const room = config.mode === 'join' ? await joinRoom(config) : await hostRoom(config, identity);
  const shares = new ShareService(config.shares);
  // Remember an explicitly chosen name, so plain `beluga` uses it next time.
  if (process.argv.includes('--name') || process.argv.includes('-n')) saveSettings({ name: config.name });
  const store = new Store(initialState(room.room, config.policy, { ...prefsFrom(saved), theme: config.theme, mouse: config.mouse, tunnel: config.tunnel, selfApproval: config.selfApproval }));
  if (room.invite) store.dispatch({ type: 'invite', invite: room.invite });

  const client = new PeerClient({
    url: room.url,
    ...(room.fallbackUrl ? { fallbackUrl: room.fallbackUrl } : {}),
    keys: deriveKeys(room.secret),
    profile: { name: config.name, shares: shares.infos, agent: config.agent },
    identity,
  });
  const hub = room.hub;
  const replaceInvite = (): void => {
    if (!hub) return;
    room.secret = generateSecret();
    hub.replaceInvite(room.secret, deriveKeys(room.secret));
    const invite = roomInvite(room);
    if (invite) store.dispatch({ type: 'invite', invite });
  };
  const roomControl = hub
    ? {
        removePerson: (peerId: string) => {
          hub.kick(peerId);
          replaceInvite();
        },
        newInvite: replaceInvite,
        setOpen: (open: boolean) => hub.setOpen(open),
        clearHistory: () => hub.clearHistory(),
        guests: {
          setGate: (gate: GuestGate) => hub.setGuestGate(gate),
          setAccess: (peerId: string, access: GuestAccess) => hub.setGuestAccess(peerId, access),
          turnAway: (peerId: string) => void hub.dismiss(peerId, `${config.name} didn't let you in this time`),
        },
      }
    : undefined;

  const primary = config.shares[0];
  const agentCwd = primary?.root ?? process.cwd();
  let closing = false;
  let saveAsked = false;
  const workspaces = demo ? await createDemoWorkspaces() : new WorkspaceManager();
  const terminals = new TerminalManager();
  const session: Session = new Session({
    workspaces,
    client,
    store,
    shares,
    agentCwd,
    ...hooks,
    // Remote access only opens when you ask for an invite.
    startInvite: () => {
      if (config.mode !== 'host' || demo) return;
      if (config.agent && !config.policyChosen && !saveAsked) {
        saveAsked = true;
        session.intend({ type: 'overlay', overlay: 'welcome' });
      }
      void publish(config, room, session, () => closing);
    },
    saveSettings: (patch) => void saveSettings(patch),
    createAgent: demo
      ? (bridge) => createMockBackend(bridge, Number(belugaEnv('DEMO_PACE')) || 2.6) // unhurried, so you can watch workspaces run side by side
      : config.agent
        ? (bridge) =>
            createClaudeBackend({
              cwd: agentCwd,
              autoEdit: primary?.writable ?? false,
              additionalDirectories: config.shares.slice(1).map((s) => s.root),
              bridge,
              model: config.model,
              claudePath: belugaEnv('CLAUDE_PATH'),
            })
        : undefined,
    launchDir: process.cwd(),
    terminals,
    savedPeople: saved.people,
    replayFile: path.join(belugaHome(), 'seen.json'),
    stepsDir: path.join(belugaHome(), 'steps'),
    ...(demo ? {} : { findConversation, otherTools }),
    ...(roomControl ? { room: roomControl } : {}),
  });

  for (const note of config.notes) session.system(note, 'warn');
  if (config.mode === 'join') session.system(`Joining ${room.room}…`);

  let stopNetwork = async (): Promise<void> => undefined;
  let stopEarnings = (): void => undefined;
  let stopClaudeCode = (): void => undefined;
  let stopGateway = (): void => undefined;
  let stopChat = (): void => undefined;
  let stopBoard = (): void => undefined;
  const start = (): void => {
    session.start();
    // The Beluga network (friends, groups, presence): only the daemon runs it, and only when it's turned on.
    // It can be turned on and off later too (`network.setEnabled`).
    if (opts.network) stopNetwork = networkSwitch({ session, store, identity, name: config.name, dir: belugaHome(), demo: Boolean(demo), warn: (text) => session.system(text, 'warn') }, saved).stop;
    // Earnings from Stripe per project (the Mac app shows them): the daemon counts them in the background.
    if (opts.network) stopEarnings = launchEarnings({ session, store, demo: Boolean(demo) });
    // Claude Code sessions running outside Beluga (Conductor, a terminal): the Mac app shows them live, read-only.
    // Tasks between Claudes (the gateway): over this room now, and over the network whenever it's on.
    if (opts.network) stopGateway = launchGateway({ session, store, demo: Boolean(demo) });
    // Chats: files shared Mac to Mac, Claudes called into a conversation, your main channel.
    if (opts.network) stopChat = launchChat({ session, store, demo: Boolean(demo) });
    // Tasks (the board): opened by worktrees, moved by pull requests, kept true by Claude.
    if (opts.network) stopBoard = launchBoard({ session, store, demo: Boolean(demo) });
    if (opts.network) stopClaudeCode = launchClaudeCode({ session, store, demo: Boolean(demo), notify: (e) => session.notifier.notify(e) });
    if (config.mode === 'host' && config.inviteNow) void publish(config, room, session, () => closing);
    if (!demo) return;
    // A pretend friend and a fake invite so every part of the UI has something to show.
    store.dispatch({ type: 'invite', invite: 'https://calm-river-demo.trycloudflare.com#k3JdQ9vXr2Lm8TzW4yBn' });
    store.dispatch({ type: 'hosting', hosting: { phase: 'ready', copied: true } });
    session.system('Demo mode: bob, mia and every Claude are simulated. Nothing leaves your computer.');
    seedDemoContext(store);
    setTimeout(() => session.updateUsage({ plan: 'max', fiveHour: { pct: 12 }, week: { pct: 38 } }), 300);
    // bob "arrives" a moment later so you first see how inviting works (sooner at a faster pace: the e2e tests).
    const soon = (ms: number): number => ms * Math.min(1, Number(process.env.KLAUD_DEMO_PACE) || 1);
    setTimeout(() => startDemoFriend(room.url, deriveKeys(room.secret), demo.bob, 'bob'), soon(2500));
    setTimeout(() => startDemoFriend(room.url, deriveKeys(room.secret), demo.mine, 'mia'), soon(3500));
    // zoe got a link to bob-api and knocks, so you see the card for letting someone in.
    setTimeout(() => {
      const project = store.getState().projects.find((p) => p.name === 'bob-api');
      if (!project) return;
      void session.invites.create({ scope: project.id, ...DEFAULT_LINK }, { copy: false }).then((link) => {
        const secret = link && session.invites.urlOf(link.id)?.match(/#([\w-]+)$/)?.[1];
        if (secret) startDemoGuest(room.url, deriveKeys(secret));
      });
    }, soon(5500));
  };

  const stop = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    closeAllTunnels();
    stopGateway();
    stopChat();
    stopBoard();
    await stopNetwork();
    stopEarnings();
    stopClaudeCode();
    await session.stop();
    terminals.closeAll();
    await room.hub?.close();
  };

  return { config, session, store, terminals, room: room.room, workspacesHome: workspaces.store.home, start, stop };
}
