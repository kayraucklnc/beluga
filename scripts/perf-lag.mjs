#!/usr/bin/env node
/**
 * The daemon stays responsive while many Claudes stream: starts the demo daemon in a throwaway home,
 * makes 8 worktrees, keeps a long demo run streaming in each, and reads the daemon's event-loop delay
 * (src/daemon/lag.ts) for the measuring window. Passes when every period's p95 is under the target.
 *
 *   node scripts/perf-lag.mjs [--sessions 8] [--seconds 120] [--every 10] [--target 50] [--pace 0.3] [--profile <dir>]
 *
 * --profile writes a CPU profile of the daemon (node --cpu-prof) into <dir> when it stops.
 * Prints a JSON summary last (the proof).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SESSIONS = Number(arg('sessions', 8));
const SECONDS = Number(arg('seconds', 120));
const EVERY = Number(arg('every', 10));
const TARGET = Number(arg('target', 50));
const PACE = arg('pace', '0.3');
const PROFILE = arg('profile', '');
const PROMPT = 'deep dive, take your time';

const repo = path.resolve(import.meta.dirname, '..');
const home = mkdtempSync(path.join(os.tmpdir(), 'klaud-perf-lag-'));
const claudeHome = path.join(home, 'claude');
mkdirSync(claudeHome);
const say = (line) => process.stdout.write(`[perf-lag] ${line}\n`);

/** Lag lines the daemon logged, with when they arrived. */
const lags = [];
const LAG = /event loop delay: p50 ([\d.]+) ms, p95 ([\d.]+) ms, max ([\d.]+) ms/;
const nodeArgs = [...(PROFILE ? ['--cpu-prof', `--cpu-prof-dir=${path.resolve(PROFILE)}`] : []), '--import', 'tsx', 'src/cli.ts', 'daemon', '--keep-alive', 'demo'];
const daemon = spawn(process.execPath, nodeArgs, {
  cwd: repo,
  // Its own home and ~/.claude: never your real data, never your real Claude Code sessions.
  env: { ...process.env, KLAUD_HOME: home, KLAUD_CLAUDE_HOME: claudeHome, KLAUD_DEMO_PACE: PACE, KLAUD_LAG_EVERY_MS: String(EVERY * 1000), KLAUD_WORKTREE: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let exited = false;
daemon.on('exit', () => (exited = true));
let logTail = '';
const onLog = (chunk) => {
  const text = String(chunk);
  logTail = (logTail + text).slice(-4000);
  for (const line of text.split('\n')) {
    const m = LAG.exec(line);
    if (m) lags.push({ at: Date.now(), p50: Number(m[1]), p95: Number(m[2]), max: Number(m[3]) });
  }
};
daemon.stdout.on('data', onLog);
daemon.stderr.on('data', onLog);

let client;
const stop = async () => {
  client?.close?.();
  if (!exited) {
    daemon.kill('SIGTERM');
    for (let i = 0; i < 100 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
    if (!exited) daemon.kill('SIGKILL');
  }
  rmSync(home, { recursive: true, force: true });
};
process.on('SIGINT', () => void stop().then(() => process.exit(130)));

try {
  const info = path.join(home, 'daemon.json');
  for (let i = 0; i < 240 && !existsSync(info) && !exited; i++) await new Promise((r) => setTimeout(r, 250));
  if (!existsSync(info)) throw new Error(`the demo daemon did not start:\n${logTail}`);
  const { port, token } = JSON.parse(readFileSync(info, 'utf8'));
  const { SocketClient } = await tsImport('../src/ipc/socket-client.ts', import.meta.url);
  client = await SocketClient.connect({ url: `ws://127.0.0.1:${port}`, token, kind: 'test', version: 'perf-lag', timeoutMs: 30_000 });
  const state = () => client.store.getState();
  const project = state().projects.find((p) => p.name === 'bob-api');
  if (!project) throw new Error('no bob-api project in the demo');

  const ids = [];
  for (let i = 0; i < SESSIONS; i++) {
    const id = await client.api.workspaces.newWorktree(project.id, `lag-${i + 1}`);
    if (!id) throw new Error(`could not make worktree lag-${i + 1}`);
    ids.push(id);
  }
  say(`${ids.length} worktrees made; streaming "${PROMPT}" in each (pace ${PACE})`);

  const RUNNING = new Set(['started', 'text', 'tool', 'sub', 'awaiting_approval', 'queued']);
  const busy = (channel) => state().log.some((it) => it.type === 'agent' && it.channel === channel && RUNNING.has(it.status));
  const asked = new Map();
  let runs = 0;
  // Keep every worktree streaming: a new run once the last one finished.
  const keepBusy = async () => {
    for (const id of ids) {
      const channel = `ws:${id}`;
      if (busy(channel) || Date.now() - (asked.get(channel) ?? 0) < 3000) continue;
      asked.set(channel, Date.now());
      runs++;
      await client.api.session.submit(PROMPT, { channel });
    }
  };
  await keepBusy();
  const ticker = setInterval(() => void keepBusy().catch(() => undefined), 1000);
  // Measure once they're all under way (and the setup's own work has been logged and forgotten).
  for (let i = 0; i < 60 && !ids.every((id) => busy(`ws:${id}`)); i++) await new Promise((r) => setTimeout(r, 500));
  const from = Date.now() + EVERY * 1000;
  say(`all ${ids.filter((id) => busy(`ws:${id}`)).length} streaming; measuring for ${SECONDS} s after one ${EVERY} s warm-up period`);
  await new Promise((r) => setTimeout(r, (SECONDS + EVERY) * 1000 + 1500));
  clearInterval(ticker);
  const measured = lags.filter((l) => l.at > from);
  for (const l of measured) say(`p50 ${l.p50.toFixed(1)} ms  p95 ${l.p95.toFixed(1)} ms  max ${l.max.toFixed(1)} ms`);
  if (!measured.length) throw new Error('the daemon logged no event-loop delay');
  const worst = Math.max(...measured.map((l) => l.p95));
  const sorted = measured.map((l) => l.p95).sort((a, b) => a - b);
  const summary = {
    sessions: SESSIONS,
    seconds: SECONDS,
    periodSeconds: EVERY,
    pace: Number(PACE),
    runsStarted: runs,
    load: os.loadavg().map((n) => Number(n.toFixed(2))),
    cpus: os.cpus().length,
    p95: { worst, median: sorted[Math.floor(sorted.length / 2)] },
    maxDelay: Math.max(...measured.map((l) => l.max)),
    periods: measured.map(({ p50, p95, max }) => ({ p50, p95, max })),
    targetMs: TARGET,
    pass: worst < TARGET,
  };
  say(`${summary.pass ? 'PASS' : 'FAIL'}: worst p95 ${worst.toFixed(1)} ms (target < ${TARGET} ms) over ${measured.length} periods`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  await stop();
  process.exit(summary.pass ? 0 : 1);
} catch (err) {
  say(`error: ${err instanceof Error ? err.message : String(err)}`);
  await stop();
  process.exit(2);
}
