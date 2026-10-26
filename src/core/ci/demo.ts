import type { GitHubRepo } from '../../workspaces/github.js';
import { type CiSource, logTail } from './gh.js';
import type { GhConclusion, GhJob, GhRun, GhRunStatus, GhStep, GhWorkflow } from './model.js';

/**
 * The demo's pretend GitHub Actions: each demo project has a CI workflow (lint, a test matrix,
 * build, deploy) and a nightly one. The newest run plays out live over a couple of minutes from
 * when it was first asked about, so there's something to watch; a re-run starts it again.
 */

const M = 60_000;
const H = 60 * M;

const CI = `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run lint

  test:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - name: Unit tests
        run: npm test

  build:
    needs: [lint, test]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Build
        run: npm run build
      - name: Upload the build
        uses: actions/upload-artifact@v4

  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    environment: production
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        run: ./scripts/deploy.sh
`;

const NIGHTLY = `name: Nightly

on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:

jobs:
  e2e:
    name: End-to-end
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Playwright
        run: npx playwright test
  audit:
    runs-on: ubuntu-latest
    steps:
      - run: npm audit --omit=dev
`;

const FLOWS: Readonly<Record<string, string>> = { '.github/workflows/ci.yml': CI, '.github/workflows/nightly.yml': NIGHTLY };

type Plan = ReadonlyArray<{ readonly name: string; readonly steps: readonly string[]; /** Starts after these jobs (by index). */ readonly after: readonly number[]; readonly secs: number; readonly fail?: number }>;

const CI_JOBS = (fail: boolean): Plan => [
  { name: 'lint', steps: ['Set up job', 'Run actions/checkout@v4', 'Run actions/setup-node@v4', 'Run npm ci', 'Run npm run lint', 'Complete job'], after: [], secs: 25 },
  ...['ubuntu-latest, 20', 'ubuntu-latest, 22', 'macos-latest, 20', 'macos-latest, 22'].map((m, i) => ({ name: `test (${m})`, steps: ['Set up job', 'Run actions/checkout@v4', 'Run actions/setup-node@v4', 'Run npm ci', 'Unit tests', 'Complete job'], after: [], secs: 40 + i * 9, ...(fail && i === 2 ? { fail: 4 } : {}) })),
  { name: 'build', steps: ['Set up job', 'Run actions/checkout@v4', 'Run npm ci', 'Build', 'Upload the build', 'Complete job'], after: [0, 1, 2, 3, 4], secs: 35 },
  { name: 'deploy', steps: ['Set up job', 'Deploy', 'Complete job'], after: [5], secs: 20 },
];
const NIGHTLY_JOBS: Plan = [
  { name: 'End-to-end', steps: ['Set up job', 'Run actions/checkout@v4', 'Run npm ci', 'Playwright', 'Complete job'], after: [], secs: 160 },
  { name: 'audit', steps: ['Set up job', 'Run npm audit --omit=dev', 'Complete job'], after: [], secs: 12 },
];

interface Seed {
  readonly id: number;
  readonly path: string;
  readonly workflow: string;
  readonly title: string;
  readonly event: string;
  readonly branch: string;
  readonly actor: string;
  readonly plan: Plan;
  /** When it started (ms before the demo began); the newest is undefined: it starts when first seen. */
  readonly ago?: number;
  readonly cancelled?: boolean;
}

const SEEDS: readonly Seed[] = [
  { id: 9104, path: '.github/workflows/ci.yml', workflow: 'CI', title: 'Retry webhooks once after a timeout', event: 'pull_request', branch: 'fix/webhook-retry', actor: 'sam-r', plan: CI_JOBS(false) },
  { id: 9103, path: '.github/workflows/ci.yml', workflow: 'CI', title: 'Decode the login email only once', event: 'push', branch: 'main', actor: 'bob', plan: CI_JOBS(false), ago: 2 * H },
  { id: 9102, path: '.github/workflows/ci.yml', workflow: 'CI', title: 'Read-only API keys', event: 'pull_request', branch: 'feat/read-only-keys', actor: 'jules', plan: CI_JOBS(true), ago: 5 * H },
  { id: 9101, path: '.github/workflows/nightly.yml', workflow: 'Nightly', title: 'Nightly', event: 'schedule', branch: 'main', actor: 'github-actions', plan: NIGHTLY_JOBS, ago: 16 * H },
  { id: 9100, path: '.github/workflows/ci.yml', workflow: 'CI', title: 'Bump the engines field to Node 22', event: 'push', branch: 'main', actor: 'kemal', plan: CI_JOBS(false), ago: 26 * H, cancelled: true },
];

