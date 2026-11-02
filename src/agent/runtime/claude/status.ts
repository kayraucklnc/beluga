import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { claudeCodePath } from '../../claude-code.js';
import { belugaEnv } from '../../../core/beluga-env.js';
import type { RuntimeStatus } from '../types.js';

/**
 * Claude Code on this Mac (BLG-507): signed in or not. Beluga brings Claude Code itself (the SDK's
 * binary, or the pinned one the Mac app downloads), so it's never "not installed"; what can be
 * missing is the sign-in. Asked of the binary itself: `claude auth status --json` (Claude Code
 * 2.1, about 0.2 s, no network) says `loggedIn` for a claude.ai login, an API key, Bedrock or
 * Vertex alike. Before the pinned binary is downloaded, the signs it leaves are looked for instead.
 */

const STATUS_TIMEOUT_MS = 10_000;

export const CLAUDE_SIGN_IN = 'Sign in to Claude Code: run claude auth login in Terminal';

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The SDK's own Claude Code (development, npm installs): its platform package's binary. */
function sdkBinary(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  } catch {
    return undefined;
  }
}

/** The Claude Code Beluga runs: BELUGA_CLAUDE_PATH, the pinned download, or the SDK's own. Undefined: not there yet. */
export function claudeBinary(): string | undefined {
  return [belugaEnv('CLAUDE_PATH'), claudeCodePath(), sdkBinary()].find((bin): bin is string => Boolean(bin) && executable(bin!));
}

type Run = (bin: string, args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string }>;

const run: Run = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, [...args], { timeout: STATUS_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

/** What `claude auth status --json` says: signed in, signed out, or undefined when it said nothing we read. */
export function readAuthStatus(stdout: string): boolean | undefined {
  try {
    const json = JSON.parse(stdout) as { loggedIn?: unknown };
    return typeof json.loggedIn === 'boolean' ? json.loggedIn : undefined;
  } catch {
    return undefined;
  }
}

/** Env vars that sign Claude Code in by themselves (an API key, a token, Bedrock, Vertex). */
const SIGNED_IN_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];

/**
 * Without the binary: the signs a sign-in leaves. An env var, the credentials file (Linux, or a
 * Mac without a keychain), or Claude Code's keychain item (looked up by name only; its secret is
 * never read, so macOS never asks).
 */
export async function signedInWithoutBinary(deps: { readonly env?: NodeJS.ProcessEnv; readonly home?: string; readonly keychain?: () => Promise<boolean> } = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (SIGNED_IN_ENV.some((k) => env[k])) return true;
  const config = env.CLAUDE_CONFIG_DIR ?? path.join(deps.home ?? os.homedir(), '.claude');
  if (existsSync(path.join(config, '.credentials.json'))) return true;
  const keychain = deps.keychain ?? (process.platform === 'darwin' ? async () => (await run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'])).code === 0 : async () => false);
  return keychain().catch(() => false);
}

/** Claude Code here: ready (its models come from Claude Code itself: the state's `models`), or not signed in. */
export async function claudeStatus(deps: { readonly bin?: string | null; readonly run?: Run; readonly signedIn?: () => Promise<boolean> } = {}): Promise<RuntimeStatus> {
  const bin = deps.bin === null ? undefined : (deps.bin ?? claudeBinary());
  let loggedIn: boolean | undefined;
  if (bin) loggedIn = readAuthStatus((await (deps.run ?? run)(bin, ['auth', 'status', '--json'])).stdout);
  // An older binary without `auth status`, or not downloaded yet.
  loggedIn ??= await (deps.signedIn ?? (() => signedInWithoutBinary()))();
  return loggedIn ? { state: 'ready', models: [] } : { state: 'signed_out', fix: CLAUDE_SIGN_IN, models: [] };
}

/** How to sign in, as a command for Terminal: Beluga's own Claude Code (it may not be on PATH), else `claude`. */
export function claudeSignInCommand(): readonly string[] {
  return [claudeBinary() ?? 'claude', 'auth', 'login'];
}
