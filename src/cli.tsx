#!/usr/bin/env node
import os from 'node:os';
import { spawn } from 'node:child_process';
import React from 'react';
import { render } from 'ink';
import { USAGE, type Config, parseConfig } from './config.js';
import { createClaudeBackend } from './agent/runner.js';
import { Session } from './core/session.js';
import { ShareService } from './core/shares.js';
import { Store, initialState } from './core/store.js';
import { deriveKeys, generateSecret } from './net/crypto.js';
import { startHub, type Hub } from './net/hub.js';
import { decodeInvite, encodeInvite, toWsUrl } from './net/invite.js';
import { PeerClient } from './net/peer-client.js';
import { openTunnel, type Tunnel } from './net/tunnel.js';
import { App } from './ui/App.js';

interface Room {
  readonly url: string;
  readonly secret: string;
  readonly room: string;
  readonly invite?: string;
  readonly notes: readonly string[];
  readonly hub?: Hub;
  readonly tunnel?: Tunnel;
}

function lanAddress(): string | undefined {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
}

function copyToClipboard(text: string): boolean {
  if (process.platform !== 'darwin') return false;
  const child = spawn('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => undefined);
  child.stdin.end(text);
  return true;
}

async function hostRoom(config: Config): Promise<Room> {
  const secret = generateSecret();
  const hub = await startHub({ keys: deriveKeys(secret), port: config.port, host: config.lan ? '0.0.0.0' : '127.0.0.1' });
  const room = `${config.name}'s room`;
  const notes: string[] = [];
  let tunnel: Tunnel | undefined;
  try {
    tunnel = await openTunnel(config.tunnel, hub.port);
  } catch (err) {
    notes.push(err instanceof Error ? err.message : String(err));
  }
  const lan = lanAddress();
  const publicUrl = tunnel ? toWsUrl(tunnel.publicUrl) : config.lan && lan ? `ws://${lan}:${hub.port}` : undefined;
  const invite = publicUrl ? encodeInvite({ url: publicUrl, secret, room }) : undefined;
  if (tunnel) notes.push(`Tunnel up via ${tunnel.kind}: ${tunnel.publicUrl}`);
  if (invite) {
    notes.push(`Invite your friends:  klaude join ${invite}`);
    if (copyToClipboard(`klaude join ${invite}`)) notes.push('(copied to clipboard)');
  } else {
    notes.push(`No public URL. Hub is on 127.0.0.1:${hub.port}; restart with --lan or install ngrok/cloudflared.`);
  }
  notes.push('Everything is end-to-end encrypted with the secret inside the invite. Only share it with friends.');
  return { url: `ws://127.0.0.1:${hub.port}`, secret, room, invite, notes, hub, tunnel };
}

function joinRoom(config: Config): Room {
  const invite = decodeInvite(config.invite ?? '');
  return { url: invite.url, secret: invite.secret, room: invite.room ?? 'room', notes: [`Joining ${invite.room ?? 'room'}…`] };
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  if (config.mode === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const room = config.mode === 'host' ? await hostRoom(config) : joinRoom(config);
  const shares = new ShareService(config.shares);
  const store = new Store(initialState(room.room, config.policy));
  if (room.invite) store.dispatch({ type: 'invite', invite: `klaude join ${room.invite}` });

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
    createAgent: config.agent
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
    app.unmount();
    await session.stop();
    room.tunnel?.close();
    await room.hub?.close();
    process.stdout.write('\x1b[?1049l');
    if (room.invite) process.stdout.write('klaude: room closed.\n');
    process.exit(0);
  };

  for (const note of room.notes) session.system(note, note.startsWith('No ') ? 'warn' : 'info');
  session.system('Type to chat · @claude <task> for your agent · @claude:<friend> for theirs · :help');

  process.stdout.write('\x1b[?1049h\x1b[H');
  const app = render(<App session={session} />, { exitOnCtrlC: false });
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  session.start();
}

main().catch((err: unknown) => {
  process.stdout.write('\x1b[?1049l');
  process.stderr.write(`klaude: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
