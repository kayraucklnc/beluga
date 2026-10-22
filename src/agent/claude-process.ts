import { type ChildProcess, spawn } from 'node:child_process';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { RunProcess } from './types.js';

/** How long Claude Code gets to exit on SIGTERM before it's killed outright. */
export const KILL_GRACE_MS = 3_000;

/** Whether a child process still runs. */
const running = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

/** Resolves once `child` exits, or after `ms` (false: still running). */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (!running(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(!running(child));
    }, ms);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

/** End a process for sure: SIGTERM, then SIGKILL after `graceMs`. Resolves once it's gone. */
export async function endProcess(child: ChildProcess, graceMs = KILL_GRACE_MS): Promise<void> {
  if (!running(child)) return;
  child.kill('SIGTERM');
  if (await exited(child, graceMs)) return;
  child.kill('SIGKILL');
  await exited(child, graceMs);
}

/** A run's handle on its Claude Code process. */
export function runProcess(child: ChildProcess & { pid: number }, graceMs = KILL_GRACE_MS): RunProcess {
  const exited = running(child) ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve();
  return { pid: child.pid, alive: () => running(child), kill: () => endProcess(child, graceMs), exited };
}

/** Add `data`'s non-empty lines to `lines`, keeping only the last `keep`. */
export function keepLines(lines: string[], data: string, keep: number): void {
  lines.push(...data.split('\n').filter((l) => l.trim()));
  if (lines.length > keep) lines.splice(0, lines.length - keep);
}

/**
 * Spawns Claude Code as the SDK itself would, but hands us the process, so a run that won't end
 * can be told dead and killed (see AgentRunInput.onProcess). Its stderr is read (an unread pipe
 * would stall it) and handed to `onStderr`: the SDK reads none from a process we spawn, so this is
 * the only way a crash keeps its last words (see shared/run-failure.ts).
 */
export function trackedSpawn(onSpawn: (proc: RunProcess) => void, onStderr?: (chunk: string) => void): { spawn: (options: SpawnOptions) => SpawnedProcess } {
  return {
    spawn: ({ command, args, cwd, env, signal }) => {
      const child = spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => onStderr?.(chunk));
      if (child.pid !== undefined) onSpawn(runProcess(child as ChildProcess & { pid: number }));
      return child;
    },
  };
}
