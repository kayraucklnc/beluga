import { execFile } from 'node:child_process';

import type { ZoomDir } from '../../core/session.js';

export type { ZoomDir };

export type TerminalId = 'apple' | 'iterm' | 'warp' | 'kitty' | 'wezterm' | 'ghostty' | 'alacritty' | 'vscode' | 'unknown';

export interface TerminalInfo {
  readonly id: TerminalId;
  readonly name: string;
}

/** Work out which terminal Beluga is running in. */
export function detectTerminal(env: NodeJS.ProcessEnv = process.env): TerminalInfo {
  const program = env.TERM_PROGRAM ?? '';
  if (env.KITTY_WINDOW_ID) return { id: 'kitty', name: 'kitty' };
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return { id: 'alacritty', name: 'Alacritty' };
  if (program === 'Apple_Terminal') return { id: 'apple', name: 'Terminal' };
  if (program === 'iTerm.app' || env.ITERM_SESSION_ID) return { id: 'iterm', name: 'iTerm2' };
  if (program === 'WarpTerminal') return { id: 'warp', name: 'Warp' };
  if (program === 'WezTerm') return { id: 'wezterm', name: 'WezTerm' };
  if (program === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) return { id: 'ghostty', name: 'Ghostty' };
  if (program === 'vscode') return { id: 'vscode', name: 'VS Code' };
  return { id: 'unknown', name: 'your terminal' };
}

/** Click the first matching menu item of a macOS app (menus are found by title, in any menu). */
function clickMenuScript(processName: string, titles: readonly string[]): string {
  const list = titles.map((t) => `"${t}"`).join(', ');
  return `tell application "System Events" to tell process "${processName}"
  repeat with bar in menu bar items of menu bar 1
    repeat with title in {${list}}
      try
        click menu item (title as text) of menu 1 of bar
        return "ok"
      end try
    end repeat
  end repeat
end tell
error "menu item not found"`;
}

const ITERM: Record<ZoomDir, readonly string[]> = {
  in: ['Make Text Bigger'],
  out: ['Make Text Smaller'],
  reset: ['Make Text Normal Size'],
};

const WARP: Record<ZoomDir, readonly string[]> = {
  in: ['Increase Font Size', 'Zoom In', 'Increase font size'],
  out: ['Decrease Font Size', 'Zoom Out', 'Decrease font size'],
  reset: ['Reset Font Size', 'Reset Zoom', 'Actual Size', 'Reset font size'],
};

const APPLE_SIZE = 'font size of current settings of selected tab of front window';

export interface ZoomCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

/** The command that changes text size in this terminal, if there is a way to do it. */
export function zoomCommand(term: TerminalId, dir: ZoomDir): ZoomCommand | undefined {
  switch (term) {
    case 'apple': {
      const set =
        dir === 'reset' ? `set ${APPLE_SIZE} to 12` : `set ${APPLE_SIZE} to (${APPLE_SIZE}) ${dir === 'in' ? '+' : '-'} 1`;
      return { cmd: 'osascript', args: ['-e', `tell application "Terminal" to ${set}`] };
    }
    case 'iterm':
      return { cmd: 'osascript', args: ['-e', clickMenuScript('iTerm2', ITERM[dir])] };
    case 'warp':
      return { cmd: 'osascript', args: ['-e', clickMenuScript('Warp', WARP[dir])] };
    case 'kitty':
      return { cmd: 'kitty', args: ['@', 'set-font-size', '--', dir === 'in' ? '+1' : dir === 'out' ? '-1' : '0'] };
    default:
      return undefined;
  }
}

/** What to tell people whose terminal can't be driven from here. */
export function zoomHelp(term: TerminalInfo): string {
  switch (term.id) {
    case 'kitty':
      return 'Enable kitty remote control (allow_remote_control yes) so Beluga can change text size.';
    case 'wezterm':
    case 'ghostty':
    case 'alacritty':
      return `${term.name} can't be resized from apps. Bind "increase font size" to a key you can press in its config.`;
    default:
      return `${term.name} can't be resized from apps. On macOS you can give its "Bigger" menu item any shortcut: System Settings → Keyboard → Keyboard Shortcuts → App Shortcuts.`;
  }
}

export type Runner = (cmd: string, args: readonly string[]) => Promise<void>;

const run: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: 5000 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });

/** Make the terminal's text bigger/smaller. Works without any keyboard shortcut. */
export async function zoom(dir: ZoomDir, env: NodeJS.ProcessEnv = process.env, exec: Runner = run): Promise<{ ok: boolean; message: string }> {
  const term = detectTerminal(env);
  const command = zoomCommand(term.id, dir);
  if (!command) return { ok: false, message: zoomHelp(term) };
  try {
    await exec(command.cmd, command.args);
    const verb = dir === 'in' ? 'bigger' : dir === 'out' ? 'smaller' : 'back to normal';
    return { ok: true, message: `Text ${verb}` };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/not allowed|assistive|1002|1719|-25211/i.test(text)) {
      return { ok: false, message: `Allow ${term.name} to control menus: System Settings → Privacy & Security → Accessibility → turn on ${term.name}, then try again.` };
    }
    return { ok: false, message: zoomHelp(term) };
  }
}
