/**
 * Which shells this computer has, for picking the terminal's shell: the ones listed in
 * /etc/shells, your login shell ($SHELL), and popular ones Homebrew installs without listing.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { type ShellChoice, isPosixShell, shellName } from '../shared/shells.js';
import { defaultShell, posixSh } from './pty.js';

/** Installed by Homebrew (or by hand) but often not added to /etc/shells. */
const EXTRA = ['fish', 'nu', 'bash', 'zsh', 'elvish', 'xonsh', 'pwsh'].flatMap((n) => [`/opt/homebrew/bin/${n}`, `/usr/local/bin/${n}`]);

/** Windows has no /etc/shells: the usual places of PowerShell, cmd and Git Bash. */
const windowsShells = (env: NodeJS.ProcessEnv): string[] => {
  const system = env.SystemRoot ?? 'C:\\Windows';
  const programs = env.ProgramFiles ?? 'C:\\Program Files';
  return [`${programs}\\PowerShell\\7\\pwsh.exe`, `${system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, `${system}\\System32\\cmd.exe`, posixSh(env, 'win32', () => true) ?? `${programs}\\Git\\bin\\bash.exe`];
};

const isProgram = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const real = (file: string): string => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

/** Paths listed in an /etc/shells-style file (comments and blank lines skipped). */
export function readShellsFile(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l.startsWith('/'));
}

export interface ListShellsOptions {
  readonly shellsFile?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly extra?: readonly string[];
  readonly exists?: (file: string) => boolean;
}

/** The shells you can pick, your login shell first, then by name; each program once. */
export function listShells(opts: ListShellsOptions = {}): ShellChoice[] {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? isProgram;
  let listed: string[] = [];
  try {
    listed = readShellsFile(readFileSync(opts.shellsFile ?? '/etc/shells', 'utf8'));
  } catch {
    // No /etc/shells (some containers): $SHELL and the usual places still count.
  }
  const login = env.SHELL && exists(env.SHELL) ? env.SHELL : defaultShell(env);
  const seen = new Set<string>();
  const out: ShellChoice[] = [];
  for (const file of [login, ...listed, ...(opts.extra ?? (process.platform === 'win32' ? windowsShells(env) : EXTRA))]) {
    if (!file || !exists(file)) continue;
    // /bin/sh and /private/var/select/sh are the same program: list it once.
    const id = opts.exists ? file : real(file);
    if (seen.has(id) || seen.has(file)) continue;
    seen.add(id);
    seen.add(file);
    out.push({ path: file, name: shellName(file), isDefault: file === login });
  }
  const [first, ...rest] = out;
  return first ? [first, ...rest.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))] : [];
}

/**
 * The shell for setup and run commands: yours when it speaks sh (zsh, bash…), otherwise your
 * login shell or zsh, since those commands are usually written for sh (`npm i && npm run dev`).
 */
export function scriptShell(chosen: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (chosen && isPosixShell(chosen) && existsSync(chosen)) return chosen;
  // Windows: Git Bash (Claude Code's own), else your shell, which at least starts.
  if (process.platform === 'win32') return posixSh(env) ?? defaultShell(env);
  const fallback = defaultShell(env);
  return isPosixShell(fallback) ? fallback : existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
}
