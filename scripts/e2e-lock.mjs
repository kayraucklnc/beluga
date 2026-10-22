#!/usr/bin/env node
// One Mac e2e run at a time, machine-wide, and nothing left behind when it ends.
//   node scripts/e2e-lock.mjs <command…>        (packages/mac's `npm run e2e` runs playwright through it)
// - A second run, from any worktree, waits for the first and says whose it is ("waiting for KLD-12's e2e").
// - Each worktree gets its own E2E_PORT and demo home (KLAUD_HOME), so runs never share a server or a daemon.
// - The command runs in its own process group; every process it starts is tracked (even ones that move to
//   their own group, like vite and the browser) and stopped however the run ends: done, Ctrl-C, killed.
// - A run that fails while the Mac is overloaded re-runs its failed tests once, alone, after the load drops.
// The lock lives in ~/.klaud/e2e (KLAUD_E2E_DIR overrides it); Klaud reads it to stop a worktree's tests.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where the machine-wide lock is kept. */
export const stateDir = () => process.env.KLAUD_E2E_DIR || path.join(os.homedir(), '.klaud', 'e2e');
export const lockFile = () => path.join(stateDir(), 'lock.json');

const short = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);

/** The worktree a folder is in (its git top level), else the folder. */
export function worktreeOf(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || dir;
  } catch {
    return dir;
  }
}

/** Whose run it is, in words: "KLD-12" from a task branch (klaud/kld-12-…), else the worktree's name. */
export function runName(worktree, branch) {
  const key = /(?:^|\/)([a-z]{2,6})-(\d+)(?:-|$)/i.exec(branch ?? '');
  return key ? `${key[1].toUpperCase()}-${key[2]}` : path.basename(worktree);
}

function branchOf(dir) {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** A worktree's own vite port: stable for the worktree, different between worktrees (14300–17299). */
export const portFor = (worktree) => 14300 + (Number.parseInt(short(worktree), 16) % 3000);

/** A worktree's own demo home (klaud data) and pretend ~/.claude, in the temp folder (short paths). */
export function homesFor(worktree) {
  const base = path.join(os.tmpdir(), `klaud-e2e-${short(worktree)}`);
  return { home: path.join(base, 'home'), claude: path.join(base, 'claude') };
}

/** Whether a process is alive (and ours to signal). */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function readLock(file = lockFile()) {
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    return typeof lock?.pid === 'number' ? lock : undefined;
  } catch {
    return undefined;
  }
}

function writeLock(lock, file = lockFile()) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock, null, 2));
  renameSync(tmp, file);
}

/**
 * Take the lock for this run, or say who has it. A lock whose owner died is taken over (after
 * `onStale` cleans up what that run left running).
 * → { ok: true } | { ok: false, holder }
 */
export function tryLock(run, { file = lockFile(), onStale } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, JSON.stringify(run, null, 2));
      closeSync(fd);
      return { ok: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = readLock(file);
      // Unreadable and new: another run is writing it right now.
      if (!holder && Date.now() - mtimeOf(file) < 5000) return { ok: false, holder: { pid: 0, name: 'another run', startedAt: Date.now() } };
      if (holder && holder.pid !== run.pid && alive(holder.pid)) return { ok: false, holder };
      if (holder && holder.pid === run.pid) return { ok: true };
      if (holder) onStale?.(holder);
      rmSync(file, { force: true });
    }
  }
  const holder = readLock(file);
  return holder ? { ok: false, holder } : { ok: false, holder: { pid: 0, name: 'another run', startedAt: Date.now() } };
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function releaseLock(pid = process.pid, file = lockFile()) {
  if (readLock(file)?.pid === pid) rmSync(file, { force: true });
}

const ago = (ms) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`);

/** What a waiting run prints. */
export const waitingLine = (holder, now = Date.now()) =>
  `waiting for ${holder.name}'s e2e (started ${ago(now - holder.startedAt)} ago${holder.worktree ? ` in ${path.basename(holder.worktree)}` : ''}, pid ${holder.pid}): one Mac e2e run at a time`;

