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
 * demo daemon, the browser); whatever its Bash commands left running (a dev server in the background,
 * `npm run dev &`, `nohup node server.js`), whatever it's called; the e2e run holding the machine-wide
 * lock (scripts/e2e-lock.mjs) from that worktree, everything it started included; and, when the
 * worktree is going away, any test runner installed in it. Your own dev servers in its terminals are
 * never touched (they don't carry the tag), nor is a Claude Code process itself.
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
/** A dev server installed there: stopped when its worktree goes away, whoever started it. */
const SERVER = /(^|[\s/])vite(\.[cm]?js)?(\s|$)/;
/** A shell Claude Code's Bash tool runs a command in (still there: the command runs in the background). */
const BASH_SHELL = /\/shell-snapshots\/snapshot-/;
/** Claude Code itself (its binary, or its npm cli.js): never stopped from here. Judged on the command (first), not its environment. */
const CLAUDE = /^(\S*\/)?claude(\s|$)|^\S*node\s+\S*@anthropic-ai\/claude-code\/cli\.js(\s|$)/;

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
  // Kept on purpose (KLAUD_KEEP=1, see keepsRunning) while the worktree stays: they, and the shells waiting on them.
  const keep = new Set<number>();
  if (!leaving) {
    const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
    for (const r of rows) {
      if (!r.line.includes(` ${KEEP_MARK} `) && !r.line.endsWith(` ${KEEP_MARK}`)) continue;
      for (let p: number | undefined = r.pid; p && p > 1 && !keep.has(p); p = parent.get(p)) keep.add(p);
    }
  }
  const hits = rows.filter((r) => {
    if (r.pid === process.pid || keep.has(r.pid)) return false;
    const tagged = r.line.includes(`${tag} `) || r.line.endsWith(tag);
    const installed = leaving && r.line.includes(path.join(dir, 'node_modules') + path.sep);
    const e2e = tagged && r.line.includes(' KLAUD_E2E_RUN=');
    // Left by a Bash command: its shell still running (run_in_background), or orphaned once the shell exited (`&`, nohup).
    const leftByBash = tagged && !CLAUDE.test(r.line) && (BASH_SHELL.test(r.line) || r.ppid === 1);
    return e2e || leftByBash || ((tagged || installed) && isTestRunner(r.line, dir)) || (installed && SERVER.test(r.line.split(dir).join('<worktree>')));
  });
  const kids = new Map<number, number[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const out = new Set<number>();
  const queue = hits.map((h) => h.pid);
  while (queue.length) {
    const pid = queue.shift()!;
    if (out.has(pid) || pid === process.pid || pid <= 1 || keep.has(pid)) continue;
    out.add(pid);
    queue.push(...(kids.get(pid) ?? []));
  }
  return [...out];
}

/** A program that runs tests, serves or watches (after `npx`, `pnpm exec`…). */
const RUNS = /^(vitest|playwright|jest|mocha|vite|next|nuxt|astro|nodemon|webpack-dev-server|http-server|serve|live-server)$/;
/** A package script (or make target) that does: `npm test`, `npm run test:e2e`, `pnpm dev`, `npm start`, `make serve`. */
const SCRIPT = /^(test|e2e|dev|start|serve|preview|watch|demo)([:\-_.]|$)|[:\-_.](test|e2e|dev|start|serve|preview|watch|demo)([:\-_.]|$)/i;
/** A script an interpreter runs that does: `node server.js`, `python3 -m http.server`, `tsx src/cli.tsx daemon`, `node scripts/e2e-lock.mjs`. */
const RUNTIME = /^(node|nodejs|tsx|ts-node|deno|bun|python[\d.]*|ruby|php|rails|uvicorn|gunicorn|flask)$/;
const SERVES = /(^|[\s/._-])(server|serve|dev|daemon|e2e|tests?|watch|runserver|http\.server)([\s/._-]|$)/i;
/** `cmd &` (not `&&`, `2>&1`, `&>`, `|&`): it goes on after the command returns. */
const AMP = /(^|[^&>|])&(?![&>\d])/;

/** A command line's simple commands (split at `&&`, `||`, `;`, `|`, `&`, newlines), redirections taken out. */
function simpleCommands(command: string): string[][] {
  return command
    .split(/&&|\|\||[;\n|]|(?<![&>|])&(?![&>\d])/)
    .map((part) => part.replace(/\d*[<>]+&?\s*\S+/g, ' ').trim().split(/\s+/).filter(Boolean));
}

/** Whether one simple command starts something that may keep running. */
function starts(words: readonly string[]): boolean {
  const base = (x: string | undefined) => (x ?? '').replace(/^\(+/, '').split('/').pop() ?? '';
  let w = [...words];
  // Past its variables (`PORT=3000 npm run dev`) and what runs a program for you (`npx`, `env`, `pnpm exec`): the program.
  for (;;) {
    const next = w.findIndex((x) => !/^\w+=/.test(x));
    w = next < 0 ? [] : w.slice(next);
    const skip = ['env', 'time', 'exec', 'command', 'npx', 'bunx', 'pnpx'].includes(base(w[0])) ? 1 : ['pnpm', 'yarn'].includes(base(w[0])) && ['exec', 'dlx'].includes(w[1] ?? '') ? 2 : 0;
    if (!skip) break;
    w = w.slice(skip);
    while (w[0]?.startsWith('-')) w = w.slice(1);
  }
  const program = base(w[0]);
  if (['nohup', 'setsid', 'disown'].includes(program) || RUNS.test(program) || w.includes('--watch')) return true;
  if (['npm', 'pnpm', 'yarn', 'bun', 'make', 'just', 'turbo'].includes(program)) {
    const args = w.slice(1).filter((x) => !x.startsWith('-'));
    const script = ['run', 'run-script'].includes(args[0] ?? '') ? args[1] : args[0];
    if (script && SCRIPT.test(script)) return true;
  }
  return RUNTIME.test(program) && w.slice(1).some((x) => SERVES.test(x));
}

/**
 * Whether a Bash command may leave processes running after it returns (so the turn's end checks for
 * them with ps). Judged on the command alone, on what it runs (not on words in its paths: `2>/dev/null`,
 * `cat src/server.ts`): ps on every turn is slow on a busy Mac.
 */
export function mayLeaveProcesses(command: unknown, background?: unknown): boolean {
  if (background === true) return true;
  if (typeof command !== 'string') return false;
  return AMP.test(command) || simpleCommands(command).some(starts);
}

/** What a command says to keep what it starts running past the turn (they carry it in their environment). */
export const KEEP_MARK = 'KLAUD_KEEP=1';

/** Whether a Bash command asks to keep what it starts (`KLAUD_KEEP=1 npm run dev &`). */
export const keepsRunning = (command: unknown): boolean => typeof command === 'string' && new RegExp(`(^|[\\s;&|(])${KEEP_MARK}(\\s|$)`).test(command);

/** Whether someone's message asks to leave what Claude starts running ("keep the server running", "leave it up", "don't stop it"). */
export function askedToKeep(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false;
  return /\b(keep|leave)\b[^.!?\n]{0,40}\b(running|up|on|open|alive|going)\b|\bdo(n['’]?t| not)\s+(stop|kill)\b/i.test(prompt);
}

/** Whether the machine-wide e2e lock is held from this worktree (one small file read, no ps). */
export function e2eLockedIn(dir: string): boolean {
  return lockedRun(path.resolve(dir)) !== undefined;
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

/** The lock's run, when it's from this worktree: its pid, process groups, demo daemon, run id. */
function lockedRun(dir: string): LockedRun | undefined {
  const file = e2eLockFile();
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown; pid?: unknown; worktree?: unknown; groups?: unknown; home?: unknown };
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
    return { pid: lock.pid, worktree: lock.worktree, groups, ...(typeof lock.id === 'string' ? { id: lock.id } : {}), ...(daemon ? { daemon } : {}), file };
  } catch {
    return undefined;
  }
}

export interface LockedRun {
  readonly pid: number;
  readonly worktree: string;
  readonly id?: string;
  readonly groups: readonly number[];
  readonly daemon?: number;
  readonly file: string;
}

/**
 * What of a locked run may be stopped, judged on the processes there now. Its lock holder, its
 * groups and its daemon only while the holder is verifiably that run (e2e-lock.mjs, under its
 * worktree); the daemon only when it carries the run's tag. A stale lock (its holder gone, or the
 * pid reused after a reboot) gives nothing: its leftovers are found by their tags instead.
 */
export function lockTargets(run: LockedRun, rows: readonly ProcRow[]): { pids: number[]; groups: number[] } {
  const row = (pid: number | undefined) => (pid ? rows.find((r) => r.pid === pid) : undefined);
  const holder = row(run.pid);
  const verified = Boolean(holder && /e2e-lock\.mjs(\s|$)/.test(holder.line) && holder.line.includes(run.worktree));
  if (!verified) return { pids: [], groups: [] };
  const tag = run.id ? ` KLAUD_E2E_RUN=${run.id}` : undefined;
  const daemon = row(run.daemon);
  const daemonOurs = Boolean(daemon && tag && (daemon.line.includes(`${tag} `) || daemon.line.endsWith(tag)));
  return { pids: [run.pid, ...(daemonOurs ? [run.daemon!] : [])], groups: [...run.groups] };
}

/** Processes kept running when you asked (see keepTestProcesses), per worktree: pid → its command then (a reused pid isn't spared). */
const spared = new Map<string, Map<number, string>>();

/**
 * Keep what a worktree's Claude left running (you asked it to: "keep the server running"): the next
 * turn's end spares those processes too, until the worktree goes away. → how many.
 */
export async function keepTestProcesses(dir: string): Promise<number> {
  const root = path.resolve(dir);
  const rows = await processRows();
  const pids = new Set(testProcessesIn(rows, root));
  const keep = spared.get(root) ?? new Map<number, string>();
  for (const r of rows) if (pids.has(r.pid)) keep.set(r.pid, r.line);
  spared.set(root, keep);
  return pids.size;
}

/**
 * Stop a worktree's test processes: SIGTERM, then SIGKILL what's left after `graceMs`.
 * → how many processes (and e2e process groups) were stopped.
 */
export async function stopTestProcesses(dir: string, opts: { leaving?: boolean; graceMs?: number } = {}): Promise<number> {
  const root = path.resolve(dir);
  const rows = await processRows();
  const kept = spared.get(root);
  if (opts.leaving) spared.delete(root);
  const keep = (r: ProcRow | undefined): boolean => Boolean(!opts.leaving && r && kept?.get(r.pid) === r.line);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const pids = testProcessesIn(rows, root, opts.leaving).filter((p) => !keep(byPid.get(p)));
  // The e2e run holding the lock: when its Claude started it (it's among them), or the worktree goes; only what it can verify (see lockTargets).
  const locked = lockedRun(root);
  const run = locked && (opts.leaving || pids.includes(locked.pid)) ? locked : undefined;
  const fromLock = run ? lockTargets(run, rows) : { pids: [], groups: [] };
  pids.push(...fromLock.pids);
  const own = new Set([process.pid, process.ppid]);
  const targets = [...new Set(pids)].filter((p) => p > 1 && !own.has(p));
  const groups = fromLock.groups.filter((g) => !own.has(g));
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
