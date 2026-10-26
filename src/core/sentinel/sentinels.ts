import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import type { SentinelTools } from '../../agent/types.js';
import type { NoticeEvent } from '../notify.js';
import type { Action, Store } from '../store.js';
import { filterIssues, isOpen } from '../board/model.js';
import { describeList } from '../board/prompt.js';
import { planTitle } from '../plans/model.js';
import { dueNow, nextRunAt } from './clock.js';
import { RunFolders, SentinelFile, pruneRuns } from './files.js';
import {
  APPROVAL_MS,
  CLAUDE_CHANGED,
  DEFAULT_LIMITS,
  KEEP_IN_STATE,
  MAX_RUN_AT_ONCE,
  type Limits,
  type Recipe,
  type Run,
  type RunBy,
  type RunDetail,
  type RunSummary,
  type RunTrigger,
  type Sentinel,
  type SentinelAsk,
  type SentinelDraft,
  type SentinelPatch,
  type SentinelState,
  type Step,
  type WebhookAddress,
  type WebhookState,
  type StepDraft,
  STEP_INFO,
  accessAllows,
  accessNeeded,
  ACCESS_INFO,
  capPayload,
  claudeWidened,
  firstLine,
  isLive,
  keepRuns,
  lastRunOf,
  scheduleSentence,
  sentinelLabel,
  toSummary,
} from './model.js';
import { redactSecrets } from '../../shared/steps.js';
import { describeSentinels, sentinelAskBrief, sentinelMaterial, sentinelNote } from './prompt.js';
import { RECIPES } from './recipes.js';
import { type ActiveRun, OUTPUT_KEPT, type SentinelChat, type SentinelClaude, type SentinelFriends, type SentinelGitHub, type SentinelPlaces, type SentinelShell, SentinelRunner, type YourAnswer, mergePinned, runSentinelShell } from './runner.js';
import { StepInputSchema } from './schema.js';
import type { ToolDraft, ToolPatch, ToolStep } from './tool-draft.js';
import { Triggers, isEventTrigger } from './triggers/index.js';
import type { TriggerDeps, TriggerEvent } from './triggers/types.js';
import { newSecret } from './triggers/webhook.js';

/**
 * Sentinels (docs/sentinel.md): the sentinels and their runs, kept in ~/.beluga/sentinel.json and
 * mirrored into the state; the clock that starts what's due; the queue (one run per sentinel at a
 * time, at most Run at Once Claude steps together); limits (time, runs per day, pausing after
 * failures); and Claude's tools. Yours only: friends' runs never see any of it.
 */

export interface SentinelsDeps {
  readonly store: Store;
  /** Where sentinel.json and the runs' folders live (~/.beluga); null: memory only. */
  readonly dir: string | null;
  readonly now?: () => number;
  readonly selfId: () => string;
  readonly claude?: SentinelClaude;
  readonly places?: SentinelPlaces;
  readonly shell?: SentinelShell;
  readonly envFor?: (cwd: string) => Record<string, string>;
  readonly notify: (e: NoticeEvent) => void;
  readonly home?: string;
  /** The schedules' time zone (none: the Mac's). */
  readonly tz?: string;
  /** How often the clock looks (30 s; 0: only when asked, the tests). */
  readonly tickMs?: number;
  /** The first look after start (10 s). */
  readonly firstTickMs?: number;
  readonly saveDelayMs?: number;
  /** How long a cancelled Claude request may take to end before its worktree is looked at (10 s). */
  readonly cancelGraceMs?: number;
  readonly fetch?: typeof fetch;
  readonly github?: SentinelGitHub;
  readonly chat?: SentinelChat;
  readonly friends?: SentinelFriends;
  /** How often pending checks are looked at again (15 s). */
  readonly pollMs?: number;
  /** How long a merge waits for your Merge (24 hours). */
  readonly approvalMs?: number;
  /**
   * The event triggers' sources (gh, fetch, Stripe keys, your variables, the tunnel). Without
   * them no event trigger watches (the tests that don't test them, a CLI without the app).
   */
  readonly triggers?: Omit<TriggerDeps, 'store' | 'selfId'>;
}

const TICK_MS = 30_000;
/** A chain of sentinels running each other (after, Run another sentinel) stops this long. */
const MAX_CHAIN = 8;
const FIRST_TICK_MS = 10_000;
/** A run over its runs per day says this. */
const OVER_DAY = 'Over its runs per day';
const MAX_SENTINELS = 200;
/** The runs that count toward runs per day. */
const COUNTS_PER_DAY: ReadonlySet<Run['state']> = new Set(['running', 'done', 'failed', 'stopped']);

const short = (prefix: string, bytes = 6): string => `${prefix}_${randomBytes(bytes).toString('hex')}`;
const startOfDay = (at: number): number => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export interface RunSentinel {
  readonly tools: SentinelTools;
  readonly brief: string;
  /** This conversation is a sentinel run's Claude step (it gets the task tools, even in a main folder). */
  readonly inRun: boolean;
}

export class Sentinels {
  private items: Sentinel[] = [];
  /** The index, oldest first. */
  private runs: RunSummary[] = [];
  private runAtOnce: number;
  private readonly file: SentinelFile;
  readonly folders: RunFolders;
  private readonly runner: SentinelRunner;
  private readonly now: () => number;
  /** Runs going now, by sentinel. */
  private readonly active = new Map<string, ActiveRun>();
  /** A run waiting for its sentinel's run to end (one at most), by sentinel. */
  private readonly queued = new Map<string, RunSummary & { readonly payload?: unknown }>();
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly offs: Array<() => void> = [];
  private lastTick: number | undefined;
  private closed = false;
  /** Events that came while a run went and another waited: the history's note of them, by sentinel. */
  private readonly extra = new Map<string, { readonly runId: string; readonly n: number }>();
  /** Conversations where your Claude changes a sentinel (sentinel.ask), and which. */
  private readonly askChannels = new Map<string, string>();
  private asks: Record<string, SentinelAsk> = {};
  /** Sentinels whose ask is being set up (before its state says writing): a second one waits. */
  private readonly asking = new Set<string>();
  /** Runs Beluga was closed under that are being merged now (decide): one Merge at a time. */
  private readonly deciding = new Set<string>();
  /** What each event sentinel saw last (kept in the file). */
  private cursors: Record<string, unknown>;
  /** Webhook sentinels' secrets (in the file only, never in the state). */
  private secrets: Record<string, string>;
  /** The secrets GitHub signs their posts with (Copy Secret), apart from the URL's (in the file only). */
  private signingSecrets: Record<string, string>;
  private troubles: Record<string, string> = {};
  private webhook: WebhookState = { ready: false };
  private readonly triggers: Triggers | undefined;