/** Wait for the lock (polling), printing who we wait for now and then. Gives up after `maxMs`. */
export async function waitForLock(run, { file = lockFile(), onStale, log = console.log, pollMs = 2000, sayEveryMs = 60_000, maxMs = 60 * 60_000 } = {}) {
  const start = Date.now();
  let said = 0;
  let saidPid = 0;
  for (;;) {
    const got = tryLock(run, { file, onStale });
    if (got.ok) return true;
    if (got.holder.pid !== saidPid || Date.now() - said >= sayEveryMs) {
      log(waitingLine(got.holder));
      said = Date.now();
      saidPid = got.holder.pid;
    }
    if (Date.now() - start > maxMs) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ------------------------------------------------------------------ processes

/** Every process: pid, parent and group (one `ps`). */
export function processTable() {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((r) => r.length === 3 && r.every(Number.isFinite))
      .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
  } catch {
    return [];
  }
}

/** The process groups of `root` and everything under it (some children start their own group). */
export function groupsUnder(root, table) {
  const kids = new Map();
  for (const p of table) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const groups = new Set();
  const seen = new Set([root]);
  const queue = [root];
  const self = table.find((p) => p.pid === root);
  if (self) groups.add(self.pgid);
  while (queue.length) {
    for (const k of kids.get(queue.shift()) ?? []) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid);
      groups.add(k.pgid);
      queue.push(k.pid);
    }
  }
  return groups;
}

/** Processes whose environment carries `KEY=value` (ps -E: only the user's own processes). */
export function processesTagged(key, value) {
  const needle = ` ${key}=${value}`;
  try {
    return execFileSync('ps', ['-axwwE', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      .split('\n')
      .filter((l) => l.includes(needle) && (l.includes(`${needle} `) || l.endsWith(needle)))
      .map((l) => l.trim().split(/\s+/).slice(0, 2).map(Number))
      .filter(([pid, pgid]) => Number.isFinite(pid) && Number.isFinite(pgid))
      .map(([pid, pgid]) => ({ pid, pgid }));
  } catch {
    return [];
  }
}

/** Who listens on a TCP port (pids). */
export function listeners(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map(Number)
      .filter((n) => n > 0);
  } catch {
    return [];
  }
}

const signal = (target, sig) => {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stop process groups (and single pids): SIGTERM, then SIGKILL what's still there after `graceMs`.
 * Never this process's own group.
 */
export async function stopGroups({ groups = [], pids = [] }, { graceMs = 3000 } = {}) {
  const own = processTable().find((p) => p.pid === process.pid)?.pgid;
  const gs = [...new Set(groups)].filter((g) => g > 1 && g !== own);
  const ps = [...new Set(pids)].filter((p) => p > 1 && p !== process.pid);
  for (const g of gs) signal(-g, 'SIGTERM');
  for (const p of ps) signal(p, 'SIGTERM');
  const left = () => gs.some((g) => signal(-g, 0)) || ps.some((p) => alive(p));
  for (let t = 0; t < graceMs && left(); t += 100) await new Promise((r) => setTimeout(r, 100));
  for (const g of gs) signal(-g, 'SIGKILL');
  for (const p of ps) signal(p, 'SIGKILL');
}

/** Stop everything a run started: its tracked groups, anything tagged with its id, the demo daemon, its port. */
export async function stopRun(run, opts) {
  const tagged = processesTagged('KLAUD_E2E_RUN', run.id);
  const daemon = readDaemonPid(run.home);
  await stopGroups({ groups: [...(run.groups ?? []), ...tagged.map((p) => p.pgid)], pids: [...tagged.map((p) => p.pid), ...(daemon ? [daemon] : []), ...(run.port ? listeners(run.port) : [])] }, opts);
}

function readDaemonPid(home) {
  if (!home) return undefined;
  try {
    const pid = JSON.parse(readFileSync(path.join(home, 'daemon.json'), 'utf8')).pid;
    return typeof pid === 'number' && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ load

/** The 1-minute load per core (1 = every core busy). */
export const loadPerCore = () => os.loadavg()[0] / Math.max(1, os.cpus().length);

/** A run counts as "under load" when the Mac had more work than cores at some point. */
export const OVERLOADED = 1.5;

/** The command again for just the tests that failed (playwright only), else undefined. */
export function rerunArgs(args) {
  if (!args.some((a) => /playwright/.test(a))) return undefined;
  return [...args.filter((a) => a !== '--last-failed'), '--last-failed'];
}

// ------------------------------------------------------------------ the run

/** The command running now (kept off `run`, which is written to the lock file). */
let current;

function runOnce(cmd, args, env, run) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env, detached: true });
    current = child;
    run.groups = [child.pid];
    let peak = loadPerCore();
    const track = setInterval(() => {
      const before = run.groups.length;
      run.groups = [...new Set([...run.groups, ...groupsUnder(child.pid, processTable())])];
      if (run.groups.length !== before) writeLock(run);
      peak = Math.max(peak, loadPerCore());
    }, 2500);
    child.on('exit', (code, sig) => {
      clearInterval(track);
      current = undefined;
      resolve({ code: code ?? (sig ? 1 : 0), peak });
    });
  });
}

