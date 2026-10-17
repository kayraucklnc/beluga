#!/usr/bin/env node
import os from 'node:os';
import React from 'react';
import { render } from 'ink';
import { USAGE, type Config, parseConfig } from './config.js';
import { createClaudeBackend } from './agent/runner.js';
import { copyNative, copyText, pasteText } from './core/clipboard.js';
import { Session } from './core/session.js';
import { ShareService } from './core/shares.js';
import { Store, initialState } from './core/store.js';
import { saveSettings } from './core/settings.js';
import { applyTheme } from './ui/theme.js';
import { type Identity, deriveKeys, generateIdentity, generateSecret } from './net/crypto.js';
import { startHub, type Hub } from './net/hub.js';
import { decodeInvite, encodeInvite, findInvite, toWsUrl } from './net/invite.js';
import { PeerClient } from './net/peer-client.js';
import { closeAllTunnels, openTunnel, waitUntilReachable } from './net/tunnel.js';
import { App } from './ui/App.js';
import { ErrorBoundary } from './ui/components/ErrorBoundary.js';
import { createMockBackend } from './agent/mock.js';
import { runUpdate } from './update/update.js';
import { installedVersion } from './update/check.js';
import { runView } from './image/view-cli.js';
import { createDemoFolders, createDemoWorkspaces, startDemoFriend } from './demo.js';
import { WorkspaceManager } from './workspaces/manager.js';
import { MOUSE_OFF, MOUSE_ON, type MouseEvent, createMouseInput } from './ui/mouse.js';

interface Room {
  readonly url: string;
  /** Changes when the host replaces the invite link. */
  secret: string;
  readonly room: string;
  readonly hub?: Hub;
  readonly invite?: string;
  /** The host's signing identity (its peer id is marked as host in the room). */
  readonly identity?: Identity;
  /** Where friends reach the room, once remote access is up. */
  publicUrl?: string;
}

function lanAddress(): string | undefined {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
}

async function hostRoom(config: Config): Promise<Room> {
  const secret = generateSecret();
  const room = `${config.name}'s room`;
  const lan = config.lan || config.tunnel === 'none';
  // The host's peer id comes from its own key, so nobody else can claim to be the host.
  const identity = generateIdentity();
  const hub = await startHub({ keys: deriveKeys(secret), port: config.port, host: lan ? '0.0.0.0' : '127.0.0.1', roomName: room, hostId: identity.peerId });
  return { url: `ws://127.0.0.1:${hub.port}`, secret, room, hub, identity };
}

async function resolveJoinInvite(config: Config): Promise<string> {
  if (config.invite) return config.invite;
  const found = findInvite((await pasteText()) ?? '');
  if (!found) throw new Error('No invite given and none found on your clipboard. Copy the link your friend sent, then run: klaude join');
  return found;
}

async function joinRoom(config: Config): Promise<Room> {
  const code = await resolveJoinInvite(config);
  const invite = decodeInvite(code);
  const host = new URL(invite.url.replace(/^ws/, 'http')).host;
  return { url: invite.url, secret: invite.secret, room: host, invite: encodeInvite(invite) };
}

