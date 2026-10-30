import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../store.js';
import type { CcSession } from './model.js';
import { placeOf } from './watch.js';

/**
 * Codex sessions running outside Beluga (the Codex app, `codex` in a terminal), for Activity like
 * Claude Code's (BLG-455). Codex writes each session to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl;
 * this reads the recent ones (only what was added since the last look) and never writes there.
 * Beluga's own Codex runs (originator "beluga") show in their chats instead, so they're left out.
 */

export interface CodexWatcherOptions {
  /** Codex's folder (~/.codex). */
  readonly home: string;
  readonly store: Store;
  readonly now?: () => number;
  /** A session counts while it wrote this lately (default 30 min). */
  readonly activeMs?: number;
  /** No writes for this long and no finished turn: idle (default 5 min). */
  readonly idleMs?: number;
  /** How often to look (default 5 s); 0: only when asked (tests). */
  readonly pollMs?: number;
  /** Day folders looked in, counting back from today (a session resumed later still writes in its first day's). */
  readonly days?: number;
}

/** What one rollout says so far. */
interface Rollout {
  offset: number;
  rest: string;
  id?: string;
  originator?: string;
  cwd?: string;
  startedAt?: number;
  title?: string;
  model?: string;
  step?: string;
  steps: number;
  tokens?: number;
  /** The last turn finished (task_complete after the last task_started). */
  final: boolean;
  lastAt: number;
}

const ACTIVE_MS = 30 * 60_000;
const IDLE_MS = 5 * 60_000;
const MAX_SESSIONS = 40;
/** Bytes read from one file at a time. */
const CHUNK = 1 << 20;
const TITLE_MAX = 80;

/** The words a step shows ("Ran npm test", "Edited files"): Codex's tool calls in Activity's terms. */
export function codexStepWords(name: string, args: string | undefined): string {
  if (name === 'exec_command' || name === 'shell' || name === 'local_shell') {
    try {
      const parsed = JSON.parse(args ?? '{}') as { cmd?: unknown; command?: unknown };
      const cmd = parsed.cmd ?? parsed.command;
      const text = Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : '';
      if (text) return `Ran ${text.split('\n')[0]!.slice(0, 80)}`;
    } catch {
      // not JSON: its name says enough
    }
    return 'Ran a command';
  }
  if (name === 'apply_patch') return 'Edited files';
  if (name === 'web_search') return 'Searched the web';
  return `Used ${name}`;
}

/** One rollout line into what the session says (pure: tests feed lines). */
export function readRolloutLine(r: Rollout, line: string): void {
  let d: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
  try {
    d = JSON.parse(line) as typeof d;
  } catch {
    return;
  }
  const p = d.payload ?? {};
  const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
  if (d.type === 'session_meta') {
    r.id = typeof p.id === 'string' ? p.id : r.id;
    r.originator = typeof p.originator === 'string' ? p.originator : r.originator;
    r.cwd ??= typeof p.cwd === 'string' ? p.cwd : undefined;
    const started = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : ts;
    if (!Number.isNaN(started)) r.startedAt ??= started;
    return;
  }
  if (d.type === 'turn_context') {
    if (typeof p.cwd === 'string') r.cwd = p.cwd;
    if (typeof p.model === 'string') r.model = p.model;
    return;
  }
  if (d.type === 'event_msg') {
    if (p.type === 'user_message' && !r.title && typeof p.message === 'string' && p.message.trim()) r.title = p.message.trim().split('\n')[0]!.slice(0, TITLE_MAX);
    if (p.type === 'task_started') r.final = false;
    if (p.type === 'task_complete' || p.type === 'turn_aborted') r.final = true;
    if (p.type === 'token_count') {
      const last = (p.info as { last_token_usage?: { input_tokens?: number } } | null)?.last_token_usage?.input_tokens;
      if (typeof last === 'number') r.tokens = last;
    }
    return;
  }
  if (d.type === 'response_item') {
    // The Codex app logs no user_message events: the first thing you typed (not the instructions it sends first).
    if (p.type === 'message' && p.role === 'user' && !r.title && Array.isArray(p.content)) {
      const said = (p.content as Array<{ type?: string; text?: unknown }>).map((c) => (c.type === 'input_text' && typeof c.text === 'string' ? c.text.trim() : '')).find((t) => t && !t.startsWith('<') && !t.startsWith('# AGENTS.md'));
      if (said) r.title = said.split('\n')[0]!.slice(0, TITLE_MAX);
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      r.steps++;
      r.step = codexStepWords(String(p.name ?? 'shell'), typeof p.arguments === 'string' ? p.arguments : undefined);
    }
    if (p.type === 'web_search_call') {
      r.steps++;
      r.step = 'Searched the web';
    }
  }
}

