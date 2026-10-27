import path from 'node:path';
import { PAYMENT_FLOW } from '../../agent/mock-graphs.js';
import type { Store } from '../store.js';
import type { Actor, Assignee, BriefSection } from './model.js';
import type { BoardWork } from './work.js';

/**
 * The demo's board (`beluga demo`, screenshots, the README): a payments API mid-launch and a
 * landing page, with the demo's worktrees doing three of the tasks, a pull request in review,
 * blockers, sub-tasks, briefs Claude kept, proof and a few days of history.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const bob: Assignee & Actor = { kind: 'person', id: 'demo-bob', name: 'bob' };
const mia: Assignee & Actor = { kind: 'person', id: 'demo-mia', name: 'mia' };

/** Seed once the demo's projects are there (they arrive a moment after the daemon starts). */
export function seedDemoBoard(store: Store, work: BoardWork, travel: (msAgo: number) => void, after?: () => void, tries = 60): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (left: number): void => {
    const projects = store.getState().projects;
    const api = projects.find((p) => p.name === 'bob-api');
    const landing = projects.find((p) => p.name === 'landing');
    const ws = (name: string) => projects.flatMap((p) => p.workspaces).find((w) => w.name === name);
    if (!api || !landing || !ws('checkout-auth') || !ws('checkout-events') || !ws('new-hero')) {
      if (left > 0) {
        timer = setTimeout(() => attempt(left - 1), 250);
        timer.unref?.();
      }
      return;
    }
    try {
      // The payments tasks are worked in the demo plan's worktrees (add-auth and webhook-retries are worktrees of their own, with no task).
      seed(work, travel, { api: api.id, landing: landing.id, auth: ws('checkout-auth')!, retries: ws('checkout-events')!, hero: ws('new-hero')! });
      after?.();
    } finally {
      travel(0);
    }
  };
  attempt(tries);
  return () => clearTimeout(timer);
}

interface Places {
  readonly api: string;
  readonly landing: string;
  readonly auth: { readonly id: string; readonly name: string; readonly branch?: string; readonly path: string };
  readonly retries: { readonly id: string; readonly name: string; readonly branch?: string; readonly path: string };
  readonly hero: { readonly id: string; readonly name: string; readonly branch?: string; readonly path: string };
}