/** Bring remote access up in the background so the UI appears instantly. */
async function publish(config: Config, room: Room, session: Session, isClosing: () => boolean): Promise<void> {
  const store = session.store;
  const port = room.hub?.port ?? 0;
  const lanInvite = (): string | undefined => {
    const ip = lanAddress();
    if (!ip) return undefined;
    room.publicUrl = `ws://${ip}:${port}`;
    return encodeInvite({ url: room.publicUrl, secret: room.secret });
  };
  const announce = async (invite: string, phase: 'ready' | 'local'): Promise<void> => {
    if (isClosing()) return;
    store.dispatch({ type: 'invite', invite });
    store.dispatch({ type: 'hosting', hosting: { phase } });
    // Only auto-copy with a real clipboard tool; never silently push secrets through the terminal.
    const copied = await copyNative(`klaude join ${invite}`).catch(() => false);
    if (!isClosing()) store.dispatch({ type: 'hosting', hosting: { phase, copied } });
  };

  if (config.tunnel === 'none') {
    const invite = lanInvite();
    if (invite) await announce(invite, 'local');
    else store.dispatch({ type: 'hosting', hosting: { phase: 'failed', detail: 'No network address found.' } });
    return;
  }
  store.dispatch({ type: 'hosting', hosting: { phase: 'tunnel' } });
  try {
    const tunnel = await openTunnel(config.tunnel, port, {
      onProgress: (detail) => store.dispatch({ type: 'hosting', hosting: { phase: 'tunnel', detail } }),
      onDied: (reason) => {
        if (isClosing()) return;
        store.dispatch({ type: 'hosting', hosting: { phase: 'failed', detail: `${reason}. Restart klaude host to get a new invite.` } });
        session.toast('Remote access stopped: the tunnel closed', 'error');
      },
    });
    if (!tunnel || isClosing()) return;
    store.dispatch({ type: 'hosting', hosting: { phase: 'reachable' } });
    if (!(await waitUntilReachable(tunnel.publicUrl))) throw new Error('The tunnel never became reachable');
    room.publicUrl = toWsUrl(tunnel.publicUrl);
    await announce(encodeInvite({ url: room.publicUrl, secret: room.secret }), 'ready');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const fallback = config.lan ? lanInvite() : undefined;
    if (fallback) await announce(fallback, 'local');
    store.dispatch({
      type: 'hosting',
      hosting: { phase: 'failed', detail: `${reason}. ${fallback ? 'Friends on your Wi-Fi can still join with /invite.' : 'Restart with --lan to invite people on your Wi-Fi.'}` },
    });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') {
    process.stdout.write(`klaude ${installedVersion()}\n`);
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
  const room = config.mode === 'join' ? await joinRoom(config) : await hostRoom(config);
  const shares = new ShareService(config.shares);
  applyTheme(config.theme);
  // Remember an explicitly chosen name, so plain `klaude` uses it next time.
  if (process.argv.includes('--name') || process.argv.includes('-n')) saveSettings({ name: config.name });
  const store = new Store(initialState(room.room, config.policy, { theme: config.theme, mouse: config.mouse, tunnel: config.tunnel, selfApproval: config.selfApproval }));
  if (room.invite) store.dispatch({ type: 'invite', invite: room.invite });

  const client = new PeerClient({
    url: room.url,
    keys: deriveKeys(room.secret),
    profile: { name: config.name, shares: shares.infos, agent: config.agent },
    ...(room.identity ? { identity: room.identity } : {}),
  });
  const hub = room.hub;
  const replaceInvite = (): void => {
    if (!hub) return;
    room.secret = generateSecret();
    hub.replaceInvite(room.secret, deriveKeys(room.secret));
    if (room.publicUrl) store.dispatch({ type: 'invite', invite: encodeInvite({ url: room.publicUrl, secret: room.secret }) });
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
      ? (bridge) => createMockBackend(bridge)
      : config.agent
      ? (bridge) =>
          createClaudeBackend({
            cwd: agentCwd,
            autoEdit: primary?.writable ?? false,
            additionalDirectories: config.shares.slice(1).map((s) => s.root),
            bridge,
            model: config.model,
            claudePath: process.env.KLAUDE_CLAUDE_PATH,
          })
      : undefined,
    onQuit: () => void shutdown(),
    launchDir: process.cwd(),
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
      process.stdout.write('\x1b[?1049l');
      process.stdout.write('klaude: left the room. See you soon!\n');
      process.exit(0);
    }
  };

  for (const note of config.notes) session.system(note, 'warn');
  if (config.mode === 'join') session.system(`Joining ${room.room}…`);

  const mouseListeners = new Set<(e: MouseEvent) => void>();
  const stdin = config.mouse && process.stdin.isTTY ? createMouseInput(process.stdin, (e) => mouseListeners.forEach((l) => l(e))) : process.stdin;
  const subscribeMouse = config.mouse
    ? (listener: (e: MouseEvent) => void) => {
        mouseListeners.add(listener);
        return () => void mouseListeners.delete(listener);
      }
    : undefined;

  process.stdout.write('\x1b[?1049h\x1b[H');
  if (config.mouse) process.stdout.write(MOUSE_ON);
  // Who may use your Claude only matters once you invite someone (or join a room).
  const onboarding = config.agent && !config.policyChosen && (config.mode === 'join' || config.inviteNow);
  const app = render(
    <ErrorBoundary>
      <App session={session} onboarding={onboarding} subscribeMouse={subscribeMouse} />
    </ErrorBoundary>,
    { exitOnCtrlC: false, stdin },
  );
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGHUP', () => void shutdown()); // terminal window closed
  session.start();
  if (config.mode === 'host' && config.inviteNow) void publish(config, room, session, () => shuttingDown);
  if (demo) {
    // A pretend friend and a fake invite so every part of the UI has something to show.
    store.dispatch({ type: 'invite', invite: 'https://calm-river-demo.trycloudflare.com#k3JdQ9vXr2Lm8TzW4yBn' });
    store.dispatch({ type: 'hosting', hosting: { phase: 'ready', copied: true } });
    session.system('Demo mode: bob and both Claudes are simulated. Nothing leaves your computer.');
    setTimeout(() => session.updateUsage({ plan: 'max', fiveHour: { pct: 12 }, week: { pct: 38 } }), 300);
    // bob "arrives" a moment later so you first see how inviting works.
    setTimeout(() => startDemoFriend(room.url, deriveKeys(room.secret), demo.bob), 2500);
  }
}

main().catch((err: unknown) => {
  process.stdout.write(MOUSE_OFF + '\x1b[?1049l');
  process.stderr.write(`klaude: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