  constructor(private readonly deps: SentinelsDeps) {
    this.now = deps.now ?? Date.now;
    this.file = new SentinelFile(deps.dir, this.now, deps.saveDelayMs ?? 300);
    this.folders = new RunFolders(deps.dir);
    const data = this.file.load();
    this.runAtOnce = data.runAtOnce;
    this.cursors = { ...data.cursors };
    this.secrets = { ...data.secrets };
    this.signingSecrets = { ...data.signingSecrets };
    const at = this.now();
    this.items = data.items.map((s) => (!s.paused && s.trigger.kind === 'schedule' && s.lastScheduledAt === undefined ? { ...s, lastScheduledAt: at } : s));
    // Runs that were going (or waiting their turn) when Beluga closed or crashed ended there; one
    // that waits for you (a merge) still does.
    this.runs = data.runs.map((r) => (r.state === 'running' || r.state === 'queued' ? { ...r, state: 'failed', why: 'Beluga closed while it ran', headline: 'Beluga closed while it ran', endedAt: r.endedAt ?? at, steps: r.steps.map((s) => (s.state === 'running' || s.state === 'waiting' ? { ...s, state: 'skipped' as const } : s)) } : r));
    // A load that lost something (the file set aside, sentinels or runs that didn't read) sweeps
    // nothing: those runs' folders are kept for when the file is mended.
    if (!data.lossy) this.sweepFolders();
    // What didn't read is kept beside it now: sentinel.json is written again without it.
    else this.save();
    this.runner = new SentinelRunner({
      now: this.now,
      ...(deps.claude ? { claude: deps.claude } : {}),
      ...(deps.places ? { places: deps.places } : {}),
      shell: deps.shell ?? runSentinelShell,
      envFor: deps.envFor ?? (() => ({})),
      notify: (e) => deps.notify(e),
      folders: this.folders,
      project: (id) => {
        const p = deps.store.getState().projects.find((x) => x.id === id);
        return p ? { name: p.name, root: p.root } : undefined;
      },
      beluga: (projectId) => this.belugaData(projectId),
      home: deps.home ?? os.homedir(),
      claudeTurn: (signal) => this.claudeTurn(signal),
      ...(deps.cancelGraceMs !== undefined ? { cancelGraceMs: deps.cancelGraceMs } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.github ? { github: deps.github } : {}),
      ...(deps.chat ? { chat: deps.chat } : {}),
      ...(deps.friends ? { friends: deps.friends } : {}),
      ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
      startOther: (id, from, output) => this.startFrom(id, from, output),
      waitForYou: (active) => this.waitForYou(active),
    });
    this.expireWaiting();
    for (const item of this.items) this.ensureSecret(item);
    this.triggers = deps.triggers
      ? new Triggers({
          deps: { ...deps.triggers, store: deps.store, selfId: deps.selfId, now: deps.triggers.now ?? this.now },
          cursor: (id) => this.cursors[id],
          saveCursor: (id, c) => {
            this.cursors = { ...this.cursors, [id]: c };
            this.save();
          },
          fire: (id, e) => this.fireEvent(id, e),
          trouble: (id, words) => this.setTrouble(id, words),
          webhookState: (w) => {
            this.webhook = w;
            if (!this.closed) deps.store.dispatch({ type: 'sentinel_webhook', webhook: w });
          },
          hook: (id) => {
            const s = this.items.find((i) => i.id === id);
            const secret = this.secrets[id];
            if (!s || s.paused || s.trigger.kind !== 'webhook' || !secret) return undefined;
            const signingSecret = this.signingSecrets[id];
            const stripeSecret = s.trigger.signature === 'stripe' ? deps.triggers?.env?.(s.projectId).STRIPE_WEBHOOK_SECRET?.trim() : undefined;
            return { secret, ...(signingSecret ? { signingSecret } : {}), ...(s.trigger.signature ? { signature: s.trigger.signature } : {}), ...(stripeSecret ? { stripeSecret } : {}) };
          },
        })
      : undefined;
    deps.store.dispatch({ type: 'sentinel_init', state: this.state() });
    this.triggers?.sync(this.items);
    // Tasks a run's Claude makes (labelled sentinel:<slug>) go on the run.
    this.offs.push(deps.store.onAction((a) => queueMicrotask(() => this.onAction(a))));
    const every = deps.tickMs ?? TICK_MS;
    if (every > 0) {
      const first = setTimeout(() => this.tick(), Math.min(deps.firstTickMs ?? FIRST_TICK_MS, every));
      const timer = setInterval(() => this.tick(), every);
      first.unref?.();
      timer.unref?.();
      this.offs.push(() => {
        clearTimeout(first);
        clearInterval(timer);
      });
    }
  }

  // ------------------------------------------------------------------ reading

  state(): SentinelState {
    const index = keepRuns(this.runs, KEEP_IN_STATE);
    const live: Record<string, { stepId?: string; state: Run['state'] }> = {};
    for (const r of index) {
      if (!isLive(r.state)) continue;
      const step = (r.steps.find((s) => s.state === 'running') ?? r.steps.find((s) => s.state === 'waiting'))?.id;
      live[r.id] = { ...(step ? { stepId: step } : {}), state: r.state };
    }
    const nextAt: Record<string, number> = {};
    for (const s of this.items) {
      const at = this.nextAtOf(s);
      if (at !== undefined) nextAt[s.id] = at;
    }
    return { enabled: true, items: this.items, runs: index, live, runAtOnce: this.runAtOnce, nextAt, asks: this.asks, troubles: this.troubles, webhook: this.webhook };
  }

  list = (): readonly Sentinel[] => this.items;

  get = (ref: string): Sentinel | undefined => this.items.find((s) => s.id === ref) ?? this.items.find((s) => s.name.toLowerCase() === ref.trim().toLowerCase());

  need(ref: string): Sentinel {
    const s = this.get(ref);
    if (!s) throw new Error(`There's no sentinel ${ref}`);
    return s;
  }

  /** A sentinel's whole index, newest first. */
  runsOf(ref: string): RunSummary[] {
    const id = this.need(ref).id;
    return this.runs.filter((r) => r.sentinelId === id).reverse();
  }

  /** A run with its steps' outputs (the first 16 KB each) and its report's text. */
  runGet(runId: string): RunDetail {
    const live = [...this.active.values()].find((a) => a.run.id === runId);
    const summary = live ? toSummary(live.run) : this.runs.find((r) => r.id === runId);
    if (!summary) throw new Error('That run is gone (only the last 200 of each sentinel are kept)');
    const sentinel = this.items.find((s) => s.id === summary.sentinelId);
    const saved = this.folders.read(runId, 'trigger.json');
    let payload: unknown;
    try {
      payload = saved ? (JSON.parse(saved) as { payload?: unknown }).payload : undefined;
    } catch {
      payload = undefined;
    }
    const run: Run = live
      ? live.run
      : {
          ...summary,
          trigger: { ...summary.trigger, ...(payload !== undefined ? { payload } : {}) },
          steps: summary.steps.map((s, i) => {
            const output = this.folders.read(runId, `step-${i + 1}.txt`);
            return output === undefined ? s : { ...s, output: output.slice(0, OUTPUT_KEPT) };
          }),
        };
    const report = this.folders.read(runId, 'report.md');
    return { run, ...(sentinel ? { sentinel: { id: sentinel.id, name: sentinel.name } } : {}), ...(report !== undefined ? { report } : {}) };
  }

  recipes = (): readonly Recipe[] => RECIPES;

  // ------------------------------------------------------------------ changing

