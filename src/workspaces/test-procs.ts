import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Test runs a worktree left behind: when its Claude stops or it's archived, klaud stops them, so
 * interrupted e2e runs never pile up demo daemons, vite servers and browsers on the Mac.
 *
 * What counts: every process the worktree's Claude started (klaud gives its runs KLAUD_WORKTREE, and
 * their commands inherit it) that is a test runner or what one starts (vitest, playwright, vite, the
 * demo daemon, the browser); the e2e run holding the machine-wide lock (scripts/e2e-lock.mjs) from that
 * worktree, everything it started included; and, when the worktree is going away, any test runner
 * installed in it. Your own dev servers in its terminals are never touched.
 */

/** The machine-wide e2e lock (scripts/e2e-lock.mjs keeps it there). */
export const e2eLockFile = (): string => path.join(process.env.KLAUD_E2E_DIR || path.join(os.homedir(), '.klaud', 'e2e'), 'lock.json');

export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  /** Its command line, then (from ps -E) its environment. */
  readonly line: string;
}

/** A test runner, judged on the command with the worktree's own path taken out (it may say "playwright"). */
const RUNNER = /(^|[\s/])(vitest|playwright|jest|e2e-lock\.mjs|chrome-headless-shell)(\.[cm]?js)?(\s|$)|node_modules\/(@playwright\/|playwright(-core)?\/|vitest\/)|ms-playwright|cli\.tsx daemon --keep-alive demo/;
/** A dev server: stopped only when an e2e run started it, or its worktree goes away. */
const SERVER = /(^|[\s/])vite(\.[cm]?js)?(\s|$)/;

export function isTestRunner(line: string, dir: string): boolean {
  return RUNNER.test(line.split(dir).join('<worktree>'));
}

const inside = (child: string, dir: string): boolean => child === dir || child.startsWith(dir + path.sep);

/**
 * The processes to stop for a worktree (and everything under them). `leaving`: the worktree is going
 * away, so test runners installed in it go too, whoever started them.
 */
export function testProcessesIn(rows: readonly ProcRow[], dir: string, leaving = false): number[] {
  const tag = ` KLAUD_WORKTREE=${dir}`;
  const hits = rows.filter((r) => {
    if (r.pid === process.pid) return false;
    const tagged = r.line.includes(`${tag} `) || r.line.endsWith(tag);
    const installed = leaving && r.line.includes(path.join(dir, 'node_modules') + path.sep);
    const e2e = tagged && r.line.includes(' KLAUD_E2E_RUN=');
    return e2e || ((tagged || installed) && isTestRunner(r.line, dir)) || (installed && SERVER.test(r.line.split(dir).join('<worktree>')));
  });
  const kids = new Map<number, number[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const out = new Set<number>();
  const queue = hits.map((h) => h.pid);
  while (queue.length) {
    const pid = queue.shift()!;
    if (out.has(pid) || pid === process.pid || pid <= 1) continue;
    out.add(pid);
    queue.push(...(kids.get(pid) ?? []));
  }
  return [...out];
}

function ps(args: readonly string[]): Promise<string> {
  return new Promise((resolve) => execFile('ps', [...args], { maxBuffer: 256 * 1024 * 1024, timeout: 15_000 }, (err, out) => resolve(err ? '' : out)));
}

/** Every process with its command and environment (yours only: the OS shows no one else's). */
export async function processRows(): Promise<ProcRow[]> {
  if (process.platform === 'win32') return [];
  const out = await ps(process.platform === 'darwin' ? ['-axwwE', '-o', 'pid=,ppid=,command='] : ['axeww', '-o', 'pid=,ppid=,command=']);
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), line: m[3]! }));
}

const signal = (target: number, sig: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
};

/** The lock's run, when it's from this worktree: its pid, process groups, demo daemon. */
function lockedRun(dir: string): { pid: number; groups: number[]; daemon?: number; file: string } | undefined {
  const file = e2eLockFile();
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; worktree?: unknown; groups?: unknown; home?: unknown };
    if (typeof lock.pid !== 'number' || typeof lock.worktree !== 'string' || !inside(lock.worktree, dir)) return undefined;
    const groups = Array.isArray(lock.groups) ? lock.groups.filter((g): g is number => typeof g === 'number' && g > 1) : [];
    let daemon: number | undefined;
    if (typeof lock.home === 'string') {
      try {
        const pid = (JSON.parse(readFileSync(path.join(lock.home, 'daemon.json'), 'utf8')) as { pid?: unknown }).pid;
        if (typeof pid === 'number') daemon = pid;
      } catch {
        // No daemon running.
      }
    }
    return { pid: lock.pid, groups, ...(daemon ? { daemon } : {}), file };
  } catch {
    return undefined;
  }
}

/**
 * Stop a worktree's test processes: SIGTERM, then SIGKILL what's left after `graceMs`.
 * → how many processes (and e2e process groups) were stopped.
 */
export async function stopTestProcesses(dir: string, opts: { leaving?: boolean; graceMs?: number } = {}): Promise<number> {
  const root = path.resolve(dir);
  const pids = testProcessesIn(await processRows(), root, opts.leaving);
  // The e2e run holding the lock: when its Claude started it (it's among them), or the worktree goes.
  const locked = lockedRun(root);
  const run = locked && (opts.leaving || pids.includes(locked.pid)) ? locked : undefined;
  if (run) pids.push(run.pid, ...(run.daemon ? [run.daemon] : []));
  const own = new Set([process.pid, process.ppid]);
  const targets = [...new Set(pids)].filter((p) => p > 1 && !own.has(p));
  const groups = (run?.groups ?? []).filter((g) => !own.has(g));
  if (!targets.length && !groups.length) return 0;
  for (const p of targets) signal(p, 'SIGTERM');
  for (const g of groups) signal(-g, 'SIGTERM');
  const left = (): boolean => targets.some((p) => signal(p, 0)) || groups.some((g) => signal(-g, 0));
  for (let t = 0, grace = opts.graceMs ?? 3000; t < grace && left(); t += 100) await new Promise((r) => setTimeout(r, 100));
  for (const p of targets) signal(p, 'SIGKILL');
  for (const g of groups) signal(-g, 'SIGKILL');
  if (run && !signal(run.pid, 0)) rmSync(run.file, { force: true });
  return targets.length + groups.length;
}
