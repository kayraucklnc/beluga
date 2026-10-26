import {
  type Access,
  type RunState,
  type RunSummary,
  type ScheduleEvery,
  type ScheduleHours,
  type ScheduleTrigger,
  type Sentinel,
  type SentinelState,
  type Step,
  type StepDraft,
  type StepKind,
  type TriggerKind,
  type Trigger,
  RUN_STATE_INFO,
  STEP_INFO,
  TRIGGER_INFO,
  isLive,
  lastRunOf,
  scheduleSentence,
  stepAvailable,
  stepRefusal,
  triggerAvailable,
} from '../../../../src/core/sentinel/model.js';
import type { IconName } from '../components/Icon.js';
import { ago } from '../tasks/tasks-model.js';

/**
 * Sentinel's window, its plain parts (docs/sentinel.md §3): the list's rows and groups, the
 * sidebar's line, the foot, times and durations in words, the schedule's controls, the Ask Claude
 * presets and the step edits. Pure (tests/mac-sentinel.test.ts).
 */

/** The list's project switch: every sentinel, Your Mac's (no project), or one project's. */
export const MAC_SCOPE = 'mac';
export type Show = 'watching' | 'paused' | 'all';

/** What a later update brings (shown on the disabled choices). */
export const LATER = 'Comes with a later update';

// ---------------------------------------------------------------- icons

const SENTINEL_ICONS: ReadonlySet<string> = new Set(['calendar', 'check', 'refresh', 'tag', 'issue', 'wrench', 'globe', 'eye', 'bell', 'terminal', 'flag', 'pr', 'coin', 'pulse', 'task', 'claude', 'clock', 'hand', 'sentinel', 'laptop', 'search', 'chartLine', 'merge']);

/** A sentinel's (or a recipe's) icon: the name it carries when the window has it, else the shield. */
export const iconOf = (name: string | undefined): IconName => (name && SENTINEL_ICONS.has(name) ? (name as IconName) : 'sentinel');

export const TRIGGER_ICON: Readonly<Record<TriggerKind, IconName>> = {
  schedule: 'clock',
  manual: 'hand',
  after: 'refresh',
  beluga: 'claude',
  github: 'pr',
  stripe: 'coin',
  uptime: 'pulse',
  sentry: 'alert',
  webhook: 'link',
};

export const STEP_ICON: Readonly<Record<StepKind, IconName>> = {
  claude: 'claude',
  script: 'terminal',
  notify: 'bell',
  http: 'globe',
  pr: 'pr',
  merge: 'merge',
  message: 'chat',
  friend: 'people',
  trigger: 'play',
};

// ---------------------------------------------------------------- times

const pad = (n: number): string => String(n).padStart(2, '0');

