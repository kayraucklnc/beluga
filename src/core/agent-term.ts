import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TerminalLaunch, TerminalSink } from '../agent/types.js';
import type { StepRecord } from '../shared/steps.js';
import { describeVisual } from '../shared/term-visuals.js';
import { agentTermId } from '../shared/terminal-keys.js';
import type { PtyProcess } from '../terminal/pty-host.js';
import type { Workspace } from '../workspaces/types.js';
import { TranscriptTail, claudeTranscriptFile, claudeTurns, sizeOf } from './agent-term-sync.js';
import { belugaHome } from './home.js';
import type { Store } from './store.js';
import { MAX_TERM_VISUALS } from './work-store.js';

/**
 * The agent's own terminal on a conversation (BLG-534): Claude Code's terminal app (a local
 * model's runs in it too; Codex's conversations stay in the chat) in the middle of a worktree, on the same conversation as its chat. While it's open the terminal
 * drives (the chat's own turns wait, see AgentHost.runAgent); what's said there comes back to the
 * chat as it's written (agent-term-sync.ts); the visuals it shows are kept here for its links.
 * Closing it (or it ending) gives the conversation back to the chat.
 */

export interface AgentTermDeps {
  readonly store: Store;
  readonly find: (wsId: string) => Workspace | undefined;
  /** Load the conversation's saved chat first, so what comes back joins it. */
  readonly ensureLoaded: (wsId: string) => void;
  /** The launch, as AgentHost.terminalLaunch makes it. */
  readonly launch: (channel: string, sink: TerminalSink, prompt?: string) => Promise<TerminalLaunch>;
  readonly openProgram: (key: string, ws: Workspace, program: { readonly file: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly title: string }, size?: { cols: number; rows: number }) => PtyProcess | undefined;
  readonly closeTerminal: (key: string) => void;
  /** The pty under a key now (gone when it was closed some other way: archiving). */
  readonly pty: (key: string) => PtyProcess | undefined;
  /** The conversation's runtime and its agent's name. */
  readonly agentOf: (wsId: string) => { readonly runtime: string; readonly label: string };
  /** A new conversation the terminal started is the workspace's from now on. */
  readonly rememberSession: (wsId: string, session: string, runtime: string) => void;
  readonly self: () => { readonly id: string; readonly name: string };
  /** A turn's steps in detail, for its card. */
  readonly keepSteps?: (steps: Readonly<Record<string, readonly StepRecord[]>>) => void;
  readonly home?: string;
  readonly claudeConfigDir?: string;
  /** How often the transcript is looked at while the terminal is open (default 700 ms; 0: only when asked, tests). */
  readonly pollMs?: number;
  readonly now?: () => number;
}

/** One open terminal. */
interface Live {
  readonly wsId: string;
  readonly key: string;
  readonly launch: TerminalLaunch;
  readonly runtime: string;
  readonly cwd: string;
  readonly startedAt: number;
  pty: PtyProcess;
  remembered: boolean;
  /** The message from the chat it opened with (BLG-553): in the chat already, so its copy in the transcript isn't. */
  readonly handed?: string;
  tail?: TranscriptTail;
  timer?: NodeJS.Timeout;
}

/** The terminal's turns less the first prompt it was handed from the chat (said there already, BLG-553). */
export function withoutHanded<T extends { readonly type: string; readonly text?: string }>(items: readonly T[], handed: string | undefined): readonly T[] {
  if (!handed) return items;
  const at = items.findIndex((it) => it.type === 'chat' && it.text?.trim() === handed.trim());
  return at < 0 ? items : [...items.slice(0, at), ...items.slice(at + 1)];
}

interface KeptVisuals {
  next: number;
  items: Array<{ n: number; block: string }>;
}

export class AgentTerminals {
  private readonly live = new Map<string, Live>();
  private readonly opening = new Map<string, Promise<string>>();
  private readonly visuals = new Map<string, KeptVisuals>();

