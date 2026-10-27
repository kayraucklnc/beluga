import type { NeedsYou, SentinelPageView, SentinelRunView, SentinelSummary, SentinelsView, Topic } from '../protocol';
import { type DemoNumbers, makeNumbers, numbersOf } from './dashboard';

/**
 * The demo Mac's sentinels (1.21), as src/core/sentinel/demo.ts seeds the Mac's: a Morning brief
 * with a week of reports, Fix what broke with a merge waiting for you, Nightly tests paused after
 * three failed nights, and Watch the web with a run going now. Views are built as views.ts builds
 * them; reports come through `sentinel.runGet` (the demo hands out no report refs).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface DemoRun extends SentinelRunView {
  /** Its report's text (sentinel.runGet). */
  text?: string;
}

interface DemoSentinel {
  summary: Omit<SentinelSummary, 'last' | 'live'>;
  steps: SentinelPageView['steps'];
  runs: DemoRun[];
}

export interface DemoSentinels {
  items: DemoSentinel[];
  /** 1.22: the numbers four of them keep, and the dashboards that show them (./dashboard.ts). */
  numbers: DemoNumbers;
}

/** The day `daysAgo` before today at hh:mm. */
const at = (daysAgo: number, hh: number, mm = 0): number => {
  const d = new Date(Date.now() - daysAgo * DAY);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).getTime();
};
const nextAt = (hh: number): number => {
  const today = at(0, hh);
  return today > Date.now() ? today : at(-1, hh);
};

const BRIEFS: ReadonlyArray<readonly [string, string]> = [
  ['3 commits landed, 1 review waits on you, CI is green', '- Mia asked for your review on the webhook retries\n- Sign-in with a `+` in the email is fixed (#52)\n- Checkout refuses expired sessions'],
  ['Nightly tests failed again; a fix is in review', '- The checkout test times out on CI only: Fix what broke opened #52\n- 2 commits on main, both small'],
  ['Quiet day: 1 commit, nothing waits on you', '- The landing hero got its new copy\n- No new issues'],
  ['2 pull requests merged, 1 new issue', '- Refund webhooks are in\n- Issue #48: sign-in fails with a `+` in the email'],
  ['4 tasks moved to Done, CI is green', '- The payments launch is three tasks from done'],
  ['A failing check on main', '- `npm test` fails in `webhooks.test.ts` since last night'],
];

export function makeSentinels(): DemoSentinels {
  const now = Date.now();
  const brief: DemoSentinel = {
    summary: { id: 'sn_brief', topic: 'sentinel:sn_brief', name: 'Morning brief', icon: 'calendar', projectId: 'beluga', project: 'beluga', sentence: 'Every day at 7:00', paused: false, nextAt: nextAt(7) },
    steps: [
      { kind: 'claude', name: 'Read what changed' },
      { kind: 'notify', name: 'Tell me' },
    ],
    runs: BRIEFS.map(([headline, body], i) => {
      const start = at(i + (at(0, 7) < now ? 0 : 1), 7);
      return { id: `run_brief${i}`, by: 'schedule', state: 'done', headline, startedAt: start, endedAt: start + 2 * MIN + i * 7_000, text: `${headline}\n\n${body}` };
    }),
  };
  const t2 = now - 40 * MIN;
  const fix: DemoSentinel = {
    summary: { id: 'sn_fix', topic: 'sentinel:sn_fix', name: 'Fix what broke', icon: 'wrench', projectId: 'beluga', project: 'beluga', sentence: 'When a workflow fails on GitHub', paused: false },
    steps: [
      { kind: 'claude', name: 'Find and fix it' },
      { kind: 'pr', name: 'Open a pull request' },
      { kind: 'merge', name: 'Merge if acceptable' },
      { kind: 'notify', name: 'Tell me' },
    ],
    runs: [
      { id: 'run_fix2', by: 'CI failed on main: login.test.ts', state: 'needs-you', headline: 'Merge the fix for #48?', startedAt: t2, step: 'Merge if acceptable', pr: { number: 53, url: 'https://github.com/acme/beluga/pull/53' }, text: 'Merge the fix for #48?\n\n**What broke:** signing in with `lena+test@acme.dev` answered 500.\n\n**The fix:** `findUser()` no longer decodes the email twice. New test `login-plus-email.test.ts`.\n\n**Checks:** all 6 passed. **Review:** ship.' },
      { id: 'run_fix1', by: 'CI failed on main: checkout.test.ts', state: 'done', headline: 'Fixed the checkout test that timed out on CI · opened #52', startedAt: at(2, 2, 14), endedAt: at(2, 2, 25), pr: { number: 52, url: 'https://github.com/acme/beluga/pull/52' }, text: 'Fixed the checkout test that timed out on CI · opened #52\n\n**What broke:** `checkout.test.ts` waited for a real Stripe webhook, which CI never sends.\n\n**The fix:** the test uses the fixture. `npm test` passes, 24 tests.' },
    ],
  };
  const fail = 'exit 1: FAIL tests/webhooks.test.ts › retries a webhook once';
  const nightly: DemoSentinel = {
    summary: { id: 'sn_nightly', topic: 'sentinel:sn_nightly', name: 'Nightly tests', icon: 'check', projectId: 'beluga', project: 'beluga', sentence: 'Every day at 2:00', paused: true, pausedWhy: 'Paused after 3 failures in a row' },
    steps: [
      { kind: 'script', name: 'Run the tests' },
      { kind: 'notify', name: 'Tell me' },
    ],
    runs: [1, 2, 3].map((day) => ({ id: `run_night${day}`, by: 'schedule', state: 'failed', headline: `Run the tests: ${fail}`, why: fail, startedAt: at(day, 2), endedAt: at(day, 2) + 48_000 })),
  };
  const start = now - 3 * MIN;
  const web: DemoSentinel = {
    summary: { id: 'sn_web', topic: 'sentinel:sn_web', name: 'Watch the web', icon: 'globe', projectId: 'pixel-weather', project: 'pixel-weather', sentence: 'Every day at 6:00', paused: false, nextAt: nextAt(6) },
    steps: [
      { kind: 'http', name: 'Search the web' },
      { kind: 'claude', name: 'Turn it into tasks' },
      { kind: 'notify', name: 'Tell me' },
    ],
    runs: [{ id: 'run_web1', by: 'you', state: 'running', headline: '', startedAt: start, step: 'Turn it into tasks' }],
  };
  const numbers = makeNumbers(now);
  return { items: [brief, fix, nightly, web, ...numbers.sentinels], numbers };
}

