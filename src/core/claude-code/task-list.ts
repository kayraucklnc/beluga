import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from '../../shared/steps.js';
import { noticeStatus } from './agents.js';
import type { CcAgentStatus, CcTask, CcTaskOutput } from './model.js';
import { readTail } from './output-files.js';
import { commandLogs } from './outputs.js';
import type { TranscriptTracker } from './sessions.js';
import { type BgLaunch, cleanTerminal, exitCodeOf } from './tasks.js';

/**
 * The background commands one transcript started (tasks.ts parses them), as screens see them:
 * how each is doing, and the end of its output to follow it live. Only ever files Claude Code
 * said it writes a task's output to (or the log the command itself writes to).
 */

/** The most of a task's output sent to a screen at once (its end). */
const TAIL_BYTES = 64 * 1024;
/** A task's output file: in Claude Code's temp folder, named after the task. */
const TASK_FILE = /[\\/]claude-[\w-]+[\\/].+[\\/]tasks[\\/]([\w-]{1,64})\.output$/;

/** Files' last writes, looked at again at most this often (the list is redrawn several times a second). */
const MTIME_TTL_MS = 2000;
const mtimes = new Map<string, { at: number; mtime: number }>();
function mtimeOf(file: string | undefined, now: number): number {
  if (!file) return 0;
  const known = mtimes.get(file);
  if (known && now - known.at < MTIME_TTL_MS) return known.mtime;
  const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (mtimes.size > 2000) mtimes.clear();
  mtimes.set(file, { at: now, mtime });
  return mtime;
}

/** Writes this soon before the command started still count as its own (clocks, buffering). */
const SLACK_MS = 2000;
const TEMP_ROOTS = [...new Set([os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'])];
const inside = (root: string | undefined, p: string): boolean => Boolean(root) && (p === root || p.startsWith(`${root!.replace(/\/+$/, '')}/`));

interface TaskFacts {
  readonly launch: BgLaunch;
  readonly id: string;
  /** Its output file, when Claude Code said where (or it's next to another task's). */
  readonly file?: string;
}

/** A transcript's background tasks with their ids and output files. */
function factsOf(t: TranscriptTracker): TaskFacts[] {
  const results = [...t.bg.values()].map((launch) => ({ launch, result: t.results.get(launch.toolUseId) }));
  // A watch's result doesn't say where its output goes: next to the commands' (one folder per session).
  const dir = results.map((r) => r.result?.outputFile).find((f) => f && TASK_FILE.test(f));
  return results.map(({ launch, result }) => {
    const id = result?.taskId ?? launch.toolUseId;
    const said = result?.outputFile && TASK_FILE.exec(result.outputFile)?.[1] === id ? result.outputFile : undefined;
    const file = said ?? (result?.taskId && dir ? path.join(path.dirname(dir), `${id}.output`) : undefined);
    return { launch, id, ...(file ? { file } : {}) };
  });
}

/**
 * How each is doing. With no word from Claude Code on it, it counts as running while its output
 * grows, or just after it started while its session is at work; otherwise there's no telling
 * (its session may be gone): idle.
 */
export function tasksOf(t: TranscriptTracker, agentId: string | undefined, now: number, idleMs: number): CcTask[] {
  const live = now - t.lastAt <= idleMs;
  return factsOf(t).map(({ launch, id, file }) => {
    const notice = t.notices.get(id);
    const result = t.results.get(launch.toolUseId);
    let status: CcAgentStatus;
    if (notice) status = noticeStatus(notice.status);
    else if (result?.error) status = 'failed';
    else status = (live && now - launch.ts <= idleMs) || now - mtimeOf(file, now) <= idleMs ? 'running' : 'idle';
    const exitCode = exitCodeOf(notice?.summary);
    return {
      id,
      kind: launch.kind,
      description: launch.description,
      command: launch.command,
      status,
      startedAt: launch.ts,
      ...(notice ? { endedAt: notice.ts } : result?.error ? { endedAt: result.ts } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(notice?.summary ? { summary: redactSecrets(notice.summary) } : {}),
      ...(agentId ? { agentId } : {}),
    };
  });
}

/** Running first, then the latest. */
export const byLiveThenLatest = (a: CcTask, b: CcTask): number => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt;

/** The end of one task's output: its own file, else (when that's empty) the log its command writes to. */
export function taskOutput(t: TranscriptTracker, taskId: string): CcTaskOutput | undefined {
  const task = factsOf(t).find((f) => f.id === taskId);
  if (!task) return undefined;
  const own = task.file ? readTail(task.file, TAIL_BYTES) : undefined;
  // Its own output is empty: the log its command writes to, if it's in the project or a temp folder
  // and was written since the command started (a file it only names isn't shown).
  const log = own?.size ? undefined : commandLogs(task.launch.command, t.cwd).find((p) => inside(t.cwd, p) || TEMP_ROOTS.some((r) => inside(r, p)));
  const tail = log ? readTail(log, TAIL_BYTES) : undefined;
  const read = tail && tail.mtime >= task.launch.ts - SLACK_MS ? tail : undefined;
  const got = read ?? own;
  const file = read ? log : task.file;
  if (!got || !file) return undefined;
  return { text: redactSecrets(cleanTerminal(got.text)), size: got.size, file, mtime: got.mtime, ...(got.size > TAIL_BYTES ? { truncated: true } : {}) };
}
