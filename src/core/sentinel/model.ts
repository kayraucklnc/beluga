import type { Row, Source } from '../../shared/view-spec.js';
import type { Dashboard } from './dashboard-model.js';

/**
 * Sentinel (docs/sentinel.md): watchers that run on a schedule, by hand, or when something
 * happens, do a short list of steps and leave a report. The types, the state slice every screen
 * sees, and the sentences the window and the phone show. Browser-safe: types and pure functions.
 */

// ---------------------------------------------------------------- triggers

export const TRIGGER_KINDS = ['schedule', 'manual', 'after', 'beluga', 'github', 'stripe', 'uptime', 'sentry', 'webhook'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const SCHEDULE_EVERY = ['hours', 'day', 'other-day', 'week', 'month'] as const;
export type ScheduleEvery = (typeof SCHEDULE_EVERY)[number];
export const SCHEDULE_HOURS = [1, 2, 3, 6, 12] as const;
export type ScheduleHours = (typeof SCHEDULE_HOURS)[number];

export interface ScheduleTrigger {
  readonly kind: 'schedule';
  readonly every: ScheduleEvery;
  /** Local time, "HH:MM" (for `hours`: where the hours line up, "00:00" by default). */
  readonly at: string;
  readonly hours?: ScheduleHours;
  /** For `week`: 0 Sunday … 6 Saturday (Monday when empty). */
  readonly days?: readonly number[];
  /** For `month`: 1…28. */
  readonly day?: number;
  /** A slot that passed while the Mac slept or Beluga was closed: run once when it's back, or skip it. */
  readonly missed: 'catch-up' | 'skip';
}

export interface ManualTrigger {
  readonly kind: 'manual';
}

/** After another sentinel's run ends. */
export interface AfterTrigger {
  readonly kind: 'after';
  readonly sentinelId: string;
  readonly on: 'success' | 'failure' | 'always';
}

export const BELUGA_EVENTS = ['task-done', 'pr-opened', 'pr-merged', 'milestone-passed', 'claude-finished', 'friend-asks'] as const;
export const GITHUB_EVENTS = ['issue-opened', 'issue-labelled', 'pr-opened', 'workflow-failed', 'deployment-failed'] as const;
export const STRIPE_EVENTS = ['payment-failed', 'subscription-started', 'subscription-ended', 'dispute-opened', 'refund'] as const;
export const SENTRY_EVENTS = ['new-issue', 'regression', 'spike'] as const;

/** Phase 3: something in Beluga happened. */
export interface BelugaTrigger {
  readonly kind: 'beluga';
  readonly what: (typeof BELUGA_EVENTS)[number];
  readonly projectId?: string;
}

/** Phase 3: GitHub, polled every `minutes` (2 by default). */
export interface GitHubTrigger {
  readonly kind: 'github';
  readonly what: (typeof GITHUB_EVENTS)[number];
  readonly label?: string;
  readonly minutes?: number;
}

/** Phase 3: the project's Stripe connection (Earnings). */
export interface StripeTrigger {
  readonly kind: 'stripe';
  readonly what: (typeof STRIPE_EVENTS)[number];
}

/** Phase 3: a URL stops answering, or is back (fires on the change, never every check). */
export interface UptimeTrigger {
  readonly kind: 'uptime';
  readonly url: string;
  readonly minutes: 1 | 5 | 15;
  readonly expect?: number;
}

/** Phase 3: Sentry, with $SENTRY_TOKEN from Settings › Environment. */
export interface SentryTrigger {
  readonly kind: 'sentry';
  readonly org: string;
  readonly project: string;
  readonly what: (typeof SENTRY_EVENTS)[number];
}

/** Phase 3: something posts to its URL. The secret never enters the state (sentinel.webhookUrl). */
export interface WebhookTrigger {
  readonly kind: 'webhook';
  readonly signature?: 'github' | 'stripe';
}

export type Trigger = ScheduleTrigger | ManualTrigger | AfterTrigger | BelugaTrigger | GitHubTrigger | StripeTrigger | UptimeTrigger | SentryTrigger | WebhookTrigger;

// ---------------------------------------------------------------- steps

export const STEP_KINDS = ['claude', 'script', 'notify', 'http', 'pr', 'merge', 'message', 'friend', 'trigger', 'measure'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

interface StepBase {
  readonly id: string;
  /** What the window shows ("Read what changed"); `{{steps.<name>}}` finds its output by it. */
  readonly name: string;
}

export type ClaudeWhere = 'project' | 'worktree' | 'mac';

export interface ClaudeStep extends StepBase {
  readonly kind: 'claude';
  readonly prompt: string;
  readonly where: ClaudeWhere;
  readonly model?: string;
  readonly effort?: string;
}

export interface ScriptStep extends StepBase {
  readonly kind: 'script';
  /** One shell line or a script's path. */
  readonly command: string;
  readonly cwd: 'project' | 'home';
  /** 120 by default, up to 3600. */
  readonly timeoutSec: number;
}

export interface NotifyStep extends StepBase {
  readonly kind: 'notify';
  readonly title?: string;
  readonly body?: string;
  readonly phone: boolean;
}

/** Phase 2. */
export interface HttpStep extends StepBase {
  readonly kind: 'http';
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutSec: number;
  readonly preset?: 'groqbot' | 'slack' | 'discord' | 'url';
}

/** Phase 2. */
export interface PrStep extends StepBase {
  readonly kind: 'pr';
  readonly draft?: boolean;
}

/** Phase 2 (§5). */
export interface MergeStep extends StepBase {
  readonly kind: 'merge';
  readonly require: { readonly checks: true; readonly approval: boolean };
  readonly method: 'squash' | 'merge';
}

/** Phase 2. */
export interface MessageStep extends StepBase {
  readonly kind: 'message';
  /** 'dm:<peerId>' or 'group:<id>'. */
  readonly to: string;
  readonly text: string;
}

/** Phase 2. */
export interface FriendStep extends StepBase {
  readonly kind: 'friend';
  readonly peerId: string;
  readonly prompt: string;
  readonly project?: string;
}

/** Phase 2. */
export interface TriggerStep extends StepBase {
  readonly kind: 'trigger';
  readonly sentinelId: string;
}

// ---------------------------------------------------------------- numbers (§10)

/** How a number is shown: a count, money in a currency ("currency:USD"), a percent, a time, a size, or plain. */
export type MetricUnit = 'count' | 'percent' | 'ms' | 'bytes' | 'plain' | `currency:${string}`;
export const METRIC_UNITS: readonly MetricUnit[] = ['count', 'currency:USD', 'currency:EUR', 'percent', 'ms', 'bytes', 'plain'];
/** Which way is good: a drop in failed payments is green. */
export const BETTER = ['up', 'down', 'none'] as const;
export type Better = (typeof BETTER)[number];
export const MEASURE_FROM = ['previous', 'source', 'claude'] as const;
export type MeasureFrom = (typeof MEASURE_FROM)[number];

/** One number (or a table of rows) a measure step keeps. */
export interface MetricSpec {
  /** Stable, the file's name: "subscribers". */
  readonly name: string;
  /** What the window shows ("YouTube subscribers"; the name, said nicely, when none). */
  readonly label?: string;
  /** Where it is: a JSON path ("$.items[0].statistics.subscriberCount", "rows[0].count") or a column ("customers"); none: its name. */
  readonly pick?: string;
  readonly unit?: MetricUnit;
  readonly better?: Better;
  /** A number (the default), or the rows themselves ("who ran what last"). */
  readonly kind?: 'number' | 'rows';
}

/** Rows a rows metric keeps from a run, at most (and by default). */
export const ROWS_KEPT = 200;

/** Phase 5 (§10): Keep the numbers. */
export interface MeasureStep extends StepBase {
  readonly kind: 'measure';
  /** The previous step's output, a view source the daemon runs, or what Claude kept with sentinel_measure. */
  readonly from: MeasureFrom;
  /** For `source`: the same JSON views use (sqlite, postgres, http, command, file). Never in a tile. */
  readonly source?: Source;
  /** What it keeps (none: every top-level number, or everything Claude measured). */
  readonly metrics: readonly MetricSpec[];
  /** Rows kept per run for a rows metric (200 by default, at most). */
  readonly keep?: number;
}

export type Step = ClaudeStep | ScriptStep | NotifyStep | HttpStep | PrStep | MergeStep | MessageStep | FriendStep | TriggerStep | MeasureStep;

// ---------------------------------------------------------------- a sentinel

export const ACCESS = ['look', 'work', 'ship'] as const;
export type Access = (typeof ACCESS)[number];

export const NOTIFY_WHERE = ['mac', 'phone', 'both', 'off'] as const;
export type NotifyWhere = (typeof NOTIFY_WHERE)[number];

export interface Limits {
  /** Per run (30 by default): a Claude step still going is cancelled, the run fails as timed out. */
  readonly minutes: number;
  /** Runs per day (none or 0: no limit); over it, a run is skipped with a line in the history. */
  readonly perDay?: number;
  /** Failures in a row that pause the sentinel (3 by default; 0: never). */
  readonly pauseAfter: number;
}

export const DEFAULT_LIMITS: Limits = { minutes: 30, pauseAfter: 3 };
export const TIME_LIMITS = [10, 30, 60, 120] as const;

export interface Sentinel {
  readonly id: string;
  readonly name: string;
  /** An icon name the screens know ("calendar", "wrench"…). */
  readonly icon: string;
  /** The project it works in; none: Your Mac. */
  readonly projectId?: string;
  readonly trigger: Trigger;
  readonly steps: readonly Step[];
  readonly access: Access;
  readonly limits: Limits;
  /** Where the run's end is told. */
  readonly notify: NotifyWhere;
  /** A new sentinel starts paused until you Turn It On. */
  readonly paused: boolean;
  /**
   * Beluga paused it: the banner's words ("Paused after 3 failures in a row"), or CLAUDE_CHANGED
   * when your Claude changed what it can do (pausedWords says it in words).
   */
  readonly pausedWhy?: string;
  /** Failed runs in a row. */
  readonly failures: number;
  /** The schedule's last slot that ran or was skipped (or when it was turned on): the next one comes after it. */
  readonly lastScheduledAt?: number;
  /** The recipe it was made from. */
  readonly recipe?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A step as given: without an id or a name, it gets them. */
export type StepDraft = Step extends infer S ? (S extends Step ? Omit<S, 'id' | 'name'> & { readonly id?: string; readonly name?: string } : never) : never;

/** What makes a sentinel (create, a recipe, Claude's sentinel_create): the rest is filled in. */
export interface SentinelDraft {
  readonly name: string;
  readonly icon?: string;
  readonly projectId?: string | null;
  readonly trigger?: Trigger;
  readonly steps?: readonly StepDraft[];
  readonly access?: Access;
  readonly limits?: Partial<Limits>;
  readonly notify?: NotifyWhere;
  readonly recipe?: string;
}

/** sentinel.update: what changes (projectId null: Your Mac). */
export type SentinelPatch = Partial<Omit<SentinelDraft, 'recipe'>>;

export interface Recipe {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  /** One line for its card. */
  readonly line: string;
  readonly sentinel: SentinelDraft;
  /** A second sentinel made with it, that runs after it (`on`): Nightly tests, then Fix the nightly failure. */
  readonly then?: { readonly on: AfterTrigger['on']; readonly sentinel: SentinelDraft };
  /** Recipes that keep numbers (§10) are listed apart, under Numbers. */
  readonly group?: 'numbers';
}

// ---------------------------------------------------------------- runs

export type RunBy = 'schedule' | 'you' | 'event' | `after:${string}` | 'claude' | 'phone';
export const RUN_STATES = ['queued', 'running', 'needs-you', 'done', 'skipped', 'failed', 'stopped'] as const;
export type RunState = (typeof RUN_STATES)[number];
export type StepState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepRun {
  readonly id: string;
  readonly state: StepState;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** The first 16 KB (the whole thing is in the run's folder). */
  readonly output?: string;
  /** A Claude step's conversation. */
  readonly channel?: string;
  readonly why?: string;
}

export interface RunTrigger {
  readonly kind: TriggerKind;
  /** What fired, in words ("Every day at 7:00", "you pressed Run"). */
  readonly summary: string;
  readonly payload?: unknown;
}

export interface Run {
  readonly id: string;
  readonly sentinelId: string;
  readonly by: RunBy;
  readonly trigger: RunTrigger;
  readonly state: RunState;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** One line: "4 tasks created, 1 PR opened". */
  readonly headline: string;
  readonly steps: readonly StepRun[];
  /** The last Claude step's conversation. */
  readonly channel?: string;
  /** The worktree a Claude step made (later steps share it). */
  readonly worktreeId?: string;
  readonly pr?: { readonly number: number; readonly url: string };
  /** The pull request's head commit its checks passed on and Claude reviewed: the merge is pinned to it. */
  readonly prHead?: string;
  /** When it went needs-you (the 24 hours count from here). */
  readonly waitingSince?: number;
  /** Keys of the tasks it made. */
  readonly tasks: readonly string[];
  /** Where report.md is (none in memory-only runs: sentinel.runGet still has its text). */
  readonly report?: string;
  /** Failed: why, in words. */
  readonly why?: string;
  /**
   * The sentinels that led to it (after, Run another sentinel, an event a sentinel's run made),
   * oldest first: kept on the run, so an event that comes after its run ended (a merge, a task
   * done later) still can't start a loop.
   */
  readonly chain?: readonly string[];
}

/** A run in the index and the state: no outputs, no trigger payload. */
export interface RunSummary extends Omit<Run, 'trigger' | 'steps'> {
  readonly trigger: Omit<RunTrigger, 'payload'>;
  readonly steps: ReadonlyArray<Omit<StepRun, 'output'>>;
}

/** sentinel.runGet: a run with its steps' outputs (the first 16 KB each) and its report's text. */
export interface RunDetail {
  readonly run: Run;
  readonly sentinel?: { readonly id: string; readonly name: string };
  readonly report?: string;
}

export function toSummary(run: Run): RunSummary {
  const { payload: _payload, ...trigger } = run.trigger;
  return { ...run, trigger, steps: run.steps.map(({ output: _output, ...s }) => s) };
}

/** A trigger's payload is kept (and handed to scripts and Claude) up to this much JSON. */
export const PAYLOAD_MAX = 64 * 1024;

/**
 * A payload whose JSON is over PAYLOAD_MAX, cut once: an object keeps its small fields and its
 * biggest one becomes the start of its JSON as text; anything else becomes the start of its JSON.
 * Either way it says `truncated: true`. A payload that fits is the same object.
 */
export function capPayload(payload: unknown, max = PAYLOAD_MAX): unknown {
  if (payload === undefined) return payload;
  let json: string;
  try {
    json = JSON.stringify(payload) ?? '';
  } catch {
    return { truncated: true, text: '' };
  }
  if (json.length <= max) return payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const entries = Object.entries(payload as Record<string, unknown>).map(([k, v]) => ({ k, v, json: JSON.stringify(v) ?? '' }));
    const biggest = entries.reduce((m, e) => (e.json.length > m.json.length ? e : m));
    const rest = Object.fromEntries(entries.filter((e) => e !== biggest).map((e) => [e.k, e.v]));
    const room = max - (JSON.stringify(rest).length + JSON.stringify(biggest.k).length + 24);
    if (room > 1024) return { ...rest, [biggest.k]: cutTo(biggest.json, room), truncated: true };
  }
  return { truncated: true, text: cutTo(json, max - 32) };
}

/** The start of `text` whose JSON (quotes and escapes) is at most `room` long. */
function cutTo(text: string, room: number): string {
  let n = Math.min(text.length, room);
  let cut = text.slice(0, n);
  for (let size = JSON.stringify(cut).length; size > room && n > 0; size = JSON.stringify(cut).length) {
    n = Math.max(0, Math.min(n - 1, Math.floor((n * room) / size) - 1));
    cut = text.slice(0, n);
  }
  return cut;
}

export const isLive = (state: RunState): boolean => state === 'queued' || state === 'running' || state === 'needs-you';

// ---------------------------------------------------------------- the state

export interface SentinelState {
  /** Sentinel runs (the Mac app's daemon); off elsewhere. */
  readonly enabled: boolean;
  readonly items: readonly Sentinel[];
  /** The index, oldest first: per sentinel its last KEEP_IN_STATE runs. */
  readonly runs: readonly RunSummary[];
  /** Runs going now: the step they're on. */
  readonly live: Readonly<Record<string, { readonly stepId?: string; readonly state: RunState }>>;
  /** Claude steps running together across all sentinels (2 by default). */
  readonly runAtOnce: number;
  /** When each watching schedule runs next. */
  readonly nextAt: Readonly<Record<string, number>>;
  /** Your Claude changing a sentinel (sentinel.ask), by sentinel: live, or its answer once done. */
  readonly asks: Readonly<Record<string, SentinelAsk>>;
  /**
   * Why an event sentinel can't watch right now, in words with what to do ("Put SENTRY_TOKEN in
   * Settings › Environment"), by sentinel. Gone once it watches again.
   */
  readonly troubles?: Readonly<Record<string, string>>;
  /** The webhook sentinels' tunnel (one for all of them): up or not, and its address (never a secret). */
  readonly webhook?: WebhookState;
  /** The numbers sentinels keep (§10), by sentinel, then by name: the last 90 points each, never the files. */
  readonly metrics?: Readonly<Record<string, Readonly<Record<string, MetricSeries>>>>;
  /** Your dashboards (~/.beluga/dashboards.json), in their tabs' order. */
  readonly dashboards?: readonly Dashboard[];
  /** A dashboard's Refresh going now: how far ("Fetching… 2 of 3"), by dashboard. */
  readonly refreshing?: Readonly<Record<string, DashboardRefresh>>;
  /** Your Claude building a dashboard (its Describe it), by dashboard. */
  readonly dashboardAsks?: Readonly<Record<string, SentinelAsk>>;
}

/** A point of a number: when its run kept it, and which run. */
export interface MetricPoint {
  readonly at: number;
  readonly value: number;
  readonly runId: string;
}

/** A metric as the screens see it: what it is, its last points (oldest first) and, for rows, its last rows. */
export interface MetricSeries {
  readonly sentinelId: string;
  readonly name: string;
  readonly label: string;
  readonly unit: MetricUnit;
  readonly better: Better;
  readonly kind: 'number' | 'rows';
  /** The last POINTS_IN_STATE (a rows metric's: how many rows each run had). */
  readonly points: readonly MetricPoint[];
  readonly rows?: readonly Row[];
  readonly columns?: readonly string[];
  readonly rowsAt?: number;
  readonly rowsRunId?: string;
}

/** Points per metric in the state (the files keep two years). */
export const POINTS_IN_STATE = 90;

export interface DashboardRefresh {
  readonly done: number;
  readonly total: number;
  /** The sentinel running now. */
  readonly sentinelId?: string;
}

/** The tunnel webhook sentinels share: open only while one is on. `url` is its base (no path, no secret). */
export interface WebhookState {
  readonly ready: boolean;
  readonly url?: string;
  /** Why it isn't up (a failed open), in words. */
  readonly why?: string;
}

/** sentinel.webhookUrl / rotateSecret: its address while the tunnel is up, else why not, in words. */
export interface WebhookAddress {
  readonly url?: string;
  readonly why?: string;
  /** GitHub's signature: the secret its webhook form asks for (Copy Secret), not the URL's. Never in the state. */
  readonly signingSecret?: string;
}

/** Your Claude asked to change a sentinel (the page's box, Describe it): where, and how it's going. */
export interface SentinelAsk {
  /** The conversation (a quiet project chat, or Your Mac's). */
  readonly channel: string;
  readonly startedAt: number;
  readonly state: 'writing' | 'done' | 'failed';
  /** What you asked (its first line). */
  readonly text: string;
  /** Claude's answer once done (its first lines), or what went wrong. */
  readonly answer?: string;
  readonly endedAt?: number;
}

export interface SentinelSlice {
  readonly sentinel: SentinelState;
}

export const KEEP_IN_STATE = 30;
export const KEEP_IN_FILE = 200;
export const DEFAULT_RUN_AT_ONCE = 2;
export const MAX_RUN_AT_ONCE = 6;

export const NO_SENTINEL: SentinelState = { enabled: false, items: [], runs: [], live: {}, runAtOnce: DEFAULT_RUN_AT_ONCE, nextAt: {}, asks: {} };
export const initialSentinel: SentinelSlice = { sentinel: NO_SENTINEL };

export type SentinelAction =
  /** Everything at once (on start, and Run at Once). */
  | { type: 'sentinel_init'; state: SentinelState }
  /** One sentinel changed or was added; `nextAt` its next run (none: not scheduled). */
  | { type: 'sentinel_put'; item: Sentinel; nextAt?: number }
  | { type: 'sentinel_remove'; id: string }
  /** One run changed or began. */
  | { type: 'sentinel_run'; run: RunSummary }
  /** Your Claude changing a sentinel: began, or ended (none: forgotten). */
  | { type: 'sentinel_ask'; id: string; ask?: SentinelAsk }
  /** An event sentinel can't watch (none: it watches again). */
  | { type: 'sentinel_trouble'; id: string; trouble?: string }
  /** The webhook tunnel opened, closed or moved. */
  | { type: 'sentinel_webhook'; webhook: WebhookState }
  /** A metric kept a new point (or rows), or was made. */
  | { type: 'sentinel_metric'; metric: MetricSeries }
  /** The dashboards changed (all of them: they're small). */
  | { type: 'sentinel_dashboards'; dashboards: readonly Dashboard[] }
  /** A dashboard's Refresh moved on, or ended (none). */
  | { type: 'sentinel_refresh'; id: string; refreshing?: DashboardRefresh }
  /** Your Claude building a dashboard: began, or ended (none: forgotten). */
  | { type: 'sentinel_dashboard_ask'; id: string; ask?: SentinelAsk }
  | { type: 'sentinel_off' };

export const SENTINEL_ACTIONS: ReadonlySet<string> = new Set(['sentinel_init', 'sentinel_put', 'sentinel_remove', 'sentinel_run', 'sentinel_ask', 'sentinel_trouble', 'sentinel_webhook', 'sentinel_metric', 'sentinel_dashboards', 'sentinel_refresh', 'sentinel_dashboard_ask', 'sentinel_off']);

/** The step a live run is on: the running one, else the first still waiting. */
const liveStep = (run: RunSummary): string | undefined => (run.steps.find((s) => s.state === 'running') ?? run.steps.find((s) => s.state === 'waiting'))?.id;

/** Per sentinel, its last `keep` runs (oldest first overall). */
export function keepRuns<R extends { readonly sentinelId: string }>(runs: readonly R[], keep: number): R[] {
  const seen = new Map<string, number>();
  const out: R[] = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    const n = seen.get(r.sentinelId) ?? 0;
    if (n >= keep) continue;
    seen.set(r.sentinelId, n + 1);
    out.push(r);
  }
  return out.reverse();
}

export function reduceSentinel(state: SentinelSlice, action: SentinelAction): SentinelSlice {
  const s = state.sentinel;
  switch (action.type) {
    case 'sentinel_init':
      return { sentinel: action.state };
    case 'sentinel_put': {
      const at = s.items.findIndex((i) => i.id === action.item.id);
      const items = at >= 0 ? s.items.map((i, n) => (n === at ? action.item : i)) : [...s.items, action.item];
      const { [action.item.id]: _old, ...rest } = s.nextAt;
      return { sentinel: { ...s, items, nextAt: action.nextAt !== undefined ? { ...rest, [action.item.id]: action.nextAt } : rest } };
    }
    case 'sentinel_remove': {
      const { [action.id]: _old, ...nextAt } = s.nextAt;
      const gone = new Set(s.runs.filter((r) => r.sentinelId === action.id).map((r) => r.id));
      const live = Object.fromEntries(Object.entries(s.live).filter(([id]) => !gone.has(id)));
      const { [action.id]: _ask, ...asks } = s.asks ?? {};
      const { [action.id]: _trouble, ...troubles } = s.troubles ?? {};
      const { [action.id]: _metrics, ...metrics } = s.metrics ?? {};
      return { sentinel: { ...s, items: s.items.filter((i) => i.id !== action.id), runs: s.runs.filter((r) => r.sentinelId !== action.id), nextAt, live, asks, troubles, metrics } };
    }
    case 'sentinel_metric': {
      const m = action.metric;
      const all = s.metrics ?? {};
      return { sentinel: { ...s, metrics: { ...all, [m.sentinelId]: { ...all[m.sentinelId], [m.name]: m } } } };
    }
    case 'sentinel_dashboards':
      return { sentinel: { ...s, dashboards: action.dashboards } };
    case 'sentinel_refresh': {
      const { [action.id]: _was, ...refreshing } = s.refreshing ?? {};
      return { sentinel: { ...s, refreshing: action.refreshing ? { ...refreshing, [action.id]: action.refreshing } : refreshing } };
    }
    case 'sentinel_dashboard_ask': {
      const { [action.id]: _was, ...asks } = s.dashboardAsks ?? {};
      return { sentinel: { ...s, dashboardAsks: action.ask ? { ...asks, [action.id]: action.ask } : asks } };
    }
    case 'sentinel_trouble': {
      const { [action.id]: _was, ...troubles } = s.troubles ?? {};
      return { sentinel: { ...s, troubles: action.trouble ? { ...troubles, [action.id]: action.trouble } : troubles } };
    }
    case 'sentinel_webhook':
      return { sentinel: { ...s, webhook: action.webhook } };
    case 'sentinel_ask': {
      const { [action.id]: _was, ...asks } = s.asks ?? {};
      return { sentinel: { ...s, asks: action.ask ? { ...asks, [action.id]: action.ask } : asks } };
    }
    case 'sentinel_run': {
      const run = action.run;
      const at = s.runs.findIndex((r) => r.id === run.id);
      const runs = keepRuns(at >= 0 ? s.runs.map((r, n) => (n === at ? run : r)) : [...s.runs, run], KEEP_IN_STATE);
      const { [run.id]: _was, ...rest } = s.live;
      const step = liveStep(run);
      const live = isLive(run.state) ? { ...rest, [run.id]: { ...(step ? { stepId: step } : {}), state: run.state } } : rest;
      return { sentinel: { ...s, runs, live } };
    }
    case 'sentinel_off':
      return { sentinel: NO_SENTINEL };
    default:
      return state;
  }
}

// ---------------------------------------------------------------- for screens and Claude

export const sentinelById = (state: SentinelState, id: string): Sentinel | undefined => state.items.find((i) => i.id === id);

/** A sentinel's runs in the state, newest first. */
export const runsOf = (state: SentinelState, sentinelId: string): RunSummary[] => state.runs.filter((r) => r.sentinelId === sentinelId).reverse();

export const lastRunOf = (state: SentinelState, sentinelId: string): RunSummary | undefined => {
  for (let i = state.runs.length - 1; i >= 0; i--) if (state.runs[i]!.sentinelId === sentinelId) return state.runs[i];
  return undefined;
};

/**
 * The sentinel a worktree or chat belongs to: one its runs made (a Claude step's worktree or
 * conversation). Such a place folds under the sentinel's row, not the project's (as plans own
 * their tasks' worktrees, core/plans/owner.ts).
 */
export function sentinelOwnerOf(state: SentinelState, workspaceId: string): Sentinel | undefined {
  const channel = `ws:${workspaceId}`;
  for (let i = state.runs.length - 1; i >= 0; i--) {
    const r = state.runs[i]!;
    if (r.worktreeId === workspaceId || r.channel === channel || r.steps.some((s) => s.channel === channel)) return sentinelById(state, r.sentinelId);
  }
  return undefined;
}

/** A conversation a sentinel's run made: whose, and which run (the newest that used it; '' for the chat where Claude changes it). */
export interface SentinelPlaceOwner {
  readonly sentinel: Sentinel;
  readonly runId: string;
}

const owned = new WeakMap<SentinelState, ReadonlyMap<string, SentinelPlaceOwner>>();

/**
 * Every conversation sentinel runs made, by channel (`ws:<id>` for a project chat or worktree,
 * `mac:assistant:<id>` for Your Mac's): its Claude steps' chats and the run's worktree, and the chat
 * where your Claude changes it. Worked out
 * once per state (screens ask for every row). Such a conversation is the sentinel's, not one of
 * yours: it stays out of Unread and the counts (packages/mac/src/layout/attention-model.ts).
 */
export function sentinelChannels(state: SentinelState): ReadonlyMap<string, SentinelPlaceOwner> {
  const hit = owned.get(state);
  if (hit) return hit;
  const map = new Map<string, SentinelPlaceOwner>();
  const items = new Map(state.items.map((i) => [i.id, i]));
  // Newest first: a conversation two runs shared is the newest one's.
  for (let i = state.runs.length - 1; i >= 0; i--) {
    const r = state.runs[i]!;
    const sentinel = items.get(r.sentinelId);
    if (!sentinel) continue;
    const add = (channel: string | undefined): void => {
      if (channel && !map.has(channel)) map.set(channel, { sentinel, runId: r.id });
    };
    add(r.channel);
    for (const s of r.steps) add(s.channel);
    if (r.worktreeId) add(`ws:${r.worktreeId}`);
  }
  // The chat where your Claude changes it (sentinel.ask): the sentinel's page shows it.
  for (const [id, ask] of Object.entries(state.asks ?? {})) {
    const sentinel = items.get(id);
    if (sentinel && !map.has(ask.channel)) map.set(ask.channel, { sentinel, runId: '' });
  }
  owned.set(state, map);
  return map;
}

/** The sentinel run a conversation belongs to, if any. */
export const sentinelOfChannel = (state: SentinelState, channel: string | undefined): SentinelPlaceOwner | undefined => (channel ? sentinelChannels(state).get(channel) : undefined);

/** Tasks a sentinel's Claude makes carry this label ("sentinel:morning-brief"). */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '') || 'sentinel';

export const sentinelLabel = (s: Pick<Sentinel, 'name'>): string => `sentinel:${slugOf(s.name)}`;

export const TRIGGER_INFO: Readonly<Record<TriggerKind, { readonly label: string; readonly phase: 1 | 2 | 3 }>> = {
  schedule: { label: 'On a schedule', phase: 1 },
  manual: { label: 'Only when you press Run', phase: 1 },
  after: { label: 'After another sentinel', phase: 2 },
  beluga: { label: 'When something happens in Beluga', phase: 3 },
  github: { label: 'When something happens on GitHub', phase: 3 },
  stripe: { label: 'When something happens in Stripe', phase: 3 },
  uptime: { label: 'When a site stops answering', phase: 3 },
  sentry: { label: 'When Sentry sees something', phase: 3 },
  webhook: { label: 'When something posts to its URL', phase: 3 },
};

export const STEP_INFO: Readonly<Record<StepKind, { readonly label: string; readonly hint: string; readonly needs: Access; readonly phase: 1 | 2 | 3 | 5 }>> = {
  claude: { label: 'Ask Claude', hint: 'Claude reads, writes a brief, fixes, makes tasks', needs: 'look', phase: 1 },
  script: { label: 'Run a script', hint: 'One shell line or a script, in the project or your home folder', needs: 'look', phase: 1 },
  notify: { label: 'Notify me', hint: 'On the Mac, and the phone if you like, with the report', needs: 'look', phase: 1 },
  http: { label: 'Call a service', hint: 'A web request: Groqbot, Slack, Discord, any URL', needs: 'look', phase: 2 },
  pr: { label: 'Open a pull request', hint: 'From the worktree the run’s Claude step made', needs: 'work', phase: 2 },
  merge: { label: 'Merge if acceptable', hint: 'When the checks pass and you’ve approved', needs: 'ship', phase: 2 },
  message: { label: 'Message a chat', hint: 'A friend or a group, as you', needs: 'look', phase: 2 },
  friend: { label: 'Ask a friend’s Claude', hint: 'As you; their trust applies', needs: 'look', phase: 2 },
  trigger: { label: 'Run another sentinel', hint: 'Starts it with this run’s last output', needs: 'look', phase: 2 },
  measure: { label: 'Keep the numbers', hint: 'Numbers or rows from the step before, a source, or Claude, kept over time', needs: 'look', phase: 5 },
};

/** The steps and triggers this Beluga runs (phase 5: every one); later ones show, but a run says they aren't available yet. */
export const SENTINEL_PHASE = 5;
export const stepAvailable = (kind: StepKind): boolean => STEP_INFO[kind].phase <= SENTINEL_PHASE;
export const triggerAvailable = (kind: TriggerKind): boolean => TRIGGER_INFO[kind].phase <= SENTINEL_PHASE;

export const ACCESS_INFO: Readonly<Record<Access, { readonly label: string; readonly sentence: string }>> = {
  look: { label: 'Look', sentence: 'Claude can look and tell you' },
  work: { label: 'Work', sentence: 'Claude can change code in a worktree and open pull requests' },
  ship: { label: 'Ship', sentence: 'Claude can change code in a worktree, open pull requests, and merge when the checks pass and you’ve approved' },
};

/** Access ranked: Look < Work < Ship. */
export const accessRank = (a: Access): number => RANK[a];

/** pausedWhy when your Claude changed what a sentinel can do (a script, a service, a pull request, a merge, more access). */
export const CLAUDE_CHANGED = 'claude-changed';

/** Why a sentinel is paused, in words (none: you paused it, or it's new). */
export function pausedWords(s: Pick<Sentinel, 'paused' | 'pausedWhy'>): string | undefined {
  if (!s.paused || !s.pausedWhy) return undefined;
  return s.pausedWhy === CLAUDE_CHANGED ? 'Claude changed what it can do' : s.pausedWhy;
}

/** The banner on a sentinel Claude changed. */
export const CLAUDE_CHANGED_BANNER = 'Claude changed what this sentinel can do. Turn On to let it run.';

/** Steps whose change by Claude pauses the sentinel (they run things, call out, or ship). */
export const GUARDED_STEPS: ReadonlySet<StepKind> = new Set(['script', 'http', 'pr', 'merge']);

/** A guarded step, or a Keep the numbers step that runs a source (a query, a command, a request). */
const isGuarded = (st: Step): boolean => GUARDED_STEPS.has(st.kind) || (st.kind === 'measure' && st.from === 'source');

/** A step's content, without its id and name (what it does, not what it's called). */
const stepContent = (st: Step): string => {
  const { id: _id, name: _name, ...rest } = st;
  return stable(rest);
};

/** JSON with every object's keys in order, so the same content reads the same. */
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);

