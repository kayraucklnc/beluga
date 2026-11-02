/**
 * PTY backend.
 *
 * Package choice: `@lydell/node-pty` (a repackaging of microsoft/node-pty).
 * - It ships prebuilt binaries as per-platform optionalDependencies
 *   (`@lydell/node-pty-{darwin,linux,win32}-{x64,arm64}`), so it installs
 *   with NO install scripts and never compiles. That matters because npm here
 *   skips install scripts unless approved.
 * - Its macOS `spawn-helper` is published with the executable bit set.
 * Rejected: `node-pty@1.1.0` ships prebuilds for darwin/win32 only (Linux
 * falls back to node-gyp) and its darwin `spawn-helper` is published 0644,
 * relying on a postinstall chmod; `@homebridge/node-pty-prebuilt-multiarch`
 * needs its install script (prebuild-install download / node-gyp fallback).
 *
 * The native module is loaded lazily so importing Beluga never fails on a
 * platform without a prebuild; only opening a terminal does.
 */
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IPty } from '@lydell/node-pty';

export type { IPty };

const require = createRequire(import.meta.url);
type PtyModule = typeof import('@lydell/node-pty');

let cached: PtyModule | undefined;

/**
 * Some package managers / copies drop the executable bit on `spawn-helper`,
 * which makes every spawn fail with "posix_spawnp failed". Restore it.
 */
export function ensureSpawnHelperExecutable(): void {
  if (process.platform !== 'darwin') return;
  try {
    const pkg = require.resolve(`@lydell/node-pty-${process.platform}-${process.arch}/package.json`);
    const helper = path.join(path.dirname(pkg), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (!existsSync(helper)) return;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      chmodSync(helper, statSync(helper).mode | 0o111);
    }
  } catch {
    // Best effort: if this fails, spawn reports a clear error itself.
  }
}

export function loadPty(): PtyModule {
  if (!cached) {
    ensureSpawnHelperExecutable();
    cached = require('@lydell/node-pty') as PtyModule;
  }
  return cached;
}

export interface SpawnOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
}

export function spawnPty(opts: SpawnOptions): IPty {
  return loadPty().spawn(opts.file, [...opts.args], {
    name: opts.env.TERM ?? 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
  });
}

/** `$SHELL` if it exists, else zsh, else sh. On Windows: PowerShell 7, else Windows PowerShell, else cmd. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync): string {
  if (platform === 'win32') {
    const system = env.SystemRoot ?? 'C:\\Windows';
    const candidates = [`${env.ProgramFiles ?? 'C:\\Program Files'}\\PowerShell\\7\\pwsh.exe`, `${system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`];
    for (const c of candidates) if (exists(c)) return c;
    return env.ComSpec ?? env.COMSPEC ?? `${system}\\System32\\cmd.exe`;
  }
  const candidates = [env.SHELL, '/bin/zsh', '/bin/bash'];
  for (const c of candidates) if (c && exists(c)) return c;
  return '/bin/sh';
}

/**
 * The sh that runs commands written for sh (`npm i && npm run dev`, a sentinel's script):
 * /bin/sh, or on Windows Git for Windows' bash, the one Claude Code itself runs commands in
 * (CLAUDE_CODE_GIT_BASH_PATH when you set it). Undefined on a Windows without Git.
 */
export function posixSh(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync): string | undefined {
  if (platform !== 'win32') return '/bin/sh';
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    `${env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\bin\\bash.exe`,
    env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe` : undefined,
    env['ProgramFiles(x86)'] ? `${env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe` : undefined,
  ];
  return candidates.find((c): c is string => Boolean(c) && exists(c!));
}

/** posixSh, or a clear error where there's none (Windows without Git for Windows). */
export function needPosixSh(env: NodeJS.ProcessEnv = process.env): string {
  const sh = posixSh(env);
  if (!sh) throw new Error('Commands need Git for Windows (its bash): install it from git-scm.com, or set CLAUDE_CODE_GIT_BASH_PATH');
  return sh;
}

/** Variables that would describe the *outer* terminal, or confuse a nested `claude`. */
const DROPPED_ENV = [
  'COLUMNS',
  'LINES',
  'TERM_PROGRAM_VERSION',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  'ITERM_SESSION_ID',
  'KITTY_WINDOW_ID',
  'WEZTERM_PANE',
  'TMUX',
  'TMUX_PANE',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  // A Claude Code session's own markers (when Beluga itself runs under one): a `claude` started in
  // a terminal here is a session of its own, not a child that keeps no transcript (BLG-534).
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
];

/** Environment for the child: ours, minus outer-terminal hints, plus TERM/COLORTERM and overrides. */
export function childEnv(overrides: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !DROPPED_ENV.includes(k)) env[k] = v;
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'beluga', ...overrides };
}
