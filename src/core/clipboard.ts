import { spawn } from 'node:child_process';

interface ClipboardTool {
  readonly cmd: string;
  readonly args: readonly string[];
}

const COPY: Record<string, readonly ClipboardTool[]> = {
  darwin: [{ cmd: 'pbcopy', args: [] }],
  win32: [{ cmd: 'clip', args: [] }],
  linux: [
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
  ],
};

const PASTE: Record<string, readonly ClipboardTool[]> = {
  darwin: [{ cmd: 'pbpaste', args: [] }],
  win32: [{ cmd: 'powershell', args: ['-NoProfile', '-Command', 'Get-Clipboard'] }],
  linux: [
    { cmd: 'wl-paste', args: ['--no-newline'] },
    { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
    { cmd: 'xsel', args: ['--clipboard', '--output'] },
  ],
};

function run(tool: ClipboardTool, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.cmd, [...tool.args], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${tool.cmd} exited ${code}`))));
    child.stdin.end(input ?? '');
  });
}

/** OSC 52 asks the terminal itself to set the clipboard; works over SSH in most modern terminals. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/** Copy using the OS clipboard tool only. Returns false when none is available. */
export async function copyNative(text: string): Promise<boolean> {
  for (const tool of COPY[process.platform] ?? []) {
    try {
      await run(tool, text);
      return true;
    } catch {
      // try the next tool
    }
  }
  return false;
}

/**
 * Copy text for an explicit user action. Falls back to OSC 52 (terminal clipboard,
 * works over SSH) when no OS tool exists. Returns how it was copied.
 */
export async function copyText(text: string, write: (s: string) => void = (s) => process.stdout.write(s)): Promise<'native' | 'osc52'> {
  if (await copyNative(text)) return 'native';
  write(osc52(text));
  return 'osc52';
}

export async function pasteText(): Promise<string | undefined> {
  for (const tool of PASTE[process.platform] ?? []) {
    try {
      return await run(tool);
    } catch {
      // try the next tool
    }
  }
  return undefined;
}
