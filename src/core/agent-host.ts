import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { AgentBackend, BoardTools, FollowUp, LiveStatus, RunProcess, Steer } from '../agent/types.js';
import { type BodyInput, type BodyOf, MAX_TEXT } from '../protocol.js';
import type { People } from './people.js';
import type { QuestionBroker } from './questions.js';
import type { ShareService } from './shares.js';
import { type Store, peerName } from './store.js';
import { reachOf, trustOf } from './trust.js';
import type { WorkspaceController } from './workspace-controller.js';
import type { WorkspaceSharing } from './workspace-sharing.js';
import { StepBook, importedKey, runKey } from './step-book.js';
import { Compactor } from './compactor.js';
import { SCRATCH_DIR, ensureScratch } from '../workspaces/scratch.js';
import { isImportedItem } from '../agent/transcript.js';
import type { StepPage, StepRecord } from '../shared/steps.js';
import { STEERED_IN } from '../shared/claude-notices.js';

export interface AgentHostDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly send: (body: BodyInput, opts?: { to?: string; keep?: boolean }) => boolean;
  readonly agent?: () => AgentBackend | undefined;
  readonly shares: ShareService;
  readonly sharing: WorkspaceSharing;
  readonly people: People;
  readonly questions: QuestionBroker;
  readonly workspaces?: WorkspaceController;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  readonly system: (text: string, level?: 'info' | 'warn' | 'error') => void;
  readonly approvalTimeoutMs: () => number;
  readonly refreshUsage: () => Promise<void>;
  /** People invited by link to edit: their Claude edits files in that folder without asking (commands still ask). */
  readonly canEditIn?: (peerId: string, channel: string) => boolean;
  /** Your environment variables for a run there (see env-vars.ts). */
  readonly envFor?: (channel: string, dir?: string) => Record<string, string>;
  /** A short worktree name for a task (a small model names it). */
  readonly nameTask?: (prompt: string) => Promise<string>;
  /** Where the details of Claude's steps are kept (default: in memory only). */
  readonly steps?: StepBook;
  /** Guests invited into one project only (not the whole room). */
  readonly isGuest?: (peerId: string) => boolean;
  /** The task board for a run in this conversation (your own runs): its tools and the task's brief. */
  readonly board?: (channel: string, from: string, opts: { readonly plan: boolean }) => import('./board/work.js').RunBoard | undefined;
  /** A plan's home conversation (your own runs): its plan tools and what Claude is told about the plan (core/plans). */
  readonly plans?: (channel: string, from: string) => { readonly tools?: import('../agent/types.js').PlanTools; readonly brief?: string } | undefined;
}

/** File tools an Edit guest may use without asking, and the input naming their file. */
const GUEST_FILE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
  LS: ['path'],
};

/** The real location of `target`, or of its nearest existing parent (a file about to be written). */
function realOrParent(target: string): string {
  let dir = target;
  for (;;) {
    try {
      return path.join(realpathSync(dir), path.relative(dir, target));
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return target;
      dir = up;
    }
  }
}

/**
 * An Edit guest's tool call that may run without asking: a file tool whose file (after following
 * symlinks) is inside `cwd`. Shell commands, the web, room tools and everything else ask you:
 * a command can reach anywhere, whatever its arguments look like.
 */
export function toolInside(toolName: string, input: Record<string, unknown>, cwd: string): boolean {
  const fields = GUEST_FILE_TOOLS[toolName];
  if (!fields) return false;
  const root = realOrParent(path.resolve(cwd));
  const raw = fields.map((f) => input[f]).find((v) => typeof v === 'string' && v);
  if (typeof input.pattern === 'string' && /(^|\/)\.\.(\/|$)/.test(input.pattern)) return false;
  const target = realOrParent(path.resolve(cwd, typeof raw === 'string' ? raw : '.'));
  return target === root || target.startsWith(root + path.sep);
}

const MAX_PENDING_APPROVALS = 20;
const MAX_APPROVALS_PER_PERSON = 3;
const SEEN_REQUESTS = 1000;
const CONTEXT_LINES = 20;
/** Requests one person may have waiting for your Claude at once. */
const MAX_QUEUED_PER_PERSON = 10;

/** A message waiting in a conversation. `askTo`: who gets Claude's questions. `compact`: not a message but compacting the conversation (Compact now, /compact). */
interface Waiting {
  from: string;
  body: BodyOf<'agent_request'>;
  urgent?: boolean;
  askTo?: string;
  compact?: boolean;
}

/** The queue for one conversation (the room, or a workspace). */
interface Lane {
  readonly channel: string;
  waiting: Waiting[];
  pumping: boolean;
  current?: AbortController;
  interruptedBy?: string;
  /** Why the current run was stopped for a newer message, when there's more to say (see rush). */
  interruptNote?: string;
  /** Set while you stop the current run here (see stopRun), so it says who stopped it. */
  stopping?: boolean;
  /** Who started the current run. */
  runFrom?: string;
  /** Set while the run has answered but waits on background agents: messages go straight in. */
  followUps?: (followUp: FollowUp) => boolean;
  /** Set while a run of Claude's works here: your urgent messages steer it (see steer). */
  steer?: Steer;
  /** Set while a steer interrupts the current run: the next steer waits for it (see rush). */
  interrupting?: Promise<void>;
}

/** A tool running at least this long: a steer interrupts it instead of waiting for Claude's next step. */
const STEER_WAIT_MS = 20_000;
/** A run silent this long with no tool running (stuck in a step): a steer interrupts it. */
const STEER_QUIET_MS = 60_000;
/** A run silent this long with no tool running (and not thinking): dead; a steer starts a fresh turn instead. */
const DEAD_RUN_MS = 5 * 60_000;
/**
 * A stopped run that hasn't ended after this long has its Claude Code killed. Stopped for a newer
 * message (a steer or a dead run), it's then left behind so that message can start.
 */