  /** A new sentinel, paused until you Turn It On. */
  create(draft: SentinelDraft): Sentinel {
    if (this.items.length >= MAX_SENTINELS) throw new Error(`Up to ${MAX_SENTINELS} sentinels: delete one you don’t need first`);
    const at = this.now();
    const access = draft.access ?? 'look';
    const projectId = this.projectIdOf(draft.projectId ?? undefined);
    const steps = this.stepsOf(draft.steps ?? [], access);
    const item: Sentinel = {
      id: short('sn'),
      name: oneLine(draft.name, 80) || 'New sentinel',
      icon: draft.icon ?? 'eye',
      ...(projectId ? { projectId } : {}),
      trigger: draft.trigger ?? { kind: 'manual' },
      steps,
      access,
      limits: limitsOf({ ...DEFAULT_LIMITS, ...draft.limits }),
      notify: draft.notify ?? 'mac',
      paused: true,
      failures: 0,
      ...(draft.recipe ? { recipe: draft.recipe } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.items = [...this.items, item];
    this.put(item);
    return item;
  }

  /** Change a sentinel; it saves at once (the page has no Save button). */
  update(ref: string, patch: SentinelPatch): Sentinel {
    const was = this.need(ref);
    const access = patch.access ?? was.access;
    const steps = patch.steps ? this.stepsOf(patch.steps, access) : was.steps;
    if (patch.access && !patch.steps) this.checkAccess(steps, access);
    const projectId = patch.projectId === null ? undefined : patch.projectId !== undefined ? this.projectIdOf(patch.projectId) : was.projectId;
    const { projectId: _p, ...rest } = was;
    const triggerChanged = patch.trigger !== undefined && JSON.stringify(patch.trigger) !== JSON.stringify(was.trigger);
    const next: Sentinel = {
      ...rest,
      ...(patch.name !== undefined ? { name: oneLine(patch.name, 80) || was.name } : {}),
      ...(patch.icon ? { icon: patch.icon } : {}),
      ...(projectId ? { projectId } : {}),
      ...(patch.trigger ? { trigger: patch.trigger } : {}),
      steps,
      access,
      limits: limitsOf({ ...was.limits, ...patch.limits }),
      ...(patch.notify ? { notify: patch.notify } : {}),
      // A new schedule starts from now: nothing it would have run before is caught up.
      ...(triggerChanged ? { lastScheduledAt: this.now() } : {}),
      updatedAt: this.now(),
    };
    // Another trigger (or another project's GitHub, Stripe, board) watches from now: what the old one saw doesn't apply.
    if (triggerChanged || projectId !== was.projectId) this.forgetCursor(next.id);
    this.replace(next);
    return next;
  }

  /** Turn it on (Resume) or pause it. */
  pause(ref: string, paused: boolean): Sentinel {
    const was = this.need(ref);
    if (was.paused === paused) return was;
    const { pausedWhy: _why, ...rest } = was;
    const next: Sentinel = paused ? { ...rest, paused: true, updatedAt: this.now() } : { ...rest, paused: false, failures: 0, lastScheduledAt: this.now(), updatedAt: this.now() };
    this.replace(next);
    return next;
  }

  /** Delete a sentinel: its run stops; its runs' folders go with the next prune. */
  remove(ref: string): void {
    const s = this.need(ref);
    // Its run stops; when it ends it's gone with the sentinel (record ignores a run whose sentinel is gone).
    this.active.get(s.id)?.abort.abort();
    this.active.delete(s.id);
    this.queued.delete(s.id);
    this.items = this.items.filter((i) => i.id !== s.id);
    this.runs = this.runs.filter((r) => r.sentinelId !== s.id);
    const { [s.id]: _ask, ...asks } = this.asks;
    this.asks = asks;
    const { [s.id]: _secret, ...secrets } = this.secrets;
    this.secrets = secrets;
    const { [s.id]: _signing, ...signing } = this.signingSecrets;
    this.signingSecrets = signing;
    this.extra.delete(s.id);
    const { [s.id]: _trouble, ...troubles } = this.troubles;
    this.troubles = troubles;
    this.forgetCursor(s.id);
    this.triggers?.sync(this.items);
    this.deps.store.dispatch({ type: 'sentinel_remove', id: s.id });
    this.save();
  }

  // ------------------------------------------------------------------ webhooks

  /** A webhook sentinel's address (with its secret), or why there isn't one now, in words. */
  webhookUrl(ref: string): WebhookAddress {
    const s = this.need(ref);
    if (s.trigger.kind !== 'webhook') throw new Error(`“${s.name}” doesn’t start from a webhook`);
    if (!this.triggers) return { why: 'Webhooks need the Beluga app for Mac' };
    const secret = this.ensureSecret(s);
    const signing = this.signingSecrets[s.id];
    const signingSecret = signing ? { signingSecret: signing } : {};
    const base = this.triggers.webhooks.base();
    const url = base ? `${base}/hook/${s.id}/${secret}` : undefined;
    if (s.paused) return { ...(url ? { url } : {}), why: 'It’s paused: posts to its URL are refused until you turn it on', ...signingSecret };
    if (!url) return { why: this.webhook.why ?? 'The tunnel is opening: its URL is here in a moment', ...signingSecret };
    return { url, ...signingSecret };
  }

  /** New secrets for a webhook sentinel (the URL's and GitHub's signing one): the old URL stops working at once. → its new address. */
  rotateSecret(ref: string): WebhookAddress {
    const s = this.need(ref);
    if (s.trigger.kind !== 'webhook') throw new Error(`“${s.name}” doesn’t start from a webhook`);
    this.secrets = { ...this.secrets, [s.id]: newSecret() };
    this.signingSecrets = { ...this.signingSecrets, [s.id]: newSecret() };
    this.save();
    return this.webhookUrl(s.id);
  }

  /** Something an event trigger saw: a run, unless it's paused, or a run of its own (or of a sentinel that led to it) made it. */
  private fireEvent(id: string, e: TriggerEvent): void {
    const s = this.items.find((i) => i.id === id);
    if (!s || s.paused || this.closed) return;
    let chain: string[] | undefined;
    if (e.from) {
      // The run that made it keeps its chain after it ended (a merge, a task done later).
      const runId = e.from.runId;
      const made = [...this.active.values()].find((a) => a.run.id === runId)?.run ?? this.runs.find((r) => r.id === runId) ?? [...this.queued.values()].find((q) => q.id === runId);
      chain = [...(made?.chain ?? []), e.from.sentinelId];
      if (chain.includes(s.id) || chain.length >= MAX_CHAIN) return;
    }
    // The payload is kept, and handed on, at most 64 KB.
    const payload = capPayload(e.payload);
    try {
      this.start(s.id, 'event', { kind: s.trigger.kind, summary: e.summary, ...(payload !== undefined ? { payload } : {}) }, chain);
    } catch {
      // Deleted or paused meanwhile.
    }
  }

  private setTrouble(id: string, words: string | undefined): void {
    if (this.closed || this.troubles[id] === words) return;
    if (words && !this.items.some((i) => i.id === id)) return;
    const { [id]: _was, ...rest } = this.troubles;
    this.troubles = words ? { ...rest, [id]: words } : rest;
    this.deps.store.dispatch({ type: 'sentinel_trouble', id, ...(words ? { trouble: words } : {}) });
  }

  private forgetCursor(id: string): void {
    if (!(id in this.cursors)) return;
    const { [id]: _c, ...rest } = this.cursors;
    this.cursors = rest;
  }

  /**
   * A webhook sentinel has its secrets from the start (a copy or a new one gets its own): the URL's,
   * and the one GitHub signs with. One made before they were apart signs with its URL's secret (what
   * was pasted into GitHub keeps working) until Rotate Secret.
   */
  private ensureSecret(s: Sentinel): string {
    const had = this.secrets[s.id];
    if (s.trigger.kind !== 'webhook') return had ?? '';
    if (had && this.signingSecrets[s.id]) return had;
    const secret = had ?? newSecret();
    this.secrets = { ...this.secrets, [s.id]: secret };
    this.signingSecrets = { ...this.signingSecrets, [s.id]: had ?? newSecret() };
    this.save();
    return secret;
  }

  duplicate(ref: string): Sentinel {
    const s = this.need(ref);
    const { id: _id, createdAt: _c, updatedAt: _u, pausedWhy: _w, lastScheduledAt: _l, recipe: _r, projectId, ...rest } = s;
    const at = this.now();
    const copy: Sentinel = { ...rest, ...(projectId ? { projectId } : {}), id: short('sn'), name: `${s.name} copy`.slice(0, 80), paused: true, failures: 0, createdAt: at, updatedAt: at };
    this.items = [...this.items, copy];
    this.put(copy);
    return copy;
  }

  setRunAtOnce(n: number): number {
    this.runAtOnce = Math.max(1, Math.min(MAX_RUN_AT_ONCE, Math.round(n)));
    this.deps.store.dispatch({ type: 'sentinel_init', state: this.state() });
    this.save();
    this.pump();
    return this.runAtOnce;
  }

  // ------------------------------------------------------------------ running

  /**
   * Start a run (Run Now, the clock, Claude): one at a time per sentinel, so one that fires while
   * it runs waits (once). Paused sentinels only run when you ask (Run Now). → the run.
   */
  start(ref: string, by: RunBy, trigger?: RunTrigger, chain?: readonly string[]): RunSummary {
    const s = this.need(ref);
    const yours = by === 'you' || by === 'phone';
    if (s.paused && !yours) throw new Error(`“${s.name}” is paused: turn it on first`);
    const fired: RunTrigger = trigger ?? { kind: yours || by === 'claude' ? 'manual' : s.trigger.kind, summary: by === 'you' ? 'You pressed Run' : by === 'phone' ? 'You ran it from your phone' : by === 'claude' ? 'Your Claude ran it' : scheduleSentence(s.trigger) };
    const limit = s.limits.perDay;
    if (limit && !yours) {
      const today = startOfDay(this.now());
      // Runs that ran (or run now); skipped and queued ones don't count.
      const ran = this.runs.filter((r) => r.sentinelId === s.id && r.startedAt >= today && COUNTS_PER_DAY.has(r.state)).length;
      if (ran >= limit) return this.note(s, by, fired, OVER_DAY, `Skipped: it ran ${limit} ${limit === 1 ? 'time' : 'times'} today already`);
    }
    if (this.active.has(s.id)) {
      const waiting = this.queued.get(s.id);
      if (waiting) {
        if (by === 'event') this.oneMore(s, fired);
        return waiting;
      }
      const run = this.newRun(s, by, fired, 'queued', chain);
      this.queued.set(s.id, { ...toSummary(run), ...(fired.payload !== undefined ? { payload: fired.payload } : {}) });
      this.record(run);
      return toSummary(run);
    }
    // The chain is on the run from the start: a step that runs another sentinel at once sees it.
    const run = this.newRun(s, by, fired, 'running', chain);
    return toSummary(this.launch(s, run));
  }

  /** Stop a run going now (or one waiting its turn). → whether there was one. */
  stop(runId: string): boolean {
    for (const a of this.active.values()) {
      if (a.run.id !== runId) continue;
      a.abort.abort();
      return true;
    }
    for (const [id, q] of this.queued) {
      if (q.id !== runId) continue;
      this.queued.delete(id);
      const { payload: _p, ...run } = q;
      this.recordSummary({ ...run, steps: run.steps.map((st) => ({ ...st, state: 'skipped' as const })), state: 'stopped', headline: 'Stopped by you before it started', endedAt: this.now() });
      return true;
    }
    return false;
  }

  /**
   * A run waiting for you (a merge, docs/sentinel.md §5): Merge merges it (and archives its
   * worktree), Not Now ends it as stopped with the pull request left open. A run still going hears
   * it and goes on with its steps; one Beluga was closed under is merged from here. → the run, once
   * GitHub has merged it (or said why not).
   */
  async decide(runId: string, choice: 'merge' | 'skip'): Promise<RunSummary> {
    const going = [...this.active.values()].find((a) => a.run.id === runId);
    if (going) {
      if (going.run.state !== 'needs-you' || !going.answer) throw new Error('That run isn’t waiting for you');
      await going.answer(choice);
      return toSummary(going.run);
    }
    const run = this.runs.find((r) => r.id === runId);
    if (!run || run.state !== 'needs-you') throw new Error('That run isn’t waiting for you (anymore)');
    if (this.deciding.has(runId)) throw new Error('That run is being merged already');
    this.deciding.add(runId);
    try {
      return await this.decideClosed(run, choice);
    } finally {
      this.deciding.delete(runId);
    }
  }

  /**
   * decide for a run Beluga was closed under: Not Now stops it; Merge looks again (the sentinel
   * still has Ship access and its merge step, the pull request still at the commit that was checked
   * and reviewed, its checks passing there), merges pinned to that commit, and ends the run as a
   * run ends (its failures counted, the sentinels that run after it started).
   */
  private async decideClosed(run: RunSummary, choice: 'merge' | 'skip'): Promise<RunSummary> {
    const s = this.need(run.sentinelId);
    const at = s.steps.findIndex((st) => st.kind === 'merge');
    const mergeStep = at >= 0 ? s.steps[at] : undefined;
    const n = run.pr ? `#${run.pr.number}` : 'the pull request';
    const ended = (state: 'done' | 'skipped' | 'failed', why?: string): RunSummary['steps'] =>
      run.steps.map((st) => (mergeStep && st.id === mergeStep.id ? { ...st, state, endedAt: this.now(), ...(why ? { why } : {}) } : st.state === 'waiting' || st.state === 'running' ? { ...st, state: 'skipped' as const } : st));
    if (choice === 'skip') {
      const next: RunSummary = { ...run, state: 'stopped', headline: `Not now: ${n} stays open`, endedAt: this.now(), steps: ended('skipped') };
      this.recordSummary(next);
      return next;
    }
    const gh = this.deps.github;
    if (!gh || !run.pr) throw new Error('Merging needs the Beluga app and the run’s pull request');
    const end = (state: 'done' | 'failed', headline: string, why?: string): RunSummary => {
      const fresh = this.runs.find((r) => r.id === run.id) ?? run;
      const next: RunSummary = { ...fresh, state, headline: redactSecrets(headline), endedAt: this.now(), steps: ended(state, why), ...(why ? { why: redactSecrets(why) } : {}) };
      // Ended as a run ends: its failures counted, told, the sentinels after it started.
      const active: ActiveRun = { run: next, sentinel: s, abort: new AbortController(), deadline: this.now(), places: {} };
      this.finished(active, next);
      return next;
    };
    const refuse = (why: string): never => {
      end('failed', `${mergeStep?.name ?? 'Merge'}: ${firstLine(why, 100)}`, why);
      throw new Error(capitalFirst(why));
    };
    if (mergeStep?.kind !== 'merge') return refuse('this sentinel has no merge step anymore');
    if (!accessAllows(s.access, 'merge')) return refuse(`it needs ${ACCESS_INFO.ship.label} access, and this sentinel has ${ACCESS_INFO[s.access].label}`);
    if (!run.prHead) return refuse('Beluga can’t tell which commit Claude reviewed; run it again');
    const where = { ...(run.worktreeId ? { workspaceId: run.worktreeId } : {}), ...(s.projectId ? { projectId: s.projectId } : {}) };
    const res = await mergePinned(gh, where, run.pr, mergeStep.method, run.prHead);
    if (res !== true) return refuse(res);
    // Its work is on the base branch now; a worktree that can't go stays (nothing is lost).
    if (run.worktreeId) await this.deps.places?.archive(run.worktreeId).catch(() => undefined);
    return end('done', `Merged ${n}`);
  }

  /** The clock: start what's due (the Mac waking from sleep shows as a gap since the last look). */
  tick(): void {
    if (this.closed) return;
    const now = this.now();
    const every = this.deps.tickMs || TICK_MS;
    const woke = this.lastTick !== undefined && now - this.lastTick > 3 * every;
    this.lastTick = now;
    this.expireWaiting();
    for (const s of this.items) {
      if (s.paused || s.trigger.kind !== 'schedule') continue;
      const due = dueNow(s.trigger, s.lastScheduledAt, now, this.deps.tz ? { tz: this.deps.tz } : {});
      if (due.kind === 'wait') {
        // The clock jumped: what the window says comes next is worked out again.
        if (woke) this.put(s);
        continue;
      }
      const moved: Sentinel = { ...s, lastScheduledAt: due.slot };
      this.replace(moved);
      const sentence = scheduleSentence(s.trigger);
      if (due.kind === 'skip') {
        this.note(moved, 'schedule', { kind: 'schedule', summary: sentence }, 'Missed while the Mac was asleep or Beluga was closed', 'Skipped: the Mac was asleep or Beluga was closed');
        continue;
      }
      try {
        this.start(moved.id, 'schedule', { kind: 'schedule', summary: due.late ? `${sentence} (caught up: the Mac was asleep or Beluga was closed)` : sentence });
      } catch {
        // Deleted or paused meanwhile.
      }
    }
  }

  /** Everything a run of Claude's gets: the tools (your own runs only), and the brief of a sentinel run's Claude step. */
  forRun(channel: string, from: string): RunSentinel | undefined {
    if (from !== this.deps.selfId()) return undefined;
    const active = [...this.active.values()].find((a) => a.claude?.channel === channel);
    if (active?.claude) return { tools: this.toolsFor(active), brief: active.claude.brief, inRun: true };
    // A conversation where your Claude changes a sentinel (sentinel.ask): the sentinel as material.
    const asked = this.askChannels.get(channel);
    const sentinel = asked ? this.items.find((i) => i.id === asked) : undefined;
    if (sentinel) return { tools: this.toolsFor(undefined, sentinel.id), brief: sentinelAskBrief(sentinel, this.items, RECIPES), inRun: false };
    return { tools: this.toolsFor(undefined), brief: sentinelNote(), inRun: false };
  }

  /**
   * Ask your Claude to change a sentinel (the page's box; Describe it is create, then this): a quiet
   * chat in its project's main folder (Claude reads, never changes files) or in Your Mac, told the
   * sentinel, the step kinds and the recipes, with the tools to change it. The page follows it
   * through the state (asks). → the conversation.
   */
  async ask(ref: string, text: string): Promise<{ readonly channel: string }> {
    const s = this.need(ref);
    const claude = this.deps.claude;
    const places = this.deps.places;
    if (!claude || !places) throw new Error('Asking Claude needs the Beluga app with your Claude on');
    const words = text.trim();
    if (!words) throw new Error('Say what to change');
    if (this.asking.has(s.id) || this.asks[s.id]?.state === 'writing') throw new Error(`Claude is changing “${s.name}” already: wait for it, or open its chat`);
    // Taken before the first await: a second ask in the meantime is refused, not run twice.
    this.asking.add(s.id);
    let place: Awaited<ReturnType<SentinelPlaces['projectChat']>>;
    try {
      place = s.projectId ? await places.projectChat(s.projectId, `Change “${s.name}”`) : places.macChat();
    } catch (err) {
      this.asking.delete(s.id);
      throw err;
    }
    if (!place) {
      this.asking.delete(s.id);
      throw new Error('Claude’s conversation couldn’t be made');
    }
    const { channel } = place;
    this.askChannels.set(channel, s.id);
    const ask: SentinelAsk = { channel, startedAt: this.now(), state: 'writing', text: firstLine(words, 200) };
    this.setAsk(s.id, ask);
    this.asking.delete(s.id);
    const requestId = claude.ask(words, channel, words);
    if (!requestId) {
      this.setAsk(s.id, { ...ask, state: 'failed', answer: 'Your Claude couldn’t be asked there', endedAt: this.now() });
      throw new Error('Your Claude couldn’t be asked there');
    }
    // As long as one of its runs may take: then it's stopped, and the page says so.
    let over = false;
    const timer = setTimeout(
      () => {
        over = true;
        claude.cancel(requestId, 'Stopped by Beluga: Claude took too long');
        this.setAsk(s.id, { ...ask, state: 'failed', answer: TOOK_TOO_LONG, endedAt: this.now() });
      },
      (s.limits.minutes || DEFAULT_LIMITS.minutes) * 60_000,
    );
    timer.unref?.();
    void claude.wait(requestId).then(
      (answer) => {
        clearTimeout(timer);
        if (!over) this.setAsk(s.id, { ...ask, state: 'done', answer: clipLines(answer), endedAt: this.now() });
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (!over) this.setAsk(s.id, { ...ask, state: 'failed', answer: firstLine(redactSecrets(err instanceof Error ? err.message : String(err)), 200) || 'Claude stopped', endedAt: this.now() });
      },
    );
    return { channel };
  }

  /** Your Claude's change (sentinel_update): a change to what it can do pauses one that was on. */
  claudeUpdate(ref: string, patch: ToolPatch): { readonly sentinel: Sentinel; readonly paused: boolean } {
    const was = this.need(ref);
    const next = this.update(was.id, this.fromToolPatch(patch));
    // Paused already (after failures, say): it now says Claude changed it, so Resume runs nothing new unseen.
    if (!claudeWidened(was, next)) return { sentinel: next, paused: false };
    const paused: Sentinel = { ...next, paused: true, pausedWhy: CLAUDE_CHANGED, updatedAt: this.now() };
    this.replace(paused);
    return { sentinel: paused, paused: true };
  }

  /** Recorded history (the demo): a run as if it had happened, with its outputs and report (the same id: that run, changed). */
  addHistory(sentinelId: string, run: Omit<Run, 'id' | 'sentinelId'> & { readonly id?: string }, files: { readonly outputs?: readonly (string | undefined)[]; readonly report?: string } = {}): Run {
    const full: Run = { ...run, id: run.id ?? short('run', 8), sentinelId };
    files.outputs?.forEach((o, i) => o !== undefined && this.folders.write(full.id, `step-${i + 1}.txt`, o));
    if (files.report !== undefined) this.folders.write(full.id, 'report.md', files.report);
    const report = files.report !== undefined ? this.folders.pathOf(full.id, 'report.md') : undefined;
    this.record(report ? { ...full, report } : full);
    return full;
  }

  /** The demo's history: a sentinel as if its runs had failed (and paused it). */
  demoSet(ref: string, patch: { readonly paused?: boolean; readonly failures?: number; readonly pausedWhy?: string; readonly lastScheduledAt?: number }): Sentinel {
    const next: Sentinel = { ...this.need(ref), ...patch };
    this.replace(next);
    return next;
  }

  /** On the way out: runs going now stop, and everything is written. */
  stopAll(): void {
    this.triggers?.stopAll();
    this.closed = true;
    for (const off of this.offs) off();
    // Nothing reads "running" after a restart: the steps going (or still to come) are skipped, and
    // the runs waiting their turn are stopped.
    const unfinished = (steps: RunSummary['steps']): RunSummary['steps'] => steps.map((st) => (st.state === 'running' || st.state === 'waiting' ? { ...st, state: 'skipped' as const } : st));
    for (const a of this.active.values()) {
      a.abort.abort();
      const run = toSummary(a.run);
      this.recordSummary({ ...run, state: 'stopped', headline: 'Beluga closed while it ran', endedAt: this.now(), steps: unfinished(run.steps) });
    }
    for (const q of this.queued.values()) {
      const { payload: _p, ...run } = q;
      this.recordSummary({ ...run, state: 'stopped', headline: 'Beluga closed before it started', endedAt: this.now(), steps: unfinished(run.steps) });
    }
    this.active.clear();
    this.queued.clear();
    this.file.flush();
  }

  // ------------------------------------------------------------------ inside

  private newRun(s: Sentinel, by: RunBy, trigger: RunTrigger, state: Run['state'], chain?: readonly string[]): Run {
    return { id: short('run', 8), sentinelId: s.id, by, trigger, state, startedAt: this.now(), headline: state === 'queued' ? 'Waiting for the run before it' : '', steps: s.steps.map((st) => ({ id: st.id, state: 'waiting' })), tasks: [], ...(chain?.length ? { chain } : {}) };
  }

  /**
   * An event while it runs and another run waits already: it isn't run, but the history says so,
   * one line for them all until the run ends ("2 more events while it ran").
   */
  private oneMore(s: Sentinel, trigger: RunTrigger): void {
    const was = this.extra.get(s.id);
    const n = (was?.n ?? 0) + 1;
    const headline = `Skipped: ${n} more ${n === 1 ? 'event' : 'events'} while it ran`;
    const prev = was && this.runs.find((r) => r.id === was.runId);
    const { payload: _p, ...summary } = trigger;
    if (prev) this.recordSummary({ ...prev, trigger: summary, headline, endedAt: this.now() });
    else {
      const note = this.note(s, 'event', summary, 'it was running, and another run waited already', headline);
      this.extra.set(s.id, { runId: note.id, n });
      return;
    }
    this.extra.set(s.id, { runId: prev.id, n });
  }

  /** A run that didn't run (over its runs per day, a missed slot skipped): a line in the history. */
  private note(s: Sentinel, by: RunBy, trigger: RunTrigger, why: string, headline: string): RunSummary {
    const at = this.now();
    const run: Run = { ...this.newRun(s, by, trigger, 'skipped'), why, headline, endedAt: at, steps: s.steps.map((st) => ({ id: st.id, state: 'skipped' })) };
    this.record(run);
    return toSummary(run);
  }

  private launch(s: Sentinel, run: Run): Run {
    const active: ActiveRun = { run, sentinel: s, abort: new AbortController(), deadline: this.now() + s.limits.minutes * 60_000, places: {} };
    this.active.set(s.id, active);
    this.folders.write(run.id, 'trigger.json', `${JSON.stringify(run.trigger, null, 2)}\n`);
    this.record(run);
    void this.runner
      .execute(active, (r) => !this.closed && this.record(r))
      .catch((err: unknown) => ({ ...active.run, state: 'failed' as const, why: redactSecrets(err instanceof Error ? err.message : String(err)), headline: 'Something went wrong', endedAt: this.now() }))
      .then((final) => this.finished(active, final));
    return active.run;
  }

  private finished(active: ActiveRun, run: Run): void {
    if (this.closed) return;
    const sid = active.sentinel.id;
    if (this.active.get(sid) === active) this.active.delete(sid);
    const s = this.items.find((i) => i.id === sid);
    // Its sentinel was deleted while it ran: it goes too, its folder with it.
    if (!s) {
      this.folders.remove(run.id);
      return;
    }
    this.record(run);
    const failures = run.state === 'failed' ? s.failures + 1 : run.state === 'done' || run.state === 'skipped' ? 0 : s.failures;
    const pausing = run.state === 'failed' && s.limits.pauseAfter > 0 && failures >= s.limits.pauseAfter && !s.paused;
    const next: Sentinel = { ...s, failures, ...(pausing ? { paused: true, pausedWhy: `Paused after ${failures} failures in a row` } : {}) };
    if (next.failures !== s.failures || pausing) this.replace(next);
    this.tell(next, run, pausing);
    this.follow(next, run);
    this.extra.delete(sid);
    this.prune();
    const waiting = this.active.has(sid) ? undefined : this.queued.get(sid);
    if (waiting) {
      this.queued.delete(sid);
      const { payload, ...q } = waiting;
      const fresh = this.items.find((i) => i.id === sid)!;
      if (fresh.paused && q.by !== 'you' && q.by !== 'phone') this.recordSummary({ ...q, state: 'skipped', why: 'paused', headline: 'Skipped: it was paused', endedAt: this.now() });
      else this.launch(fresh, { ...q, trigger: { ...q.trigger, ...(payload !== undefined ? { payload } : {}) }, state: 'running', startedAt: this.now(), headline: '', steps: fresh.steps.map((st) => ({ id: st.id, state: 'waiting' })) });
    }
  }

  /** The run's end, told: failures (and pausing) as problems, a finished run where the sentinel says. */
  private tell(s: Sentinel, run: Run, paused: boolean): void {
    const where = s.notify;
    const channel = run.channel ? { channel: run.channel } : {};
    if (paused) {
      this.deps.notify({ kind: 'problems', tag: 'sentinel', title: `${s.name} is paused after ${s.failures} failures`, body: run.why ? `The last one: ${run.why}` : 'Resume it from its page', key: `${run.id}:paused`, ...channel });
      return;
    }
    if (where === 'off') return;
    if (run.state === 'failed') this.deps.notify({ kind: 'problems', tag: 'sentinel', title: `${s.name} failed`, body: run.headline, key: `${run.id}:failed`, ...channel });
    // A Notify step told it already (with its own words).
    else if (run.state === 'done' && (where === 'mac' || where === 'both') && !s.steps.some((st, i) => st.kind === 'notify' && run.steps[i]?.state === 'done')) this.deps.notify({ kind: 'done', tag: 'sentinel', title: s.name, body: run.headline, key: run.id, ...channel });
    // The phone (where === 'phone' | 'both') is told by the companion host, from the state: a `done`
    // nudge collapsed as `sentinel:<id>` (src/companion/views.ts sentinelDone), the report on its page.
  }

  /** Sentinels that run after this one ("After “Nightly tests” fails"): started with its last output. */
  private follow(s: Sentinel, run: Run): void {
    const fits = (on: 'success' | 'failure' | 'always'): boolean => (on === 'success' ? run.state === 'done' : on === 'failure' ? run.state === 'failed' : run.state === 'done' || run.state === 'failed');
    const output = this.lastOutput(run);
    for (const f of this.items) {
      if (f.paused || f.trigger.kind !== 'after' || f.trigger.sentinelId !== s.id || !fits(f.trigger.on)) continue;
      const how = run.state === 'done' ? 'succeeded' : run.state === 'failed' ? 'failed' : 'ran';
      try {
        this.chained(f, run, s, { kind: 'after', summary: `After “${s.name}” ${how}${run.headline ? `: ${firstLine(run.headline, 120)}` : ''}`, payload: { sentinel: s.name, run: run.id, state: run.state, headline: run.headline, ...(output !== undefined ? { output } : {}) } });
      } catch {
        // Deleted, paused, or a loop: nothing starts.
      }
    }
  }

  /** Start `target` from another sentinel's run (after, Run another sentinel), never in a loop. */
  private chained(target: Sentinel, from: Pick<Run, 'id' | 'chain'>, by: Sentinel, trigger: RunTrigger): RunSummary {
    const chain = [...(from.chain ?? []), by.id];
    if (chain.includes(target.id)) throw new Error(`“${target.name}” led to this run: starting it again would run them in a loop`);
    if (chain.length >= MAX_CHAIN) throw new Error(`${MAX_CHAIN} sentinels ran each other in a row: “${target.name}” doesn’t start`);
    return this.start(target.id, `after:${from.id}`, trigger, chain);
  }

  /** Run another sentinel (a step): with this run's last output as its trigger's payload. → its name. */
  private startFrom(ref: string, from: ActiveRun, output: string | undefined): string {
    const target = this.need(ref);
    this.chained(target, from.run, from.sentinel, { kind: 'after', summary: `“${from.sentinel.name}” ran it`, payload: { sentinel: from.sentinel.name, run: from.run.id, ...(output !== undefined ? { output: output.slice(0, OUTPUT_KEPT) } : {}) } });
    return target.name;
  }

  /** A run's last step output (the first 16 KB), from its folder. */
  private lastOutput(run: Run): string | undefined {
    for (let i = run.steps.length; i >= 1; i--) {
      const out = this.folders.read(run.id, `step-${i}.txt`);
      if (out !== undefined) return out.slice(0, OUTPUT_KEPT);
    }
    return undefined;
  }

  /** A merge waits for your Merge or Not Now (decide), or 24 hours. */
  private waitForYou(active: ActiveRun): Promise<YourAnswer> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ choice: 'expired' }), this.deps.approvalMs ?? APPROVAL_MS);
      timer.unref?.();
      const onAbort = (): void => finish({ choice: 'expired' });
      active.abort.signal.addEventListener('abort', onAbort, { once: true });
      let done = false;
      function finish(a: YourAnswer): void {
        if (done) return;
        done = true;
        clearTimeout(timer);
        active.abort.signal.removeEventListener('abort', onAbort);
        active.answer = undefined;
        resolve(a);
      }
      active.answer = (choice) =>
        new Promise<void>((ok, no) => {
          finish({ choice, settle: (why) => (why ? no(new Error(why)) : ok()) });
        });
    });
  }

  /** Runs waiting for you that Beluga was closed under, unanswered for 24 hours: stopped. */
  private expireWaiting(): void {
    const now = this.now();
    const limit = this.deps.approvalMs ?? APPROVAL_MS;
    const going = new Set([...this.active.values()].map((a) => a.run.id));
    for (const r of this.runs) {
      if (r.state !== 'needs-you' || going.has(r.id)) continue;
      const since = r.waitingSince ?? r.steps.find((st) => st.state === 'running')?.startedAt ?? r.startedAt;
      if (now - since < limit) continue;
      const n = r.pr ? `#${r.pr.number}` : 'the pull request';
      this.recordSummary({ ...r, state: 'stopped', headline: `Nobody said Merge in 24 hours: ${n} stays open`, why: 'nobody said Merge in 24 hours', endedAt: now, steps: r.steps.map((st) => (st.state === 'running' || st.state === 'waiting' ? { ...st, state: 'skipped' as const } : st)) });
    }
  }

  private setAsk(id: string, ask: SentinelAsk): void {
    if (!this.items.some((i) => i.id === id)) return;
    this.asks = { ...this.asks, [id]: ask };
    this.deps.store.dispatch({ type: 'sentinel_ask', id, ask });
  }

  /** Claude's patch as a sentinel patch: its project and other sentinels by name. */
  private fromToolPatch(p: ToolPatch): SentinelPatch {
    const idOf = (ref: string): string => this.get(ref)?.id ?? ref;
    const trigger = p.trigger?.kind === 'after' ? { ...p.trigger, sentinelId: idOf(p.trigger.sentinelId) } : p.trigger;
    return {
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.project !== undefined ? { projectId: p.project } : {}),
      ...(trigger ? { trigger } : {}),
      ...(p.steps ? { steps: p.steps.map((st) => toolStep(st.kind === 'trigger' ? { ...st, sentinelId: idOf(st.sentinelId) } : st)) } : {}),
      ...(p.access ? { access: p.access } : {}),
      ...(p.limits ? { limits: p.limits } : {}),
      ...(p.notify ? { notify: p.notify } : {}),
    };
  }

  private claudeTurn(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.inUse++;
        let given = false;
        resolve(() => {
          if (given) return;
          given = true;
          this.inUse--;
          this.pump();
        });
      };
      if (this.inUse < this.runAtOnce) return grant();
      this.waiters.push(grant);
      signal.addEventListener(
        'abort',
        () => {
          const at = this.waiters.indexOf(grant);
          if (at >= 0) this.waiters.splice(at, 1);
        },
        { once: true },
      );
    });
  }

  private pump(): void {
    while (this.inUse < this.runAtOnce && this.waiters.length) this.waiters.shift()!();
  }

  private onAction(a: Action): void {
    if (a.type !== 'board_issue' || this.closed) return;
    const issue = a.issue;
    for (const active of this.active.values()) {
      if (!issue.labels.includes(sentinelLabel(active.sentinel)) || issue.createdAt < active.run.startedAt || active.run.tasks.includes(issue.key)) continue;
      active.run = { ...active.run, tasks: [...active.run.tasks, issue.key] };
      this.record(active.run);
    }
  }

  private nextAtOf(s: Sentinel): number | undefined {
    if (s.paused || s.trigger.kind !== 'schedule') return undefined;
    return nextRunAt(s.trigger, s.lastScheduledAt, this.now(), this.deps.tz);
  }

  private put(s: Sentinel): void {
    const at = this.nextAtOf(s);
    this.ensureSecret(s);
    this.deps.store.dispatch({ type: 'sentinel_put', item: s, ...(at !== undefined ? { nextAt: at } : {}) });
    this.save();
    if (isEventTrigger(s.trigger) || this.triggers?.watching().includes(s.id)) this.triggers?.sync(this.items);
  }

  private replace(next: Sentinel): void {
    this.items = this.items.map((i) => (i.id === next.id ? next : i));
    this.put(next);
  }

  private record(run: Run): void {
    this.recordSummary(toSummary(run));
  }

  private recordSummary(summary: RunSummary): void {
    // A deleted sentinel's run (one that ends after the delete) isn't kept: nothing shows it.
    if (!this.items.some((i) => i.id === summary.sentinelId)) return;
    const at = this.runs.findIndex((r) => r.id === summary.id);
    this.runs = at >= 0 ? this.runs.map((r, n) => (n === at ? summary : r)) : [...this.runs, summary];
    this.deps.store.dispatch({ type: 'sentinel_run', run: summary });
    this.save();
  }

  private prune(): void {
    const { kept, gone } = pruneRuns(this.runs);
    if (!gone.length) return;
    this.runs = kept;
    for (const id of gone) this.folders.remove(id);
    this.save();
  }

  /**
   * Run folders no run in the index has (a deleted sentinel's, pruned ones Beluga closed before
   * removing); never the runs an earlier load set aside (sentinel.dropped-*.json), and nothing at all
   * while an unreadable sentinel.json is kept beside it.
   */
  private sweepFolders(): void {
    const root = this.folders.root;
    if (!root) return;
    const aside = this.file.setAside();
    if (aside.all) return;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    const ids = new Set([...this.runs.map((r) => r.id), ...aside.ids]);
    for (const name of names) if (!ids.has(name)) this.folders.remove(name);
  }

  private save(): void {
    this.file.save(() => ({ runAtOnce: this.runAtOnce, items: this.items, runs: this.runs, cursors: this.cursors, secrets: this.secrets, signingSecrets: this.signingSecrets }));
  }

  private projectIdOf(ref: string | undefined): string | undefined {
    if (!ref) return undefined;
    const projects = this.deps.store.getState().projects;
    const p = projects.find((x) => x.id === ref) ?? projects.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase());
    if (!p) throw new Error(`There's no project ${ref}`);
    return p.id;
  }

  /** Steps with their ids, names and defaults, each one the access allows. */
  private stepsOf(drafts: readonly StepDraft[], access: Sentinel['access']): Step[] {
    const steps = drafts.map((d) => {
      const parsed = StepInputSchema.parse(d);
      return { ...parsed, id: parsed.id ?? short('st', 4), name: oneLine(parsed.name ?? '', 80) || STEP_INFO[parsed.kind].label } as Step;
    });
    this.checkAccess(steps, access);
    return steps;
  }

  private checkAccess(steps: readonly Step[], access: Sentinel['access']): void {
    for (const st of steps) {
      const where = st.kind === 'claude' ? st.where : undefined;
      if (!accessAllows(access, st.kind, where)) throw new Error(`“${st.name}” needs ${ACCESS_INFO[accessNeeded(st.kind, where)].label} access; this sentinel has ${ACCESS_INFO[access].label}`);
    }
  }

  /** Beluga's own data for templates: open tasks (as task_list prints them), worktrees, plans. */
  private belugaData(projectId: string | undefined): { tasks: string; worktrees: string; plans: string } {
    const st = this.deps.store.getState();
    const tasks = st.board.enabled ? describeList(filterIssues(st.board, { scope: 'all', selfId: this.deps.selfId(), ...(projectId ? { projectId } : {}) }).filter((i) => isOpen(i.status))) : '';
    const projects = st.projects.filter((p) => !projectId || p.id === projectId);
    const worktrees = projects.flatMap((p) => p.workspaces.filter((w) => w.kind === 'worktree' && !w.archived).map((w) => `${p.name}/${w.name}${w.branch ? ` (${w.branch})` : ''}`)).join('\n');
    const plans = st.plans.plans.filter((p) => (!projectId || p.projectId === projectId) && p.status !== 'done').map((p) => `${planTitle(p)} · ${p.status}`).join('\n');
    return { tasks, worktrees, plans };
  }

  // ------------------------------------------------------------------ Claude's tools

  private toolsFor(active: ActiveRun | undefined, asking?: string): SentinelTools {
    const line = (s: Sentinel): string => {
      const last = lastRunOf(this.state(), s.id);
      const next = this.nextAtOf(s);
      return `${last ? ` · last run ${last.state}${last.headline ? `: ${last.headline}` : ''}` : ''}${next ? ` · next ${new Date(next).toLocaleString()}` : ''}`;
    };
    return {
      ...(asking ? { asking } : {}),
      ...(active
        ? {
            stop: (reason: string) => {
              active.stopReason = oneLine(reason, 200) || 'nothing to do';
              return 'Noted: this run ends as skipped (nothing to do) when you finish this message. Keep it to one line.';
            },
          }
        : {}),
      list: () => describeSentinels(this.items, line),
      create: (d: ToolDraft) => {
        const { name: _n, ...refs } = this.fromToolPatch({ trigger: d.trigger, steps: d.steps });
        const s = this.create({ ...fromToolDraft(d), ...refs });
        return `Made “${s.name}” (${scheduleSentence(s.trigger)}), paused: \`sentinel:${s.id}\`. It runs once the user turns it on from its page (you can’t).`;
      },
      run: (ref: string) => {
        const s = this.need(ref);
        if (active?.sentinel.id === s.id) throw new Error('This run is that sentinel’s: it can’t start itself');
        const run = this.start(s.id, 'claude');
        return run.state === 'queued' ? `“${s.name}” is running already: this run waits for it` : run.state === 'skipped' ? `“${s.name}” didn’t run: ${run.headline}` : `Started “${s.name}” (\`sentinel:${s.id}\`)`;
      },
      // Pause-only: Claude never turns a sentinel on (that's the user's, from the Mac or the phone).
      pause: (ref: string) => {
        const was = this.need(ref);
        if (was.paused) return `“${was.name}” is paused already; only the user can turn it on, from its page`;
        const s = this.pause(ref, true);
        return `“${s.name}” is paused; the user can turn it back on from its page`;
      },
      get: (ref: string) => {
        const s = this.need(ref);
        return `“${s.name}” (${scheduleSentence(s.trigger, (id) => this.get(id)?.name)}) ${s.paused ? 'is paused' : 'is on'}${line(s)}. As material:\n${sentinelMaterial(s)}`;
      },
      update: (ref: string, patch: ToolPatch) => {
        if (active?.sentinel.id === this.get(ref)?.id) throw new Error('This run is that sentinel’s: it can’t change itself while it runs');
        const { sentinel: s, paused } = this.claudeUpdate(ref, patch);
        const changed = Object.keys(patch).filter((k) => patch[k as keyof ToolPatch] !== undefined);
        return `Changed “${s.name}” (${changed.join(', ') || 'nothing'}): ${scheduleSentence(s.trigger, (id) => this.get(id)?.name)}; ${s.steps.length} ${s.steps.length === 1 ? 'step' : 'steps'}.${paused ? ' It changed what it can do, so it is paused now: the user turns it on again from its page (say so).' : s.paused ? ' It is paused: the user turns it on from its page.' : ''} \`sentinel:${s.id}\``;
      },
      remove: (ref: string) => {
        const s = this.need(ref);
        if (active?.sentinel.id === s.id) throw new Error('This run is that sentinel’s: it can’t delete itself');
        this.remove(s.id);
        return `Deleted “${s.name}”. Its past runs’ reports go with the next clean-up.`;
      },
    };
  }
}

