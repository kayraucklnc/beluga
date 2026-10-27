import type { Store } from '../store.js';
import { demoRepo } from '../issues/demo.js';
import { type StepRun, presetFields } from './model.js';
import type { SentinelGitHub } from './runner.js';
import type { Sentinels } from './sentinels.js';
import type { FetchLike, TriggerDeps } from './triggers/types.js';

/**
 * The demo's sentinels (`beluga demo`, screenshots, the README): a Morning brief with a week of
 * reports, Fix what broke with a pull request it opened and a run waiting for your Merge, Nightly
 * tests paused after failing three nights, Watch the web with a run going now, Uptime guard with
 * the landing page going down and coming back, and a webhook on Your Mac with its URL.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * The demo's GitHub: a pull request opens (#54 on), its six checks pass, the reviewer says ship,
 * and Merge merges it (Fix what broke's waiting run goes through the real decide path).
 */
/** A demo pull request's head commit: the same for its look and its review, so the merge is pinned. */
const demoHead = (number: number): string => `de30${String(number).padStart(4, '0')}`.padEnd(40, '0');

export function demoGitHub(): SentinelGitHub {
  let next = 54;
  return {
    openPr: async () => {
      const number = next++;
      return { number, url: `https://github.com/acme/bob-api/pull/${number}` };
    },
    look: async (_where, number) => ({ number, url: `https://github.com/acme/bob-api/pull/${number}`, state: 'OPEN', draft: false, conflicts: false, checks: 'passing', failed: [], count: 6, head: demoHead(number) }),
    review: async (_where, pr) => ({ verdict: 'ship', line: 'A small fix with a test that covers it', head: demoHead(pr.number) }),
    merge: async () => true,
  };
}

/** The demo's event sources: GitHub, Stripe and Sentry have nothing new, every site answers, the tunnel is pretend. No network. */
export function demoTriggers(store: Store): Omit<TriggerDeps, 'store' | 'selfId'> {
  const fetch: FetchLike = async (url) => {
    const body = url.includes('sentry.io') ? '[]' : url.includes('api.stripe.com') ? '{"object":"list","data":[],"has_more":false}' : 'ok';
    return { status: 200, ok: true, text: async () => body };
  };
  return {
    gh: async (args) => (args.some((a) => a.includes('/actions/runs')) ? '{"total_count":0,"workflow_runs":[]}' : '[]'),
    repoOf: async (id) => {
      const p = store.getState().projects.find((x) => x.id === id);
      return p ? demoRepo(p.name) : undefined;
    },
    fetch,
    stripeKey: () => 'sk_test_demo',
    env: () => ({ SENTRY_TOKEN: 'demo' }),
    tunnel: async () => ({ url: 'https://quiet-harbor-demo.trycloudflare.com', close: () => undefined }),
    warmupMs: 5_000,
  };
}

/** Seed once the demo's projects are there (they arrive a moment after the daemon starts). */
export function seedDemoSentinel(store: Store, sentinels: Sentinels, travel: (msAgo: number) => void, tries = 60): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later: Array<ReturnType<typeof setTimeout>> = [];
  const attempt = (left: number): void => {
    const projects = store.getState().projects;
    const api = projects.find((p) => p.name === 'bob-api');
    const landing = projects.find((p) => p.name === 'landing');
    if (!api || !landing) {
      if (left > 0) {
        timer = setTimeout(() => attempt(left - 1), 250);
        timer.unref?.();
      }
      return;
    }
    try {
      seed(sentinels, travel, api.id, landing.id, (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        later.push(t);
      });
    } catch {
      // A demo without its sentinels still works.
    } finally {
      travel(0);
    }
  };
  attempt(tries);
  return () => {
    clearTimeout(timer);
    for (const t of later) clearTimeout(t);
  };
}

/** The day `daysAgo` before today at hh:mm. */
const at = (daysAgo: number, hh: number, mm = 0): number => {
  const d = new Date(Date.now() - daysAgo * DAY);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).getTime();
};

