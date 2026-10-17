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
import { deriveKeys, generateSecret } from './net/crypto.js';
import { startHub, type Hub } from './net/hub.js';
import { decodeInvite, encodeInvite, findInvite, toWsUrl } from './net/invite.js';
import { PeerClient } from './net/peer-client.js';
import { closeAllTunnels, openTunnel, waitUntilReachable } from './net/tunnel.js';
import { App } from './ui/App.js';
import { ErrorBoundary } from './ui/components/ErrorBoundary.js';
import { createMockBackend } from './agent/mock.js';
import { createDemoFolders, startDemoFriend } from './demo.js';
import { MOUSE_OFF, MOUSE_ON, type MouseEvent, createMouseInput } from './ui/mouse.js';

interface Room {
  readonly url: string;
  readonly secret: string;
  readonly room: string;
  readonly hub?: Hub;
  readonly invite?: string;
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
  const hub = await startHub({ keys: deriveKeys(secret), port: config.port, host: lan ? '0.0.0.0' : '127.0.0.1', roomName: room });
  return { url: `ws://127.0.0.1:${hub.port}`, secret, room, hub };
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
    return ip ? encodeInvite({ url: `ws://${ip}:${port}`, secret: room.secret }) : undefined;
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
    await announce(encodeInvite({ url: toWsUrl(tunnel.publicUrl), secret: room.secret }), 'ready');
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
  let config = parseConfig(process.argv.slice(2));
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
  const store = new Store(initialState(room.room, config.policy, { theme: config.theme, mouse: config.mouse, tunnel: config.tunnel }));
  if (room.invite) store.dispatch({ type: 'invite', invite: room.invite });

  const client = new PeerClient({
    url: room.url,
    keys: deriveKeys(room.secret),
    profile: { name: config.name, shares: shares.infos, agent: config.agent },
  });

  const primary = config.shares[0];
  const agentCwd = primary?.root ?? process.cwd();
  let shuttingDown = false;
  const session: Session = new Session({
    client,
    store,
    shares,
    agentCwd,
    copy: (text) => copyText(text),
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
  const onboarding = config.agent && !config.policyChosen;
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
  if (config.mode === 'host') void publish(config, room, session, () => shuttingDown);
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