/** Who or what a step reaches (a chat, a friend, another sentinel); undefined for the other kinds. */
const stepTarget = (st: Step): string | undefined => (st.kind === 'message' ? `message:${st.to}` : st.kind === 'friend' ? `friend:${st.peerId}` : st.kind === 'trigger' ? `trigger:${st.sentinelId}` : undefined);

/**
 * What a trigger watches, without how often or when: its kind and its target (the other
 * sentinel, the event, the repository's label, the URL, the Sentry project, the signature).
 * A schedule's times aren't a target: changing when it runs isn't widening.
 */
const triggerTarget = (t: Trigger): string => {
  switch (t.kind) {
    case 'schedule':
    case 'manual':
      return t.kind;
    case 'after':
      return `after:${t.sentinelId}`;
    case 'beluga':
      return stable({ k: t.kind, what: t.what, projectId: t.projectId });
    case 'github':
      return stable({ k: t.kind, what: t.what, label: t.label });
    case 'stripe':
      return stable({ k: t.kind, what: t.what });
    case 'uptime':
      return stable({ k: t.kind, url: t.url });
    case 'sentry':
      return stable({ k: t.kind, org: t.org, project: t.project, what: t.what });
    case 'webhook':
      return stable({ k: t.kind, signature: t.signature });
  }
};

