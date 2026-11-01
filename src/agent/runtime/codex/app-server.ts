import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunProcess } from '../../types.js';
import { endProcess, keepLines, niceForWorktree } from '../claude/claude-process.js';
import { CodexRpc } from './rpc.js';

/** `codex app-server` for one run (or one side call): its JSON-RPC and its process. */
export interface CodexConnection {
  readonly rpc: CodexRpc;
  readonly proc: RunProcess;
  /** Its last stderr lines, for a failure's details. */
  readonly stderr: () => readonly string[];
}

export interface ConnectOptions {
  readonly cwd: string;
  /** Its whole environment (the run's env over Beluga's). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Codex's own executable; unset: findCodex(). */
  readonly bin?: string;
}

/** How a Codex run reaches its app-server: spawn it (tests hand a scripted one instead). */
export type CodexConnect = (opts: ConnectOptions) => Promise<CodexConnection>;

const STDERR_KEEP = 40;
const INIT_TIMEOUT_MS = 20_000;

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where Codex is: BELUGA_CODEX_PATH, then the Codex app's own binary (self-contained), then `codex`
 * on PATH (the npm shim, which can lose its platform binary on an upgrade). Undefined: not installed.
 */
export function findCodex(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const set = env.BELUGA_CODEX_PATH;
  if (set) return executable(set) ? set : undefined;
  const apps = ['/Applications/Codex.app/Contents/Resources/codex', path.join(os.homedir(), 'Applications/Codex.app/Contents/Resources/codex')];
  const onPath = (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'codex'));
  return [...apps, ...onPath].find(executable);
}

/** Say hello as Beluga: required before any other request. */
export async function handshake(rpc: CodexRpc, version = '0'): Promise<void> {
  await rpc.request('initialize', { clientInfo: { name: 'beluga', title: 'Beluga', version }, capabilities: null }, INIT_TIMEOUT_MS);
  rpc.notify('initialized');
}

/** Spawn `codex app-server` and shake hands. */
export const spawnAppServer: CodexConnect = async ({ cwd, env, bin }) => {
  const command = bin ?? findCodex(env ?? process.env);
  if (!command) throw new Error('Codex isn’t installed on this Mac. Install the Codex app or `npm i -g @openai/codex`, then try again.');
  const child = spawn(command, ['app-server'], { cwd, env: { ...(env ?? process.env) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => keepLines(lines, chunk, STDERR_KEEP));
  const spawned = await new Promise<Error | undefined>((resolve) => {
    child.once('spawn', () => resolve(undefined));
    child.once('error', resolve);
  });
  if (spawned || child.pid === undefined) throw new Error(`Couldn’t start Codex (${spawned?.message ?? 'no process'}).`);
  niceForWorktree(child.pid, env);
  const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;
  const exited = running(child) ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve();
  const proc: RunProcess = { pid: child.pid, alive: () => running(child), kill: () => endProcess(child), exited };
  const rpc = new CodexRpc(child.stdout, child.stdin);
  try {
    await handshake(rpc);
  } catch (err) {
    await proc.kill();
    throw new Error(`Codex didn’t start: ${err instanceof Error ? err.message : String(err)}${lines.length ? ` (${lines.at(-1)})` : ''}`);
  }
  return { rpc, proc, stderr: () => lines };
};
