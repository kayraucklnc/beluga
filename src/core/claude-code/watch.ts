import { type FSWatcher, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '../../workspaces/types.js';
import { worktreeOrigin } from '../../workspaces/origin.js';
import { AgentOrigins } from './agent-origins.js';
import type { Store } from '../store.js';
import { type AgentMeta, agentStatus, finishedIn, readMeta } from './agents.js';
import type { AgentOrigin, CcAgent, CcAgentStatus, CcMessage, CcOutputFile, CcOutputs, CcSession, CcSteps, CcTask, CcTaskOutput, CcTeam } from './model.js';
import { byLiveThenLatest, taskOutput, tasksOf } from './task-list.js';
import { agentScratchDir, outputsOnDisk, readOutput } from './output-files.js';
import { type PageOptions, TranscriptTracker } from './sessions.js';
import type { StepRecord } from '../../shared/steps.js';
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
  /** Asks to scan within this long of each other make one scan (default 250 ms). */
  readonly scanDebounceMs?: number;
  /** How often every transcript's time is read again, even in folders that didn't change (default 60 s). */
  readonly sweepMs?: number;
  /** The most often screens hear about changes (default 250 ms: at most 4 a second). */
  readonly publishMs?: number;
  /** Use fs.watch (default true; tests drive it by hand). */
  readonly watch?: boolean;
  /** Tell you a background agent finished (through the notifier, which minds your settings). */
  readonly notify?: (note: { title: string; body: string; failed: boolean }) => void;
  /**
   * Where klaud remembers the Claude sessions it ran, so they stay out of Activity after their
   * conversation is archived or deleted (undefined: memory only).
   */
  readonly ownFile?: string;
}

/** The most sessions remembered as klaud's own (the oldest are forgotten first). */
const MAX_OWN = 5000;

interface AgentEntry {
  readonly id: string;
  readonly file: string;
  readonly metaFile: string;
  meta: AgentMeta;
  tracker?: TranscriptTracker;
  /** The status last published (to notice an agent finishing). */
  last?: CcAgentStatus;
  /** When a screen last asked for its steps (kept and shown a while, however old it is). */
  viewedAt?: number;
}

interface SessionEntry {
  readonly id: string;
  readonly file: string;
  readonly dir: string;
  readonly tracker: TranscriptTracker;
  readonly agents: Map<string, AgentEntry>;
  /** When a screen last asked for its steps (kept watched a while after it goes quiet). */
  viewedAt: number;
  /** One of klaud's own conversations: watched for its sub-agents, kept out of Activity. */
  readonly own: boolean;
}

const ACTIVE_MS = 30 * 60_000;
const IDLE_MS = 5 * 60_000;
/** Sessions this old aren't checked for agents still working. */
const AGENT_LOOKBACK_MS = 6 * 60 * 60_000;
const VIEWED_MS = 10 * 60_000;
const MAX_SESSIONS = 30;
const MAX_AGENTS = 12;
/** Background commands shown per session (running ones, then the latest). */
const MAX_TASKS = 20;
/** Messages shown in a team's timeline. */
const TEAM_MESSAGES = 12;
const AGENT_FILE = /^agent-([\w-]+)\.jsonl$/;
const SESSION_FILE = /^([0-9a-f-]{8,})\.jsonl$/i;

const SCAN_DEBOUNCE_MS = 250;
const SWEEP_MS = 60_000;
/** Files looked at at once while scanning. */
const SCAN_PARALLEL = 16;

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

const mtimeAsync = async (file: string): Promise<number> => {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
};

/** Run `fn` over `items`, `limit` at a time. */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Folder listings, read again only when the folder's time changed (a file added or removed). */
export class Listings {
  private readonly cache = new Map<string, { readonly mtime: number; readonly names: readonly string[] }>();

  /** `changed`: the folder is new here or its entries changed since it was last listed. */
  async list(dir: string): Promise<{ readonly names: readonly string[]; readonly changed: boolean }> {
    const mtime = await mtimeAsync(dir);
    if (!mtime) {
      this.cache.delete(dir);
      return { names: [], changed: false };
    }
    const known = this.cache.get(dir);
    if (known?.mtime === mtime) return { names: known.names, changed: false };
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return { names: [], changed: false };
    }
    this.cache.set(dir, { mtime, names });
    return { names, changed: true };
  }

  /** Forget folders not in `keep` (gone, or no longer looked at). */
  keepOnly(keep: ReadonlySet<string>): void {
    for (const dir of [...this.cache.keys()]) if (!keep.has(dir)) this.cache.delete(dir);
  }
}