/**
 * Whether a change widened what a sentinel can do (docs/sentinel.md §3, "Rules"): a script, a
 * service call, a pull request or a merge step added or edited; more access; another project; a
 * message to another chat, a question to another friend, another sentinel run; or a trigger of
 * another kind or target. A change to the name, the schedule's times, a prompt or Notify doesn't;
 * removing a step doesn't either.
 */
export function claudeWidened(was: Pick<Sentinel, 'steps' | 'access'> & Partial<Pick<Sentinel, 'projectId' | 'trigger'>>, next: Pick<Sentinel, 'steps' | 'access'> & Partial<Pick<Sentinel, 'projectId' | 'trigger'>>): boolean {
  if (RANK[next.access] > RANK[was.access]) return true;
  if ((next.projectId ?? '') !== (was.projectId ?? '')) return true;
  if (was.trigger && next.trigger && triggerTarget(was.trigger) !== triggerTarget(next.trigger)) return true;
  const before = new Set(was.steps.filter(isGuarded).map(stepContent));
  if (next.steps.some((st) => isGuarded(st) && !before.has(stepContent(st)))) return true;
  const reached = new Set(was.steps.map(stepTarget).filter((t) => t !== undefined));
  return next.steps.some((st) => {
    const t = stepTarget(st);
    return t !== undefined && !reached.has(t);
  });
}