function seed(work: BoardWork, travel: (msAgo: number) => void, at: Places): void {
  const board = work.board;
  const me = work.me();
  const claude = work.myClaude();
  const beluga: Actor = { kind: 'beluga' };
  const when = (ago: number): void => travel(ago);
  const brief = (key: string, section: BriefSection, text: string, by: Actor, reason: string, mode: 'replace' | 'append' = 'replace'): void => void board.editBrief(key, section, text, by, { reason, mode });

  // ---- bob-api: the payments launch
  when(4 * DAY);
  // Two labels of its own, beside the built-in ones (bug, important, feature…).
  board.createLabel(at.api, { name: 'payments', icon: 'bolt', color: 'teal', hint: 'Checkout, webhooks and refunds' });
  board.createLabel(at.api, { name: 'security', icon: 'lock', color: 'pink', hint: 'Who can do what' });
  const epic = board.create(
    {
      projectId: at.api,
      title: 'Payments API v1',
      status: 'in_progress',
      priority: 'high',
      assignee: me,
      labels: ['payments', 'important'],
      brief: {
        goal: 'Take card payments for the launch: checkout, webhooks that mark orders paid, and refunds.',
        context: 'Stripe PaymentIntents. Orders live in Postgres (`orders`). The API is Express (`src/server.ts`).',
        acceptance: '- [ ] Only signed-in users can pay\n- [ ] A retried webhook never charges or emails twice\n- [ ] Refunds work from the admin\n- [x] Test-mode fixtures for every flow',
      },
    },
    me,
  );
  when(3 * DAY + 20 * HOUR);
  const fixtures = board.create({ projectId: at.api, title: 'Stripe test-mode fixtures', status: 'todo', priority: 'medium', parent: epic.id, labels: ['payments'], assignee: claude }, me);
  when(3 * DAY + 2 * HOUR);
  board.update(fixtures.id, { status: 'in_progress' }, claude);
  when(2 * DAY + 18 * HOUR);
  board.comment(fixtures.id, 'Added fixtures for card, 3-D Secure and declined cards under `test/fixtures/stripe/`. All 24 payment tests use them now.', claude);
  board.update(fixtures.id, { status: 'done' }, me);

  when(3 * DAY + 6 * HOUR);
  const auth = board.create(
    {
      projectId: at.api,
      title: 'Add auth to the payment routes',
      status: 'todo',
      priority: 'urgent',
      parent: epic.id,
      labels: ['security', 'feature'],
      brief: {
        goal: 'Only signed-in users can reach `/api/payments/*`.',
        acceptance: '- [x] `requireUser()` rejects missing sessions with 401\n- [x] Payment routes use it\n- [ ] Expired sessions are rejected too — not done: next turn, see the handoff\n- [ ] Tests for missing, expired and valid sessions — deferred: the expired one comes with that fix',
      },
    },
    me,
  );
  when(2 * DAY + 3 * HOUR);
  board.update(auth.id, { assignee: claude }, me);
  board.linkWorktree(auth.id, at.auth.id, { ...(at.auth.branch ? { branch: at.auth.branch } : {}), name: at.auth.name }, me);
  board.update(auth.id, { status: 'in_progress' }, me);
  when(2 * DAY + 2 * HOUR);
  brief(auth.key, 'context', '`src/server.ts` had a `TODO: add auth` and no middleware. Sessions are signed cookies (`session`), set by the login route.', claude, 'what I found reading the code');
  brief(auth.key, 'decisions', '- Signed cookies, not Redis: no server state, and the API runs on one box for now (you picked this).', claude, 'session store chosen');
  when(DAY + 22 * HOUR);
  brief(auth.key, 'decisions', '- 401 with no body for missing sessions, so the web app sends people to login.', claude, 'how to reject', 'append');
  board.comment(auth.id, 'Wired `requireUser()` into `/api/payments/*`. 27 tests pass.', claude);
  board.addProof(auth.id, { kind: 'graph', title: 'How a payment goes through', body: JSON.stringify(PAYMENT_FLOW) }, claude);
  when(DAY + 20 * HOUR);
  brief(auth.key, 'handoff', 'Middleware and routes are done and tested. Left: reject **expired** sessions (check `expiresAt` in the cookie) and add its test. The PR is open; bob is reviewing.', claude, 'end of the turn');
  board.prChanged(at.auth.id, { number: 42, url: 'https://github.com/bob/bob-api/pull/42', state: 'OPEN', title: 'Add auth to the payment routes', draft: false, checks: 'passing', review: 'REVIEW_REQUIRED' });
  when(DAY + 8 * HOUR);
  board.comment(auth.id, 'Looks good. Can we also cover expired sessions before I approve?', bob);

  when(2 * DAY + 20 * HOUR);
  const retries = board.create(
    {
      projectId: at.api,
      title: 'Idempotent webhook retries',
      status: 'todo',
      priority: 'high',
      parent: epic.id,
      labels: ['payments', 'bug'],
      brief: {
        goal: 'A webhook Stripe retries is handled once: no order marked paid twice, no second receipt.',
        acceptance: '- [ ] Each `event.id` is handled at most once\n- [ ] Failures retry with backoff, 5 attempts\n- [ ] A test replays the same event three times',
      },
    },
    me,
  );
  when(DAY + 6 * HOUR);
  board.update(retries.id, { assignee: claude }, me);
  board.linkWorktree(retries.id, at.retries.id, { ...(at.retries.branch ? { branch: at.retries.branch } : {}), name: at.retries.name }, me);
  board.update(retries.id, { status: 'in_progress' }, me);
  when(DAY + 5 * HOUR);
  brief(retries.key, 'decisions', '- Remember handled event ids in a `processed_events` table (unique on `event_id`), not in memory: the API restarts on deploy.', claude, 'where to remember events');
  brief(retries.key, 'questions', '- Keep processed event ids forever, or drop them after 30 days? (Stripe stops retrying after 3 days.)', claude, 'needs a call');
  when(5 * HOUR);
  brief(retries.key, 'handoff', 'Backoff is in (`MAX_RETRIES = 5`). Next: the `processed_events` migration, then the replay test.', claude, 'end of the turn');

  when(2 * DAY);
  const refunds = board.create({ projectId: at.api, title: 'Refund endpoint', status: 'todo', priority: 'medium', parent: epic.id, labels: ['payments'], brief: { goal: 'Admins refund an order (whole or part) from the admin page.' } }, me);
  board.relate(refunds.id, 'blocked_by', auth.id, true, me);
  board.relate(refunds.id, 'blocked_by', retries.id, true, me);

  when(DAY + 12 * HOUR);
  board.create({ projectId: at.api, title: 'Rate-limit the login endpoint', status: 'todo', priority: 'medium', labels: ['security'], assignee: bob, brief: { goal: '10 tries a minute per IP, then 429.' } }, bob);
  when(3 * DAY);
  board.create({ projectId: at.api, title: 'Move secrets to the keychain', status: 'backlog', priority: 'low', labels: ['security'] }, me);
  board.create({ projectId: at.api, title: 'Preview environments for pull requests', status: 'backlog', labels: ['chore'] }, bob);
  when(4 * DAY);
  const graphql = board.create({ projectId: at.api, title: 'GraphQL experiment', status: 'backlog', labels: ['feature'] }, me);
  when(2 * DAY + 4 * HOUR);
  board.comment(graphql.id, 'Not before launch: REST covers everything the web app needs.', me);
  board.update(graphql.id, { status: 'canceled' }, me);

  // ---- landing: the launch page
  when(2 * DAY + 10 * HOUR);
  const hero = board.create(
    {
      projectId: at.landing,
      title: 'New hero for the launch',
      status: 'todo',
      priority: 'high',
      assignee: me,
      labels: ['design', 'important'],
      brief: {
        goal: 'A hero that says what Beluga is in one line, with a real screenshot.',
        acceptance: '- [x] New headline and line under it\n- [x] Screenshot of the app\n- [ ] Looks right on phones\n- [ ] mia signs off on the copy',
      },
    },
    me,
  );
  when(DAY + 3 * HOUR);
  board.linkWorktree(hero.id, at.hero.id, { ...(at.hero.branch ? { branch: at.hero.branch } : {}), name: at.hero.name }, me);
  board.update(hero.id, { status: 'in_progress' }, me);
  // A file you dropped on the task for the work: the brand brief.
  board.addProof(hero.id, { kind: 'file', title: 'brand-brief.pdf', path: path.join(at.hero.path, 'docs', 'brand-brief.pdf'), context: true }, me);
  when(DAY + 2 * HOUR);
  board.addProof(hero.id, { kind: 'image', title: 'Hero, desktop', path: path.join(at.hero.path, 'public', 'hero-shot.png') }, claude);
  board.addProof(hero.id, { kind: 'file', title: 'Hero copy', path: path.join(at.hero.path, 'content', 'hero.md') }, claude);
  when(20 * HOUR);
  board.comment(hero.id, 'Love the screenshot. “Build together” might undersell the Claude part, though?', mia);
  when(3 * HOUR);
  const pricing = board.create({ projectId: at.landing, title: 'Pricing page copy', status: 'todo', priority: 'medium', assignee: mia, labels: ['docs'] }, mia);
  board.relate(pricing.id, 'blocked_by', hero.id, true, mia);
  when(2 * HOUR);
  board.create({ projectId: at.landing, title: 'Open Graph images for every page', status: 'backlog', labels: ['design'] }, me);
  board.create({ projectId: at.landing, title: 'Lighthouse 95+ on mobile', status: 'backlog', priority: 'low', labels: ['performance'] }, beluga);
}
