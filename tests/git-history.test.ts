import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { commitDetail, historyFilters, log, parseNumstat, parseRefs, pathspecs, splitDiff } from '../src/workspaces/history.js';

/** History for the Mac app: commits with parents and refs (the graph), filters, one commit's diff. */

let repo: string;
const git = (cwd: string, who: string, ...args: string[]) => execFileSync('git', ['-c', `user.name=${who}`, '-c', `user.email=${who.toLowerCase()}@x.dev`, ...args], { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T12:00:00Z' } }).toString();
const commit = (who: string, file: string, content: string, message: string, when: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), content);
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', `user.name=${who}`, '-c', `user.email=${who.toLowerCase()}@x.dev`, 'commit', '-q', '-m', message], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
};

beforeAll(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-hist-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  commit('Ada', 'README.md', '# app\n', 'Initial commit', '2026-10-01T10:00:00Z');
  commit('Ada', 'src/server.ts', 'one\n', 'Add the server', '2026-10-01T11:00:00Z');
  execFileSync('git', ['switch', '-q', '-c', 'feat/auth'], { cwd: repo });
  commit('Bo', 'src/auth/session.ts', 'session\n', 'Add sessions\n\nCookies, signed.', '2026-10-02T09:00:00Z');
  execFileSync('git', ['switch', '-q', 'main'], { cwd: repo });
  commit('Ada', 'src/server.ts', 'one\ntwo\n', 'Log requests', '2026-10-02T10:00:00Z');
  git(repo, 'Ada', 'merge', '-q', '--no-ff', 'feat/auth', '-m', 'Merge feat/auth');
  git(repo, 'Ada', 'mv', 'README.md', 'docs.md');
  git(repo, 'Ada', 'commit', '-q', '-m', 'Rename the readme');
  execFileSync('git', ['tag', 'v1.0'], { cwd: repo });
});

describe('log', () => {
  it('lists every branch newest first, children before parents, with refs', async () => {
    const page = await log(repo, { branch: 'all' });
    expect(page.commits.map((c) => c.subject)).toEqual(['Rename the readme', 'Merge feat/auth', 'Log requests', 'Add sessions', 'Add the server', 'Initial commit']);
    const [top, merge] = page.commits;
    expect(top!.refs).toEqual([{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'branch' }, { name: 'v1.0', kind: 'tag' }]);
    expect(merge!.parents).toHaveLength(2);
    expect(page.commits.find((c) => c.subject === 'Add sessions')).toMatchObject({ author: { name: 'Bo', email: 'bo@x.dev' }, body: 'Cookies, signed.', refs: [{ name: 'feat/auth', kind: 'branch' }] });
    expect(top!.short).toHaveLength(7);
    expect(top!.date).toBeGreaterThan(Date.parse('2026-01-01'));
    expect(page.next).toBeUndefined();
  });

  it('pages', async () => {
    const first = await log(repo, { limit: 4 });
    expect(first.commits).toHaveLength(4);
    expect(first.next).toBe('4');
    const second = await log(repo, { limit: 4, before: first.next });
    expect(second.commits.map((c) => c.subject)).toEqual(['Add the server', 'Initial commit']);
    expect(second.next).toBeUndefined();
  });

  it('filters by branch, author and path', async () => {
    expect((await log(repo, { branch: 'feat/auth' })).commits.map((c) => c.subject)).toEqual(['Add sessions', 'Add the server', 'Initial commit']);
    expect((await log(repo, { author: 'bo@X' })).commits.map((c) => c.subject)).toEqual(['Add sessions']);
    expect((await log(repo, { path: 'src/server.ts' })).commits.map((c) => c.subject)).toEqual(['Log requests', 'Add the server']);
    expect((await log(repo, { path: 'auth' })).commits.map((c) => c.subject)).toEqual(['Add sessions']);
    await expect(log(repo, { branch: '--output=/tmp/x' })).rejects.toThrow(/no branch/);
    await expect(log(repo, { branch: 'nope' })).rejects.toThrow(/no branch/);
  });

  it('marks what the upstream has that HEAD doesn’t ("current")', async () => {
    const clone = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-hist-clone-')));
    execFileSync('git', ['clone', '-q', repo, clone]);
    execFileSync('git', ['reset', '-q', '--hard', 'HEAD~2'], { cwd: clone });
    const page = await log(clone, { branch: 'current' });
    expect(page.commits.filter((c) => c.incoming).map((c) => c.subject)).toEqual(['Rename the readme', 'Merge feat/auth', 'Add sessions']);
  });
});