// ---------------------------------------------------------------- service presets

export type ServicePreset = NonNullable<HttpStep['preset']>;

/**
 * The Call a service step's presets (docs/sentinel.md §6): they only fill the fields; everything
 * stays editable. `$VAR` comes from Settings › Environment.
 */
export const SERVICE_PRESETS: Readonly<Record<ServicePreset, { readonly label: string; readonly line: string; readonly method: HttpStep['method']; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly note?: string }>> = {
  groqbot: {
    label: 'Groqbot',
    line: 'Search the web with Groqbot',
    method: 'POST',
    url: '',
    headers: { Authorization: 'Bearer $GROQBOT_KEY', 'Content-Type': 'application/json' },
    body: '{"query": "{{previous}}"}',
    note: 'A placeholder: Groqbot’s address and the shape of its answer are filled in once its API is settled. Put your key in Settings › Environment as GROQBOT_KEY.',
  },
  slack: {
    label: 'Slack webhook',
    line: 'Post to a Slack channel (an incoming webhook)',
    method: 'POST',
    url: '$SLACK_WEBHOOK_URL',
    headers: { 'Content-Type': 'application/json' },
    body: '{"text": "{{sentinel}}: {{previous}}"}',
    note: 'Make an incoming webhook in Slack and keep its address in Settings › Environment as SLACK_WEBHOOK_URL.',
  },
  discord: {
    label: 'Discord webhook',
    line: 'Post to a Discord channel (a webhook)',
    method: 'POST',
    url: '$DISCORD_WEBHOOK_URL',
    headers: { 'Content-Type': 'application/json' },
    body: '{"content": "{{sentinel}}: {{previous}}"}',
    note: 'Make a webhook in the Discord channel’s settings and keep its address in Settings › Environment as DISCORD_WEBHOOK_URL.',
  },
  url: { label: 'Any URL', line: 'A web request of your own', method: 'GET', url: 'https://', headers: {} },
};

