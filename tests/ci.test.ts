import { describe, expect, it } from 'vitest';
import { ghCiSource, logTail, parseJobs, parseRuns } from '../src/core/ci/gh.js';
import { GitHubCi, LIVE_TTL_MS } from '../src/core/ci/ci.js';
import { demoCiSource } from '../src/core/ci/demo.js';
import { durationWords, eventWords, jobsSummary, pollEvery, runTone, sortRuns, statusWords } from '../src/core/ci/model.js';
import { jobsOf, matrixSize, readWorkflow, stepItems, toneOf, workflowGraph } from '../src/core/ci/workflow-graph.js';
import type { GhJob } from '../src/core/ci/model.js';
import type { GitHubRepo } from '../src/workspaces/github.js';
import { parseGraph } from '../src/shared/graph-spec.js';

const repo: GitHubRepo = { host: 'github.com', owner: 'acme', repo: 'api', url: 'https://github.com/acme/api' };

const RUN = {
  id: 77,
  name: 'CI',
  path: '.github/workflows/ci.yml@refs/heads/main',
  display_title: 'Fix the login',
  run_number: 12,
  run_attempt: 2,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'failure',
  head_branch: 'fix/login',
  head_sha: 'abc1234def',
  html_url: 'https://github.com/acme/api/actions/runs/77',
  created_at: '2026-10-26T10:00:00Z',
  run_started_at: '2026-10-26T10:05:00Z',
  updated_at: '2026-10-26T10:08:30Z',
  triggering_actor: { login: 'mia' },
  actor: { login: 'bob' },
  pull_requests: [{ number: 5 }],
};

const job = (name: string, status: GhJob['status'], conclusion?: GhJob['conclusion']): GhJob => ({ id: name.length, name, status, ...(conclusion ? { conclusion } : {}), url: `u/${name}`, steps: [] });

describe('reading runs from gh', () => {
  it('reads a run in Beluga’s words', () => {
    const { runs, total } = parseRuns(JSON.stringify({ total_count: 40, workflow_runs: [RUN, { nonsense: true }] }));
    expect(total).toBe(40);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: 77, workflow: 'CI', path: '.github/workflows/ci.yml', title: 'Fix the login', attempt: 2, status: 'completed', conclusion: 'failure', branch: 'fix/login', actor: 'mia', prs: [5] });
    expect(runs[0]!.startedAt - runs[0]!.createdAt).toBe(5 * 60_000);
  });

  it('drops the conclusion of a run that is still going', () => {
    const { runs } = parseRuns(JSON.stringify({ workflow_runs: [{ ...RUN, status: 'in_progress', conclusion: null }] }));
    expect(runs[0]!.conclusion).toBeUndefined();
    expect(runTone(runs[0]!)).toBe('running');
  });

  it('reads jobs and their steps', () => {
    const jobs = parseJobs(JSON.stringify({ jobs: [{ id: 1, name: 'test (ubuntu, 20)', status: 'completed', conclusion: 'success', html_url: 'x', started_at: '2026-10-26T10:00:00Z', completed_at: '2026-10-26T10:01:00Z', steps: [{ name: 'Set up job', number: 1, status: 'completed', conclusion: 'success' }] }] }));
    expect(jobs[0]).toMatchObject({ id: 1, name: 'test (ubuntu, 20)', conclusion: 'success', steps: [{ name: 'Set up job', number: 1 }] });
  });

  it('asks gh the right things', async () => {
    const asked: string[][] = [];
    const src = ghCiSource(async (args) => {
      asked.push([...args]);
      return JSON.stringify({ workflow_runs: [], jobs: [] });
    });
    await src.runs(repo, { workflow: '.github/workflows/ci.yml', branch: 'main' });
    await src.rerun(repo, 77, true);
    expect(asked[0]).toEqual(['api', '-X', 'GET', 'repos/acme/api/actions/workflows/ci.yml/runs', '-f', 'per_page=30', '-f', 'branch=main']);
    expect(asked[1]).toEqual(['api', '-X', 'POST', 'repos/acme/api/actions/runs/77/rerun-failed-jobs']);
  });

  it('keeps the end of a log, without timestamps or colours', () => {
    const log = ['2026-10-26T10:00:00.1234567Z \u001b[31mfirst\u001b[0m', '2026-10-26T10:00:01.0000000Z second', '', ''].join('\n');
    expect(logTail(log)).toBe('first\nsecond');
    expect(logTail('a\nb\nc', 2)).toBe('b\nc');
    expect(logTail('##[group]Run npm test\nnpm test\n##[endgroup]\n##[error]Process completed with exit code 1.')).toBe('▸ Run npm test\nnpm test\nError: Process completed with exit code 1.');
  });
});