  constructor(private readonly deps: AgentTermDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether a conversation's terminal is driving it now (its channel, `ws:<id>`). */
  driving(channel: string): boolean {
    return channel.startsWith('ws:') && this.live.has(channel.slice(3));
  }

  /** Whether a conversation can have its agent's terminal: a chat or a worktree of yours, not on Codex. */
  canOpen(wsId: string): boolean {
    const ws = this.deps.find(wsId);
    return Boolean(ws && !ws.archived && ws.kind !== 'main' && this.deps.agentOf(wsId).runtime !== 'codex');
  }

  /**
   * Open the agent's terminal on a workspace's conversation, or the one already open. The pty's
   * key, for the screen to attach to. Throws why it can't (a turn running in the chat, no agent).
   */
  open(wsId: string, size?: { cols: number; rows: number }, prompt?: string): Promise<string> {
    const live = this.live.get(wsId);
    const running = Boolean(live && this.deps.pty(live.key) === live.pty && live.pty.running);
    // A first prompt only goes to a terminal starting now: one open already has its own conversation going.
    if (prompt && (running || this.opening.has(wsId))) return Promise.reject(new Error('The terminal is open here already: type there.'));
    if (live && running) {
      if (size) live.pty.resize(size.cols, size.rows);
      return Promise.resolve(live.key);
    }
    if (live) this.finish(wsId);
    const pending = this.opening.get(wsId);
    if (pending) return pending;
    const opening = this.start(wsId, size, prompt).finally(() => this.opening.delete(wsId));
    this.opening.set(wsId, opening);
    return opening;
  }

  private async start(wsId: string, size?: { cols: number; rows: number }, prompt?: string): Promise<string> {
    const ws = this.deps.find(wsId);
    if (!ws || ws.archived) throw new Error('That workspace is archived or gone.');
    if (ws.kind === 'main') throw new Error('A project’s main folder has no conversation of its own: open a chat or a worktree.');
    const channel = `ws:${wsId}`;
    const agent = this.deps.agentOf(wsId);
    if (agent.runtime === 'codex') throw new Error('Codex conversations stay in the chat: the terminal view is Claude Code’s (and local models’, which run in it).');
    this.deps.ensureLoaded(wsId);
    this.loadVisuals(wsId, true);
    const launch = await this.deps.launch(channel, this.sink(wsId), prompt);
    try {
      const key = agentTermId(wsId);
      const startedAt = this.now;
      // A transcript already there (a resumed conversation): only what's added from now on is new.
      const existing = claudeTranscriptFile(ws.path, launch.session, launch.transcriptHome ?? this.deps.claudeConfigDir);
      const startAt = sizeOf(existing);
      const pty = this.deps.openProgram(key, ws, { file: launch.file, args: launch.args, env: launch.env, title: agent.label }, size);
      if (!pty) throw new Error('Beluga couldn’t start a terminal here.');
      const entry: Live = { wsId, key, launch, runtime: agent.runtime, cwd: ws.path, startedAt, pty, remembered: !launch.fresh, ...(prompt ? { handed: prompt } : {}), ...(existing ? { tail: new TranscriptTail(existing, startAt) } : {}) };
      this.live.set(wsId, entry);
      this.deps.store.dispatch({ type: 'agent_term', id: wsId, state: { runtime: agent.runtime, label: agent.label, since: startedAt } });
      pty.onExit(() => this.finish(wsId));
      const every = this.deps.pollMs ?? 700;
      if (every > 0) {
        entry.timer = setInterval(() => this.tick(wsId), every);
        entry.timer.unref();
      }
      return key;
    } catch (err) {
      launch.close();
      throw err;
    }
  }

  /** Give the conversation back to the chat: the terminal closes, and what it said is in the chat. */
  takeOver(wsId: string): void {
    const live = this.live.get(wsId);
    if (!live) return;
    this.sync(wsId);
    this.deps.closeTerminal(live.key);
    this.finish(wsId);
  }

  /** Close every terminal (Beluga is stopping). */
  closeAll(): void {
    for (const wsId of [...this.live.keys()]) this.takeOver(wsId);
  }

  /** The visual a terminal's link opens: its fenced block (shared/term-visuals.ts). */
  visual(wsId: string, n: number): string | undefined {
    return this.loadVisuals(wsId).items.find((v) => v.n === n)?.block;
  }

  /** One look: the terminal still there, and what's new in its transcript. */
  tick(wsId: string): void {
    const live = this.live.get(wsId);
    if (!live) return;
    // Closed some other way (archived, the window's ✕): the conversation is the chat's again.
    if (this.deps.pty(live.key) !== live.pty || !live.pty.running) return this.finish(wsId);
    this.sync(wsId);
  }

  /** Read what the terminal's agent wrote since the last look, into the chat. */
  sync(wsId: string): void {
    const live = this.live.get(wsId);
    if (!live) return;
    // A new conversation's transcript is there once something's said in it.
    if (!live.tail) {
      const file = claudeTranscriptFile(live.cwd, live.launch.session, live.launch.transcriptHome ?? this.deps.claudeConfigDir);
      if (file) live.tail = new TranscriptTail(file, 0);
    }
    if (!live.tail?.read()) return;
    // A conversation it started is the workspace's once something was said in it.
    if (!live.remembered) {
      live.remembered = true;
      this.deps.rememberSession(wsId, live.launch.session, live.runtime);
    }
    const self = this.deps.self();
    // A few seconds' slack: the transcript's clock is the agent's, ours is the daemon's (the same Mac).
    const opts = { selfId: self.id, selfName: self.name, cwd: live.cwd, key: `${live.startedAt.toString(36)}`, visual: (n: number) => this.visual(wsId, n), since: live.startedAt - 5_000 };
    const turns = claudeTurns(live.tail.lines, opts);
    const items = withoutHanded(turns.items, live.handed);
    if (!items.length) return;
    this.deps.keepSteps?.(turns.steps);
    this.deps.store.dispatch({ type: 'log_upsert', channel: `ws:${wsId}`, items });
  }

  private finish(wsId: string): void {
    const live = this.live.get(wsId);
    if (!live) return;
    this.sync(wsId);
    clearInterval(live.timer);
    this.live.delete(wsId);
    live.launch.close();
    this.deps.store.dispatch({ type: 'agent_term', id: wsId });
  }

  // ------------------------------------------------------------------ visuals

  private file(wsId: string): string {
    return path.join(this.deps.home ?? belugaHome(), 'terminal', 'visuals', `${wsId.replace(/[^\w.-]/g, '_')}.json`);
  }

  /** A workspace's kept visuals (read once); `announce` tells the screens about them. */
  private loadVisuals(wsId: string, announce = false): KeptVisuals {
    let kept = this.visuals.get(wsId);
    if (!kept) {
      kept = { next: 1, items: [] };
      try {
        const raw = JSON.parse(readFileSync(this.file(wsId), 'utf8')) as Partial<KeptVisuals>;
        const items = Array.isArray(raw.items) ? raw.items.filter((v): v is { n: number; block: string } => typeof v?.n === 'number' && typeof v.block === 'string') : [];
        kept = { next: Math.max(typeof raw.next === 'number' ? raw.next : 1, ...items.map((v) => v.n + 1)), items };
      } catch {
        // none yet
      }
      this.visuals.set(wsId, kept);
    }
    if (announce && kept.items.length) this.deps.store.dispatch({ type: 'term_visuals', id: wsId, visuals: kept.items.map((v) => describeVisual(v.n, v.block)), all: true });
    return kept;
  }

  /** Where the terminal's `show` keeps what it shows: kept on disk, so links in its scrollback still open after a restart. */
  private sink(wsId: string): TerminalSink {
    return {
      add: (block) => {
        const kept = this.loadVisuals(wsId);
        const n = kept.next++;
        kept.items = [...kept.items, { n, block }].slice(-MAX_TERM_VISUALS);
        this.save(wsId, kept);
        this.deps.store.dispatch({ type: 'term_visuals', id: wsId, visuals: [describeVisual(n, block)] });
        return n;
      },
    };
  }

  private save(wsId: string, kept: KeptVisuals): void {
    const file = this.file(wsId);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(kept), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {
      // the link still opens while Beluga runs (kept in memory)
    }
  }
}