/** An http step's fields from a preset (its name and timeout kept). */
export function presetFields(preset: ServicePreset): Pick<HttpStep, 'method' | 'url' | 'headers' | 'preset'> & { readonly body?: string } {
  const p = SERVICE_PRESETS[preset];
  return { preset, method: p.method, url: p.url, headers: { ...p.headers }, ...(p.body !== undefined ? { body: p.body } : {}) };
}

/** How long a merge waits for your Merge before the run stops (24 hours). */
export const APPROVAL_MS = 24 * 60 * 60_000;

const RANK: Readonly<Record<Access, number>> = { look: 0, work: 1, ship: 2 };

/** What a step needs: a Claude step in a worktree changes code (Work). */
export const accessNeeded = (kind: StepKind, where?: ClaudeWhere): Access => (kind === 'claude' && where === 'worktree' ? 'work' : STEP_INFO[kind].needs);

/** Whether a sentinel with this access may have this step. */
export const accessAllows = (access: Access, kind: StepKind, where?: ClaudeWhere): boolean => RANK[access] >= RANK[accessNeeded(kind, where)];

/** Why a step can't be added (shown on the disabled menu item), or undefined when it can. */
export function stepRefusal(access: Access, kind: StepKind, where?: ClaudeWhere): string | undefined {
  if (accessAllows(access, kind, where)) return undefined;
  const needs = accessNeeded(kind, where);
  return `Needs ${ACCESS_INFO[needs].label} access`;
}