describe('what the screens say', () => {
  it('words', () => {
    expect(durationWords(42_000)).toBe('42s');
    expect(durationWords(185_000)).toBe('3m 05s');
    expect(durationWords(3_720_000)).toBe('1h 02m');
    expect(eventWords('workflow_dispatch')).toBe('Manual');
    expect(eventWords('push')).toBe('Push');
    expect(statusWords({ status: 'completed', conclusion: 'timed_out' })).toBe('Timed out');
    expect(jobsSummary([job('a', 'completed', 'success'), job('b', 'completed', 'failure'), job('c', 'in_progress')])).toBe('2 of 3 jobs done · 1 failed');
  });

  it('watches closely only while something runs, and puts running runs first', () => {
    expect(pollEvery([{ status: 'completed' }, { status: 'queued' }])).toBeLessThan(pollEvery([{ status: 'completed' }]));
    const sorted = sortRuns([
      { id: 1, status: 'completed' as const, createdAt: 3 },
      { id: 2, status: 'in_progress' as const, createdAt: 1 },
      { id: 3, status: 'completed' as const, createdAt: 2 },
    ]);
    expect(sorted.map((r) => r.id)).toEqual([2, 1, 3]);
  });
});

const CI = {
  name: 'CI',
  on: { push: { branches: ['main'] }, pull_request: null },
  jobs: {
    lint: { 'runs-on': 'ubuntu-latest', steps: [{ uses: 'actions/checkout@v4' }, { run: 'npm run lint' }] },
    test: { name: 'Tests', 'runs-on': '${{ matrix.os }}', strategy: { matrix: { os: ['ubuntu', 'macos'], node: [20, 22], exclude: [{ os: 'macos', node: 20 }] } }, steps: [{ name: 'Unit tests', run: 'npm test' }] },
    build: { needs: ['lint', 'test'], 'runs-on': 'ubuntu-latest', steps: [] },
    release: { needs: 'build', uses: './.github/workflows/release.yml', if: "github.ref == 'refs/heads/main'" },
  },
};

describe('a workflow as a graph', () => {
  it('reads triggers, jobs and needs', () => {
    const shape = readWorkflow(CI)!;
    expect(shape.triggers).toEqual([{ event: 'push', detail: 'main' }, { event: 'pull_request' }]);
    expect(shape.jobs.map((j) => [j.id, j.name, j.needs])).toEqual([
      ['lint', 'lint', []],
      ['test', 'Tests', []],
      ['build', 'build', ['lint', 'test']],
      ['release', 'release', ['build']],
    ]);
    expect(shape.jobs[0]!.steps).toEqual(['actions/checkout@v4', 'npm run lint']);
    expect(shape.jobs[1]!.matrix).toBe(3);
    expect(readWorkflow({ name: 'not a workflow' })).toBeUndefined();
    // A YAML 1.1 reader's `on`.
    expect(readWorkflow({ true: 'push', jobs: {} })!.triggers).toEqual([{ event: 'push' }]);
  });

  it('counts a matrix', () => {
    expect(matrixSize(undefined)).toBeUndefined();
    expect(matrixSize({ os: ['a', 'b', 'c'] })).toBe(3);
    expect(matrixSize('${{ fromJSON(needs.plan.outputs.m) }}')).toBe(0);
    expect(matrixSize({ include: [{ a: 1 }, { a: 2 }] })).toBe(2);
  });

  it('draws what starts it, each job, and what needs what', () => {
    const g = workflowGraph(readWorkflow(CI)!);
    expect(g.title).toBe('CI');
    expect(g.nodes.map((n) => n.id)).toEqual(['on', 'job:lint', 'job:test', 'job:build', 'job:release']);
    expect(g.nodes[0]!.label).toBe('push · pull_request');
    expect(g.nodes.find((n) => n.id === 'job:release')!.type).toBe('file');
    expect(g.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['on->job:lint', 'on->job:test', 'job:lint->job:build', 'job:test->job:build', 'job:build->job:release']);
    // It's a graph Beluga draws.
    expect(parseGraph(JSON.stringify(g)).ok).toBe(true);
  });

  it('colours each job by how it went in a run, a matrix adding up', () => {
    const jobs = [job('lint', 'completed', 'success'), job('Tests (ubuntu, 20)', 'completed', 'success'), job('Tests (macos, 22)', 'completed', 'failure'), job('build', 'completed', 'skipped')];
    expect(jobsOf({ id: 'test', name: 'Tests' }, jobs)).toHaveLength(2);
    expect(toneOf(jobsOf({ id: 'test', name: 'Tests' }, jobs))).toBe('failed');
    const g = workflowGraph(readWorkflow(CI)!, { jobs });
    const by = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(by('job:lint').status).toBe('done');
    expect(by('job:test').status).toBe('failed');
    expect(by('job:test').emphasis).toBe(true);
    expect(by('job:build').status).toBe('idle');
    expect(by('job:release').sublabel).toContain('Not run');
  });

  it('draws each job’s steps inside it: as the file says, then as they run', () => {
    const plain = workflowGraph(readWorkflow(CI)!);
    expect(plain.nodes.find((n) => n.id === 'job:lint')!.items).toEqual([{ label: 'actions/checkout@v4' }, { label: 'npm run lint' }]);
    // A reusable workflow has no steps of its own.
    expect(plain.nodes.find((n) => n.id === 'job:release')!.items).toBeUndefined();
    const parsed = parseGraph(JSON.stringify(plain));
    expect(parsed.ok && parsed.graph.nodes[1]!.items).toHaveLength(2);
  });

  it('a running job’s steps: GitHub’s own chores left out, each with its status and time', () => {
    const t0 = 1_000_000;
    const step = (number: number, name: string, status: GhJob['status'], conclusion?: GhJob['conclusion'], secs = 10) => ({ number, name, status, ...(conclusion ? { conclusion } : {}), startedAt: t0 + number * 10_000, ...(status === 'completed' ? { completedAt: t0 + number * 10_000 + secs * 1000 } : {}) });
    const running: GhJob = { ...job('lint', 'in_progress'), steps: [step(1, 'Set up job', 'completed', 'success'), step(2, 'Run actions/checkout@v4', 'completed', 'success', 3), step(3, 'Run npm run lint', 'in_progress'), step(4, 'Complete job', 'queued')] };
    const items = stepItems({ steps: ['actions/checkout@v4', 'npm run lint'] }, [running], t0 + 35_000);
    expect(items).toEqual([
      { label: 'actions/checkout@v4', status: 'done', note: '3s' },
      { label: 'npm run lint', status: 'active', note: '5s' },
    ]);
    // Not picked up yet: the file's steps, to do; not run at all: idle.
    expect(stepItems({ steps: ['a', 'b'] }, [job('lint', 'queued')], t0).map((i) => i.status)).toEqual(['todo', 'todo']);
    expect(stepItems({ steps: ['a'] }, [], t0)).toEqual([{ label: 'a', status: 'idle' }]);
  });

  it('a matrix’s steps add up: one failing makes the step failed', () => {
    const step = (name: string, conclusion: GhJob['conclusion']) => ({ number: 1, name, status: 'completed' as const, conclusion });
    const a: GhJob = { ...job('Tests (a)', 'completed', 'success'), steps: [step('Unit tests', 'success')] };
    const b: GhJob = { ...job('Tests (b)', 'completed', 'failure'), steps: [step('Unit tests', 'failure')] };
    expect(stepItems({ steps: ['Unit tests'] }, [a, b], 0)).toEqual([{ label: 'Unit tests', status: 'failed' }]);
  });

  it('finds a reusable workflow’s jobs under the job that calls it', () => {
    expect(jobsOf({ id: 'release', name: 'release' }, [job('release / publish', 'in_progress')])).toHaveLength(1);
  });
});