export class CodexSessionsWatcher {
  private readonly files = new Map<string, Rollout>();
  private timer?: NodeJS.Timeout;
  private lastPublished = '';

  constructor(private readonly opts: CodexWatcherOptions) {}

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  start(): void {
    this.scan();
    const every = this.opts.pollMs ?? 5_000;
    if (every > 0) {
      this.timer = setInterval(() => this.scan(), every);
      this.timer.unref();
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Look for sessions written lately, read what they added, and publish the picture. */
  scan(): void {
    const now = this.now;
    const activeMs = this.opts.activeMs ?? ACTIVE_MS;
    const seen = new Set<string>();
    for (const dir of this.dayDirs(now)) {
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        let st: { mtimeMs: number; size: number };
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        if (now - st.mtimeMs > activeMs) continue;
        seen.add(file);
        const r = this.files.get(file) ?? { offset: 0, rest: '', steps: 0, final: false, lastAt: st.mtimeMs };
        this.files.set(file, r);
        r.lastAt = st.mtimeMs;
        if (st.size > r.offset) this.readMore(file, r, st.size);
      }
    }
    for (const file of [...this.files.keys()]) if (!seen.has(file)) this.files.delete(file);
    this.publish();
  }

  /** The sessions as Activity shows them. */
  sessions(): CcSession[] {
    const now = this.now;
    const idleMs = this.opts.idleMs ?? IDLE_MS;
    const projects = this.opts.store.getState().projects;
    const out: CcSession[] = [];
    for (const r of this.files.values()) {
      if (!r.id || r.originator === 'beluga') continue;
      const cwd = r.cwd ?? '';
      out.push({
        id: r.id,
        title: r.title ?? 'Codex session',
        cwd,
        ...(cwd ? placeOf(projects, cwd) : {}),
        status: r.final ? 'waiting' : now - r.lastAt <= idleMs ? 'working' : 'idle',
        ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
        lastAt: r.lastAt,
        ...(r.step ? { step: r.step } : {}),
        steps: r.steps,
        ...(r.tokens ? { tokens: r.tokens } : {}),
        ...(r.model ? { model: r.model } : {}),
        agents: [],
        agent: 'codex',
      });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_SESSIONS);
  }

  private publish(): void {
    const sessions = this.sessions();
    const key = JSON.stringify(sessions);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.opts.store.dispatch({ type: 'codex_sessions', sessions });
  }

  private readMore(file: string, r: Rollout, size: number): void {
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      while (r.offset < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - r.offset));
        const got = readSync(fd, buf, 0, buf.length, r.offset);
        if (!got) break;
        r.offset += got;
        const text = r.rest + buf.subarray(0, got).toString('utf8');
        const lines = text.split('\n');
        r.rest = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) readRolloutLine(r, line);
      }
    } catch {
      // Gone or unreadable meanwhile: the next look tries again.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** ~/.codex/sessions/YYYY/MM/DD for the last few days. */
  private dayDirs(now: number): string[] {
    const root = path.join(this.opts.home, 'sessions');
    const days = this.opts.days ?? 7;
    const pad = (n: number): string => String(n).padStart(2, '0');
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(now - i * 86_400_000);
      return path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    });
  }
}