/** "7:00" (the Mac's local time, 24 hours, as the schedule's sentence says it). */
export const clockOf = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getHours()}:${pad(d.getMinutes())}`;
};

const DAY = 86_400_000;
const startOf = (ts: number): number => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** When a run was: "Today 7:00", "Yesterday 7:00", "Fri 2:00", "Oct 3 2:00". */
export function whenText(ts: number, now: number): string {
  const days = Math.round((startOf(now) - startOf(ts)) / DAY);
  const at = clockOf(ts);
  if (days === 0) return `Today ${at}`;
  if (days === 1) return `Yesterday ${at}`;
  if (days > 1 && days < 7) return `${new Date(ts).toLocaleDateString('en-US', { weekday: 'short' })} ${at}`;
  return `${new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${at}`;
}

/** When it runs next, short: "7:00" today, "Tue 7:00" this week, "Nov 3" later. */
export function nextText(ts: number, now: number): string {
  const days = Math.round((startOf(ts) - startOf(now)) / DAY);
  if (days <= 0) return clockOf(ts);
  if (days === 1) return `tomorrow ${clockOf(ts)}`;
  if (days < 7) return `${new Date(ts).toLocaleDateString('en-US', { weekday: 'short' })} ${clockOf(ts)}`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** How long something took: "48 s", "2.1 s", "4 min 12 s", "1 h 3 min". */
export function durationText(ms: number): string {
  if (ms < 0) return '';
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toString()} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** A run's length: from its start to its end, or to now while it goes. */
export const runDuration = (run: Pick<RunSummary, 'startedAt' | 'endedAt'>, now: number): number => (run.endedAt ?? now) - run.startedAt;

// ---------------------------------------------------------------- the list

export interface Counts {
  readonly watching: number;
  readonly paused: number;
  readonly all: number;
}

export const countsOf = (items: readonly Sentinel[]): Counts => {
  const paused = items.filter((s) => s.paused).length;
  return { watching: items.length - paused, paused, all: items.length };
};

/** In the project switch's scope: every one, Your Mac's, or one project's. */
export const inScope = (s: Pick<Sentinel, 'projectId'>, scope: string | undefined): boolean => (!scope ? true : scope === MAC_SCOPE ? !s.projectId : s.projectId === scope);

/** The list's sentinels: in the scope, watching or paused, matching the filter (name, trigger, steps). */
export function filterSentinels(items: readonly Sentinel[], opts: { readonly scope?: string; readonly show: Show; readonly query?: string }): Sentinel[] {
  const q = opts.query?.trim().toLowerCase();
  return items.filter((s) => {
    if (!inScope(s, opts.scope)) return false;
    if (opts.show === 'watching' && s.paused) return false;
    if (opts.show === 'paused' && !s.paused) return false;
    if (!q) return true;
    const words = [s.name, scheduleSentence(s.trigger), ...s.steps.map((st) => `${st.name} ${STEP_INFO[st.kind].label}`)].join(' ').toLowerCase();
    return words.includes(q);
  });
}

export interface Group {
  /** The project's id (none: Your Mac). */
  readonly projectId?: string;
  readonly name: string;
  readonly items: readonly Sentinel[];
}

/** Rows grouped by project, in the sidebar's order of projects, Your Mac last; names A to Z inside. */
export function groupSentinels(items: readonly Sentinel[], projects: ReadonlyArray<{ readonly id: string; readonly name: string }>): Group[] {
  const byName = (a: Sentinel, b: Sentinel): number => a.name.localeCompare(b.name);
  const out: Group[] = [];
  for (const p of projects) {
    const mine = items.filter((s) => s.projectId === p.id);
    if (mine.length) out.push({ projectId: p.id, name: p.name, items: [...mine].sort(byName) });
  }
  const known = new Set(projects.map((p) => p.id));
  const mac = items.filter((s) => !s.projectId || !known.has(s.projectId));
  if (mac.length) out.push({ name: 'Your Mac', items: [...mac].sort(byName) });
  return out;
}

export interface Row {
  readonly sentence: string;
  readonly last?: { readonly state: RunState; readonly label: string; readonly tone: (typeof RUN_STATE_INFO)[RunState]['tone']; readonly headline: string; readonly when: string; readonly id: string };
  /** "next 7:00" (watching schedules only). */
  readonly next?: string;
  readonly live: boolean;
  readonly steps: ReadonlyArray<{ readonly kind: StepKind; readonly name: string }>;
}

const nameOfIn =
  (state: Pick<SentinelState, 'items'>) =>
  (id: string): string | undefined =>
    state.items.find((i) => i.id === id)?.name;

/** One sentinel's row: its sentence, its last run (pill and headline), when it runs next. */
export function rowOf(state: SentinelState, s: Sentinel, now: number): Row {
  const last = lastRunOf(state, s.id);
  const next = state.nextAt[s.id];
  const info = last ? RUN_STATE_INFO[last.state] : undefined;
  return {
    sentence: scheduleSentence(s.trigger, nameOfIn(state)),
    ...(last && info ? { last: { id: last.id, state: last.state, label: info.label, tone: info.tone, headline: headlineOf(last), when: ago(last.startedAt, now) } } : {}),
    ...(next !== undefined && !s.paused ? { next: `next ${nextText(next, now)}` } : {}),
    live: Boolean(last && isLive(last.state) && last.state !== 'needs-you'),
    steps: s.steps.map((st) => ({ kind: st.kind, name: st.name })),
  };
}

/** A run's one line: its headline, else what it's doing. */
export function headlineOf(run: Pick<RunSummary, 'headline' | 'state' | 'why'>): string {
  if (run.headline) return run.headline;
  if (run.state === 'running') return 'Running…';
  if (run.state === 'queued') return 'Waiting for the run before it';
  return run.why ?? RUN_STATE_INFO[run.state].label;
}

/** The sidebar row's line, and whether it's a problem (paused after failures). */
export function sidebarLine(state: SentinelState): { readonly text: string; readonly problem: boolean } {
  const broken = state.items.find((s) => s.paused && s.pausedWhy);
  if (broken) return { text: broken.pausedWhy ?? 'Paused after failures', problem: true };
  const watching = state.items.filter((s) => !s.paused);
  if (!state.items.length) return { text: 'Nothing watching yet', problem: false };
  if (!watching.length) return { text: `Nothing watching · ${state.items.length} paused`, problem: false };
  const soonest = watching.map((s) => state.nextAt[s.id]).filter((n): n is number => n !== undefined).sort((a, b) => a - b)[0];
  return { text: `${watching.length} watching${soonest !== undefined ? ` · next at ${clockOf(soonest)}` : ''}`, problem: false };
}

/** Whether any run is going now (the sidebar's live dot). */
export const anyRunning = (state: SentinelState): boolean => Object.values(state.live).some((l) => l.state === 'running' || l.state === 'queued');

/** The list's foot: "3 watching · 1 paused · last run 2 min ago". */
export function footLine(items: readonly Sentinel[], runs: readonly RunSummary[], now: number): string {
  const c = countsOf(items);
  const ids = new Set(items.map((s) => s.id));
  const last = runs.filter((r) => ids.has(r.sentinelId)).reduce<number | undefined>((at, r) => (at === undefined || r.startedAt > at ? r.startedAt : at), undefined);
  return [`${c.watching} watching`, ...(c.paused ? [`${c.paused} paused`] : []), ...(last !== undefined ? [`last run ${ago(last, now)}`] : [])].join(' · ');
}

// ---------------------------------------------------------------- runs

/** Who or what started a run, in words: "schedule", "you", "your phone", "after Nightly tests". */
export function byWords(run: Pick<RunSummary, 'by' | 'trigger'>, state: Pick<SentinelState, 'items' | 'runs'>): string {
  switch (run.by) {
    case 'schedule':
      return 'schedule';
    case 'you':
      return 'you';
    case 'phone':
      return 'your phone';
    case 'claude':
      return 'your Claude';
    case 'event':
      return run.trigger.summary || 'an event';
    default: {
      const before = state.runs.find((r) => r.id === run.by.slice('after:'.length));
      const name = before ? state.items.find((s) => s.id === before.sentinelId)?.name : undefined;
      return name ? `after ${name}` : 'after another sentinel';
    }
  }
}

/** Under a run's title: "Nightly tests · ran by schedule · Fri 2:00 · 4 min 12 s". */
export function runLine(run: RunSummary, name: string | undefined, state: Pick<SentinelState, 'items' | 'runs'>, now: number): string {
  const took = run.endedAt !== undefined ? durationText(run.endedAt - run.startedAt) : `${durationText(now - run.startedAt)} so far`;
  return [name ?? 'A sentinel', `ran by ${byWords(run, state)}`, whenText(run.startedAt, now), took].join(' · ');
}

/** The history's dot strip: up to the last 30 runs, oldest first, each with its tone. */
export function dotStrip(runs: readonly RunSummary[], keep = 30): Array<{ readonly id: string; readonly state: RunState; readonly tone: (typeof RUN_STATE_INFO)[RunState]['tone']; readonly label: string }> {
  return [...runs]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-keep)
    .map((r) => ({ id: r.id, state: r.state, tone: RUN_STATE_INFO[r.state].tone, label: `${RUN_STATE_INFO[r.state].label} · ${headlineOf(r)}` }));
}

/** Where a run's chat opens: a worktree's or a project chat's conversation, or one of Your Mac's chats. */
export type ChatPlace = { readonly kind: 'workspace'; readonly id: string } | { readonly kind: 'assistant'; readonly chat?: string };

export function chatPlaceOf(channel: string | undefined): ChatPlace | undefined {
  if (!channel) return undefined;
  if (channel.startsWith('ws:')) return { kind: 'workspace', id: channel.slice(3) };
  if (channel === 'mac:assistant') return { kind: 'assistant' };
  if (channel.startsWith('mac:assistant:')) return { kind: 'assistant', chat: channel.slice('mac:assistant:'.length) };
  return undefined;
}

/** A runs folder from a report's path (…/sentinel/runs/<runId>/report.md), for Open the Runs Folder. */
export function runsFolderOf(runs: ReadonlyArray<Pick<RunSummary, 'report'>>): string | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    const m = /^(.*\/sentinel\/runs)\/[^/]+\/report\.md$/.exec(runs[i]!.report ?? '');
    if (m) return m[1];
  }
  return undefined;
}

// ---------------------------------------------------------------- the When card

export const EVERY_CHOICES: ReadonlyArray<{ readonly value: ScheduleEvery; readonly label: string }> = [
  { value: 'day', label: 'Every day' },
  { value: 'other-day', label: 'Every other day' },
  { value: 'week', label: 'Every week' },
  { value: 'month', label: 'Every month' },
  { value: 'hours', label: 'Every few hours' },
];

export const DEFAULT_SCHEDULE: ScheduleTrigger = { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' };

/** Another "every": the fields that kind needs, the rest kept where they make sense. */
export function withEvery(t: ScheduleTrigger, every: ScheduleEvery): ScheduleTrigger {
  const base = { kind: 'schedule' as const, every, at: t.at, missed: t.missed };
  if (every === 'week') return { ...base, days: t.days?.length ? t.days : [1] };
  if (every === 'month') return { ...base, day: t.day ?? 1 };
  if (every === 'hours') return { ...base, hours: t.hours ?? 3 };
  return base;
}

/** A weekday chip pressed: on or off (one stays on). Monday first, as the chips show them. */
export function toggleDay(days: readonly number[] | undefined, day: number): number[] {
  const now = new Set(days?.length ? days : [1]);
  if (now.has(day)) {
    if (now.size > 1) now.delete(day);
  } else now.add(day);
  return [...now].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
}

/** The chips' order: Monday … Sunday. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

export const HOURS_CHOICES: readonly ScheduleHours[] = [1, 2, 3, 6, 12];

/** "What starts it": schedule and by hand now; the rest shown, for a later update. */
export function triggerChoices(): Array<{ readonly value: TriggerKind; readonly label: string; readonly disabled: boolean; readonly description?: string }> {
  return (Object.keys(TRIGGER_INFO) as TriggerKind[]).map((k) => ({ value: k, label: k === 'schedule' ? 'On a schedule' : TRIGGER_INFO[k].label, disabled: !triggerAvailable(k), ...(triggerAvailable(k) ? {} : { description: LATER }) }));
}

/** A trigger of another kind (only the ones this Beluga runs). */
export function triggerOfKind(kind: TriggerKind, was: Trigger): Trigger | undefined {
  if (kind === was.kind) return was;
  if (kind === 'schedule') return DEFAULT_SCHEDULE;
  if (kind === 'manual') return { kind: 'manual' };
  return undefined;
}

// ---------------------------------------------------------------- the Steps card

/** Ask Claude presets (docs/sentinel.md §1): a good prompt to start from, editable. */
export const CLAUDE_PRESETS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly prompt: string }> = [
  {
    id: 'brief',
    label: 'Write a brief of what changed',
    prompt: [
      'Write a brief for {{project}} ({{date}}) of what changed since the last run: commits on the default branch (`git log --since="24 hours ago"`), pull requests opened, merged or waiting for review (`gh pr list`), new issues (`gh issue list`), the latest CI runs (`gh run list --limit 10`), and these open tasks:',
      '{{tasks}}',
      '',
      'Start with what needs me first, then what moved, then what is next. Short bullets. If nothing changed, say so in one line and stop.',
    ].join('\n'),
  },
  {
    id: 'tasks',
    label: 'Turn this into tasks',
    prompt: [
      'Here is what came in:',
      '{{previous}}',
      '',
      'Make a task with task_create for each real thing worth doing on {{project}}: a short title in your own words, what done means, a priority. One task per thing; skip noise and anything already open:',
      '{{tasks}}',
      '',
      'If there is nothing worth a task, say so and stop.',
    ].join('\n'),
  },
  {
    id: 'fix',
    label: 'Investigate and fix it',
    prompt: [
      'Something needs looking at:',
      '{{trigger}}',
      '{{previous}}',
      '',
      'Find out why it happens and reproduce it. Fix it with the smallest change that is clearly right, add or update a test that shows it, and run the tests. Commit the fix with a message that says what broke. If you can’t reproduce it, say what you tried and stop.',
    ].join('\n'),
  },
  {
    id: 'review',
    label: 'Review the changes',
    prompt: [
      'Review what changed in {{project}} since the last run (`git log --since="24 hours ago" -p`, and open pull requests with `gh pr diff`).',
      '',
      'Look for bugs, missing tests and anything risky; say what to fix, file by file, most important first. Praise nothing; skip style nits. If there is nothing new, say so and stop.',
    ].join('\n'),
  },
  {
    id: 'deps',
    label: 'Update dependencies and run the tests',
    prompt: [
      'Update this project’s dependencies within the ranges its manifest allows, with its own package manager and lockfile.',
      'Run the tests and the type check. If something breaks, fix it when the fix is small and clear; otherwise put that dependency back and say why.',
      'Commit what works with a message listing what moved. If everything is current, say so and stop.',
    ].join('\n'),
  },
  {
    id: 'notes',
    label: 'Write release notes',
    prompt: [
      'Write release notes for {{project}} up to {{date}} from the pull requests merged and the tasks done since the last release.',
      'Group them as New, Better and Fixed, one line each in plain words a user understands, in the voice of the project’s README and earlier notes. Leave out internal chores. If nothing shipped, say so in one line.',
    ].join('\n'),
  },
];

/** The one line under a text field: what it can say. */
export const TEMPLATE_HELP = '{{trigger}}, {{previous}}, {{steps.<name>}}, {{project}}, {{date}}; $VAR from Settings › Environment';

export interface StepChoice {
  readonly kind: StepKind;
  readonly label: string;
  readonly hint: string;
  readonly disabled: boolean;
}

/** Add a step: the nine kinds, each with why it can't be added when it can't (a later update, or the access). */
export function stepChoices(access: Access): StepChoice[] {
  return (Object.keys(STEP_INFO) as StepKind[]).map((kind) => {
    const info = STEP_INFO[kind];
    const later = !stepAvailable(kind);
    const refused = later ? undefined : stepRefusal(access, kind);
    return { kind, label: info.label, hint: later ? LATER : (refused ?? info.hint), disabled: later || Boolean(refused) };
  });
}

/** A new step of a kind this Beluga runs, with what it needs filled in. */
export function newStep(kind: 'claude' | 'script' | 'notify'): StepDraft {
  if (kind === 'claude') return { kind: 'claude', name: 'Ask Claude', prompt: '', where: 'project' };
  if (kind === 'script') return { kind: 'script', name: 'Run a script', command: '', cwd: 'project', timeoutSec: 120 };
  return { kind: 'notify', name: 'Tell me', phone: false };
}

/** Steps moved: `at` goes `by` places (kept in the list). */
export function moveStep<T>(steps: readonly T[], at: number, by: number): T[] {
  const to = at + by;
  if (at < 0 || at >= steps.length || to < 0 || to >= steps.length) return [...steps];
  const out = [...steps];
  const [s] = out.splice(at, 1);
  out.splice(to, 0, s!);
  return out;
}

/** A step copied right after itself (a new id from the daemon, "copy" on its name). */
export function duplicateStep(steps: readonly Step[], at: number): StepDraft[] {
  const s = steps[at];
  if (!s) return [...steps];
  const { id: _id, ...rest } = s;
  const copy = { ...rest, name: `${s.name} copy`.slice(0, 80) } as StepDraft;
  return [...steps.slice(0, at + 1), copy, ...steps.slice(at + 1)];
}

/** One step changed (its fields merged). */
export const patchStep = (steps: readonly Step[], id: string, patch: Partial<Step>): Step[] => steps.map((s) => (s.id === id ? ({ ...s, ...patch } as Step) : s));

// ---------------------------------------------------------------- properties

export const PER_DAY_CHOICES: readonly number[] = [0, 1, 2, 3, 4, 6, 12, 24];
export const PAUSE_AFTER_CHOICES: readonly number[] = [0, 1, 2, 3, 5, 10];

export const perDayLabel = (n: number | undefined): string => (!n ? 'No limit' : n === 1 ? 'Once a day' : `${n} a day`);
export const pauseAfterLabel = (n: number): string => (n === 0 ? 'Never' : n === 1 ? '1 failure' : `${n} failures in a row`);

export const NOTIFY_LABEL: Readonly<Record<Sentinel['notify'], string>> = { mac: 'On the Mac', phone: 'On your phone', both: 'Mac and phone', off: 'Off' };

/** The model the Claude steps share ('' for Claude Code's default, undefined when they differ or there are none). */
export function sharedModel(steps: readonly Step[]): string | undefined {
  const models = new Set(steps.filter((s) => s.kind === 'claude').map((s) => (s.kind === 'claude' ? (s.model ?? '') : '')));
  return models.size === 1 ? [...models][0] : models.size === 0 ? '' : undefined;
}

/** Every Claude step on one model ('' : Claude Code's default). */
export const withModel = (steps: readonly Step[], model: string): Step[] =>
  steps.map((s) => {
    if (s.kind !== 'claude') return s;
    const { model: _m, ...rest } = s;
    return model ? { ...rest, model } : rest;
  });

/** Whether a run's chat (a Claude step's) is there to open. */
export const hasChat = (run: Pick<RunSummary, 'channel' | 'steps'>): boolean => Boolean(run.channel ?? run.steps.some((s) => s.channel));

export const isRunning = (state: RunState): boolean => state === 'running' || state === 'queued';