async function main(argv) {
  if (!argv.length) {
    console.error('usage: node scripts/e2e-lock.mjs <command…>');
    process.exit(2);
  }
  const worktree = worktreeOf(process.cwd());
  const homes = homesFor(worktree);
  const port = Number(process.env.E2E_PORT) || portFor(worktree);
  const run = {
    id: `${process.pid}-${Date.now().toString(36)}`,
    pid: process.pid,
    name: runName(worktree, branchOf(worktree)),
    worktree,
    port,
    // Never an inherited KLAUD_HOME: inside Klaud that's your real data, and the demo home is wiped each run.
    home: process.env.KLAUD_E2E_HOME || homes.home,
    startedAt: Date.now(),
    groups: [],
  };
  const env = {
    ...process.env,
    E2E_PORT: String(port),
    KLAUD_HOME: run.home,
    KLAUD_CLAUDE_HOME: homes.claude,
    KLAUD_E2E_RUN: run.id,
  };

  let ending = false;
  const finish = async (code) => {
    if (ending) return;
    ending = true;
    await stopRun(run);
    releaseLock(run.pid);
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      // Let playwright run its teardown first, then stop whatever is still there.
      if (!current) return void finish(130);
      signal(-current.pid, sig === 'SIGHUP' ? 'SIGTERM' : sig);
      current.once('exit', () => void finish(130));
      setTimeout(() => void finish(130), 8000).unref();
    });
  }

  let cleaned;
  const onStale = (old) => {
    if (old.id === cleaned) return;
    console.log(`${old.name}'s e2e (pid ${old.pid}) ended without cleaning up: stopping what it left running`);
    void stopRun(old, { graceMs: 1000 });
  };
  // A run that was killed outright: stop what it left before taking its place (and again in the race below).
  const before = readLock();
  if (before && !alive(before.pid)) {
    console.log(`${before.name}'s e2e (pid ${before.pid}) ended without cleaning up: stopping what it left running`);
    await stopRun(before, { graceMs: 1000 });
    cleaned = before.id;
  }
  const got = await waitForLock({ ...run, groups: [] }, { onStale });
  if (!got) {
    console.error('Gave up waiting for the e2e lock after an hour. If no e2e is really running, delete ' + lockFile());
    process.exit(1);
  }
  console.log(`e2e for ${run.name} on port ${port} (demo home ${run.home})`);

  const [cmd, ...args] = argv;
  let { code, peak } = await runOnce(cmd, args, env, run);
  await stopRun(run, { graceMs: 1000 });
  const again = code !== 0 && peak > OVERLOADED ? rerunArgs(argv) : undefined;
  if (again) {
    console.log(`The run failed while the Mac was overloaded (load ${peak.toFixed(1)}× its ${os.cpus().length} cores). Re-running just the failed tests once, alone, when the load drops…`);
    for (let t = 0; t < 10 * 60_000 && loadPerCore() > 1; t += 5000) await new Promise((r) => setTimeout(r, 5000));
    ({ code } = await runOnce(again[0], again.slice(1), env, run));
    console.log(code === 0 ? 'They pass when run alone: the failure was the load, not the code.' : 'They fail alone too: a real failure.');
  }
  await finish(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main(process.argv.slice(2));
