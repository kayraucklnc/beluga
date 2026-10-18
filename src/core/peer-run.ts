import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { mentionsSecret } from '../agent/policy.js';
import { type BodyInput, type BodyOf, MAX_SHELL_OUTPUT, MAX_SHELL_SECONDS } from '../protocol.js';
import { ATTACHMENT_SHARE } from './attachments.js';
import { tilde } from './paths.js';
import { expandPath } from './remote-work.js';
import { type ShareService, isSecretPath } from './shares.js';
import { type ShellItem, type Store, clean, peerName } from './store.js';
import { reachOf, shellGate, trustOf } from './trust.js';
import type { WorkspaceController } from './workspace-controller.js';

/** What running one command produced. */
export interface ShellOutcome {
  readonly exitCode?: number;
  readonly output: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly ms: number;
}

export type ShellRunner = (command: string, cwd: string, timeoutMs: number) => Promise<ShellOutcome>;

/** "42s", "2m05s". */
const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

export const DEFAULT_SHELL_SECONDS = 120;
/** Commands one person may have running here at once. */
const MAX_RUNNING_PER_PERSON = 2;

/** Keep the last `max` characters (the end of a log is what matters). */
export function keepTail(text: string, max = MAX_SHELL_OUTPUT): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(text.length - max), truncated: true };
}

export { tilde };

/**
 * Run a command in a non-interactive shell: no input (stdin is closed), output capped (tail
 * kept), the whole process group killed when it runs out of time.
 */
export const runShell: ShellRunner = (command, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const started = Date.now();
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    let out = '';
    let truncated = false;
    let timedOut = false;
    const child = spawn(shell, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' },
    });
    const take = (chunk: Buffer): void => {
      const kept = keepTail(out + chunk.toString('utf8'), MAX_SHELL_OUTPUT);
      out = kept.text;
      truncated ||= kept.truncated;
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const kill = (): void => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref?.();
    const finish = (exitCode: number | undefined, extra = ''): void => {
      clearTimeout(timer);
      resolve({ ...(exitCode === undefined ? {} : { exitCode }), output: out + extra, truncated, timedOut, ms: Date.now() - started });
    };
    child.on('error', (err) => finish(undefined, `${out ? '\n' : ''}${err.message}`));
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : undefined)));
  });

/** What a command's result says to Claude (the run_on_peer tool's answer). */
export function describeShellResult(name: string, res: BodyOf<'shell_result'>): string {
  if (!res.ok) return `${name} did not run it: ${res.error ?? 'declined'}`;
  const head = res.timedOut
    ? `Stopped after ${formatDuration(res.ms ?? 0)} (timed out)`
    : `Exit code ${res.exitCode ?? '?'}${res.ms !== undefined ? ` after ${formatDuration(res.ms)}` : ''}`;
  return `${head} on ${name}'s computer, in ${res.cwd ?? 'their folder'}.${res.truncated ? ' Output was long; this is its end.' : ''}\n\n${res.output || '(no output)'}`;
}

export interface PeerRunDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly send: (body: BodyInput, opts: { to: string }) => boolean;
  readonly shares: ShareService;
  readonly controller?: WorkspaceController;
  /** The room's folder (where your Claude works when no workspace is open). */
  readonly agentCwd: string;
  /** Ask you to approve something for `peer`. */
  readonly approve: (title: string, detail: string, peer: string) => Promise<'yes' | 'no' | 'always'>;
  /** How commands run here (injected by the demo and tests). */
  readonly runShell?: ShellRunner;
  readonly home?: string;
  /** How long you wait for the other side to approve (default 6 minutes). */
  readonly approvalWaitMs?: number;
}