export const RUN_STATE_INFO: Readonly<Record<RunState, { readonly label: string; readonly tone: 'muted' | 'neutral' | 'claude' | 'info' | 'ok' | 'error' }>> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'claude' },
  'needs-you': { label: 'Needs you', tone: 'info' },
  done: { label: 'Done', tone: 'ok' },
  skipped: { label: 'Skipped', tone: 'muted' },
  failed: { label: 'Failed', tone: 'error' },
  stopped: { label: 'Stopped', tone: 'muted' },
};

// ---------------------------------------------------------------- sentences

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** "07:00" → "7:00". */
export function clockText(at: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  return m ? `${Number(m[1])}:${m[2]}` : at;
}

/** 1 → "1st", 22 → "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

const WORDS: Readonly<Record<string, string>> = {
  'task-done': 'a task is done',
  'pr-opened': 'a pull request opens',
  'pr-merged': 'a pull request merges',
  'milestone-passed': 'a milestone passes',
  'claude-finished': 'a worktree’s Claude finishes',
  'friend-asks': 'a friend asks something',
  'issue-opened': 'an issue opens',
  'issue-labelled': 'an issue gets a label',
  'workflow-failed': 'a workflow fails',
  'deployment-failed': 'a deployment fails',
  'payment-failed': 'a payment fails',
  'subscription-started': 'a subscription starts',
  'subscription-ended': 'a subscription ends',
  'dispute-opened': 'a dispute opens',
  refund: 'a refund happens',
  'new-issue': 'Sentry sees a new issue',
  regression: 'Sentry sees a regression',
  spike: 'Sentry sees a spike',
};

/**
 * When a sentinel runs, in one sentence: the one truth the row, the page and the phone show.
 * `nameOf` names another sentinel (for `after`).
 */