describe('GitHubCi', () => {
  const store = { getState: () => ({ projects: [{ id: 'p', root: '/nowhere', name: 'api' }] }) } as never;

  it('asks GitHub once for two screens, and again soon while something runs', async () => {
    let t = 1_000_000;
    const src = demoCiSource(() => t);
    let asked = 0;
    const counted = { ...src, runs: (...a: Parameters<typeof src.runs>) => (asked++, src.runs(...a)) };
    const ci = new GitHubCi({ store, repoOf: async () => repo, ghReady: async () => true, source: counted, localFiles: false, now: () => t });
    const [a, b] = await Promise.all([ci.list('p'), ci.list('p')]);
    expect(a).toBe(b);
    expect(asked).toBe(1);
    expect(a.kind === 'github' && a.runs.some((r) => r.status !== 'completed')).toBe(true);
    t += LIVE_TTL_MS + 1;
    await ci.list('p');
    expect(asked).toBe(2);
  });

  it('a run plays out in the demo, with its file and a graph that fits it', async () => {
    let t = 5_000_000;
    const ci = new GitHubCi({ store, repoOf: async () => repo, ghReady: async () => true, source: demoCiSource(() => t), localFiles: false, now: () => t });
    const list = await ci.list('p');
    const live = list.kind === 'github' ? list.runs[0]! : undefined;
    t += 10 * 60_000;
    const { run } = await ci.get('p', live!.id, true);
    expect(run.status).toBe('completed');
    expect(run.conclusion).toBe('success');
    expect(run.file).toContain('name: CI');
    const { run: failed } = await ci.get('p', 9102);
    expect(failed.conclusion).toBe('failure');
    expect(failed.jobs.find((j) => j.name === 'build')!.conclusion).toBe('skipped');
  });

  it('says the project isn’t on GitHub', async () => {
    const ci = new GitHubCi({ store, repoOf: async () => undefined, ghReady: async () => true, source: demoCiSource(), localFiles: false });
    expect(await ci.list('p')).toEqual({ kind: 'none' });
    expect(await ci.list('gone')).toEqual({ kind: 'none' });
  });
});
