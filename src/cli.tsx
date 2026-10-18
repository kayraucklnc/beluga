#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { USAGE, type Config, parseConfig } from './config.js';
import { openWithSystem } from './core/local.js';
import { copyText } from './ui/tty/clipboard.js';
import { zoom } from './ui/tty/zoom.js';
import { createDesktopNotifier } from './ui/tty/desktop-notify.js';
import { applyTheme } from './ui/theme.js';
import { App } from './ui/App.js';
import { ErrorBoundary } from './ui/components/ErrorBoundary.js';
import { runUpdate } from './update/update.js';
import { installedVersion } from './update/check.js';
import { runView } from './ui/tty/view-cli.js';
import { FOCUS_OFF, FOCUS_ON, MOUSE_OFF, MOUSE_ON, type MouseEvent, PASTE_OFF, PASTE_ON, createInput } from './ui/mouse.js';
import { buildCore } from './daemon/core.js';
import { roomKeyOf, runDaemon } from './daemon/main.js';
import { runningDaemon } from './daemon/files.js';
import { APP_ORIGINS } from './daemon/server.js';
import type { KlaudClient } from './ipc/client.js';
import { InProcessClient } from './ipc/in-process.js';
import { connectOrSpawn, listening } from './ipc/launch.js';
import type { SocketClient } from './ipc/socket-client.js';

const RESTORE = MOUSE_OFF + FOCUS_OFF + PASTE_OFF + '\x1b[?1049l';

/** The terminal UI on a client: takes over the terminal, draws the App, gives the terminal back on the way out. */
function runTui(client: KlaudClient, config: Config, leave: () => Promise<void>, farewell: string): (message?: string) => Promise<void> {
  let shuttingDown = false;
  const shutdown = async (message = farewell): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      app.unmount();
      await leave();
    } finally {
      if (config.mouse) process.stdout.write(MOUSE_OFF);
      process.stdout.write(FOCUS_OFF + PASTE_OFF);
      process.stdout.write('\x1b[?1049l');
      process.stdout.write(`${message}\n`);
      process.exit(0);
    }
  };
  client.onIntent((intent) => {
    if (intent.type === 'quit') void shutdown();
  });

  const mouseListeners = new Set<(e: MouseEvent) => void>();
  let pasteListener: ((text: string) => boolean) | undefined;
  // The built-in terminal takes the keyboard while it's focused (raw keys go to its shell).
  let rawSink: ((data: string) => void) | undefined;
  let lastInput = 0;
  const stdin = process.stdin.isTTY
    ? createInput(process.stdin, {
        onMouse: (e) => mouseListeners.forEach((l) => l(e)),
        onFocus: (focused) => client.store.dispatch({ type: 'away', away: !focused }),
        rawSink: () => rawSink,
        onPaste: (text) => pasteListener?.(text) ?? false,
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
  // Pastes arrive marked, so an image paste (which sends no text) can attach the clipboard's image.
  if (process.stdin.isTTY) process.stdout.write(PASTE_ON);
  // Who may use your Claude only matters once you invite someone (or join a room).
  const onboarding = config.agent && !config.policyChosen && (config.mode === 'join' || config.inviteNow);
  const app = render(
    <ErrorBoundary>
      <App client={client} onboarding={onboarding} subscribeMouse={subscribeMouse} setRawInput={(sink) => (rawSink = sink)} setPasteHandler={(fn) => (pasteListener = fn)} inputTime={() => lastInput} />
    </ErrorBoundary>,
    // Only rewrite the lines that changed, and redraw often enough that scrolling feels smooth.
    { exitOnCtrlC: false, stdin, incrementalRendering: true, maxFps: 60 },
  );
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGHUP', () => void shutdown()); // terminal window closed
  // A background task failing (a git call, a config write…) shouldn't kill klaud: say so and carry on.
  process.on('unhandledRejection', (err) => client.store.dispatch({ type: 'toast', text: `Something went wrong: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), level: 'error' }));
  // Whatever happens, leave the terminal as we found it (no stray mouse codes, normal screen).
  process.on('exit', () => {
    if (!shuttingDown) process.stdout.write(RESTORE);
  });
  return shutdown;
}

/** klaud in this process: the core and its one screen together (quitting leaves the room). */
async function inProcess(config: Config): Promise<void> {
  const desktop = await createDesktopNotifier((data) => process.stdout.write(data)).catch(() => undefined);
  let shutdown: (message?: string) => Promise<void> = async () => undefined;
  const core = await buildCore(config, {
    copy: (text) => copyText(text),
    zoom: (dir) => zoom(dir),
    ...(desktop ? { desktopNotify: desktop } : {}),
    shutdown: () => void shutdown(),
  });
  const client = new InProcessClient(core.session, { kind: 'tui', launchDir: process.cwd() });
  shutdown = runTui(
    client,
    config,
    async () => {
      client.close();
      await core.stop();
    },
    'klaud: left the room. See you soon!',
  );
  core.start();
}

/** klaud as one screen of the daemon (started if it isn't running): other screens can attach too. */
async function attached(config: Config, args: readonly string[]): Promise<void> {
  const version = installedVersion();
  const desktop = await createDesktopNotifier((data) => process.stdout.write(data)).catch(() => undefined);
  const client: SocketClient = await connectOrSpawn({
    args,
    roomKey: roomKeyOf(config),
    anyRoom: args.length === 0,
    version,
    kind: 'tui',
    launchDir: process.cwd(),
    caps: {
      copyText: async (text: string) => void (await copyText(text)),
      zoom: (dir: 'in' | 'out' | 'reset') => zoom(dir),
      notify: (n: { title: string; body: string; sound: boolean }) => desktop?.(n),
      openExternal: (target: string) => openWithSystem(target),
    },
  });
  if (client.daemonVersion !== version) {
    const others = client.clients - 1;
    const text =
      others > 0
        ? `klaud ${client.daemonVersion} is running (you have ${version}). Restart to update (${others} other window${others === 1 ? '' : 's'} attached)`
        : `klaud ${client.daemonVersion} is running (you have ${version}). Quit and start again to update`;
    client.store.dispatch({ type: 'toast', text, level: 'warn' });
  }
  const shutdown = runTui(client, config, async () => client.close(), 'klaud: closed this window. The room stays open while other windows are.');
  client.onClose((reason) => void shutdown(`klaud: ${reason}`));
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
    // The running daemon has the old code; it stops first so the next klaud starts the new one.
    // Only if it really is klaud: a crash can leave the file, and its process id reused.
    const daemon = runningDaemon();
    if (daemon && (await listening(daemon.port))) process.kill(daemon.pid, 'SIGTERM');
    process.exitCode = await runUpdate({ checkOnly: args.includes('--check') });
    return;
  }
  if (args[0] === 'daemon') {
    const rest = args.slice(1).filter((a) => a !== '--keep-alive');
    // The Mac app's web view; KLAUD_ALLOW_ORIGINS adds more (its dev server while developing).
    const extra = (process.env.KLAUD_ALLOW_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    await runDaemon(parseConfig(rest), { version: installedVersion(), keepAlive: args.includes('--keep-alive') || process.env.KLAUD_KEEP_ALIVE === '1', allowedOrigins: [...APP_ORIGINS, ...extra] });
    return;
  }
  const config = parseConfig(args);
  if (config.mode === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  applyTheme(config.theme);
  if (process.env.KLAUD_DAEMON === '1') await attached(config, args);
  else await inProcess(config);
}

main().catch((err: unknown) => {
  process.stdout.write(RESTORE);
  process.stderr.write(`klaud: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