describe('one commit', () => {
  it('has its files with +/− and each file’s diff', async () => {
    const page = await log(repo, {});
    const logReq = page.commits.find((c) => c.subject === 'Log requests')!;
    const detail = await commitDetail(repo, logReq.hash);
    expect(detail.commit.subject).toBe('Log requests');
    expect(detail.files).toEqual([{ path: 'src/server.ts', added: 1, removed: 0, state: 'modified', diff: expect.stringContaining('+two') }]);
    const rename = await commitDetail(repo, page.commits[0]!.hash);
    expect(rename.files[0]).toMatchObject({ path: 'docs.md', from: 'README.md', state: 'renamed' });
    const first = await commitDetail(repo, page.commits.at(-1)!.hash);
    expect(first.files).toEqual([expect.objectContaining({ path: 'README.md', state: 'added', added: 1 })]);
    expect(first.against).toBeUndefined();
    await expect(commitDetail(repo, 'not-a-hash')).rejects.toThrow();
    await expect(commitDetail(repo, 'deadbeef')).rejects.toThrow(/no commit/);
  });
});

describe('filters', () => {
  it('lists branches, tags and authors by activity', async () => {
    const f = await historyFilters(repo);
    expect(f.current).toBe('main');
    expect(f.branches).toEqual(expect.arrayContaining(['main', 'feat/auth']));
    expect(f.remotes).toEqual([]);
    expect(f.tags).toEqual(['v1.0']);
    expect(f.authors[0]).toMatchObject({ name: 'Ada', commits: 5 });
    expect(f.authors[1]).toMatchObject({ name: 'Bo', commits: 1 });
  });
});

describe('parsing', () => {
  it('reads decorations', () => {
    expect(parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v2')).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'main', kind: 'branch' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'v2', kind: 'tag' },
    ]);
    expect(parseRefs('HEAD')).toEqual([{ name: 'HEAD', kind: 'head' }]);
    expect(parseRefs('')).toEqual([]);
  });

  it('turns a path search into pathspecs', () => {
    expect(pathspecs('')).toEqual([]);
    expect(pathspecs('auth')).toEqual([':(glob,icase)**/*auth*', ':(glob,icase)**/*auth*/**']);
    expect(pathspecs('src/a*.ts')[0]).toBe(':(icase)src/a*.ts');
    expect(pathspecs('src/a*.ts')[1]).toBe(':(glob,icase)**/*src/a\\*.ts*');
  });

  it('numstat with renames and binaries; diffs per file', () => {
    expect(parseNumstat('3\t1\ta.ts\0-\t-\timg.png\0' + '0\t0\t\0old.md\0new.md\0', 'M\0a.ts\0A\0img.png\0R100\0old.md\0new.md\0')).toEqual([
      { path: 'a.ts', added: 3, removed: 1, state: 'modified' },
      { path: 'img.png', added: 0, removed: 0, state: 'added', binary: true },
      { path: 'new.md', from: 'old.md', added: 0, removed: 0, state: 'renamed' },
    ]);
    const parts = splitDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n');
    expect([...parts.keys()]).toEqual(['a.ts', 'gone.ts']);
  });
});

describe('the default branch’s history', () => {
  it('shows main and its upstream wherever the folder is, marking what main hasn’t got yet', async () => {
    const clone = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-hist-default-')));
    execFileSync('git', ['clone', '-q', repo, clone]);
    execFileSync('git', ['switch', '-q', '-c', 'elsewhere', 'HEAD~3'], { cwd: clone });
    execFileSync('git', ['branch', '-q', '-f', 'main', 'origin/main~2'], { cwd: clone, stdio: 'pipe' });
    const page = await log(clone, { branch: 'default' }, { branch: 'main', upstream: 'origin/main' });
    expect(page.commits[0]!.subject).toBe('Rename the readme');
    expect(page.commits.filter((c) => c.incoming).map((c) => c.subject)).toEqual(['Rename the readme', 'Merge feat/auth', 'Add sessions']);
    // Without the project's refs it falls back to what's checked out.
    expect((await log(clone, { branch: 'default' })).commits[0]!.subject).not.toBe('Rename the readme');
  });
});