type Reply = (r: Omit<BodyInput & { kind: 'shell_result' }, 'kind' | 'reqId'>) => void;
type Waiter = { peer: string; item: ShellItem; resolve: (r: BodyOf<'shell_result'>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * Commands on each other's computers, run by the klaud of whoever owns the computer: with full
 * trust right away, otherwise after they say yes. Also tells each friend how much you trust
 * them, so they (and their Claude) know what they may ask for.
 */
export class PeerRun {
  private readonly waiters = new Map<string, Waiter>();
  /** People whose commands you said "Always" to (this session only). */
  private readonly always = new Set<string>();
  private readonly running = new Map<string, number>();
  private readonly told = new Map<string, string>();
  /** When each of your commands started running there (after their approval). */
  private readonly started = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: PeerRunDeps) {
    this.unsubscribe = deps.store.subscribe(() => this.tellGrants());
  }

  stop(): void {
    this.unsubscribe();
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('Session closed'));
    }
    this.waiters.clear();
  }

  private get state() {
    return this.deps.store.getState();
  }

  private get home(): string {
    return this.deps.home ?? os.homedir();
  }

  // ------------------------------------------------------------ trust grants

  /** Tell each friend your trust in them whenever it changes (and when they arrive). */
  tellGrants(): void {
    const state = this.state;
    const self = this.deps.selfId();
    if (!state.self) return;
    const here = new Set(state.peers.map((p) => p.peerId));
    for (const id of [...this.told.keys()]) if (!here.has(id)) this.told.delete(id);
    for (const p of state.peers) {
      if (p.peerId === self) continue;
      const level = trustOf(state, p.peerId);
      const reach = reachOf(state, p.peerId);
      const key = `${level}:${reach}`;
      if (this.told.get(p.peerId) === key) continue;
      if (this.deps.send({ kind: 'trust_grant', level, reach }, { to: p.peerId })) this.told.set(p.peerId, key);
    }
  }

  onTrustGrant(from: string, body: BodyOf<'trust_grant'>): void {
    if (from === this.deps.selfId()) return;
    this.deps.store.dispatch({ type: 'granted', peerId: from, grant: { level: body.level, reach: body.reach } });
  }

  // ------------------------------------------------------------- asking

  /**
   * Run a command on a friend's computer and show it (with its output) in `channel`.
   * Resolves with their answer; rejects only when it couldn't be asked at all.
   */
  async run(peerId: string, command: string, opts: { cwd?: string; project?: string; timeoutSec?: number; why?: string; viaAgent: boolean; channel: string }): Promise<BodyOf<'shell_result'>> {
    const reqId = randomUUID();
    const timeoutSec = Math.min(MAX_SHELL_SECONDS, Math.max(1, Math.round(opts.timeoutSec ?? DEFAULT_SHELL_SECONDS)));
    const item: ShellItem = {
      id: `sh-${reqId}`,
      type: 'shell',
      channel: opts.channel,
      ts: Date.now(),
      owner: peerId,
      ownerName: peerName(this.state, peerId),
      by: opts.viaAgent ? 'your Claude' : 'you',
      command: command.slice(0, 8000),
      ...(opts.project ? { cwd: opts.project } : opts.cwd ? { cwd: opts.cwd } : {}),
      status: 'waiting',
      output: '',
    };
    const answer = new Promise<BodyOf<'shell_result'>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(reqId);
        reject(new Error(`${item.ownerName} did not answer in time`));
      }, (this.deps.approvalWaitMs ?? 6 * 60_000) + timeoutSec * 1000 + 30_000);
      timer.unref?.();
      this.waiters.set(reqId, { peer: peerId, item, resolve, reject, timer });
    });
    answer.catch(() => undefined);
    const body: BodyInput = {
      kind: 'shell_request',
      reqId,
      command: item.command,
      timeoutSec,
      viaAgent: opts.viaAgent,
      why: (opts.why ?? '').slice(0, 500),
      ...(opts.cwd ? { cwd: opts.cwd.slice(0, 4096) } : {}),
      ...(opts.project ? { project: opts.project.slice(0, 80) } : {}),
    };
    if (!this.deps.send(body, { to: peerId })) {
      const w = this.waiters.get(reqId);
      if (w) clearTimeout(w.timer);
      this.waiters.delete(reqId);
      throw new Error('Not connected');
    }
    this.deps.store.dispatch({ type: 'shell', item });
    try {
      const res = await answer;
      this.deps.store.dispatch({
        type: 'shell',
        item: {
          ...item,
          ...(this.started.has(reqId) ? { startTs: this.started.get(reqId) } : {}),
          status: !res.ok ? (/declin|blocked/i.test(res.error ?? '') ? 'declined' : 'failed') : res.timedOut ? 'failed' : 'done',
          output: res.output,
          truncated: res.truncated,
          timedOut: res.timedOut,
          endTs: Date.now(),
          ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
          ...(res.cwd ? { cwd: res.cwd } : {}),
          ...(res.error ? { error: res.error } : {}),
        },
      });
      this.started.delete(reqId);
      return res;
    } catch (err) {
      this.started.delete(reqId);
      this.deps.store.dispatch({ type: 'shell', item: { ...item, status: 'failed', error: err instanceof Error ? err.message : String(err), endTs: Date.now() } });
      throw err;
    }
  }

  /** They approved (or didn't need to): the card turns from "waiting for bob" to "running". */
  onShellStarted(from: string, body: BodyOf<'shell_started'>): void {
    const w = this.waiters.get(body.reqId);
    if (!w || w.peer !== from || this.started.has(body.reqId)) return;
    const ts = Date.now();
    this.started.set(body.reqId, ts);
    this.deps.store.dispatch({ type: 'shell', item: { ...w.item, status: 'running', startTs: ts, ...(body.cwd ? { cwd: body.cwd } : {}) } });
  }

  onShellResult(from: string, body: BodyOf<'shell_result'>): void {
    const w = this.waiters.get(body.reqId);
    if (!w || w.peer !== from) return;
    clearTimeout(w.timer);
    this.waiters.delete(body.reqId);
    w.resolve(body);
  }

  // ------------------------------------------------------------- serving

  async onShellRequest(from: string, body: BodyOf<'shell_request'>): Promise<void> {
    const reply: Reply = (r) => void this.deps.send({ kind: 'shell_result', reqId: body.reqId, ...r }, { to: from });
    try {
      await this.serve(from, body, reply);
    } catch (err) {
      reply({ ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 400) });
    }
  }

  /** Where a request runs: the project or folder it names, else your shared folder (home with full trust). */
  private async where(from: string, body: BodyOf<'shell_request'>, full: boolean): Promise<string> {
    let dir: string;
    if (body.project) {
      const project = this.deps.controller?.manager.list.find((p) => p.root && p.name === body.project);
      if (!project) throw new Error(`there is no project called ${clean(body.project)} here`);
      dir = project.root;
    } else if (body.cwd) {
      dir = expandPath(body.cwd, this.home);
    } else {
      const shared = this.deps.shares.configs.find((c) => !c.name.startsWith('out-') && !c.name.startsWith('handoff-') && c.name !== ATTACHMENT_SHARE && this.deps.shares.canAccess(c.name, from, this.deps.selfId()));
      dir = full ? this.home : (shared?.root ?? this.deps.agentCwd);
    }
    const real = await fs.realpath(dir).catch(() => dir);
    if (isSecretPath(dir) || isSecretPath(real)) throw new Error('that folder holds secrets, so klaud never runs commands there');
    const stat = await fs.stat(real).catch(() => undefined);
    if (!stat?.isDirectory()) throw new Error(`there is no folder at ${clean(body.cwd ?? dir)}`);
    return real;
  }

  private async serve(from: string, body: BodyOf<'shell_request'>, reply: Reply): Promise<void> {
    const state = this.state;
    const owner = state.self?.name ?? 'The owner';
    const level = trustOf(state, from);
    const gate = shellGate(level);
    if (gate === 'decline' || from === this.deps.selfId()) return reply({ ok: false, error: `${owner} declined (blocked)` });
    // Secrets stay off-limits at every trust level, like for Claude's own commands.
    if (mentionsSecret(body.command)) return reply({ ok: false, error: 'klaud never runs commands that touch secrets (.env files, keys, credentials)' });
    if ((this.running.get(from) ?? 0) >= MAX_RUNNING_PER_PERSON) return reply({ ok: false, error: 'too many of your commands are already running there; wait for them to finish' });
    const cwd = await this.where(from, body, gate === 'run');
    const name = peerName(state, from);
    const who = `${name}${body.viaAgent ? "'s Claude" : ''}`;
    if (gate === 'ask' && !this.always.has(from)) {
      const answer = await this.deps.approve(
        `${name} (#${from.slice(0, 6)})${body.viaAgent ? "'s Claude" : ''} wants to run a command on your computer`,
        `$ ${clean(body.command)}\nin ${tilde(cwd, this.home)} · stops after ${formatDuration(body.timeoutSec * 1000)} · no input${body.why ? `\nwhy: ${clean(body.why)}` : ''}\nAlways = run ${name}'s commands without asking until klaud quits`,
        from,
      );
      if (answer === 'no') return reply({ ok: false, error: `${owner} declined` });
      if (answer === 'always') this.always.add(from);
    }
    const place = tilde(cwd, this.home);
    this.deps.send({ kind: 'shell_started', reqId: body.reqId, cwd: place }, { to: from });
    this.running.set(from, (this.running.get(from) ?? 0) + 1);
    let res: ShellOutcome;
    try {
      res = await (this.deps.runShell ?? runShell)(body.command, cwd, body.timeoutSec * 1000);
    } finally {
      this.running.set(from, Math.max(0, (this.running.get(from) ?? 1) - 1));
    }
    const kept = keepTail(res.output);
    reply({ ok: true, output: kept.text, truncated: res.truncated || kept.truncated, timedOut: res.timedOut, cwd: place, ms: res.ms, ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}) });
    // A quiet line in the chat and the inbox, so nothing runs here unseen.
    const short = clean(body.command).split('\n')[0]!.slice(0, 80);
    const text = `${who} ran \`${short}\` in ${place}${res.timedOut ? ' (timed out)' : res.exitCode ? ` (exit ${res.exitCode})` : ''}`;
    this.deps.store.dispatch({ type: 'system', text });
    this.deps.store.dispatch({ type: 'notice_add', notice: { kind: 'people', title: text, body: gate === 'run' ? 'You fully trust them, so it ran without asking' : 'You approved it', channel: 'room' } });
  }
}