export function scheduleSentence(trigger: Trigger, nameOf: (id: string) => string | undefined = () => undefined): string {
  switch (trigger.kind) {
    case 'schedule': {
      const at = clockText(trigger.at);
      switch (trigger.every) {
        case 'hours': {
          const n = trigger.hours ?? 1;
          return n === 1 ? 'Every hour' : `Every ${n} hours`;
        }
        case 'day':
          return `Every day at ${at}`;
        case 'other-day':
          return `Every other day at ${at}`;
        case 'week': {
          const days = [...new Set(trigger.days?.length ? trigger.days : [1])].filter((d) => d >= 0 && d <= 6).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
          if (days.length === 7) return `Every day at ${at}`;
          if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return `Every weekday at ${at}`;
          if (days.length === 2 && days.includes(0) && days.includes(6)) return `Every weekend day at ${at}`;
          return `Every week on ${days.map((d) => DAY_NAMES[d]).join(', ')} at ${at}`;
        }
        case 'month':
          return `Every month on the ${ordinal(trigger.day ?? 1)} at ${at}`;
      }
      return at;
    }
    case 'manual':
      return 'Only when you press Run';
    case 'after': {
      const name = nameOf(trigger.sentinelId);
      const other = name ? `“${name}”` : 'another sentinel';
      return trigger.on === 'success' ? `After ${other} succeeds` : trigger.on === 'failure' ? `After ${other} fails` : `After ${other} runs`;
    }
    case 'beluga':
      return `When ${WORDS[trigger.what] ?? trigger.what}`;
    case 'github':
      return trigger.what === 'issue-labelled' && trigger.label ? `When an issue gets the label “${trigger.label}” on GitHub` : `When ${WORDS[trigger.what] ?? trigger.what} on GitHub`;
    case 'stripe':
      return `When ${WORDS[trigger.what] ?? trigger.what} in Stripe`;
    case 'uptime':
      return `When ${hostOf(trigger.url)} stops answering (checked every ${trigger.minutes === 1 ? 'minute' : `${trigger.minutes} minutes`}), and when it’s back`;
    case 'sentry':
      return `When ${WORDS[trigger.what] ?? trigger.what}${trigger.org && trigger.project ? ` in ${trigger.org}/${trigger.project}` : ''}`;
    case 'webhook':
      return trigger.signature === 'github' ? 'When GitHub posts to its URL' : trigger.signature === 'stripe' ? 'When Stripe posts to its URL' : 'When something posts to its URL';
  }
}