/** Where each job of a plan is `t` ms after it started. */
function play(plan: Plan, start: number, t: number, cancelled: boolean, url: string, base: number): { readonly jobs: GhJob[]; readonly status: GhRunStatus; readonly conclusion?: GhConclusion; readonly end: number } {
  const ends: number[] = [];
  const failedJobs = new Set<number>();
  const jobs = plan.map((j, i): GhJob => {
    const blocked = j.after.some((a) => failedJobs.has(a));
    const from = Math.max(0, ...j.after.map((a) => ends[a] ?? 0)) + (j.after.length ? 3000 : 2000);
    const span = j.secs * 1000;
    ends[i] = from + span;
    const id = base + i;
    const common = { id, name: j.name, url: `${url}/job/${id}` };
    if (blocked || (cancelled && i >= 5)) {
      failedJobs.add(i);
      return { ...common, status: 'completed', conclusion: blocked ? 'skipped' : 'cancelled', steps: [] };
    }
    if (t < from) return { ...common, status: 'queued', steps: [] };
    const per = span / j.steps.length;
    const fails = j.fail !== undefined;
    const steps = j.steps.map((name, n): GhStep => {
      const s0 = start + from + n * per;
      const s1 = s0 + per;
      const failsHere = fails && n === j.fail;
      const after = fails && n > j.fail!;
      if (start + t < s0) return { number: n + 1, name, status: 'queued' };
      if (start + t < s1 && !after) return { number: n + 1, name, status: 'in_progress', startedAt: s0 };
      if (after) return { number: n + 1, name, status: 'completed', conclusion: 'skipped', startedAt: s0, completedAt: s0 };
      return { number: n + 1, name, status: 'completed', conclusion: failsHere ? 'failure' : 'success', startedAt: s0, completedAt: s1 };
    });
    const done = t >= from + span;
    if (fails && done) failedJobs.add(i);
    return { ...common, status: done ? 'completed' : 'in_progress', ...(done ? { conclusion: fails ? 'failure' : 'success', completedAt: start + from + span } : {}), startedAt: start + from, runner: `GitHub Actions ${10 + i}`, steps };
  });
  const end = Math.max(...ends);
  const live = jobs.some((j) => j.status !== 'completed');
  const conclusion: GhConclusion | undefined = live ? undefined : cancelled ? 'cancelled' : jobs.some((j) => j.conclusion === 'failure') ? 'failure' : 'success';
  return { jobs, status: live ? (jobs.every((j) => j.status === 'queued') ? 'queued' : 'in_progress') : 'completed', ...(conclusion ? { conclusion } : {}), end };
}

export function demoCiSource(now: () => number = Date.now): CiSource {
  const born = now();
  /** When the live run started (again, after a re-run). */
  const restarted = new Map<number, number>();
  const startOf = (s: Seed): number => restarted.get(s.id) ?? (s.ago !== undefined ? born - s.ago : born);
  const state = (repo: GitHubRepo, s: Seed): GhRun & { readonly jobs: GhJob[] } => {
    const start = startOf(s);
    const url = `${repo.url}/actions/runs/${s.id}`;
    const p = play(s.plan, start, now() - start, Boolean(s.cancelled), url, s.id * 100);
    return {
      id: s.id,
      workflow: s.workflow,
      path: s.path,
      title: s.title,
      number: s.id - 9000,
      attempt: restarted.has(s.id) ? 2 : 1,
      event: s.event,
      status: p.status,
      ...(p.conclusion ? { conclusion: p.conclusion } : {}),
      branch: s.branch,
      sha: `${s.id}`.padEnd(40, 'a3f9c1e0'),
      actor: s.actor,
      prs: s.event === 'pull_request' ? [s.id - 9050] : [],
      url,
      createdAt: start,
      startedAt: start,
      updatedAt: p.status === 'completed' ? start + p.end : now(),
      jobs: p.jobs,
    };
  };
  const seed = (id: number): Seed => {
    const s = SEEDS.find((x) => x.id === id);
    if (!s) throw new Error(`There's no run ${id}`);
    return s;
  };
  return {
    async runs(repo, query) {
      const runs = SEEDS.filter((s) => (!query.workflow || s.path.endsWith(query.workflow)) && (!query.branch || s.branch === query.branch))
        .map((s) => {
          const { jobs: _j, ...run } = state(repo, s);
          return run;
        })
        .sort((a, b) => b.createdAt - a.createdAt);
      return { runs, more: false };
    },
    async run(repo, id) {
      const { jobs: _j, ...run } = state(repo, seed(id));
      return run;
    },
    async jobs(repo, id) {
      return state(repo, seed(id)).jobs;
    },
    async file(_repo, path) {
      return FLOWS[path];
    },
    async workflows(repo): Promise<readonly GhWorkflow[]> {
      return Object.keys(FLOWS).map((path, i) => ({ id: 70 + i, name: path.includes('ci') ? 'CI' : 'Nightly', path, state: 'active', url: `${repo.url}/actions/workflows/${path.split('/').pop()}` }));
    },
    async log(_repo, jobId) {
      return logTail([
        '##[group]Run npm test',
        'npm test',
        '##[endgroup]',
        '> bob-api@2.4.1 test',
        '> vitest run',
        '',
        ' ✓ tests/login.test.ts (12)',
        ' ✓ tests/refunds.test.ts (8)',
        ' ✗ tests/keys.test.ts > a read-only key can’t create a charge',
        '   AssertionError: expected 201 to be 403',
        '    ❯ tests/keys.test.ts:41:24',
        '',
        ' Test Files  1 failed | 2 passed (3)',
        `      Tests  1 failed | 20 passed (21)   [job ${jobId}]`,
        '##[error]Process completed with exit code 1.',
      ].join('\n'));
    },
    async rerun(_repo, id) {
      restarted.set(seed(id).id, now());
    },
    async cancel() {
      throw new Error('The demo’s runs can’t be cancelled');
    },
  };
}