/** One of klaud's own sessions: the workspace whose conversation it is (else where its folder is). */
function ownPlace(projects: readonly Project[], sessionId: string, cwd: string): { projectId?: string; workspaceId?: string } {
  for (const p of projects) for (const w of p.workspaces) if (w.sessionId === sessionId) return { projectId: p.id, workspaceId: w.id };
  return cwd ? placeOf(projects, cwd) : {};
}

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
  private lastOrigins = '';
  private origins?: AgentOrigins;
  private lastPublishAt = 0;
  private offStore?: () => void;
  private stopped = false;
  /** The scan under way (one at a time), whether another was asked for meanwhile, and the debounce. */
  private scanning?: Promise<void>;
  private rescan = false;
  private scanTimer?: NodeJS.Timeout;
  private readonly listings = new Listings();
  /** Each transcript's time when last read: old ones aren't read again until something says so. */
  private readonly mtimes = new Map<string, number>();
  /** Transcripts fs.watch saw written since the last scan (read again even if old). */
  private hints = new Set<string>();
  private sweptAt = -Infinity;

  constructor(private readonly opts: WatcherOptions) {}

  private get now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private get projectsDir(): string {
    return path.join(this.opts.home, 'projects');
  }

  start(): void {
    void this.scan().then(() => this.poll());
    this.timers.push(setInterval(() => this.poll(), this.opts.pollMs ?? 2000), setInterval(() => this.requestScan(), this.opts.scanMs ?? 10_000));
    for (const t of this.timers) t.unref?.();
    // Projects found or changed: sessions map to their workspaces again.
    let projects = this.opts.store.getState().projects;
    this.offStore = this.opts.store.subscribe(() => {
      const next = this.opts.store.getState().projects;
      if (next === projects) return;
      projects = next;
      this.requestScan();
      this.schedulePublish();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.splice(0)) clearInterval(t);
    clearTimeout(this.publishTimer);
    clearTimeout(this.pollSoon);
    clearTimeout(this.scanTimer);
    this.watcher?.close();
    this.offStore?.();
  }

  /** fs.watch over every project folder (recursive where the system can): a write means a quick check. */
  private watchFolder(): void {
    try {
      this.watcher = watch(this.projectsDir, { recursive: true, persistent: false }, (_event, name) => {
        if (!name || !String(name).endsWith('.jsonl')) return;
        const file = path.join(this.projectsDir, String(name));
        // A file we don't know yet (a new session or agent, or an old one going on): look for it soon.
        if (!this.knows(file)) {
          this.hints.add(file);
          this.requestScan();
        }
        clearTimeout(this.pollSoon);
        this.pollSoon = setTimeout(() => {
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

  private remembered?: Set<string>;

  /**
   * klaud's own conversations (its workspaces) show in klaud's chat already, and stay out of
   * Activity for good: once seen they're remembered, even after the conversation is deleted.
   */
  private ownSessions(): Set<string> {
    if (!this.remembered) {
      this.remembered = new Set();
      try {
        if (this.opts.ownFile) for (const id of JSON.parse(readFileSync(this.opts.ownFile, 'utf8')) as unknown[]) if (typeof id === 'string') this.remembered.add(id);
      } catch {
        // none yet
      }
    }
    let added = false;
    for (const p of this.opts.store.getState().projects) {
      for (const w of p.workspaces) {
        if (w.sessionId && !this.remembered.has(w.sessionId)) {
          this.remembered.add(w.sessionId);
          added = true;
        }
      }
    }
    if (added && this.opts.ownFile) {
      const ids = [...this.remembered].slice(-MAX_OWN);
      try {
        mkdirSync(path.dirname(this.opts.ownFile), { recursive: true });
        const tmp = `${this.opts.ownFile}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(ids));
        renameSync(tmp, this.opts.ownFile);
      } catch {
        // kept in memory for this run
      }
    }
    return this.remembered;
  }

  /** Scan soon: asks close together make one scan. */
  requestScan(): void {
    if (this.stopped || this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      void this.scan();
    }, this.opts.scanDebounceMs ?? SCAN_DEBOUNCE_MS);
    this.scanTimer.unref?.();
  }

  /**
   * Find sessions written lately (or with agents still writing), and forget ones gone quiet. Never
   * two at once: asked for during one, it scans once more after it (and resolves after that).
   */
  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    const run = (async () => {
      try {
        do {
          this.rescan = false;
          await this.scanOnce();
        } while (this.rescan && !this.stopped);
      } finally {
        this.scanning = undefined;
      }
    })();
    this.scanning = run;
    return run;
  }

  /** Whether a scan is under way (tests). */
  get scanBusy(): boolean {
    return this.scanning !== undefined;
  }

  private async scanOnce(): Promise<void> {
    // Claude Code's folder may appear after klaud starts: watch it once it's there.
    if (this.opts.watch !== false && !this.watcher) this.watchFolder();
    const now = this.now;
    const activeMs = this.opts.activeMs ?? ACTIVE_MS;
    const own = this.ownSessions();
    // Old transcripts are read again only in folders that changed, when fs.watch saw them written, or once a sweep.
    const sweep = now - this.sweptAt >= (this.opts.sweepMs ?? SWEEP_MS);
    if (sweep) this.sweptAt = now;
    const hints = this.hints;
    this.hints = new Set();
    const found = new Set<string>();
    const listed = new Set<string>();
    const dirs = new Set<string>([this.projectsDir]);
    for (const folder of (await this.listings.list(this.projectsDir)).names) {
      if (this.stopped) return;
      const dir = path.join(this.projectsDir, folder);
      dirs.add(dir);
      const { names, changed } = await this.listings.list(dir);
      await eachLimit(names, SCAN_PARALLEL, async (name) => {
        const id = SESSION_FILE.exec(name)?.[1];
        if (!id) return;
        const file = path.join(dir, name);
        listed.add(file);
        const known = this.sessions.get(id);
        const viewed = Boolean(known && now - known.viewedAt <= VIEWED_MS);
        let mtime = this.mtimes.get(file);
        if (mtime === undefined || now - mtime <= AGENT_LOOKBACK_MS || changed || sweep || known || hints.has(file)) {
          mtime = await mtimeAsync(file);
          this.mtimes.set(file, mtime);
        }
        if (now - mtime > AGENT_LOOKBACK_MS && !viewed) return;
        const agentsDir = path.join(dir, id, 'subagents');
        dirs.add(agentsDir);
        const recent = now - mtime <= activeMs || (await this.agentsWrittenSince(agentsDir, now - activeMs));
        if (!recent && !viewed) return;
        found.add(id);
        if (!this.sessions.has(id)) this.sessions.set(id, { id, file, dir, tracker: new TranscriptTracker(file), agents: new Map(), viewedAt: 0, own: own.has(id) });
      });
    }
    if (this.stopped) return;
    for (const file of [...this.mtimes.keys()]) if (!listed.has(file)) this.mtimes.delete(file);
    this.listings.keepOnly(dirs);
    // Kept: sessions found, and any a screen asked for while this scan ran.
    for (const [id, s] of [...this.sessions]) if (!found.has(id) && s.viewedAt < now) this.sessions.delete(id);
    for (const s of [...this.sessions.values()]) await this.scanAgents(s);
    if (this.stopped) return;
    await this.publishOrigins(own);
    this.schedulePublish();
  }

  /** Whether an agent in this folder wrote since `since`. */
  private async agentsWrittenSince(agentsDir: string, since: number): Promise<boolean> {
    for (const f of (await this.listings.list(agentsDir)).names) if (AGENT_FILE.test(f) && (await mtimeAsync(path.join(agentsDir, f))) >= since) return true;
    return false;
  }

  /** Who started each sub-agent worktree in the projects (from Claude Code's files), when that changed. */
  private async publishOrigins(own: ReadonlySet<string>): Promise<void> {
    const projects = this.opts.store.getState().projects;
    const paths = projects.flatMap((p) => p.workspaces.filter((w) => !w.archived && worktreeOrigin(w) === 'agent').map((w) => w.path));
    this.origins ??= new AgentOrigins(this.opts.home, this.opts.now ? { now: this.opts.now } : {});
    const origins: AgentOrigin[] = (await this.origins.find(paths)).map((o) => {
      const mine = own.has(o.sessionId);
      const place = mine ? ownPlace(projects, o.sessionId, o.sessionCwd ?? '') : o.sessionCwd ? placeOf(projects, o.sessionCwd) : {};
      // Never its own worktree's conversation (a session that ran there isn't what started it).
      const workspaceId = place.workspaceId && projects.some((p) => p.workspaces.some((w) => w.id === place.workspaceId && w.path === o.path)) ? undefined : place.workspaceId;
      return { ...o, ...(place.projectId ? { projectId: place.projectId } : {}), ...(workspaceId ? { workspaceId } : {}), ...(mine ? { own: true as const } : {}) };
    });
    const key = JSON.stringify(origins);
    if (key === this.lastOrigins) return;
    this.lastOrigins = key;
    this.opts.store.dispatch({ type: 'agent_origins', origins });
  }

  /** A session's agents written lately (their transcripts are read; older ones are left alone). */
  private async scanAgents(s: SessionEntry): Promise<void> {
    const now = this.now;
    const activeMs = this.opts.activeMs ?? ACTIVE_MS;
    const dir = path.join(s.dir, s.id, 'subagents');
    const seen = new Set<string>();
    for (const name of (await this.listings.list(dir)).names) {
      const id = AGENT_FILE.exec(name)?.[1];
      if (!id) continue;
      const file = path.join(dir, name);
      const known = s.agents.get(id);
      const mtime = await mtimeAsync(file);
      const viewed = known?.viewedAt !== undefined && now - known.viewedAt <= VIEWED_MS;
      if (now - mtime > activeMs && known?.last !== 'running' && !viewed) continue;
      seen.add(id);
      const metaFile = path.join(dir, `agent-${id}.meta.json`);
      if (!known) s.agents.set(id, { id, file, metaFile, meta: readMeta(metaFile) });
      else if (!known.meta.description) known.meta = readMeta(metaFile);
    }
    for (const id of [...s.agents.keys()]) if (!seen.has(id)) s.agents.delete(id);
  }

  /** The launch that started an agent (its description, type and name). */
  private launchOf(s: SessionEntry, a: AgentEntry) {
    return a.meta.toolUseId ? s.tracker.launches.get(a.meta.toolUseId) : undefined;
  }

  /** An agent (by id, or by the name it was given) → its id in this session, if it's one of them. */
  private agentIdOf(s: SessionEntry, who: string): string | undefined {
    if (s.agents.has(who)) return who;
    for (const a of s.agents.values()) if (this.launchOf(s, a)?.name === who) return a.id;
    return undefined;
  }

  /** An agent in words: its name, else what it was asked to do. */
  private labelOf(s: SessionEntry, who: string): string {
    const id = this.agentIdOf(s, who);
    const a = id ? s.agents.get(id) : undefined;
    if (!a) return who;
    const launch = this.launchOf(s, a);
    return launch?.name ?? a.meta.description ?? launch?.description ?? who;
  }

  /** Transcripts name agents the way the watcher knows them. */
  private label(s: SessionEntry): void {
    s.tracker.labeler ??= (who) => this.labelOf(s, who);
    for (const a of s.agents.values()) if (a.tracker) a.tracker.labeler ??= (who) => this.labelOf(s, who);
  }

  /**
   * Agents working as a team: when any is named (so it can be messaged) or an agent messages
   * another session. Its members are the named agents and every agent in a message; the
   * timeline is the messages between them and the lead session (SendMessage), newest last.
   */
  private teamOf(s: SessionEntry, shown: readonly CcAgent[]): CcTeam | undefined {
    const resolve = (to: string): string => (to === 'main' || to === 'lead' ? 'lead' : (this.agentIdOf(s, to) ?? to));
    const messages: CcMessage[] = [
      ...s.tracker.sends.map((m) => ({ from: 'lead', to: resolve(m.to), summary: m.summary, ts: m.ts })),
      ...[...s.agents.values()].flatMap((a) => (a.tracker?.sends ?? []).map((m) => ({ from: a.id, to: resolve(m.to), summary: m.summary, ts: m.ts }))),
    ].sort((a, b) => a.ts - b.ts);
    const ids = new Set(shown.map((a) => a.id));
    const named = shown.filter((a) => a.name).map((a) => a.id);
    const fromAgents = messages.some((m) => m.from !== 'lead');
    if (!named.length && !fromAgents) return undefined;
    const members = new Set([...named, ...messages.flatMap((m) => [m.from, m.to]).filter((id) => ids.has(id))]);
    return { members: shown.filter((a) => members.has(a.id)).map((a) => a.id), messages: messages.slice(-TEAM_MESSAGES) };
  }

  /** Read what was added to every watched transcript. */
  poll(): void {
    if (this.stopped) return;
    for (const s of this.sessions.values()) {
      this.label(s);
      const facts = s.tracker.update();
      // It started an agent: its transcript appears any moment.
      if (facts.some((f: Facts) => f.launches.length)) void this.scanAgents(s).then(() => this.schedulePublish());
      for (const a of s.agents.values()) {
        a.tracker ??= new TranscriptTracker(a.file);
        a.tracker.labeler ??= (who) => this.labelOf(s, who);
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
      const viewedAgent = (id: string): boolean => {
        const at = s.agents.get(id)?.viewedAt;
        return at !== undefined && now - at <= VIEWED_MS;
      };
      const shown = agents
        .filter((a) => a.status === 'running' || now - a.lastAt <= activeMs || viewedAgent(a.id))
        .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.lastAt - a.lastAt)
        .slice(0, MAX_AGENTS);
      // Nothing in it yet (just created, or only bookkeeping lines): nothing to show.
      if (!t.count && !t.title && !shown.length) continue;
      const lastAt = t.lastAt;
      const quiet = now - lastAt > activeMs && !shown.some((a) => a.status === 'running') && now - s.viewedAt > VIEWED_MS;
      const tasks = this.tasksIn(s, shown, now, idleMs, activeMs);
      if (quiet && !tasks.some((x) => x.status === 'running')) continue;
      const cwd = t.cwd ?? '';
      const team = this.teamOf(s, shown);
      out.push({
        id: s.id,
        title: t.title ?? 'Claude Code session',
        cwd,
        ...(s.own ? { ...ownPlace(projects, s.id, cwd), own: true as const } : cwd ? placeOf(projects, cwd) : {}),
        status: t.final ? 'waiting' : now - lastAt <= idleMs ? 'working' : 'idle',
        ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
        lastAt,
        ...(t.current ? { step: t.current } : {}),
        steps: t.count,
        ...(t.tokens ? { tokens: t.tokens } : {}),
        ...(t.model ? { model: t.model } : {}),
        agents: shown,
        ...(team ? { team } : {}),
        ...(tasks.length ? { tasks } : {}),
      });
    }
    const live = (x: CcSession): number => Number(x.status === 'working' || x.agents.some((a) => a.status === 'running'));
    return out.sort((a, b) => live(b) - live(a) || b.lastAt - a.lastAt).slice(0, MAX_SESSIONS);
  }

  /** The background commands a session and its agents started: running ones, and those that ended lately. */
  private tasksIn(s: SessionEntry, shown: readonly CcAgent[], now: number, idleMs: number, activeMs: number): CcTask[] {
    const agents = shown.flatMap((x) => {
      const t = s.agents.get(x.id)?.tracker;
      return t ? tasksOf(t, x.id, now, idleMs) : [];
    });
    const all = [...tasksOf(s.tracker, undefined, now, idleMs), ...agents];
    return all.filter((x) => x.status === 'running' || now - (x.endedAt ?? x.startedAt) <= activeMs).sort(byLiveThenLatest).slice(0, MAX_TASKS);
  }

  private agentOf(s: SessionEntry, a: AgentEntry, now: number, idleMs: number): CcAgent | undefined {
    const t = a.tracker;
    if (!t) return undefined;
    const toolUseId = a.meta.toolUseId;
    const parent = s.tracker;
    const launch = toolUseId ? parent.launches.get(toolUseId) : undefined;
    const notice = parent.notices.get(a.id);
    const result = toolUseId ? parent.results.get(toolUseId) : undefined;
    // Quiet a while: did Claude Code mark it finished? (read only then: it's written once, at the end)
    const marked = now - t.lastAt > idleMs && finishedIn(a.metaFile);
    const { status, endedAt } = agentStatus({ lastAt: t.lastAt, final: t.final, ...(notice ? { notice } : {}), ...(result ? { result } : {}), now, idleMs, marked });
    const background = a.meta.requestShape === 'background' || launch?.background === true || result?.async === true;
    const description = a.meta.description ?? launch?.description ?? t.title ?? 'Sub-agent';
    t.labeler ??= (who) => this.labelOf(s, who);
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
      ...(launch?.name || a.meta.name ? { name: launch?.name ?? a.meta.name } : {}),
      ...((t.model ?? a.meta.model) ? { model: t.model ?? a.meta.model } : {}),
      ...(t.effort ? { effort: t.effort } : {}),
      ...(t.cwd ? { cwd: t.cwd } : {}),
      ...(a.meta.worktreePath ? { worktree: { path: a.meta.worktreePath, ...(a.meta.worktreeBranch ? { branch: a.meta.worktreeBranch } : {}) } } : {}),
      ...(toolUseId ? { toolUseId } : {}),
      ...(a.meta.parentAgentId ? { parentAgentId: a.meta.parentAgentId } : {}),
    };
  }

  /**
   * Find a sub-agent by its id, however old (its worktree is open on screen, say), and keep it
   * watched a while: → its session's id, or undefined when Claude Code has no such agent.
   */
  adopt(agentId: string): string | undefined {
    if (!/^[\w-]{4,64}$/.test(agentId)) return undefined;
    for (const s of this.sessions.values()) {
      const a = s.agents.get(agentId);
      if (a) {
        a.viewedAt = this.now;
        s.viewedAt = this.now;
        return s.id;
      }
    }
    const own = this.ownSessions();
    for (const folder of list(this.projectsDir)) {
      const dir = path.join(this.projectsDir, folder);
      for (const name of list(dir)) {
        const id = SESSION_FILE.exec(`${name}.jsonl`)?.[1];
        if (!id || name.includes('.')) continue;
        const agentFile = path.join(dir, name, 'subagents', `agent-${agentId}.jsonl`);
        if (!mtimeOf(agentFile)) continue;
        const file = path.join(dir, `${id}.jsonl`);
        const s: SessionEntry = this.sessions.get(id) ?? { id, file, dir, tracker: new TranscriptTracker(file), agents: new Map(), viewedAt: this.now, own: own.has(id) };
        s.viewedAt = this.now;
        this.sessions.set(id, s);
        s.agents.set(agentId, { id: agentId, file: agentFile, metaFile: path.join(dir, name, 'subagents', `agent-${agentId}.meta.json`), meta: readMeta(path.join(dir, name, 'subagents', `agent-${agentId}.meta.json`)), viewedAt: this.now });
        this.poll();
        return id;
      }
    }
    return undefined;
  }

  /** One step of a session (or of one of its agents) with its details, while klaud keeps them. */
  step(sessionId: string, agentId: string | undefined, seq: number): StepRecord | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    if (agentId === undefined) return s.tracker.detail(seq);
    return s.agents.get(agentId)?.tracker?.detail(seq);
  }

  /** A session's (or one of its agents') recent steps, for a screen showing it live. */
  steps(sessionId: string, agentId?: string, opts: PageOptions = {}): CcSteps {
    const s = this.sessions.get(sessionId);
    if (!s) return { steps: [], more: false, missing: true };
    s.viewedAt = this.now;
    this.label(s);
    if (agentId === undefined) return s.tracker.page(opts);
    const a = s.agents.get(agentId);
    if (!a) return { steps: [], more: false, missing: true };
    a.viewedAt = this.now;
    a.tracker ??= new TranscriptTracker(a.file);
    this.label(s);
    a.tracker.update();
    return a.tracker.page(opts);
  }

  /** What one of a session's agents made or looked at (screenshots, logs, test output) that's still there. */
  outputs(sessionId: string, agentId: string): CcOutputs {
    const s = this.sessions.get(sessionId);
    const a = s?.agents.get(agentId);
    if (!s || !a) return { outputs: [], missing: true };
    a.viewedAt = this.now;
    a.tracker ??= new TranscriptTracker(a.file);
    a.tracker.update();
    const root = s.tracker.cwd;
    const scratch = root && a.meta.toolUseId ? agentScratchDir(root, a.meta.toolUseId) : undefined;
    const outputs = outputsOnDisk(a.tracker.outputs.list(), root && scratch ? { root, dir: scratch } : undefined);
    return { outputs, ...(scratch ? { scratch } : {}) };
  }

  /** The end of a background command's output (the session's own, or one of its agents'), to follow it. */
  taskOutput(sessionId: string, agentId: string | undefined, taskId: string): CcTaskOutput | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    s.viewedAt = this.now;
    const t = agentId === undefined ? s.tracker : s.agents.get(agentId)?.tracker;
    if (!t) return undefined;
    t.update();
    return taskOutput(t, taskId);
  }

  /** One of an agent's outputs, to show it: only a file it made or looked at. */
  output(sessionId: string, agentId: string, file: string): CcOutputFile | undefined {
    const found = this.outputs(sessionId, agentId).outputs.find((o) => o.path === file);
    return found ? readOutput(found) : undefined;
  }
}