const isLive = (state: string): boolean => state === 'queued' || state === 'running' || state === 'needs-you';

function summaryOf(s: DemoSentinel): SentinelSummary {
  const last = s.runs[0];
  return { ...s.summary, ...(last ? { last: { state: last.state, headline: last.headline, at: last.endedAt ?? last.startedAt } } : {}), live: s.runs.some((r) => isLive(r.state)) };
}

const runView = ({ text: _text, ...r }: DemoRun): SentinelRunView => r;

export function sentinelsView(d: DemoSentinels): SentinelsView {
  const recent = d.items
    .flatMap((s) => s.runs.filter((r) => !isLive(r.state) && r.endedAt).map((r) => ({ id: r.id, sentinelId: s.summary.id, state: r.state, at: r.endedAt! })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 20);
  // The Sentinel chat's open conversation (1.23): the demo world's `conv:sentinel-chat:main`.
  return { enabled: true, sentinels: d.items.map(summaryOf), recent, ...numbersOf(d.numbers, d.items), chat: { topic: 'conv:sentinel-chat:main', title: 'What did my sentinels find this week?', last: 'A good week, with one thing to look at: Site speed slowed for a day after Tuesday’s deploy.', lastAt: Date.now() - 49 * 60_000, working: false } };
}

export function sentinelPage(d: DemoSentinels, topic: Topic, needs: readonly NeedsYou[]): SentinelPageView | undefined {
  const s = d.items.find((x) => x.summary.topic === topic);
  return s ? { ...summaryOf(s), steps: s.steps, runs: s.runs.slice(0, 30).map(runView), needsYou: needs.filter((n) => n.topic === topic) } : undefined;
}

/** The merge waiting for you, as views.ts sentinelItems makes it. */
export function sentinelNeeds(d: DemoSentinels): NeedsYou[] {
  return d.items.flatMap((s) =>
    s.runs
      .filter((r) => r.state === 'needs-you')
      .map((r) => ({
        id: `sentinel:${r.id}`,
        kind: 'decision',
        title: r.headline,
        detail: `Checks passed · Claude’s review: ship, a two-line fix with a test${r.pr ? `\nPull request #${r.pr.number}` : ''}`,
        from: s.summary.name,
        topic: s.summary.topic,
        askedAt: r.startedAt + 10 * MIN,
        actions: [
          { label: 'Merge', tone: 'main', method: 'sentinel.decide', args: [r.id, 'merge'] },
          { label: 'Not Now', tone: 'danger', method: 'sentinel.decide', args: [r.id, 'skip'] },
        ],
      })),
  );
}

export const sentinelOf = (d: DemoSentinels, id: string): DemoSentinel | undefined => d.items.find((s) => s.summary.id === id);
export const runOf = (d: DemoSentinels, runId: string): { s: DemoSentinel; r: DemoRun } | undefined => {
  for (const s of d.items) {
    const r = s.runs.find((x) => x.id === runId);
    if (r) return { s, r };
  }
  return undefined;
};
