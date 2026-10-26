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
  DEFAULT_LIMITS,
  KEEP_IN_STATE,
  MAX_RUN_AT_ONCE,
  type Recipe,
  type Run,
  type RunBy,
  type RunDetail,
  type RunSummary,
  type RunTrigger,
  type Sentinel,
  type SentinelDraft,
  type SentinelPatch,
  type SentinelState,
  type Step,
  type StepDraft,
  STEP_INFO,
  accessAllows,
  accessNeeded,
  ACCESS_INFO,
  isLive,
  keepRuns,
  lastRunOf,
  scheduleSentence,
  sentinelLabel,
  toSummary,
} from './model.js';
import { describeSentinels, sentinelNote } from './prompt.js';
import { RECIPES } from './recipes.js';
import { type ActiveRun, OUTPUT_KEPT, type SentinelClaude, type SentinelPlaces, type SentinelShell, SentinelRunner, runSentinelShell } from './runner.js';
import { StepInputSchema } from './schema.js';
import type { ToolDraft } from './tool-draft.js';

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
}

const TICK_MS = 30_000;
const FIRST_TICK_MS = 10_000;
/** A run over its runs per day says this. */
const OVER_DAY = 'Over its runs per day';
const MAX_SENTINELS = 200;

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

  constructor(private readonly deps: SentinelsDeps) {
    this.now = deps.now ?? Date.now;
    this.file = new SentinelFile(deps.dir, this.now, deps.saveDelayMs ?? 300);
    this.folders = new RunFolders(deps.dir);
    const data = this.file.load();
    this.runAtOnce = data.runAtOnce;
    const at = this.now();
    this.items = data.items.map((s) => (!s.paused && s.trigger.kind === 'schedule' && s.lastScheduledAt === undefined ? { ...s, lastScheduledAt: at } : s));
    // Runs that were going when Beluga closed (or crashed) ended there.
    this.runs = data.runs.map((r) => (isLive(r.state) ? { ...r, state: 'failed', why: 'Beluga closed while it ran', headline: 'Beluga closed while it ran', endedAt: r.endedAt ?? at, steps: r.steps.map((s) => (s.state === 'running' || s.state === 'waiting' ? { ...s, state: 'skipped' as const } : s)) } : r));
    this.sweepFolders();
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
    });
    deps.store.dispatch({ type: 'sentinel_init', state: this.state() });
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
    return { enabled: true, items: this.items, runs: index, live, runAtOnce: this.runAtOnce, nextAt };
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
      limits: { ...DEFAULT_LIMITS, ...draft.limits },
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
      limits: { ...was.limits, ...patch.limits },
      ...(patch.notify ? { notify: patch.notify } : {}),
      // A new schedule starts from now: nothing it would have run before is caught up.
      ...(triggerChanged ? { lastScheduledAt: this.now() } : {}),
      updatedAt: this.now(),
    };
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
    this.active.get(s.id)?.abort.abort();
    this.queued.delete(s.id);
    this.items = this.items.filter((i) => i.id !== s.id);
    this.runs = this.runs.filter((r) => r.sentinelId !== s.id);
    this.deps.store.dispatch({ type: 'sentinel_remove', id: s.id });
    this.save();
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
  start(ref: string, by: RunBy, trigger?: RunTrigger): RunSummary {
    const s = this.need(ref);
    const yours = by === 'you' || by === 'phone';
    if (s.paused && !yours) throw new Error(`“${s.name}” is paused: turn it on first`);
    const fired: RunTrigger = trigger ?? { kind: yours || by === 'claude' ? 'manual' : s.trigger.kind, summary: by === 'you' ? 'You pressed Run' : by === 'phone' ? 'You ran it from your phone' : by === 'claude' ? 'Your Claude ran it' : scheduleSentence(s.trigger) };
    const limit = s.limits.perDay;
    if (limit && !yours) {
      const today = startOfDay(this.now());
      const ran = this.runs.filter((r) => r.sentinelId === s.id && r.startedAt >= today && !(r.state === 'skipped' && r.why === OVER_DAY)).length;
      if (ran >= limit) return this.note(s, by, fired, OVER_DAY, `Skipped: it ran ${limit} ${limit === 1 ? 'time' : 'times'} today already`);
    }
    if (this.active.has(s.id)) {
      const waiting = this.queued.get(s.id);
      if (waiting) return waiting;
      const run = this.newRun(s, by, fired, 'queued');
      this.queued.set(s.id, { ...toSummary(run), ...(fired.payload !== undefined ? { payload: fired.payload } : {}) });
      this.record(run);
      return toSummary(run);
    }
    return toSummary(this.launch(s, this.newRun(s, by, fired, 'running')));
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
   * A run waiting for you (a merge, docs/sentinel.md §5): Merge or Not Now. Merging is phase 2;
   * until then only the demo's runs wait like this, and the answer is recorded.
   */
  decide(runId: string, choice: 'merge' | 'skip'): RunSummary {
    const run = this.runs.find((r) => r.id === runId);
    if (!run || run.state !== 'needs-you' || [...this.active.values()].some((a) => a.run.id === runId)) throw new Error('Merging from a sentinel isn’t available yet: it comes with the next part of Sentinel');
    const next: RunSummary = choice === 'merge' ? { ...run, state: 'done', headline: run.pr ? `Merged #${run.pr.number}` : 'Merged', endedAt: this.now() } : { ...run, state: 'stopped', headline: run.pr ? `Not now: #${run.pr.number} stays open` : 'Not now', endedAt: this.now() };
    this.recordSummary(next);
    return next;
  }

  /** The clock: start what's due (the Mac waking from sleep shows as a gap since the last look). */
  tick(): void {
    if (this.closed) return;
    const now = this.now();
    const every = this.deps.tickMs || TICK_MS;
    const woke = this.lastTick !== undefined && now - this.lastTick > 3 * every;
    this.lastTick = now;
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
    return { tools: this.toolsFor(active), brief: active?.claude ? active.claude.brief : sentinelNote(), inRun: Boolean(active?.claude) };
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
  demoSet(ref: string, patch: { readonly paused?: boolean; readonly failures?: number; readonly pausedWhy?: string }): Sentinel {
    const next: Sentinel = { ...this.need(ref), ...patch };
    this.replace(next);
    return next;
  }

  /** On the way out: runs going now stop, and everything is written. */
  stopAll(): void {
    this.closed = true;
    for (const off of this.offs) off();
    for (const a of this.active.values()) {
      a.abort.abort();
      this.recordSummary({ ...toSummary(a.run), state: 'stopped', headline: 'Beluga closed while it ran', endedAt: this.now() });
    }
    this.active.clear();
    this.queued.clear();
    this.file.flush();
  }

  // ------------------------------------------------------------------ inside

  private newRun(s: Sentinel, by: RunBy, trigger: RunTrigger, state: Run['state']): Run {
    return { id: short('run', 8), sentinelId: s.id, by, trigger, state, startedAt: this.now(), headline: state === 'queued' ? 'Waiting for the run before it' : '', steps: s.steps.map((st) => ({ id: st.id, state: 'waiting' })), tasks: [] };
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
      .catch((err: unknown) => ({ ...active.run, state: 'failed' as const, why: err instanceof Error ? err.message : String(err), headline: 'Something went wrong', endedAt: this.now() }))
      .then((final) => this.finished(active, final));
    return active.run;
  }

  private finished(active: ActiveRun, run: Run): void {
    if (this.closed) return;
    const sid = active.sentinel.id;
    if (this.active.get(sid) === active) this.active.delete(sid);
    this.record(run);
    const s = this.items.find((i) => i.id === sid);
    if (s) {
      const failures = run.state === 'failed' ? s.failures + 1 : run.state === 'done' || run.state === 'skipped' ? 0 : s.failures;
      const pausing = run.state === 'failed' && s.limits.pauseAfter > 0 && failures >= s.limits.pauseAfter && !s.paused;
      const next: Sentinel = { ...s, failures, ...(pausing ? { paused: true, pausedWhy: `Paused after ${failures} failures in a row` } : {}) };
      if (next.failures !== s.failures || pausing) this.replace(next);
      this.tell(next, run, pausing);
    }
    this.prune();
    const waiting = this.queued.get(sid);
    if (waiting && s) {
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
    this.deps.store.dispatch({ type: 'sentinel_put', item: s, ...(at !== undefined ? { nextAt: at } : {}) });
    this.save();
  }

  private replace(next: Sentinel): void {
    this.items = this.items.map((i) => (i.id === next.id ? next : i));
    this.put(next);
  }

  private record(run: Run): void {
    this.recordSummary(toSummary(run));
  }

  private recordSummary(summary: RunSummary): void {
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

  /** Run folders no run in the index has (a deleted sentinel's, pruned ones Beluga closed before removing). */
  private sweepFolders(): void {
    const root = this.folders.root;
    if (!root) return;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    const ids = new Set(this.runs.map((r) => r.id));
    for (const name of names) if (!ids.has(name)) this.folders.remove(name);
  }

  private save(): void {
    this.file.save(() => ({ runAtOnce: this.runAtOnce, items: this.items, runs: this.runs }));
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

  private toolsFor(active: ActiveRun | undefined): SentinelTools {
    const line = (s: Sentinel): string => {
      const last = lastRunOf(this.state(), s.id);
      const next = this.nextAtOf(s);
      return `${last ? ` · last run ${last.state}${last.headline ? `: ${last.headline}` : ''}` : ''}${next ? ` · next ${new Date(next).toLocaleString()}` : ''}`;
    };
    return {
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
        const s = this.create(fromToolDraft(d));
        return `Made “${s.name}” (${scheduleSentence(s.trigger)}), paused: \`sentinel:${s.id}\`. It runs once the user turns it on from its page.`;
      },
      run: (ref: string) => {
        const s = this.need(ref);
        if (active?.sentinel.id === s.id) throw new Error('This run is that sentinel’s: it can’t start itself');
        const run = this.start(s.id, 'claude');
        return run.state === 'queued' ? `“${s.name}” is running already: this run waits for it` : run.state === 'skipped' ? `“${s.name}” didn’t run: ${run.headline}` : `Started “${s.name}” (\`sentinel:${s.id}\`)`;
      },
      pause: (ref: string, paused: boolean) => {
        const s = this.pause(ref, paused);
        return paused ? `“${s.name}” is paused` : `“${s.name}” is on: ${scheduleSentence(s.trigger)}`;
      },
    };
  }
}

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);

/** Claude's draft as a sentinel draft (its project by name). */
export function fromToolDraft(d: ToolDraft): SentinelDraft {
  return {
    name: d.name,
    ...(d.project ? { projectId: d.project } : {}),
    trigger: d.trigger,
    steps: d.steps.map((st) => (st.kind === 'script' ? { ...st, cwd: st.cwd ?? 'project', timeoutSec: st.timeoutSec ?? 120 } : st.kind === 'notify' ? { ...st, phone: st.phone ?? false } : st)),
    ...(d.access ? { access: d.access } : {}),
    ...(d.notify ? { notify: d.notify } : {}),
  };
}