/** Runs per day 0 is no limit, the same as none: kept as none. */
function limitsOf(l: Limits): Limits {
  const { perDay, ...rest } = l;
  return perDay ? { ...rest, perDay } : rest;
}

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Claude's step as a step draft: what it left out is filled in (StepInputSchema's defaults). A
 * merge step always asks you: only the editor can untick its approval (with its alert).
 */
const toolStep = (st: ToolStep): StepDraft => StepInputSchema.parse(st.kind === 'merge' ? { ...st, require: { checks: true, approval: true } } : st) as StepDraft;

/** An ask that ran past its sentinel's time limit says this. */
export const TOOK_TOO_LONG = 'Claude took too long';

const capitalFirst = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/** Claude's draft as a sentinel draft (its project by name). */
export function fromToolDraft(d: ToolDraft): SentinelDraft {
  return {
    name: d.name,
    ...(d.project ? { projectId: d.project } : {}),
    trigger: d.trigger,
    steps: d.steps.map(toolStep),
    ...(d.access ? { access: d.access } : {}),
    ...(d.notify ? { notify: d.notify } : {}),
  };
}

/** Claude's answer, its first lines (the page's box shows it). */
function clipLines(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).filter(Boolean).slice(0, 3).join('\n');
  return lines.length > 600 ? `${lines.slice(0, 599)}…` : lines;
}
