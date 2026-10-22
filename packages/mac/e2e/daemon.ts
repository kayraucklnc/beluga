import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { alive, listeners, stopGroups } from '../../../scripts/e2e-lock.mjs';

/** Marks a folder as an e2e demo home: only such a folder is ever wiped. */
export const MARK = '.klaud-e2e';

/** A command line, for saying who holds a port ("node …/vite --port 14321"). */
function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim().slice(0, 160);
  } catch {
    return '';
  }
}

const pidIn = (file: string): number | undefined => {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const pid = raw.startsWith('{') ? (JSON.parse(raw) as { pid?: unknown }).pid : Number(raw);
    return typeof pid === 'number' && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A fresh demo home: a daemon an interrupted run left behind (daemon.json, daemon.lock) is stopped and
 * its files go, then the folder is emptied. Refuses a folder that isn't an e2e home (never your real data).
 * → what it cleaned, in words (for the log).
 */
export async function freshHome(home: string): Promise<string[]> {
  const cleaned: string[] = [];
  if (existsSync(home) && readdirSync(home).length && !existsSync(path.join(home, MARK))) {
    throw new Error(`Won't use ${home} as the demo home: it isn't an e2e home (no ${MARK}), so it may be real klaud data`);
  }
  for (const name of ['daemon.json', 'daemon.lock']) {
    const pid = pidIn(path.join(home, name));
    // A pid can be reused: only stop it if it's still a klaud daemon.
    if (pid && pid !== process.pid && alive(pid) && /daemon/.test(commandOf(pid))) {
      await stopGroups({ pids: [pid] }, { graceMs: 2000 });
      cleaned.push(`stopped the demo daemon pid ${pid} an earlier run left (${name})`);
    } else if (existsSync(path.join(home, name))) cleaned.push(`removed a stale ${name}`);
  }
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, MARK), 'A demo home for klaud e2e runs: emptied at the start of each run.\n');
  return cleaned;
}

/** Why the port can't be used, or undefined when it's free. */
export function portProblem(port: number): string | undefined {
  const pids = listeners(port);
  if (!pids.length) return undefined;
  return `Port ${port} is in use by ${pids.map((p) => `pid ${p}${commandOf(p) ? ` (${commandOf(p)})` : ''}`).join(', ')}. Stop it, or set E2E_PORT to another port.`;
}

/** The last lines of a log, for an error message. */
const tail = (file: string, lines = 15): string => {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
};

/** Start klaud's demo (simulated friends and Claudes) as a daemon for the tests; stop it after. */
export default async function setup(): Promise<() => Promise<void>> {
  const home = process.env.KLAUD_HOME!;
  const port = Number(process.env.E2E_PORT ?? 1421);
  const repo = path.resolve(import.meta.dirname, '../../..');
  for (const line of await freshHome(home)) console.log(`[e2e] ${line}`);
  const claudeHome = process.env.KLAUD_CLAUDE_HOME;
  if (claudeHome) {
    rmSync(claudeHome, { recursive: true, force: true });
    mkdirSync(claudeHome, { recursive: true });
  }
  const busy = portProblem(port);
  if (busy) throw new Error(`The demo can't start: ${busy}`);

  const log = path.join(home, 'e2e-daemon.log');
  const out = openSync(log, 'a');
  const child = spawn('npx', ['tsx', 'src/cli.tsx', 'daemon', '--keep-alive', 'demo'], {
    cwd: repo,
    env: { ...process.env, KLAUD_HOME: home, KLAUD_DEMO_PACE: process.env.E2E_DEMO_PACE ?? '0.3', KLAUD_ALLOW_ORIGINS: `http://localhost:${port}` },
    stdio: ['ignore', out, out],
  });
  let exited: string | undefined;
  child.on('exit', (code, sig) => (exited = sig ? `was killed (${sig})` : `exited with code ${code}`));
  const info = path.join(home, 'daemon.json');
  // Slow on a busy Mac: up to a minute, but stop waiting as soon as it has died.
  for (let i = 0; i < 240 && !existsSync(info) && !exited; i++) await new Promise((r) => setTimeout(r, 250));
  if (!existsSync(info)) {
    child.kill('SIGKILL');
    const holder = pidIn(path.join(home, 'daemon.lock'));
    const why = [
      exited ? `it ${exited}` : 'it gave no sign of life in 60s (is the Mac overloaded? see `uptime`)',
      holder && holder !== child.pid && alive(holder) ? `daemon.lock is held by pid ${holder} (${commandOf(holder)})` : '',
      tail(log) ? `its log (${log}):\n${tail(log)}` : '',
    ].filter(Boolean);
    throw new Error(`The demo daemon did not start: ${why.join('; ')}`);
  }
  // Let the pretend friends arrive.
  await new Promise((r) => setTimeout(r, 6000));
  return () => stopDaemon(home, child.pid);
}

/** Stop the demo daemon of a home (and the npx that started it). Safe to call twice. */
export async function stopDaemon(home: string, starter?: number): Promise<void> {
  const info = pidIn(path.join(home, 'daemon.json'));
  const pid = info && /daemon/.test(commandOf(info)) ? info : undefined;
  await stopGroups({ pids: [pid, starter].filter((p): p is number => typeof p === 'number' && alive(p)) }, { graceMs: 3000 });
  rmSync(path.join(home, 'daemon.json'), { force: true });
  rmSync(path.join(home, 'daemon.lock'), { force: true });
}