/** Oldest first: the last is yesterday's (the row's last run: done, a real brief). */
const BRIEFS: ReadonlyArray<readonly [string, string]> = [
  ['Nothing changed since Friday', ''],
  ['A failing check on main', '- `npm test` fails in `webhooks.test.ts` since last night\n- Nightly tests will say more at 2:00'],
  ['4 tasks moved to Done, CI is green', '- The payments launch is three tasks from done\n- bob is on the refunds'],
  ['2 pull requests merged, 1 new issue', '- Refund webhooks are in\n- Issue #48: sign-in fails with a `+` in the email (a task for it is Ready)'],
  ['Quiet day: 1 commit, nothing waits on you', '- The landing hero got its new copy\n- No new issues'],
  ['Nightly tests failed again; a fix is in review', '- The checkout test times out on CI only: Fix what broke opened #52\n- 2 commits on main, both small'],
  ['3 commits landed, 1 review waits on you, CI is green', '- bob asked for your review on the webhook retries `task:BOB-4`\n- Sign-in with a `+` in the email is fixed (#52)\n- Checkout refuses expired sessions `task:BOB-3`'],
];

function seed(sentinels: Sentinels, travel: (msAgo: number) => void, api: string, landing: string, after: (fn: () => void, ms: number) => void): void {
  const now = Date.now();
  travel(9 * DAY);
  const steps = (ids: readonly string[], state: StepRun['state'], startedAt: number, each: number, extra: Partial<StepRun>[] = []): StepRun[] =>
    ids.map((id, i) => ({ id, state, startedAt: startedAt + i * each, endedAt: startedAt + (i + 1) * each, ...extra[i] }));

  // ---- Morning brief: a week of done runs, each with its report
  const brief = sentinels.create({
    name: 'Morning brief',
    icon: 'calendar',
    projectId: api,
    recipe: 'morning-brief',
    trigger: { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' },
    access: 'look',
    notify: 'both',
    steps: [
      { kind: 'claude', name: 'Read what changed', where: 'project', prompt: 'Write my morning brief for {{project}} ({{date}}): commits, pull requests, issues and CI since yesterday, and the open tasks:\n{{tasks}}\n\nStart with what needs me first. If nothing changed, say so and stop.' },
      { kind: 'notify', name: 'Tell me', phone: true },
    ],
  });
  sentinels.pause(brief.id, false);
  BRIEFS.forEach(([headline, body], i) => {
    const day = BRIEFS.length - i;
    const start = at(day, 7);
    const quiet = !body;
    const report = quiet ? headline : `${headline}\n\n${body}`;
    sentinels.addHistory(
      brief.id,
      {
        by: 'schedule',
        trigger: { kind: 'schedule', summary: 'Every day at 7:00' },
        state: quiet ? 'skipped' : 'done',
        startedAt: start,
        endedAt: start + 2 * MIN + i * 7_000,
        headline,
        steps: steps(brief.steps.map((s) => s.id), 'done', start, MIN).map((s, n) => (quiet && n === 1 ? { ...s, state: 'skipped' } : s)),
        tasks: [],
        ...(quiet ? { why: 'Nothing changed since Friday' } : {}),
      },
      { outputs: [report, quiet ? undefined : `Told you (Mac and phone): Morning brief · ${headline}`], ...(quiet ? {} : { report }) },
    );
  });

  // ---- Fix what broke: a pull request it opened, and a merge waiting for you
  const fix = sentinels.create({
    name: 'Fix what broke',
    icon: 'wrench',
    recipe: 'fix-what-broke',
    projectId: api,
    trigger: { kind: 'github', what: 'workflow-failed', minutes: 2 },
    access: 'ship',
    notify: 'both',
    steps: [
      { kind: 'claude', name: 'Find and fix it', where: 'worktree', prompt: 'A workflow failed on GitHub:\n{{trigger.json}}\n\nFind the failing step (`gh run view --log-failed`), reproduce it, fix it, and run the tests. Commit the fix with a message that says what broke.' },
      { kind: 'pr', name: 'Open a pull request' },
      { kind: 'merge', name: 'Merge if acceptable', require: { checks: true, approval: true }, method: 'squash' },
      { kind: 'notify', name: 'Tell me', phone: true },
    ],
  });
  sentinels.pause(fix.id, false);
  const ids = fix.steps.map((s) => s.id);
  const t1 = at(2, 2, 14);
  sentinels.addHistory(
    fix.id,
    {
      by: 'event',
      trigger: { kind: 'github', summary: 'CI failed on main: checkout.test.ts', payload: { workflow: 'CI', branch: 'main', failed: 'test (checkout.test.ts)' } },
      state: 'done',
      startedAt: t1,
      endedAt: t1 + 11 * MIN,
      headline: 'Fixed the checkout test that timed out on CI · opened #52',
      steps: steps(ids, 'done', t1, 3 * MIN),
      pr: { number: 52, url: 'https://github.com/acme/bob-api/pull/52' },
      tasks: [],
    },
    {
      outputs: ['Fixed the checkout test that timed out on CI · opened #52\n\nThe test waited for a real Stripe webhook; it now uses the fixture. `npm test` passes (24 tests).', 'Opened #52: Use the webhook fixture in checkout.test.ts', 'Merged #52 after the checks passed and you approved', 'Told you: Fix what broke'],
      report: 'Fixed the checkout test that timed out on CI · opened #52\n\n**What broke:** `checkout.test.ts` waited for a real Stripe webhook, which CI never sends.\n\n**The fix:** the test uses the `payment_intent.succeeded` fixture. `npm test` passes, 24 tests.\n\n**Pull request:** #52, merged.',
    },
  );
  const t2 = now - 40 * MIN;
  sentinels.addHistory(
    fix.id,
    {
      by: 'event',
      trigger: { kind: 'github', summary: 'CI failed on main: login.test.ts', payload: { workflow: 'CI', branch: 'main', failed: 'test (login.test.ts)' } },
      state: 'needs-you',
      startedAt: t2,
      headline: 'Merge the fix for #48?',
      steps: [
        { id: ids[0]!, state: 'done', startedAt: t2, endedAt: t2 + 9 * MIN },
        { id: ids[1]!, state: 'done', startedAt: t2 + 9 * MIN, endedAt: t2 + 10 * MIN },
        { id: ids[2]!, state: 'running', startedAt: t2 + 10 * MIN, why: 'Checks passed · Claude’s review: ship, a two-line fix with a test' },
        { id: ids[3]!, state: 'waiting' },
      ],
      pr: { number: 53, url: 'https://github.com/acme/bob-api/pull/53' },
      prHead: demoHead(53),
      waitingSince: t2 + 10 * MIN,
      tasks: [],
    },
    {
      outputs: ['Sign-in with a `+` in the email answered 500: `findUser()` decoded the email twice. Fixed, with a test.', 'Opened #53: Sign in with a + in the email (Fixes #48)'],
      report: 'Merge the fix for #48?\n\n**What broke:** signing in with `lena+test@acme.dev` answered 500.\n\n**The fix:** `findUser()` no longer decodes the email twice; an unknown user gets a 401. New test `login-plus-email.test.ts`.\n\n**Checks:** all 6 passed. **Review:** ship.',
    },
  );

  // ---- Nightly tests: three failed nights in a row, paused
  const nightly = sentinels.create({
    name: 'Nightly tests',
    icon: 'check',
    projectId: api,
    recipe: 'nightly-tests',
    trigger: { kind: 'schedule', every: 'day', at: '02:00', missed: 'skip' },
    access: 'work',
    notify: 'mac',
    limits: { minutes: 30, pauseAfter: 3 },
    steps: [
      { kind: 'script', name: 'Run the tests', command: 'npm test', cwd: 'project', timeoutSec: 900 },
      { kind: 'notify', name: 'Tell me', title: '{{sentinel}}: the tests pass', body: 'Every test passed overnight.', phone: false },
    ],
  });
  const fail = 'exit 1: FAIL tests/webhooks.test.ts › retries a webhook once\n  Expected 1 charge, got 2';
  for (const day of [3, 2, 1]) {
    const start = at(day, 2);
    sentinels.addHistory(
      nightly.id,
      { by: 'schedule', trigger: { kind: 'schedule', summary: 'Every day at 2:00' }, state: 'failed', startedAt: start, endedAt: start + 48_000, headline: `Run the tests: ${fail.split('\n')[0]}`, why: fail, steps: [{ id: nightly.steps[0]!.id, state: 'failed', startedAt: start, endedAt: start + 48_000, why: fail }, { id: nightly.steps[1]!.id, state: 'skipped' }], tasks: [] },
      { outputs: [`> bob-api@1.0.0 test\n> vitest run\n\n ✓ tests/login.test.ts (6)\n ✓ tests/checkout.test.ts (9)\n ✗ tests/webhooks.test.ts (9)\n   × retries a webhook once\n     Expected 1 charge, got 2\n\n Tests  1 failed | 23 passed (24)`] },
    );
  }
  sentinels.demoSet(nightly.id, { paused: true, failures: 3, pausedWhy: 'Paused after 3 failures in a row' });

  // ---- Watch the web: a run going now
  const web = sentinels.create({
    name: 'Watch the web',
    icon: 'globe',
    recipe: 'watch-the-web',
    projectId: landing,
    trigger: { kind: 'schedule', every: 'day', at: '06:00', missed: 'catch-up' },
    access: 'look',
    notify: 'phone',
    steps: [
      { kind: 'http', name: 'Search the web', ...presetFields('groqbot'), url: 'https://api.groqbot.example/search', body: '{"query": "landing page builders news"}', timeoutSec: 30 },
      { kind: 'claude', name: 'Turn it into tasks', where: 'project', prompt: 'Here is what the web search found:\n{{previous}}\n\nMake a task for each real thing worth doing on {{project}} (one per thing, skip noise and duplicates of these open tasks):\n{{tasks}}' },
      { kind: 'notify', name: 'Tell me', phone: true },
    ],
  });
  sentinels.pause(web.id, false);
  const w = web.steps.map((s) => s.id);
  const start = now - 3 * MIN;
  const going = sentinels.addHistory(
    web.id,
    { by: 'you', trigger: { kind: 'manual', summary: 'You pressed Run' }, state: 'running', startedAt: start, headline: '', steps: [{ id: w[0]!, state: 'done', startedAt: start, endedAt: start + 4_000 }, { id: w[1]!, state: 'running', startedAt: start + 4_000 }, { id: w[2]!, state: 'waiting' }], tasks: [] },
    { outputs: ['{"results": [{"title": "Hero sections that convert in 2026", "url": "https://example.com/heroes"}, {"title": "Core Web Vitals: INP replaces FID", "url": "https://example.com/inp"}]}'] },
  );
  // ---- Uptime guard: the landing page went down yesterday afternoon, and came back
  const guard = sentinels.create({
    name: 'Uptime guard',
    icon: 'pulse',
    recipe: 'uptime-guard',
    projectId: landing,
    trigger: { kind: 'uptime', url: 'https://landing.example.com', minutes: 5 },
    access: 'look',
    notify: 'phone',
    steps: [
      { kind: 'claude', name: 'Say what’s likely', where: 'project', prompt: '{{trigger}}\n{{trigger.json}}\n\nIf it is down: look at what you can (the latest deploy, its logs, the status pages of what it runs on) and say in a few lines what is most likely wrong and what to do. If it is back, say how long it was down and stop.' },
      { kind: 'notify', name: 'Tell me', phone: true },
    ],
  });
  sentinels.pause(guard.id, false);
  const g = guard.steps.map((st) => st.id);
  const down = at(1, 14, 7);
  const back = down + 12 * MIN;
  sentinels.addHistory(
    guard.id,
    {
      by: 'event',
      trigger: { kind: 'uptime', summary: 'landing.example.com stopped answering (503)', payload: { state: 'down', url: 'https://landing.example.com', status: 503, ms: 812, since: down - 5 * MIN, expected: 200 } },
      state: 'done',
      startedAt: down,
      endedAt: down + 2 * MIN,
      headline: 'landing.example.com answers 503: the 14:02 deploy ran out of memory',
      steps: steps(g, 'done', down, MIN),
      tasks: [],
    },
    {
      outputs: ['landing.example.com answers 503: the 14:02 deploy ran out of memory', 'Told you (phone): Uptime guard · landing.example.com answers 503'],
      report: 'landing.example.com answers 503: the 14:02 deploy ran out of memory\n\n- The deploy at 14:02 doubled the image sizes in the hero; the server hits its 512 MB limit on the first requests\n- Roll back to the 13:40 deploy, or raise the memory limit to 1 GB\n- Nothing else changed today',
    },
  );
  sentinels.addHistory(
    guard.id,
    {
      by: 'event',
      trigger: { kind: 'uptime', summary: 'landing.example.com is back (200, 284 ms)', payload: { state: 'up', url: 'https://landing.example.com', status: 200, ms: 284, since: down - 5 * MIN, downFor: 17 * MIN } },
      state: 'done',
      startedAt: back,
      endedAt: back + 40_000,
      headline: 'landing.example.com is back after 17 minutes',
      steps: steps(g, 'done', back, 20_000),
      tasks: [],
    },
    { outputs: ['landing.example.com is back after 17 minutes', 'Told you (phone): Uptime guard · landing.example.com is back'], report: 'landing.example.com is back after 17 minutes\n\nIt answers 200 in 284 ms again, since the rollback at 14:19.' },
  );

  // ---- A webhook on Your Mac: GitHub posts its pushes to the sentinel's URL
  const hook = sentinels.create({
    name: 'GitHub pushes',
    icon: 'link',
    trigger: { kind: 'webhook', signature: 'github' },
    access: 'look',
    notify: 'mac',
    steps: [
      { kind: 'claude', name: 'Say what came in', where: 'mac', prompt: 'GitHub posted this to the webhook:\n{{trigger.json}}\n\nSay in one line what happened (who pushed what where), then anything worth a look.' },
      { kind: 'notify', name: 'Tell me', phone: false },
    ],
  });
  sentinels.pause(hook.id, false);
  const hk = hook.steps.map((st) => st.id);
  const pushed = now - 2 * HOUR;
  sentinels.addHistory(
    hook.id,
    {
      by: 'event',
      trigger: { kind: 'webhook', summary: 'Webhook from GitHub: push', payload: { headers: { 'x-github-event': 'push' }, event: 'push', body: { ref: 'refs/heads/main', pusher: { name: 'lena' }, commits: [{ message: 'Refund webhooks retry once' }, { message: 'Fix the checkout test' }, { message: 'Bump stripe to 17.2' }] } } },
      state: 'done',
      startedAt: pushed,
      endedAt: pushed + 25_000,
      headline: 'lena pushed 3 commits to main of bob-api',
      steps: steps(hk, 'done', pushed, 12_500),
      tasks: [],
    },
    { outputs: ['lena pushed 3 commits to main of bob-api', 'Told you: GitHub pushes · lena pushed 3 commits to main'], report: 'lena pushed 3 commits to main of bob-api\n\n- Refund webhooks retry once\n- Fix the checkout test\n- Bump stripe to 17.2 (a minor version: read its changelog)' },
  );

  travel(0);
  // The schedules start from now: the clock's first look catches nothing up (the history above is
  // recorded, and Watch the web's run going now is that recorded one: its Call a Service step has
  // no real address to call, so the runner must never be the one running it).
  for (const s of [brief, web]) sentinels.demoSet(s.id, { lastScheduledAt: Date.now() });
  // It finishes a moment later, so the demo shows a run ending.
  after(() => {
    const end = Date.now();
    const report = '2 tasks made from what the web said\n\n- Measure INP on the landing page (Core Web Vitals changed)\n- Try a shorter hero headline (the article’s numbers are worth a test)';
    sentinels.addHistory(
      web.id,
      { ...going, state: 'done', endedAt: end, headline: '2 tasks made from what the web said', steps: [{ id: w[0]!, state: 'done', startedAt: start, endedAt: start + 4_000 }, { id: w[1]!, state: 'done', startedAt: start + 4_000, endedAt: end - 1_000 }, { id: w[2]!, state: 'done', startedAt: end - 1_000, endedAt: end }] },
      { outputs: [undefined, report, 'Told you (Mac and phone): Watch the web · 2 tasks made from what the web said'], report },
    );
  }, 90_000 * Math.min(1, Number(process.env.KLAUD_DEMO_PACE) || 1));
}

