import { type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import type { Project } from '../../workspaces/types.js';
import type { Store } from '../store.js';
import { type AgentMeta, agentStatus, readMeta } from './agents.js';
import type { CcAgent, CcAgentStatus, CcSession, CcSteps } from './model.js';
import { type PageOptions, TranscriptTracker } from './sessions.js';
import type { Facts } from './transcript.js';

/**
 * Watches the transcripts Claude Code writes (~/.claude/projects/<folder>/<session>.jsonl, and
 * each session's subagents/agent-<id>.jsonl with its .meta.json) for sessions running outside
 * klaud, and keeps `claudeCode.sessions` in the shared state up to date: live sessions, where
 * they run, what they do, and their sub-agents. Reads only: never writes, moves or deletes
 * anything there. fs.watch makes it quick; a slow poll keeps it right when events don't come.
 * The state stays on this computer (screens only; friends never get it).
 */

export interface WatcherOptions {
  /** Claude Code's folder (~/.claude). */
  readonly home: string;
  readonly store: Store;
  readonly now?: () => number;
  /** A session counts while it (or one of its agents) wrote this lately (default 30 min). */
  readonly activeMs?: number;
  /** No writes for this long and no final answer: idle (default 5 min). */
  readonly idleMs?: number;
  /** How often watched files are checked for new lines (default 2 s). */
  readonly pollMs?: number;
  /** How often the folders are scanned for new sessions and agents (default 10 s). */
  readonly scanMs?: number;
  /** The most often screens hear about changes (default 250 ms: at most 4 a second). */
  readonly publishMs?: number;
  /** Use fs.watch (default true; tests drive it by hand). */
  readonly watch?: boolean;
  /** Tell you a background agent finished (through the notifier, which minds your settings). */
  readonly notify?: (note: { title: string; body: string; failed: boolean }) => void;
}

interface AgentEntry {
  readonly id: string;
  readonly file: string;
  readonly metaFile: string;
  meta: AgentMeta;
  tracker?: TranscriptTracker;
  /** The status last published (to notice an agent finishing). */
  last?: CcAgentStatus;
}

interface SessionEntry {
  readonly id: string;
  readonly file: string;
  readonly dir: string;
  readonly tracker: TranscriptTracker;
  readonly agents: Map<string, AgentEntry>;
  /** When a screen last asked for its steps (kept watched a while after it goes quiet). */
  viewedAt: number;
}

const ACTIVE_MS = 30 * 60_000;
const IDLE_MS = 5 * 60_000;
/** Sessions this old aren't checked for agents still working. */
const AGENT_LOOKBACK_MS = 6 * 60 * 60_000;
const VIEWED_MS = 10 * 60_000;
const MAX_SESSIONS = 30;
const MAX_AGENTS = 12;
const AGENT_FILE = /^agent-([\w-]+)\.jsonl$/;
const SESSION_FILE = /^([0-9a-f-]{8,})\.jsonl$/i;

const mtimeOf = (file: string): number => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** The klaud project and workspace a folder belongs to (the deepest workspace folder containing it). */
export function placeOf(projects: readonly Project[], cwd: string): { projectId?: string; workspaceId?: string } {
  const within = (root: string): boolean => Boolean(root) && (cwd === root || cwd.startsWith(`${root}/`));
  let best: { projectId: string; workspaceId: string; len: number } | undefined;
  for (const p of projects) {
    for (const w of p.workspaces) {
      if (w.archived || !within(w.path) || (best && best.len >= w.path.length)) continue;
      best = { projectId: p.id, workspaceId: w.id, len: w.path.length };
    }
  }
  if (best) return { projectId: best.projectId, workspaceId: best.workspaceId };
  const project = projects.find((p) => within(p.root));
  return project ? { projectId: project.id } : {};
}

export class ClaudeCodeWatcher {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly timers: NodeJS.Timeout[] = [];
  private watcher?: FSWatcher;
  private publishTimer?: NodeJS.Timeout;
  private pollSoon?: NodeJS.Timeout;
  private lastPublished = '';
  private lastPublishAt = 0;
  private offStore?: () => void;
  private stopped = false;

  constructor(private readonly opts: WatcherOptions) {}

  private get now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private get projectsDir(): string {
    return path.join(this.opts.home, 'projects');
  }

  start(): void {
    this.scan();
    this.poll();
    this.timers.push(setInterval(() => this.poll(), this.opts.pollMs ?? 2000), setInterval(() => this.scan(), this.opts.scanMs ?? 10_000));
    for (const t of this.timers) t.unref?.();
    // Projects found or changed: sessions map to their workspaces again.
    let projects = this.opts.store.getState().projects;
    this.offStore = this.opts.store.subscribe(() => {
      const next = this.opts.store.getState().projects;
      if (next === projects) return;
      projects = next;
      this.scan();
      this.schedulePublish();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.splice(0)) clearInterval(t);
    clearTimeout(this.publishTimer);
    clearTimeout(this.pollSoon);
    this.watcher?.close();
    this.offStore?.();
  }

  /** fs.watch over every project folder (recursive where the system can): a write means a quick check. */
  private watchFolder(): void {
    try {
      this.watcher = watch(this.projectsDir, { recursive: true, persistent: false }, (_event, name) => {
        if (!name || !String(name).endsWith('.jsonl')) return;
        clearTimeout(this.pollSoon);
        this.pollSoon = setTimeout(() => {
          // A file we don't know yet (a new session or agent): look for it now.
          if (!this.knows(path.join(this.projectsDir, String(name)))) this.scan();
          this.poll();
        }, 120);
        this.pollSoon.unref?.();
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // No folder yet, or no recursive watching here: the poll still works.
    }
  }

  private knows(file: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.file === file) return true;
      for (const a of s.agents.values()) if (a.file === file) return true;
    }
    return false;
  }

  /** klaud's own conversations (its workspaces) show in klaud's chat already. */
  private ownSessions(): Set<string> {
    const ids = new Set<string>();
    for (const p of this.opts.store.getState().projects) for (const w of p.workspaces) if (w.sessionId) ids.add(w.sessionId);
    return ids;
  }

  /** Find sessions written lately (or with agents still writing), and forget ones gone quiet. */
  scan(): void {
    if (this.stopped) return;
    // Claude Code's folder may appear after klaud starts: watch it once it's there.
    if (this.opts.watch !== false && !this.watcher) this.watchFolder();
    const now = this.now;
    const activeMs = this.opts.activeMs ?? ACTIVE_MS;
    const own = this.ownSessions();
    const found = new Set<string>();
    for (const folder of list(this.projectsDir)) {
      const dir = path.join(this.projectsDir, folder);
      for (const name of list(dir)) {
        const id = SESSION_FILE.exec(name)?.[1];
        if (!id || own.has(id)) continue;
        const file = path.join(dir, name);
        const mtime = mtimeOf(file);
        if (now - mtime > AGENT_LOOKBACK_MS) continue;
        const agentsDir = path.join(dir, id, 'subagents');
        const recent = now - mtime <= activeMs || list(agentsDir).some((f) => AGENT_FILE.test(f) && now - mtimeOf(path.join(agentsDir, f)) <= activeMs);
        const known = this.sessions.get(id);
        if (!recent && !(known && now - known.viewedAt <= VIEWED_MS)) continue;
        found.add(id);
        if (!known) this.sessions.set(id, { id, file, dir, tracker: new TranscriptTracker(file), agents: new Map(), viewedAt: 0 });
      }
    }
    for (const id of [...this.sessions.keys()]) if (!found.has(id)) this.sessions.delete(id);
    for (const s of this.sessions.values()) this.scanAgents(s);
    this.schedulePublish();
  }

  /** A session's agents written lately (their transcripts are read; older ones are left alone). */
  private scanAgents(s: SessionEntry): void {
    const now = this.now;
    const activeMs = this.opts.activeMs ?? ACTIVE_MS;
    const dir = path.join(s.dir, s.id, 'subagents');
    const seen = new Set<string>();
    for (const name of list(dir)) {
      const id = AGENT_FILE.exec(name)?.[1];
      if (!id) continue;
      const file = path.join(dir, name);
      const known = s.agents.get(id);
      const mtime = mtimeOf(file);
      if (now - mtime > activeMs && known?.last !== 'running') continue;
      seen.add(id);
      const metaFile = path.join(dir, `agent-${id}.meta.json`);
      if (!known) s.agents.set(id, { id, file, metaFile, meta: readMeta(metaFile) });
      else if (!known.meta.description) known.meta = readMeta(metaFile);
    }
    for (const id of [...s.agents.keys()]) if (!seen.has(id)) s.agents.delete(id);
  }

  /** Read what was added to every watched transcript. */
  poll(): void {
    if (this.stopped) return;
    for (const s of this.sessions.values()) {
      const facts = s.tracker.update();
      // It started an agent: its transcript appears any moment.
      if (facts.some((f: Facts) => f.launches.length)) this.scanAgents(s);
      for (const a of s.agents.values()) {
        a.tracker ??= new TranscriptTracker(a.file);
        a.tracker.update();
      }
    }
    this.schedulePublish();
  }

  /** At most one update every publishMs; nothing when nothing changed. */
  private schedulePublish(): void {
    if (this.publishTimer || this.stopped) return;
    const wait = Math.max(0, this.lastPublishAt + (this.opts.publishMs ?? 250) - this.now);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.publish();
    }, wait);
    this.publishTimer.unref?.();
  }

  /** Put the current picture in the shared state (when it changed). */
  publish(): void {
    if (this.stopped) return;
    this.lastPublishAt = this.now;
    const sessions = this.summarize();
    const key = JSON.stringify(sessions);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.opts.store.dispatch({ type: 'claude_code', sessions });
  }

  private summarize(): CcSession[] {
    const now = this.now;
    const activeMs = this.opts.activeMs ?? ACTIVE_MS;
    const idleMs = this.opts.idleMs ?? IDLE_MS;
    const projects = this.opts.store.getState().projects;
    const out: CcSession[] = [];
    for (const s of this.sessions.values()) {
      const t = s.tracker;
      const agents = [...s.agents.values()].map((a) => this.agentOf(s, a, now, idleMs)).filter((a): a is CcAgent => Boolean(a));
      const shown = agents
        .filter((a) => a.status === 'running' || now - a.lastAt <= activeMs)
        .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.lastAt - a.lastAt)
        .slice(0, MAX_AGENTS);
      // Nothing in it yet (just created, or only bookkeeping lines): nothing to show.
      if (!t.count && !t.title && !shown.length) continue;
      const lastAt = t.lastAt;
      if (now - lastAt > activeMs && !shown.some((a) => a.status === 'running') && now - s.viewedAt > VIEWED_MS) continue;
      const cwd = t.cwd ?? '';
      out.push({
        id: s.id,
        title: t.title ?? 'Claude Code session',
        cwd,
        ...(cwd ? placeOf(projects, cwd) : {}),
        status: t.final ? 'waiting' : now - lastAt <= idleMs ? 'working' : 'idle',
        ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
        lastAt,
        ...(t.current ? { step: t.current } : {}),
        steps: t.count,
        ...(t.tokens ? { tokens: t.tokens } : {}),
        ...(t.model ? { model: t.model } : {}),
        agents: shown,
      });
    }
    const live = (x: CcSession): number => Number(x.status === 'working' || x.agents.some((a) => a.status === 'running'));
    return out.sort((a, b) => live(b) - live(a) || b.lastAt - a.lastAt).slice(0, MAX_SESSIONS);
  }

  private agentOf(s: SessionEntry, a: AgentEntry, now: number, idleMs: number): CcAgent | undefined {
    const t = a.tracker;
    if (!t) return undefined;
    const toolUseId = a.meta.toolUseId;
    const parent = s.tracker;
    const launch = toolUseId ? parent.launches.get(toolUseId) : undefined;
    const notice = parent.notices.get(a.id);
    const result = toolUseId ? parent.results.get(toolUseId) : undefined;
    const { status, endedAt } = agentStatus({ lastAt: t.lastAt, final: t.final, ...(notice ? { notice } : {}), ...(result ? { result } : {}), now, idleMs });
    const background = a.meta.requestShape === 'background' || launch?.background === true || result?.async === true;
    const description = a.meta.description ?? launch?.description ?? t.title ?? 'Sub-agent';
    if (a.last === 'running' && status !== 'running' && status !== 'idle' && background) {
      const where = s.tracker.cwd ? path.basename(s.tracker.cwd) : 'Claude Code';
      this.opts.notify?.({ title: status === 'finished' ? `An agent finished in ${where}` : `An agent ${status === 'failed' ? 'failed' : 'stopped'} in ${where}`, body: description, failed: status === 'failed' });
    }
    a.last = status;
    return {
      id: a.id,
      description,
      type: a.meta.agentType ?? launch?.type ?? 'general-purpose',
      background,
      status,
      startedAt: t.startedAt ?? launch?.ts ?? t.lastAt,
      lastAt: t.lastAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(t.current ? { step: t.current } : {}),
      steps: t.count,
      ...(t.tokens ? { tokens: t.tokens } : {}),
    };
  }

  /** A session's (or one of its agents') recent steps, for a screen showing it live. */
  steps(sessionId: string, agentId?: string, opts: PageOptions = {}): CcSteps {
    const s = this.sessions.get(sessionId);
    if (!s) return { steps: [], more: false, missing: true };
    s.viewedAt = this.now;
    if (agentId === undefined) return s.tracker.page(opts);
    const a = s.agents.get(agentId);
    if (!a) return { steps: [], more: false, missing: true };
    a.tracker ??= new TranscriptTracker(a.file);
    a.tracker.update();
    return a.tracker.page(opts);
  }
}
