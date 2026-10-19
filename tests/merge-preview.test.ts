import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergePreview, parseCommits, parseShortstat } from '../src/workspaces/merge-preview.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-merge-'));
  sh(dir, 'init', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 'Tess');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-m', 'init');
  return dir;
}

function commit(dir: string, file: string, text: string, message: string): void {
  writeFileSync(path.join(dir, file), text);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-m', message);
}

describe('before merging a worktree', () => {
  it('says where it goes, what comes along, and that nothing stands in the way', async () => {
    const dir = repo();
    sh(dir, 'checkout', '-q', '-b', 'klaud/auth');
    commit(dir, 'b.txt', 'two\nthree\n', 'Add sign-in');
    commit(dir, 'c.txt', 'four\n', 'Add tests');
    sh(dir, 'checkout', '-q', 'main');
    const p = await mergePreview({ folder: dir, from: 'klaud/auth', into: 'main', uncommitted: 0 });
    expect(p).toMatchObject({ from: 'klaud/auth', into: 'main', folderOn: 'main', folderChanges: [], commitCount: 2, files: 2, insertions: 3, deletions: 0, newOnTarget: 0, conflicts: [] });
    expect(p.commits.map((c) => c.subject)).toEqual(['Add tests', 'Add sign-in']);
    expect(p.commits[0]).toMatchObject({ author: 'Tess' });
    expect(p.commits[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('finds conflicts, new commits on main and changes in the main folder, without changing anything', async () => {
    const dir = repo();
    sh(dir, 'checkout', '-q', '-b', 'klaud/edit');
    commit(dir, 'a.txt', 'mine\n', 'Edit a');
    sh(dir, 'checkout', '-q', 'main');
    commit(dir, 'a.txt', 'theirs\n', 'Edit a on main');
    writeFileSync(path.join(dir, 'notes.md'), 'draft\n');
    writeFileSync(path.join(dir, 'a.txt'), 'edited, not committed\n');
    const before = sh(dir, 'rev-parse', 'HEAD');
    const p = await mergePreview({ folder: dir, from: 'klaud/edit', into: 'main', uncommitted: 3 });
    expect(p.conflicts).toEqual(['a.txt']);
    expect(p.newOnTarget).toBe(1);
    // Changes to tracked files stand in the way; an untracked file doesn't.
    expect(p.folderChanges).toEqual(['a.txt']);
    expect(p.uncommitted).toBe(3);
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(before);
    expect(sh(dir, 'status', '--porcelain')).toBe(' M a.txt\n?? notes.md\n');
  });

  it('notices the main folder is on another branch', async () => {
    const dir = repo();
    sh(dir, 'branch', 'klaud/x');
    sh(dir, 'checkout', '-q', '-b', 'experiment');
    const p = await mergePreview({ folder: dir, from: 'klaud/x', into: 'main', uncommitted: 0 });
    expect(p.folderOn).toBe('experiment');
    expect(p.into).toBe('main');
    expect(p.commitCount).toBe(0);
  });

  it('reads git’s summaries', () => {
    expect(parseShortstat(' 3 files changed, 12 insertions(+), 1 deletion(-)\n')).toEqual({ files: 3, insertions: 12, deletions: 1 });
    expect(parseShortstat(' 1 file changed, 1 deletion(-)\n')).toEqual({ files: 1, insertions: 0, deletions: 1 });
    expect(parseShortstat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(parseCommits('abc\x1fFix it\x1fAda\x1f1700000000\n')).toEqual([{ hash: 'abc', subject: 'Fix it', author: 'Ada', when: 1700000000 }]);
  });
});