const ABORT_GRACE_MS = 5_000;
/** Said when a run that wouldn't take an interrupt was stopped for your message. */
const STOPPED_FOR_YOU = 'Claude didn’t stop when asked, so its run was stopped for your message';

/** What Claude reads a steered message after, said on its card. */
export const READS_AFTER_STEP = 'Claude reads this after its current step';

/** "45s", "12m", "1h 5m". */
const span = (ms: number): string => {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/**
 * How a steer reaches Claude now, from what its run is doing: into the running turn when Claude
 * will soon be at its next step; interrupt the turn when a tool has run long (a test suite) or
 * the run went quiet; a fresh turn when the run looks dead. No status (an older backend): steer.
 */
export function planSteer(status: LiveStatus | undefined, now: number): { kind: 'steer' } | { kind: 'interrupt' | 'restart'; note: string } {
  if (!status) return { kind: 'steer' };
  if (status.alive === false) return { kind: 'restart', note: 'Claude’s run had ended without finishing: started over with your message' };
  if (status.between) return { kind: 'steer' };
  if (status.tool) {
    const ran = now - status.tool.since;
    return ran < STEER_WAIT_MS ? { kind: 'steer' } : { kind: 'interrupt', note: `Interrupted: ${status.tool.label} (${span(ran)}) to read your message` };
  }
  const quiet = now - status.lastEventAt;
  // Thinking is Claude at work (its process still runs): interrupted, never taken for dead.
  if (quiet >= DEAD_RUN_MS && !status.thinking) return { kind: 'restart', note: `Claude had gone quiet for ${span(quiet)}: stopped to start over with your message` };
  if (quiet >= STEER_QUIET_MS) return { kind: 'interrupt', note: `Interrupted: Claude was ${status.thinking ? 'thinking' : 'quiet'} for ${span(quiet)}; reading your message` };
  return { kind: 'steer' };
}

/** Conversations whose Claude may work at the same time (keeps your plan's limits in mind). */
const MAX_PARALLEL_RUNS = 4;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Your Claude serving requests (yours and other people's): who may use it, the queue, the
 * approvals you're asked for, running it in the right place with the right model, and
 * reporting what it does to everyone who should see it.
 */
export class AgentHost {
  /** Conversation the agent is currently working in (for its send_chat tool). */
  currentChannel = 'room';
  private readonly approvals = new Map<string, (answer: 'yes' | 'no' | 'always') => void>();
  private readonly alwaysTools = new Set<string>();
  /** "person:project" pairs you said Always to (this session). */
  private readonly alwaysProjects = new Set<string>();
  /**
   * One queue per conversation: each workspace's Claude works on its own, at the same time as
   * the others, while messages within one conversation run in order (urgent ones jump the line).
   */
  private readonly lanes = new Map<string, Lane>();
  private running = 0;
  /** Approvals waiting per person, so one person can't crowd out everyone else's. */
  private readonly approvalsBy = new Map<string, number>();
  private readonly seenRequests: string[] = [];
  /** Tool approvals waiting → the conversation whose run asked for them. */
  private readonly toolApprovals = new Map<string, string>();
  /** Waiting for a conversation's current run to end (see idle). */
  private readonly idleWaiters = new Map<string, Array<() => void>>();
  /** Final agent events that could not be sent while disconnected. */
  private outbox: Array<{ body: BodyInput; opts: { to?: string; keep?: boolean } }> = [];

  /** Every step of your Claude's runs in detail, for the screens on this computer (see step-book.ts). */
  readonly steps: StepBook;
  /** Compacting conversations, by hand or when they're nearly full (see compactor.ts). */
  private readonly compactor: Compactor;

  constructor(private readonly deps: AgentHostDeps) {
    this.steps = deps.steps ?? new StepBook();
    this.compactor = new Compactor({
      store: deps.store,
      agent: () => this.agent,
      place: (channel) => this.deps.workspaces?.place(channel),
      emit: (requestId, kind, text, channel) => this.emitAgent(requestId, this.selfId, kind, text, channel),
      requesterName: () => peerName(this.store.getState(), this.selfId),
      modelFor: (place) => this.modelFor(place?.model),
    });
  }

  /**
   * Compact a conversation: Claude summarizes what matters and continues from there (the chat
   * stays). Waits for Claude's current turn there to end first; once is enough when asked twice.
   */
  compact(channel: string, instructions = ''): void {
    if (!this.agent) return this.toast('No Claude is running on this computer', 'warn');
    const lane = this.lane(channel);
    if (lane.waiting.some((w) => w.compact)) return;
    const body: BodyOf<'agent_request'> = { kind: 'agent_request', requestId: `compact-${randomUUID()}`, prompt: instructions.slice(0, 2000), viaAgent: false, channel, urgent: false, plan: false };
    lane.waiting.push({ from: this.selfId, body, compact: true });
    if (lane.current) this.toast('Claude compacts this conversation when it finishes what it’s doing');
    void this.pump(lane);
  }

  /** A conversation starts over (its chat was cleared fresh): forget how full it was. */
  forgetContext(channel: string): void {
    this.compactor.forget(channel);
  }

  /** Compact in the conversation's queue, as its current run (so a new message waits for it). */
  private async runCompaction(lane: Lane, auto: boolean, instructions = ''): Promise<void> {
    const controller = new AbortController();
    lane.current = controller;
    lane.runFrom = this.selfId;
    try {
      await this.compactor.run(lane.channel, auto ? 'auto' : 'manual', controller.signal, instructions);
    } finally {
      if (lane.current === controller) {
        lane.current = undefined;
        lane.runFrom = undefined;
      }
      lane.stopping = undefined;
      lane.interruptedBy = undefined;
      if (!lane.current) this.wakeIdle(lane.channel);
    }
  }

  /** Nothing runs in this conversation any more: let whoever waited for that go on. */
  private wakeIdle(channel: string): void {
    const waiters = this.idleWaiters.get(channel) ?? [];
    this.idleWaiters.delete(channel);
    for (const resolve of waiters) resolve();
  }

  /**
   * The steps of a Claude card in a conversation, light. Only for your own Claude's work (runs
   * on this computer, or turns imported from your Claude Code transcripts): someone else's
   * Claude keeps its details on their computer.
   */
  stepsFor(channel: string, itemId: string, after?: number): StepPage {
    const key = this.stepKey(channel, itemId);
    return key ? this.steps.page(key, after) : { steps: [], version: 0, missing: true };
  }

  /** One step of a Claude card, with its input, output or thinking. */
  stepFor(channel: string, itemId: string, stepId: string): StepRecord | undefined {
    const key = this.stepKey(channel, itemId);
    return key ? this.steps.get(key, stepId) : undefined;
  }

  /** Keep the steps of turns imported from a Claude Code transcript (by session, then chat item). */
  keepImported(sessionId: string, steps: Readonly<Record<string, readonly StepRecord[]>>): void {
    for (const [itemId, records] of Object.entries(steps)) if (records.length) this.steps.putAll(importedKey(sessionId, itemId), records);
  }

  private stepKey(channel: string, itemId: string): string | undefined {
    const log = this.store.getState().log;
    const item = log.find((l) => l.id === itemId && l.channel === channel);
    if (!item || item.type !== 'agent' || item.owner !== this.selfId) return undefined;
    // A turn imported from Claude Code: the conversation's note says which transcript it came from.
    if (isImportedItem(item.id)) {
      const note = [...log].reverse().find((l) => l.channel === channel && l.id.startsWith('import-'));
      if (note) return importedKey(note.id.slice('import-'.length), item.id);
    }
    return runKey(item.requestId);
  }

  private get store(): Store {
    return this.deps.store;
  }

  private get selfId(): string {
    return this.deps.selfId();
  }

  private get agent(): AgentBackend | undefined {
    return this.deps.agent?.();
  }

  private get approvalTimeoutMs(): number {
    return this.deps.approvalTimeoutMs();
  }

  private send(body: BodyInput, opts: { to?: string; keep?: boolean } = {}): boolean {
    return this.deps.send(body, opts);
  }

  private toast(text: string, level?: 'info' | 'success' | 'warn' | 'error'): void {
    this.deps.toast(text, level);
  }

  private system(text: string, level?: 'info' | 'warn' | 'error'): void {
    this.deps.system(text, level);
  }

  /** Resolves once nothing runs in this conversation (right away when nothing does). */
  idle(channel: string): Promise<void> {
    if (!this.lanes.get(channel)?.current) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.set(channel, [...(this.idleWaiters.get(channel) ?? []), resolve]));
  }

  /**
   * Claude in a main folder (questions only) was asked for a change: carry the conversation into
   * a new worktree and go on there. Your own requests move right away (you asked for the change);
   * anyone else's ask you first. Returns what Claude is told.
   */
  private async moveToWorktree(from: string, requesterName: string, channel: string, task: string, finished: Promise<void>): Promise<string> {
    const ctl = this.deps.workspaces;
    const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
    if (!ctl || !id) return "Couldn't continue in a worktree from here. Tell the user to click Continue in a New Worktree.";
    if (from !== this.selfId) {
      const answer = await this.ask('request', `${requesterName}'s request wants to continue in a new worktree`, task, from, channel);
      if (answer === 'no') return 'The owner of this computer declined moving to a new worktree. Stay read-only here and say so.';
    }
    const ws = await ctl.continueInWorktree(id, (p) => this.deps.nameTask?.(p) ?? Promise.resolve('worktree'), { task, after: finished });
    if (!ws) return "Couldn't create the worktree (klaud showed the user why). Don't change anything here; tell the user briefly.";
    return `Done: the new worktree "${ws.name}" (branch ${ws.branch}, from ${ws.base}) has this conversation and the task continues there automatically. Do not do the work here; end your turn now with one short line.`;
  }

  /** Stop whatever is running (when klaud quits). */
  abort(): void {
    for (const lane of this.lanes.values()) lane.current?.abort();
  }

  private lane(channel: string): Lane {
    let lane = this.lanes.get(channel);
    if (!lane) {
      lane = { channel, waiting: [], pumping: false };
      this.lanes.set(channel, lane);
    }
    return lane;
  }

  /** Send the final results that couldn't go out while you were disconnected. */
  flushOutbox(): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const item of queued) this.send(item.body, item.opts);
  }

  /** Run your Claude for someone else in one of your workspaces (they were invited to work there). */
  runFor(from: string, channel: string, prompt: string, plan = false): void {
    const body: BodyOf<'agent_request'> = { kind: 'agent_request', requestId: randomUUID(), prompt: prompt.slice(0, MAX_TEXT), viaAgent: false, channel, urgent: false, plan };
    this.deps.questions.track(body.requestId, this.selfId, channel);
    void this.onAgentRequest(from, body);
  }

  /**
   * Run your Claude in one of your conversations with text that came from someone else (e.g. a
   * handoff note). Their trust level decides what it may do without asking you; its questions
   * come to you.
   */
  runOnBehalf(from: string, channel: string, prompt: string): void {
    const body: BodyOf<'agent_request'> = { kind: 'agent_request', requestId: randomUUID(), prompt: prompt.slice(0, MAX_TEXT), viaAgent: true, channel, urgent: false, plan: false };
    this.deps.questions.track(body.requestId, this.selfId, channel);
    if (trustOf(this.store.getState(), from) === 'blocked') return;
    this.enqueue(from, body, this.selfId);
  }

  answerApproval(answer: 'yes' | 'no' | 'always', id?: string): boolean {
    const target = id ?? this.store.getState().approvals[0]?.id;
    const resolve = target ? this.approvals.get(target) : undefined;
    if (!target || !resolve) return false;
    this.approvals.delete(target);
    this.store.dispatch({ type: 'approval_remove', id: target });
    resolve(answer);
    return true;
  }

  stopAgent(): void {
    const lanes = [...this.lanes.values()];
    if (!lanes.some((l) => l.current || l.waiting.length)) {
      this.toast('Your Claude is not running anything');
      return;
    }
    for (const id of [...this.toolApprovals.keys()]) this.answerApproval('no', id);
    this.deps.questions.cancelAll();
    for (const lane of lanes) {
      const cancelled = lane.waiting;
      lane.waiting = [];
      lane.current?.abort();
      for (const { from, body, compact } of cancelled) if (!compact) this.emitAgent(body.requestId, from, 'error', 'Cancelled by owner', body.channel);
    }
    this.toast('Stopping your Claude everywhere (queued requests cancelled)', 'warn');
  }

  /**
   * Stop your Claude in one conversation only. Its current run there stops (whoever asked for
   * it), and that run's waiting tool approvals are denied and its questions skipped. Your own
   * messages still waiting there come out of the queue: their prompts are returned in queue order
   * so the screen can put them back in the message box (Claude goes quiet, nothing typed is lost).
   * Other people's requests there keep their places and run next; other conversations carry on.
   */
  stopRun(channel: string): { stopped: boolean; returned: string[] } {
    const lane = this.lanes.get(channel);
    const mine = lane?.waiting.filter((w) => w.from === this.selfId) ?? [];
    if (!lane || (!lane.current && !mine.length)) {
      const busy = [...this.lanes.values()].some((l) => l.current || l.waiting.length);
      this.toast(busy ? "Your Claude isn't working here" : 'Your Claude is not running anything');
      return { stopped: false, returned: [] };
    }
    for (const [id, at] of [...this.toolApprovals]) if (at === channel) this.answerApproval('no', id);
    this.deps.questions.cancelChannel(channel);
    lane.waiting = lane.waiting.filter((w) => w.from !== this.selfId);
    for (const { from, body, compact } of mine) if (!compact) this.emitAgent(body.requestId, from, 'error', 'Taken out of the queue when you stopped Claude', body.channel);
    if (lane.current) {
      lane.stopping = true;
      lane.current.abort();
    }
    const n = mine.filter((w) => !w.compact).length;
    const back = n ? ` · ${n} queued message${n === 1 ? '' : 's'} back in the box` : '';
    this.toast(`Stopped your Claude here${back}`, 'success');
    return { stopped: true, returned: mine.filter((w) => !w.compact).map((w) => w.body.prompt) };
  }

  /**
   * Send one of your waiting requests now (Steer): it always does something you can see (see
   * rush). False, with a toast saying why, when it isn't yours or isn't waiting any more.
   */
  promote(requestId: string): boolean {
    for (const lane of this.lanes.values()) {
      const i = lane.waiting.findIndex((w) => w.body.requestId === requestId);
      if (i < 0) continue;
      if (lane.waiting[i]!.from !== this.selfId) {
        this.toast("Only the person who sent a message can steer it", 'warn');
        return false;
      }
      const [item] = lane.waiting.splice(i, 1);
      this.rush(lane, item!, true);
      return true;
    }
    this.toast('That message isn’t waiting any more', 'warn');
    return false;
  }

  /**
   * Your message, now (a queued one you steer, or one sent with ⌥↩). Claude about to be at its
   * next step: it goes into the running turn. A tool running long or Claude gone quiet: the turn
   * is interrupted and the message answered next, at once. No run to steer, or a dead one: the
   * message goes first in line and the current run stops, so a fresh turn starts with it. The
   * card says which; nothing is lost when a step fails (it goes back in line).
   */
  private rush(lane: Lane, item: Waiting, queued: boolean): void {
    // Another steer is interrupting the run: this one goes after it, so they're answered in the order you sent them.
    if (lane.interrupting) {
      void lane.interrupting.then(() => this.rush(lane, item, queued));
      return;
    }
    const { from, body } = item;
    const live = lane.current && !lane.current.signal.aborted;
    const steer = live && lane.steer && lane.runFrom === from && !body.plan && !body.project && !item.compact ? lane.steer : undefined;
    const plan = steer ? planSteer(steer.status?.(), Date.now()) : undefined;
    const emit = (event: BodyOf<'agent_event'>['event'], text = ''): void => this.emitAgent(body.requestId, from, event, text, body.channel);
    if (steer && plan?.kind === 'steer' && steer(this.followUp(lane, item, queued))) {
      // Shown at once: a queued card says so (and leaves the queue); a new message, a toast.
      if (queued) emit('text', READS_AFTER_STEP);
      else this.toast(READS_AFTER_STEP);
      return;
    }
    if (steer?.interrupt && plan?.kind === 'interrupt') {
      const run = lane.current;
      const followUp = this.followUp(lane, item, true);
      emit('started');
      const interrupting: Promise<void> = steer
        .interrupt(followUp, plan.note)
        .catch(() => false)
        .then((ok) => {
          if (lane.interrupting === interrupting) lane.interrupting = undefined;
          if (ok) return;
          // Claude answered meanwhile and waits between turns: the message starts its turn now.
          if (lane.current === run && steer.status?.().between && steer(followUp)) return;
          // Still mid-turn: stopped for it (and said so). Ended already: it just goes first.
          this.jump(lane, item, run && lane.current === run && !run.signal.aborted ? STOPPED_FOR_YOU : undefined, run);
        });
      lane.interrupting = interrupting;
      return;
    }
    this.jump(lane, item, plan?.kind === 'restart' ? plan.note : undefined, lane.current);
  }

  /**
   * First in line (after your other urgent messages), with `run` (the conversation's current run)
   * stopped so it starts at once, continuing the same conversation.
   */
  private jump(lane: Lane, item: Waiting, note: string | undefined, run: AbortController | undefined): void {
    const at = lane.waiting.findIndex((w) => !w.urgent);
    lane.waiting.splice(at === -1 ? lane.waiting.length : at, 0, { ...item, urgent: true });
    // Back in line: its card says so (it may have said started).
    if (!item.compact) this.emitAgent(item.body.requestId, item.from, 'queued', item.body.prompt, item.body.channel);
    if (run && lane.current === run && !run.signal.aborted) {
      lane.interruptedBy = item.body.requestId;
      lane.interruptNote = note;
      run.abort();
    }
    if (note) this.toast(note, 'warn');
    void this.pump(lane);
  }
  /**
   * Move one of your waiting requests to `index` among your others in its conversation (friends'
   * requests keep their places). The log follows, so every screen shows the new order.
   */
  reorderQueued(requestId: string, index: number): boolean {
    for (const lane of this.lanes.values()) {
      const isMine = (w: Lane['waiting'][number]): boolean => w.from === this.selfId && !w.urgent && !w.compact;
      const mine = lane.waiting.filter(isMine);
      const from = mine.findIndex((w) => w.body.requestId === requestId);
      if (from < 0) continue;
      const to = Math.max(0, Math.min(index, mine.length - 1));
      const moved = mine.filter((_, i) => i !== from);
      const order = [...moved.slice(0, to), mine[from]!, ...moved.slice(to)];
      let k = 0;
      lane.waiting = lane.waiting.map((w) => (isMine(w) ? order[k++]! : w));
      this.store.dispatch({ type: 'queue_order', owner: this.selfId, ids: order.map((w) => w.body.requestId) });
      return true;
    }
    return false;
  }

  /** Drop one of your waiting requests before it starts. */
  cancelQueued(requestId: string): boolean {
    for (const lane of this.lanes.values()) {
      const i = lane.waiting.findIndex((w) => w.body.requestId === requestId && w.from === this.selfId);
      if (i < 0) continue;
      const [item] = lane.waiting.splice(i, 1);
      this.emitAgent(requestId, item!.from, 'error', 'Cancelled before it started', item!.body.channel);
      return true;
    }
    return false;
  }

  private emitAgent(requestId: string, requester: string, event: BodyOf<'agent_event'>['event'], text = '', channel = 'room'): void {
    const final = event === 'done' || event === 'error' || event === 'denied';
    const body: BodyInput = { kind: 'agent_event', requestId, requester, event, text: text.slice(0, 60_000), channel };
    // Workspace conversations are private: events go to you and the people you invited, never to the room.
    const targets = channel === 'room' ? [{ keep: final }] : [this.selfId, ...this.deps.sharing.recipients(channel)].map((to) => ({ to }));
    for (const opts of targets) if (!this.send(body, opts) && final) this.outbox = [...this.outbox, { body, opts }].slice(-50);
  }

  async onAgentRequest(from: string, body: BodyOf<'agent_request'>): Promise<void> {
    // Drop replays of a request we've already seen.
    const key = `${from}:${body.requestId}`;
    if (this.seenRequests.includes(key)) return;
    this.seenRequests.push(key);
    if (this.seenRequests.length > SEEN_REQUESTS) this.seenRequests.shift();
    if (!this.agent) {
      this.emitAgent(body.requestId, from, 'denied', 'No agent is running on this machine.', body.channel);
      return;
    }
    if (body.project && body.channel === 'room' && !this.projectRoot(body.project)) {
      this.emitAgent(body.requestId, from, 'denied', `There is no project called ${body.project} on this computer.`, body.channel);
      return;
    }
    const inWorkspace = body.channel !== 'room' && from !== this.selfId;
    if (inWorkspace && (this.deps.sharing.sharedFor(body.channel) || !this.deps.sharing.canPost(from, body.channel))) {
      this.emitAgent(body.requestId, from, 'denied', "That workspace isn't shared with you.", body.channel);
      return;
    }
    // Inviting someone to contribute to a workspace is your yes to their requests there
    // (each risky step still asks you, unless you fully trust them).
    const allowed = inWorkspace ? this.store.getState().policy !== 'deny' : await this.authorizeRequest(from, body);
    if (!allowed) {
      this.emitAgent(body.requestId, from, 'denied', 'Request declined by the machine owner.', body.channel);
      return;
    }
    this.enqueue(from, body);
  }

  /**
   * Queue a request. Normal requests wait their turn (and say so); urgent ones from you reach
   * Claude now (see rush).
   */
  private enqueue(from: string, body: BodyOf<'agent_request'>, askTo?: string): void {
    const lane = this.lane(body.channel);
    if (this.sendFollowUp(lane, from, body)) return;
    const urgent = body.urgent && from === this.selfId;
    if (urgent) return this.rush(lane, { from, body }, false);
    const queued = [...this.lanes.values()].reduce((n, l) => n + l.waiting.filter((w) => w.from === from).length, 0);
    if (queued >= MAX_QUEUED_PER_PERSON) {
      this.emitAgent(body.requestId, from, 'denied', 'Too many requests waiting; try again when the current ones finish.', body.channel);
      return;
    }
    lane.waiting.push({ from, body, ...(askTo ? { askTo } : {}) });
    // The prompt goes with it, so the queue can show (and you can edit) what's waiting.
    if (lane.current || lane.waiting.length > 1) this.emitAgent(body.requestId, from, 'queued', body.prompt, body.channel);
    void this.pump(lane);
  }

  /**
   * While the current run only waits on its background agents, send a message from the same
   * person straight into it instead of queueing behind it (or interrupting and killing them).
   * Someone else's message still queues: approvals in that run are judged for its requester.
   */
  private sendFollowUp(lane: Lane, from: string, body: BodyOf<'agent_request'>): boolean {
    // A request for one of your projects runs in that project's folder, so it never joins a run elsewhere.
    if (!lane.followUps || lane.runFrom !== from || body.plan || body.project) return false;
    const emit = (event: BodyOf<'agent_event'>['event'], text = ''): void => this.emitAgent(body.requestId, from, event, text, body.channel);
    const sent = lane.followUps({
      prompt: body.prompt,
      requesterName: peerName(this.store.getState(), from),
      viaAgent: body.viaAgent,
      context: this.recentChat(body.channel),
      onEvent: (kind, text) => emit(kind, text),
      onStep: (record) => this.steps.put(runKey(body.requestId), record),
      // Sent close behind another, Claude Code may answer both in one turn.
      onFolded: () => emit('done', STEERED_IN),
      onDone: (final) => {
        this.steps.flush(runKey(body.requestId));
        emit('done', final || '(done)');
      },
      onError: (reason) => emit('error', reason),
    });
    if (sent) emit('started');
    return sent;
  }

  /**
   * A message of yours steered into the run working in this conversation (see rush). Taken in
   * mid-turn, it gets no card of its own (the turn's answer covers it; a card it already had as
   * a queued message says so); else it's answered in a turn of its own. Only your own messages
   * into your own run: approvals are judged for its requester.
   */
  private followUp(lane: Lane, item: Waiting, queued: boolean): FollowUp {
    const { from, body } = item;
    const emit = (event: BodyOf<'agent_event'>['event'], text = ''): void => this.emitAgent(body.requestId, from, event, text, body.channel);
    let read = false;
    return {
      prompt: body.prompt,
      requesterName: peerName(this.store.getState(), from),
      viaAgent: body.viaAgent,
      // The conversation is the run's own: what's said in the chat it has already.
      context: [],
      onEvent: (kind, text) => {
        read = true;
        emit(kind, text);
      },
      onStep: (record) => this.steps.put(runKey(body.requestId), record),
      onStart: () => {
        read = true;
        emit('started');
      },
      onFolded: () => {
        read = true;
        if (queued) emit('done', STEERED_IN);
      },
      onDone: (final) => {
        this.steps.flush(runKey(body.requestId));
        emit('done', final || '(done)');
      },
      onError: (reason) => {
        // The run ended before Claude read it (and you didn't stop it): it goes back in line, first.
        if (read || lane.stopping) return emit('error', reason);
        this.jump(lane, item, 'Claude’s run ended before it read your message: it runs next', undefined);
      },
    };
  }

  private async pump(lane: Lane): Promise<void> {
    if (lane.pumping) return;
    lane.pumping = true;
    try {
      // Nearly full (after the last run, or before the next message): compact first, between turns.
      for (;;) {
        const auto = this.compactor.due(lane.channel);
        const next = auto ? undefined : lane.waiting.shift();
        if (!auto && !next) break;
        while (this.running >= MAX_PARALLEL_RUNS) await new Promise((r) => setTimeout(r, 200));
        this.running++;
        try {
          if (!next || next.compact) await this.runCompaction(lane, auto, next?.body.prompt);
          else await this.runAgent(next.from, next.body, lane, next.askTo).catch((err: unknown) => this.system(`Agent run failed: ${errorText(err)}`, 'error'));
        } finally {
          this.running--;
        }
      }
    } finally {
      lane.pumping = false;
    }
  }

  /** The main folder of one of your projects, by name. */
  private projectRoot(name: string): string | undefined {
    return this.deps.workspaces?.manager.list.find((p) => p.root && p.name === name)?.root;
  }

  private async authorizeRequest(from: string, body: BodyOf<'agent_request'>): Promise<boolean> {
    if (from === this.selfId) return true;
    const state = this.store.getState();
    const level = trustOf(state, from);
    if (level === 'blocked') return false;
    const name = peerName(state, from);
    // A project isn't a shared folder: working in one asks you unless you fully trust them.
    if (body.project && body.channel === 'room') {
      const scope = `${from}:${body.project}`;
      if (level === 'full' || this.alwaysProjects.has(scope)) return true;
      this.emitAgent(body.requestId, from, 'awaiting_approval', `Waiting for ${state.self?.name ?? 'owner'} to approve`, body.channel);
      const answer = await this.ask('request', `${name}${body.viaAgent ? "'s Claude" : ''} wants your Claude to work in ${body.project} (Always: for ${body.project}, until klaud quits)`, body.prompt, from);
      if (answer === 'always') this.alwaysProjects.add(scope);
      return answer !== 'no';
    }
    if (level === 'trusted' || level === 'full') return true;
    this.emitAgent(body.requestId, from, 'awaiting_approval', `Waiting for ${state.self?.name ?? 'owner'} to approve`, body.channel);
    const reach = reachOf(state, from) === 'full' ? 'whole computer' : 'shared folders; anything else asks you';
    const answer = await this.ask('request', `${name}${body.viaAgent ? "'s Claude" : ''} wants your Claude to run this (${reach})`, body.prompt, from, body.channel);
    if (answer === 'always') this.deps.people.setTrust(from, 'trusted');
    return answer !== 'no';
  }

  /** Ask you to approve something; `peer` is who it's for (each person can have a few waiting at most). */
  ask(kind: 'request' | 'tool', title: string, detail: string, peer?: string, channel = 'room', meta: { task?: string } = {}): Promise<'yes' | 'no' | 'always'> {
    if (this.approvals.size >= MAX_PENDING_APPROVALS) return Promise.resolve('no');
    if (peer && peer !== this.selfId && (this.approvalsBy.get(peer) ?? 0) >= MAX_APPROVALS_PER_PERSON) return Promise.resolve('no');
    if (peer) this.approvalsBy.set(peer, (this.approvalsBy.get(peer) ?? 0) + 1);
    const id = randomUUID();
    if (kind === 'tool') this.toolApprovals.set(id, channel);
    return new Promise((resolve) => {
      // Nobody should be stuck waiting forever on an approval you didn't see.
      const expiry = setTimeout(() => {
        if (this.answerApproval('no', id)) this.toast(`An approval expired after ${Math.round(this.approvalTimeoutMs / 60_000)} min without an answer`, 'warn');
      }, this.approvalTimeoutMs);
      expiry.unref();
      this.approvals.set(id, (answer) => {
        clearTimeout(expiry);
        this.toolApprovals.delete(id);
        if (peer) this.approvalsBy.set(peer, Math.max(0, (this.approvalsBy.get(peer) ?? 1) - 1));
        resolve(answer);
      });
      this.store.dispatch({ type: 'approval_add', approval: { id, kind, title, detail, askedAt: Date.now(), timeoutMs: this.approvalTimeoutMs, ...(peer && peer !== this.selfId ? { peer } : {}), ...(meta.task ? { task: meta.task } : {}), ...(channel.startsWith('ws:') ? { channel } : {}) } });
    });
  }

  private async runAgent(from: string, body: BodyOf<'agent_request'>, lane: Lane, askTo = from): Promise<void> {
    const agent = this.agent as AgentBackend;
    const controller = new AbortController();
    lane.current = controller;
    lane.runFrom = from;
    const requesterName = peerName(this.store.getState(), from);
    const root = body.project && body.channel === 'room' ? this.projectRoot(body.project) : undefined;
    // A friend's request in your project gets a fresh conversation in its main folder: questions only.
    const place = root ? { cwd: root, additionalDirectories: [], autoEdit: false, onSession: () => undefined, askOnly: { project: body.project ?? '' } } : this.deps.workspaces?.place(body.channel);
    let markFinished: () => void = () => undefined;
    /** Claude Code's process for this run (see gone), and whether the run is over. */
    let proc: RunProcess | undefined;
    let ended = false;
    const finished = new Promise<void>((resolve) => (markFinished = resolve));
    // In a main folder, a change request carries the conversation into a new worktree.
    const move = place?.askOnly && !place.syncMain && body.channel !== 'room' ? (task: string) => this.moveToWorktree(from, requesterName, body.channel, task, finished) : undefined;
    if (body.channel !== 'room' && !place) {
      this.emitAgent(body.requestId, from, 'error', 'That workspace is archived or missing.', body.channel);
      if (lane.current === controller) lane.current = undefined;
      return;
    }
    this.currentChannel = body.channel;
    this.emitAgent(body.requestId, from, 'started', '', body.channel);
    try {
      // A workspace (not a main folder, where nothing may change) gets its scratch folder.
      const scratch = place && !place.askOnly && this.store.getState().prefs.scratchFolder && (await ensureScratch(place.cwd)) ? SCRATCH_DIR : undefined;
      // A plan's home conversation (a main folder's chat, often): the plan's tools.
      const plans = from !== this.selfId || place?.syncMain ? undefined : this.deps.plans?.(body.channel, from);
      // Not for guests, nor in a main folder (questions only) unless planning there: a run doing a task gets it, and the tools to keep it true.
      // (In a plan's conversation, planning is the plan's: no single task to define.)
      const planFirst = body.plan && !plans?.tools;
      const board = (place?.askOnly && (!planFirst || place.syncMain)) || from !== this.selfId ? undefined : this.deps.board?.(body.channel, from, { plan: planFirst });
      // A run stopped but not ending (wedged) has its Claude Code killed after a moment (at once
      // when it's gone already). Stopped for a newer message, it's then left behind so that message
      // starts: never while its Claude Code could still work in this folder.
      const gone = new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => {
            const leave = lane.interruptedBy !== undefined;
            const timer = setTimeout(() => {
              if (ended) return;
              void (proc?.kill() ?? Promise.resolve()).then(() => leave && !ended && reject(new Error('aborted')));
            }, proc && !proc.alive() ? 0 : ABORT_GRACE_MS);
            timer.unref();
          },
          { once: true },
        ),
      );
      gone.catch(() => undefined);
      const final = await Promise.race([gone, agent.run({
        ...(scratch ? { scratchDir: scratch } : {}),
        ...(board?.tools ? { board: board.tools } : {}),
        ...(board?.brief ? { taskBrief: board.brief } : {}),
        ...(board?.needsDefinition && board.planApproved ? { planTask: { needsDefinition: board.needsDefinition, approved: board.planApproved } } : {}),
        ...(plans?.tools ? { planTools: plans.tools } : {}),
        ...(plans?.brief ? { planBrief: plans.brief } : {}),
        prompt: body.prompt,
        requesterName,
        viaAgent: body.viaAgent,
        context: this.recentChat(body.channel),
        ...(place ? { place } : {}),
        scope: from === this.selfId ? 'full' : reachOf(this.store.getState(), from),
        ...(from !== this.selfId && this.deps.isGuest?.(from) ? { guest: true } : {}),
        signal: controller.signal,
        onEvent: (kind, text) => {
          this.compactor.observe(body.channel, kind, text);
          this.emitAgent(body.requestId, from, kind, text, body.channel);
        },
        onStep: (record) => this.steps.put(runKey(body.requestId), record),
        // Another Claude asked: give it the answer now rather than after every background agent.
        ...(body.viaAgent && from !== this.selfId ? { onAnswered: (text: string) => this.emitAgent(body.requestId, from, 'answered', text, body.channel) } : {}),
        onFileTouched: (abs) => this.announceAgentFocus(abs),
        canUseTool: (toolName, input) => this.authorizeTool(from, requesterName, toolName, input, body.channel, place?.cwd),
        askUser: (question) => this.deps.questions.ask(askTo, body.requestId, body.channel, question),
        plan: body.plan,
        // A plan's conversation plans; it doesn't move to a worktree.
        ...(move && !plans?.tools ? { continueInWorktree: move } : {}),
        onProcess: (p) => void (proc = p),
        onSteer: (steer) => {
          if (lane.current === controller) lane.steer = steer;
        },
        onFollowUps: (send) => {
          if (lane.current !== controller) return;
          lane.followUps = send;
          // Anything that queued up behind this run from the same person can go in now.
          if (send) lane.waiting = lane.waiting.filter((w) => !this.sendFollowUp(lane, w.from, w.body));
        },
        ...this.modelFor(place?.model),
        // Your variables can hold secrets: only runs you asked for get them, never a friend's.
        ...(from === this.selfId && this.deps.envFor ? { env: this.deps.envFor(body.channel, place?.cwd) } : {}),
        ...this.compactor.threshold(),
      })]);
      if (controller.signal.aborted) throw new Error('aborted');
      this.emitAgent(body.requestId, from, 'done', final || '(done)', body.channel);
    } catch (err) {
      const stopped = lane.stopping ? (from === this.selfId ? 'Stopped by you' : 'Stopped by owner') : undefined;
      const reason = stopped ?? (lane.interruptedBy ? (lane.interruptNote ?? 'Interrupted by a newer message') : controller.signal.aborted ? 'Stopped by owner' : errorText(err));
      lane.interruptedBy = undefined;
      lane.interruptNote = undefined;
      lane.stopping = undefined;
      this.emitAgent(body.requestId, from, 'error', reason, body.channel);
    } finally {
      ended = true;
      if (lane.current === controller) {
        lane.current = undefined;
        lane.followUps = undefined;
        lane.steer = undefined;
        lane.runFrom = undefined;
      }
      lane.interruptedBy = undefined; // never carry an interrupt label into the next run
      lane.interruptNote = undefined;
      lane.stopping = undefined;
      markFinished();
      this.compactor.ran(body.channel);
      this.steps.flush(runKey(body.requestId));
      if (!lane.current) this.wakeIdle(body.channel);
      void this.deps.refreshUsage();
      if (body.channel !== 'room') void this.deps.workspaces?.refresh();
    }
  }

  /** The model and effort for a run: the conversation's own pick, else your defaults. */
  private modelFor(own: string | undefined): { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } {
    const prefs = this.store.getState().prefs;
    const model = own ?? prefs.model;
    return { ...(model ? { model } : {}), ...(prefs.effort ? { effort: prefs.effort } : {}) };
  }

  private async authorizeTool(requester: string, requesterName: string, toolName: string, input: Record<string, unknown>, channel = 'room', cwd?: string): Promise<boolean> {
    // Your own Claude doesn't nag you (unless you asked it to); fully trusted friends don't either.
    const state = this.store.getState();
    if (requester === this.selfId && state.prefs.selfApproval === 'never') return true;
    if (requester !== this.selfId && trustOf(state, requester) === 'full') return true;
    // Invited by link to edit this project: as if you prompted, inside its folder (secrets were already refused).
    if (cwd && requester !== this.selfId && this.deps.canEditIn?.(requester, channel) && toolInside(toolName, input, cwd)) return true;
    // "Always" is scoped to one requester and one tool, never global.
    const scope = `${requester}:${toolName}`;
    if (this.alwaysTools.has(scope)) return true;
    const detail = typeof input.command === 'string' ? input.command : JSON.stringify(input);
    const answer = await this.ask('tool', `Your Claude (working for ${requesterName}) wants to use ${toolName}`, detail, requester, channel);
    if (answer === 'always') this.alwaysTools.add(scope);
    return answer !== 'no';
  }

  private announceAgentFocus(absPath: string): void {
    const hit = this.deps.shares.locate(absPath);
    if (hit) this.send({ kind: 'focus', owner: this.selfId, share: hit.share, path: hit.path, actor: 'agent' }, this.deps.shares.isPrivate(hit.share) ? { to: this.selfId } : {});
  }

  private recentChat(channel = 'room'): string[] {
    const state = this.store.getState();
    return state.log
      .filter((l) => l.type === 'chat' && l.channel === channel)
      .slice(-CONTEXT_LINES)
      .map((l) => (l.type === 'chat' ? `${l.name}: ${l.text}`.slice(0, 1000) : ''));
  }
}
