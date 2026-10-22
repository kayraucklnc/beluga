import { describe, expect, it, vi } from 'vitest';
import { Store, initialState } from '../src/core/store.js';
import type { PullRequest } from '../src/core/work-store.js';
import type { NoticeEvent } from '../src/core/notify.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { Workbench } from '../src/core/workbench.js';
import type { MergeOptions } from '../src/workspaces/pr.js';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
const exec = vi.hoisted(() => ({ impl: undefined as undefined | ((cmd: string, args: string[]) => { err?: Error; stdout?: string; stderr?: string }), calls: [] as Array<{ cmd: string; args: string[]; cwd?: string }> }));

// gh stubbed at the process boundary: what `gh pr merge` is run with, and what it answers.
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (cmd: string, args: string[], opts: { cwd?: string }, cb: ExecCb) => {
    exec.calls.push({ cmd, args, cwd: opts.cwd });
    const r = exec.impl?.(cmd, args) ?? { err: new Error('not mocked') };
    queueMicrotask(() => cb(r.err ?? null, r.stdout ?? '', r.stderr ?? ''));
  },
}));

const { explainMergeError, mergePr, deleteRemoteBranch, parsePr } = await import('../src/workspaces/pr.js');
const { planGitOf } = await import('../src/core/plans/plan-git.js');

const pr = (more: Partial<PullRequest> = {}): PullRequest => ({ number: 42, url: 'https://github.com/o/r/pull/42', state: 'OPEN', title: 'Add auth', draft: false, checks: 'passing', ...more });

describe('mergePr / deleteRemoteBranch (gh stubbed)', () => {
  it('runs gh pr merge with the number and the way to merge, in the worktree', async () => {
    exec.calls.length = 0;
    exec.impl = () => ({ stdout: '' });
    await mergePr('/code/auth', 42, { method: 'squash' });
    await mergePr('/code/auth', 42, { method: 'rebase', auto: true });
    expect(exec.calls).toEqual([
      { cmd: 'gh', args: ['pr', 'merge', '42', '--squash'], cwd: '/code/auth' },
      { cmd: 'gh', args: ['pr', 'merge', '42', '--rebase', '--auto'], cwd: '/code/auth' },
    ]);
  });

  it("a plan's pull request merges through the same mergePr, as a merge commit", async () => {
    exec.calls.length = 0;
    exec.impl = () => ({ stdout: '' });
    const controller = { manager: { repoProject: () => ({ root: '/code/app' }) } } as unknown as WorkspaceController;
    await planGitOf(controller).mergePr('app', 7);
    expect(exec.calls.filter((c) => c.args[0] === 'pr')).toEqual([{ cmd: 'gh', args: ['pr', 'merge', '7', '--merge'], cwd: '/code/app' }]);
  });

  it("throws gh's own words", async () => {
    exec.impl = () => ({ err: new Error('exit 1'), stderr: 'X Pull request #42 is not mergeable: the merge commit cannot be cleanly created.\n' });
    await expect(mergePr('/code/auth', 42, { method: 'merge' })).rejects.toThrow(/cannot be cleanly created/);
  });

  it('deletes the branch on GitHub with git push, never gh --delete-branch', async () => {
    exec.calls.length = 0;
    exec.impl = () => ({ stdout: '' });
    await deleteRemoteBranch('/code/auth', 'klaud/auth');
    expect(exec.calls).toEqual([{ cmd: 'git', args: ['push', 'origin', '--delete', 'klaud/auth'], cwd: '/code/auth' }]);
  });
});

describe('explainMergeError', () => {
  // What gh prints when GitHub says no.
  const cases: Array<[string, string, RegExp]> = [
    ['X Pull request #42 is not mergeable: the merge commit cannot be cleanly created.', 'conflicts', /conflicts with the base/],
    ['GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)', 'reviews', /approving review/],
    ['GraphQL: Changes requested by a reviewer (mergePullRequest)', 'reviews', /approving review/],
    ['GraphQL: Required status check "test" is expected. (mergePullRequest)', 'checks', /checks haven’t passed/],
    ['X Pull request #42 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.', 'blocked', /rules don’t allow/],
    ['GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)', 'auto_off', /Allow auto-merge/],
    ['GraphQL: Squash merges are not allowed on this repository. (mergePullRequest)', 'method', /Squash merging isn’t allowed/],
    ['GraphQL: Pull Request is still a draft (mergePullRequest)', 'draft', /draft/],
    ['X Pull request #42 was already merged', 'closed', /isn’t open/],
    ['HTTP 403: Resource not accessible by integration', 'permission', /can’t merge/],
    ['error connecting to api.github.com\ncheck your internet connection', 'other', /error connecting to api\.github\.com$/],
  ];
  it.each(cases)('%s → %s', (text, reason, message) => {
    const out = explainMergeError(text, 'squash');
    expect(out.reason).toBe(reason);
    expect(out.message).toMatch(message);
  });
});

describe('parsePr: merge fields', () => {
  it('reads conflicts and auto-merge on open PRs only', () => {
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', state: 'OPEN', mergeable: 'CONFLICTING', autoMergeRequest: { mergeMethod: 'SQUASH' } }))).toMatchObject({ conflicts: true, autoMerge: true });
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', state: 'OPEN', mergeable: 'MERGEABLE', autoMergeRequest: null }))).not.toHaveProperty('conflicts');
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', state: 'MERGED', mergeable: 'CONFLICTING', autoMergeRequest: {} }))).not.toHaveProperty('autoMerge');
  });
});

