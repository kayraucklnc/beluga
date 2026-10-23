import { execFile, spawn } from 'node:child_process';
import { MAC_SOUNDS, type SoundChoice } from '../../shared/notify-sound.js';

export interface DesktopNotice {
  readonly title: string;
  readonly body: string;
  readonly sound: boolean;
  /** The sound chosen in Settings: a Mac sound plays as itself; Beluga's own sounds need the Mac app. */
  readonly tone?: SoundChoice;
}

/** The Mac sound to ask for (`fallback` when the chosen sound isn't one of the Mac's). */
const macSound = (n: DesktopNotice, fallback: string): string => (n.tone?.kind === 'mac' && MAC_SOUNDS.includes(n.tone.id) ? n.tone.id : fallback);

/** How a notification reaches the desktop on this machine. */
export type NotifyRoute = 'osc9' | 'osc99' | 'terminal-notifier' | 'osascript' | 'notify-send' | 'bell';

export interface RouteEnv {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly hasTerminalNotifier: boolean;
  readonly hasNotifySend: boolean;
}

/**
 * Terminals that turn an OSC 9 / OSC 99 escape into a native notification credited to
 * the terminal itself (clicking it brings the terminal back). Elsewhere we ask the OS.
 */
export function pickRoute(e: RouteEnv): NotifyRoute {
  const term = (e.env.TERM_PROGRAM ?? '').toLowerCase();
  if (term === 'iterm.app' || term === 'ghostty' || term === 'wezterm') return 'osc9';
  if (e.env.KITTY_WINDOW_ID || term === 'kitty') return 'osc99';
  if (e.platform === 'darwin') return e.hasTerminalNotifier ? 'terminal-notifier' : 'osascript';
  if (e.platform === 'linux' && e.hasNotifySend) return 'notify-send';
  return 'bell';
}

// eslint-disable-next-line no-control-regex
const safe = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, max);
const appleString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The escape sequence or command for a route (exported for tests). */
export function plan(route: NotifyRoute, n: DesktopNotice, env: NodeJS.ProcessEnv = process.env): { write?: string; cmd?: string; args?: string[] } {
  // Never start with "-": some notifiers would read it as an option.
  const title = safe(n.title, 120).replace(/^-+/, '');
  const body = safe(n.body, 240).replace(/^-+/, '');
  const bell = n.sound ? '\x07' : '';
  switch (route) {
    case 'osc9':
      return { write: `\x1b]9;${title}: ${body}\x07${bell}` };
    case 'osc99':
      return { write: `\x1b]99;i=beluga:d=0;${title}\x1b\\\x1b]99;i=beluga:d=1:p=body;${body}\x1b\\${bell}` };
    case 'terminal-notifier': {
      const app = env.__CFBundleIdentifier;
      return { cmd: 'terminal-notifier', args: ['-title', 'Beluga', '-subtitle', title, '-message', body || ' ', '-group', 'beluga', ...(n.sound ? ['-sound', macSound(n, 'default')] : []), ...(app ? ['-activate', app] : [])] };
    }
    case 'osascript':
      return { cmd: 'osascript', args: ['-e', `display notification ${appleString(body || ' ')} with title "Beluga" subtitle ${appleString(title)}${n.sound ? ` sound name "${macSound(n, 'Glass')}"` : ''}`] };
    case 'notify-send':
      return { cmd: 'notify-send', args: ['-a', 'Beluga', '--', title, body] };
    case 'bell':
      return { write: bell };
  }
}

const which = (cmd: string): Promise<boolean> =>
  new Promise((resolve) => execFile('/usr/bin/env', ['which', cmd], { timeout: 2000 }, (err) => resolve(!err)));

/**
 * Creates the function that shows desktop notifications, picking the best route once:
 * the terminal's own notifications when it has them, else Notification Center / notify-send.
 */
export async function createDesktopNotifier(write: (data: string) => void): Promise<(n: DesktopNotice) => void> {
  const [hasTerminalNotifier, hasNotifySend] = await Promise.all([
    process.platform === 'darwin' ? which('terminal-notifier') : Promise.resolve(false),
    process.platform === 'linux' ? which('notify-send') : Promise.resolve(false),
  ]);
  const route = pickRoute({ platform: process.platform, env: process.env, hasTerminalNotifier, hasNotifySend });
  return (n) => {
    const p = plan(route, n);
    if (p.write) write(p.write);
    if (p.cmd) {
      try {
        spawn(p.cmd, p.args ?? [], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
      } catch {
        // No notifications on this machine; the in-app inbox still has it.
      }
    }
  };
}
