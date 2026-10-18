#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { USAGE, type Config, parseConfig } from './config.js';
import { createClaudeBackend } from './agent/runner.js';
import { copyNative, copyText, pasteText } from './core/clipboard.js';
import { Session } from './core/session.js';
import { ShareService } from './core/shares.js';
import { Store, initialState, prefsFrom } from './core/store.js';
import { loadSettings, saveSettings } from './core/settings.js';
import { createDesktopNotifier } from './core/desktop-notify.js';
import { TerminalManager } from './terminal/index.js';
import { klaudHome } from './workspaces/store.js';
import { applyTheme } from './ui/theme.js';
import { type Identity, deriveKeys, generateSecret, loadIdentity } from './net/crypto.js';
import { startHub, type Hub } from './net/hub.js';
import { P2P_SCHEME, decodeInvite, encodeInvite, findInvite, isDirect, toWsUrl } from './net/invite.js';
import { PeerClient } from './net/peer-client.js';
import { closeAllTunnels, offersDirect, openTunnel, waitUntilReachable } from './net/tunnel.js';
import { App } from './ui/App.js';
import { ErrorBoundary } from './ui/components/ErrorBoundary.js';
import { createMockBackend } from './agent/mock.js';
import { runUpdate } from './update/update.js';
import { findConversation } from './agent/transcript.js';
import { installedVersion } from './update/check.js';
import { runView } from './image/view-cli.js';
import { createDemoFolders, createDemoWorkspaces, startDemoFriend } from './demo.js';
import { WorkspaceManager } from './workspaces/manager.js';
import { FOCUS_OFF, FOCUS_ON, MOUSE_OFF, MOUSE_ON, type MouseEvent, createInput } from './ui/mouse.js';

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
  if (!found) throw new Error('No invite given and none found on your clipboard. Copy the link your friend sent, then run: klaud join');
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
    if (before && (await pasteText().catch(() => undefined))?.trim() === `klaud join ${before}`) await copyNative(`klaud join ${after}`).catch(() => false);
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
    const copied = await copyNative(`klaud join ${invite}`).catch(() => false);
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
        store.dispatch({ type: 'hosting', hosting: { phase: 'failed', detail: `${reason}. Restart klaud host to get a new invite.` } });
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') {
    process.stdout.write(`klaud ${installedVersion()}\n`);
    return;
  }
  if (args[0] === 'view') {
    process.exitCode = await runView(args.slice(1));
    return;
  }
  if (args[0] === 'update') {
    process.exitCode = await runUpdate({ checkOnly: args.includes('--check') });
    return;
  }
  let config = parseConfig(args);
  if (config.mode === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const demo = config.mode === 'demo' ? createDemoFolders() : undefined;
  if (demo) config = { ...config, tunnel: 'none', policyChosen: true, shares: [{ name: 'landing', root: demo.mine, writable: true }] };
  // Your own key, kept between runs: friends recognize you, and the trust they gave you comes back.
  const identity = loadIdentity(path.join(klaudHome(), 'identity.json'));
  const saved = loadSettings();
  const room = config.mode === 'join' ? await joinRoom(config) : await hostRoom(config, identity);
  const shares = new ShareService(config.shares);
  applyTheme(config.theme);
  // Remember an explicitly chosen name, so plain `klaud` uses it next time.
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
      }
    : undefined;

  const primary = config.shares[0];
  const agentCwd = primary?.root ?? process.cwd();
  let shuttingDown = false;
  let saveAsked = false;
  const workspaces = demo ? await createDemoWorkspaces() : new WorkspaceManager();
  const terminals = new TerminalManager();
  const desktop = await createDesktopNotifier((data) => process.stdout.write(data)).catch(() => undefined);
  const session: Session = new Session({
    workspaces,
    client,
    store,
    shares,
    agentCwd,
    copy: (text) => copyText(text),
    // Remote access only opens when you ask for an invite.
    startInvite: () => {
      if (config.mode !== 'host' || demo) return;
      if (config.agent && !config.policyChosen && !saveAsked) {
        saveAsked = true;
        store.dispatch({ type: 'overlay', overlay: 'welcome' });
      }
      void publish(config, room, session, () => shuttingDown);
    },
    saveSettings: (patch) => void saveSettings(patch),
    createAgent: demo
      ? (bridge) => createMockBackend(bridge, Number(process.env.KLAUD_DEMO_PACE) || 2.6) // unhurried, so you can watch workspaces run side by side
      : config.agent
      ? (bridge) =>
          createClaudeBackend({
            cwd: agentCwd,
            autoEdit: primary?.writable ?? false,
            additionalDirectories: config.shares.slice(1).map((s) => s.root),
            bridge,
            model: config.model,
            claudePath: process.env.KLAUD_CLAUDE_PATH,
          })
      : undefined,
    onQuit: () => void shutdown(),
    launchDir: process.cwd(),
    terminals,
    savedPeople: saved.people,
    replayFile: path.join(klaudHome(), 'seen.json'),
    ...(desktop ? { desktopNotify: desktop } : {}),
    ...(demo ? {} : { findConversation }),
    ...(roomControl ? { room: roomControl } : {}),
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    closeAllTunnels();
    try {
      app.unmount();
      await session.stop();
      await room.hub?.close();
    } finally {
      if (config.mouse) process.stdout.write(MOUSE_OFF);
      process.stdout.write(FOCUS_OFF);
      process.stdout.write('\x1b[?1049l');
      process.stdout.write('klaud: left the room. See you soon!\n');
      process.exit(0);
    }
  };

  for (const note of config.notes) session.system(note, 'warn');
  if (config.mode === 'join') session.system(`Joining ${room.room}…`);

  const mouseListeners = new Set<(e: MouseEvent) => void>();
  // The built-in terminal takes the keyboard while it's focused (raw keys go to its shell).
  let rawSink: ((data: string) => void) | undefined;
  let lastInput = 0;
  const stdin = process.stdin.isTTY
    ? createInput(process.stdin, {
        onMouse: (e) => mouseListeners.forEach((l) => l(e)),
        onFocus: (focused) => store.dispatch({ type: 'away', away: !focused }),
        rawSink: () => rawSink,
        onData: () => (lastInput = Date.now()),
      })
    : process.stdin;
  const subscribeMouse = config.mouse
    ? (listener: (e: MouseEvent) => void) => {
        mouseListeners.add(listener);
        return () => void mouseListeners.delete(listener);
      }
    : undefined;

  process.stdout.write('\x1b[?1049h\x1b[H');
  if (config.mouse) process.stdout.write(MOUSE_ON);
  // Know when klaud is in the background, so notifications only fire when they help.
  process.stdout.write(FOCUS_ON);
  // Who may use your Claude only matters once you invite someone (or join a room).
  const onboarding = config.agent && !config.policyChosen && (config.mode === 'join' || config.inviteNow);
  const app = render(
    <ErrorBoundary>
      <App session={session} onboarding={onboarding} subscribeMouse={subscribeMouse} setRawInput={(sink) => (rawSink = sink)} inputTime={() => lastInput} />
    </ErrorBoundary>,
    // Only rewrite the lines that changed, and redraw often enough that scrolling feels smooth.
    { exitOnCtrlC: false, stdin, incrementalRendering: true, maxFps: 60 },
  );
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGHUP', () => void shutdown()); // terminal window closed
  // A background task failing (a git call, a config write…) shouldn't kill klaud: say so and carry on.
  process.on('unhandledRejection', (err) => session.toast(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), 'error'));
  // Whatever happens, leave the terminal as we found it (no stray mouse codes, normal screen).
  process.on('exit', () => {
    if (!shuttingDown) process.stdout.write(MOUSE_OFF + FOCUS_OFF + '\x1b[?2004l\x1b[?1049l');
  });
  session.start();
  if (config.mode === 'host' && config.inviteNow) void publish(config, room, session, () => shuttingDown);
  if (demo) {
    // A pretend friend and a fake invite so every part of the UI has something to show.
    store.dispatch({ type: 'invite', invite: 'https://calm-river-demo.trycloudflare.com#k3JdQ9vXr2Lm8TzW4yBn' });
    store.dispatch({ type: 'hosting', hosting: { phase: 'ready', copied: true } });
    session.system('Demo mode: bob, mia and every Claude are simulated. Nothing leaves your computer.');
    setTimeout(() => session.updateUsage({ plan: 'max', fiveHour: { pct: 12 }, week: { pct: 38 } }), 300);
    // bob "arrives" a moment later so you first see how inviting works.
    setTimeout(() => startDemoFriend(room.url, deriveKeys(room.secret), demo.bob, 'bob'), 2500);
    setTimeout(() => startDemoFriend(room.url, deriveKeys(room.secret), demo.mine, 'mia'), 3500);
  }
}

main().catch((err: unknown) => {
  process.stdout.write(MOUSE_OFF + FOCUS_OFF + '\x1b[?1049l');
  process.stderr.write(`klaud: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