/** A Workbench with one worktree whose PR lives in a stubbed GitHub: merging changes what gh pr view says next. */
function bench(start: PullRequest | undefined, answer: (opts: MergeOptions) => PullRequest | Error) {
  const store = new Store(initialState('t', 'ask'));
  const ws = { id: 'auth', name: 'auth', kind: 'worktree', branch: 'klaud/auth', path: '/code/auth', projectId: 'p1', status: { changed: 0, ahead: 2, behind: 0 } };
  const manager = { list: [{ id: 'p1', workspaces: [ws] }], find: (id: string) => (id === ws.id ? ws : undefined) };
  let github = start;
  const merges: Array<{ dir: string; number: number; opts: MergeOptions }> = [];
  const deleted: string[] = [];
  const toasts: Array<{ text: string; level?: string }> = [];
  const notices: NoticeEvent[] = [];
  const views: string[] = [];
  const wb = new Workbench({
    store,
    controller: { manager } as unknown as WorkspaceController,
    notify: (e) => void notices.push(e),
    toast: (text, level) => void toasts.push({ text, level }),
    intend: () => undefined,
    askClaude: () => undefined,
    setPrefs: () => undefined,
    hasGh: async () => true,
    findPr: async (_dir, branch) => (views.push(branch), github),
    remoteRef: () => undefined,
    mergePr: async (dir, number, opts) => {
      merges.push({ dir, number, opts });
      const next = answer(opts);
      if (next instanceof Error) throw next;
      github = next;
    },
    deleteRemoteBranch: async (_dir, branch) => void deleted.push(branch),
  });
  store.dispatch({ type: 'gh', ok: true });
  if (start) store.dispatch({ type: 'pr', id: 'auth', pr: start });
  return { wb, store, merges, deleted, toasts, notices, views, pr: () => store.getState().prs.auth };
}

describe('Workbench.mergePr', () => {
  it('merges with gh and shows Merged at once, without a second "was merged" notice', async () => {
    const b = bench(pr(), () => pr({ state: 'MERGED' }));
    const out = await b.wb.mergePr('auth', { method: 'squash' });
    expect(out).toEqual({ ok: true, result: 'merged', message: 'Merged PR #42' });
    expect(b.merges).toEqual([{ dir: '/code/auth', number: 42, opts: { method: 'squash' } }]);
    expect(b.views).toEqual(['klaud/auth']);
    expect(b.pr()?.state).toBe('MERGED');
    expect(b.notices).toEqual([]);
    expect(b.toasts.at(-1)).toEqual({ text: 'Merged PR #42', level: 'success' });
  });

  it('deletes the branch on GitHub only once merged', async () => {
    const b = bench(pr(), () => pr({ state: 'MERGED' }));
    await b.wb.mergePr('auth', { method: 'merge', deleteBranch: true });
    expect(b.deleted).toEqual(['klaud/auth']);
    const q = bench(pr({ checks: 'pending' }), () => pr({ checks: 'pending', autoMerge: true }));
    await q.wb.mergePr('auth', { method: 'merge', auto: true, deleteBranch: true });
    expect(q.deleted).toEqual([]);
  });

  it('"Merge when checks pass" leaves it open with auto-merge on', async () => {
    const b = bench(pr({ checks: 'pending' }), () => pr({ checks: 'pending', autoMerge: true }));
    const out = await b.wb.mergePr('auth', { method: 'squash', auto: true });
    expect(out).toEqual({ ok: true, result: 'queued', message: 'PR #42 merges when its checks pass' });
    expect(b.merges[0]?.opts).toEqual({ method: 'squash', auto: true });
    expect(b.pr()).toMatchObject({ state: 'OPEN', autoMerge: true });
  });

  it('says why GitHub refused (a review is required), and looks at the PR again', async () => {
    const b = bench(pr({ review: 'REVIEW_REQUIRED' }), () => new Error('GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)'));
    const out = await b.wb.mergePr('auth', { method: 'squash' });
    expect(out).toMatchObject({ ok: false, reason: 'reviews' });
    expect(b.toasts.at(-1)?.level).toBe('error');
    expect(b.views).toEqual(['klaud/auth']);
    expect(b.pr()?.state).toBe('OPEN');
  });

  it('says when it conflicts', async () => {
    const b = bench(pr(), () => new Error('X Pull request #42 is not mergeable: the merge commit cannot be cleanly created.'));
    expect(await b.wb.mergePr('auth', { method: 'rebase' })).toMatchObject({ ok: false, reason: 'conflicts' });
  });

  it('does nothing without an open PR, or while one merge is under way', async () => {
    expect(await bench(undefined, () => pr()).wb.mergePr('auth', { method: 'squash' })).toMatchObject({ ok: false, reason: 'no_pr' });
    const merged = bench(pr({ state: 'MERGED' }), () => pr());
    expect(await merged.wb.mergePr('auth', { method: 'squash' })).toMatchObject({ ok: false, reason: 'closed', message: 'PR #42 is already merged' });
    expect(merged.merges).toEqual([]);
    const b = bench(pr(), () => pr({ state: 'MERGED' }));
    const [first, second] = await Promise.all([b.wb.mergePr('auth', { method: 'squash' }), b.wb.mergePr('auth', { method: 'squash' })]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: 'busy' });
    expect(b.merges).toHaveLength(1);
  });
});