/** When a sentinel runs, in one sentence, for every kind of trigger (scheduleSentence's name for what it is now). */
export const triggerSentence = scheduleSentence;

export function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return m?.[1] ?? url;
}

const quoteLine = (text: string, max = 60): string => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What a step does, in one line (the steps card, the run's timeline). */
export function stepSentence(step: Step, nameOf: (id: string) => string | undefined = () => undefined): string {
  switch (step.kind) {
    case 'claude': {
      const where = step.where === 'worktree' ? 'in a new worktree' : step.where === 'mac' ? 'on Your Mac' : 'in the project';
      const what = quoteLine(step.prompt);
      return what ? `Claude ${where}: “${what}”` : `Claude ${where}`;
    }
    case 'script':
      return `Runs \`${quoteLine(step.command, 50)}\` in ${step.cwd === 'home' ? 'your home folder' : 'the project'}`;
    case 'notify':
      return step.phone ? 'Tells you on the Mac and the phone' : 'Tells you on the Mac';
    case 'http':
      return step.preset && step.preset !== 'url' ? `${SERVICE_PRESETS[step.preset].label}: ${step.method} ${hostOf(step.url) || 'its address'}` : `${step.method} ${hostOf(step.url) || 'a URL'}`;
    case 'pr':
      return step.draft ? 'Opens a draft pull request' : 'Opens a pull request';
    case 'merge':
      return step.require.approval ? 'Merges when the checks pass and you approve' : 'Merges by itself when the checks pass';
    case 'message': {
      const name = nameOf(step.to);
      return name ? `Messages ${name}` : `Messages ${step.to.startsWith('group:') ? 'a group' : 'a friend'}`;
    }
    case 'friend': {
      const name = nameOf(step.peerId);
      return name ? `Asks ${name}’s Claude` : 'Asks a friend’s Claude';
    }
    case 'trigger': {
      const name = nameOf(step.sentinelId);
      return name ? `Runs “${name}”` : 'Runs another sentinel';
    }
    case 'measure': {
      const names = step.metrics.map((m) => m.label || m.name).filter(Boolean);
      const what = names.length ? (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')) : step.from === 'claude' ? 'the numbers Claude measures' : 'every number';
      const from = step.from === 'previous' ? ' from the step before' : step.from === 'source' ? ` from ${step.source ? `a ${step.source.kind} source` : 'a source (pick one)'}` : '';
      return `Keeps ${what}${step.from === 'claude' && names.length ? ' that Claude measures' : from}`;
    }
  }
}

/** One line from a report or an output: its first line, without Markdown marks. */
export function firstLine(text: string, max = 140): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^#+\s*|^[-*>]\s+/, '').replace(/[*_`]/g, '').trim())
      .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
