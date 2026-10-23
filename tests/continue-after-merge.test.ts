import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentIn } from '../src/workspaces/git.js';
import { catchUpPrompt, resolvePrConflictsPrompt } from '../src/workspaces/pr.js';
import type { PullRequest } from '../src/core/work-store.js';

/** Continue After Merge moves a branch to the base only when everything on it is already there. */

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-after-merge-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 'Tess');
  commit(dir, 'a.txt', 'one\n', 'init');
  return dir;
}

function commit(dir: string, file: string, text: string, message: string): void {
  writeFileSync(path.join(dir, file), text);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', message);
}

describe('whether a branch is already in its base', () => {
  it('is, once squash-merged (the commits differ, the content is there), even with newer work on the base', async () => {
    const dir = repo();
    sh(dir, 'checkout', '-q', '-b', 'feature');
    commit(dir, 'b.txt', 'two\n', 'add b');
    commit(dir, 'b.txt', 'two\nthree\n', 'more b');
    sh(dir, 'checkout', '-q', 'main');
    sh(dir, 'merge', '-q', '--squash', 'feature');
    sh(dir, 'commit', '-q', '-m', 'Add b (#7)');
    commit(dir, 'c.txt', 'someone else\n', 'other work');
    expect(await contentIn(dir, 'feature', 'main')).toBe(true);
  });

  it('is not, when the branch carried on after the merge', async () => {
    const dir = repo();
    sh(dir, 'checkout', '-q', '-b', 'feature');
    commit(dir, 'b.txt', 'two\n', 'add b');
    sh(dir, 'checkout', '-q', 'main');
    sh(dir, 'merge', '-q', '--squash', 'feature');
    sh(dir, 'commit', '-q', '-m', 'Add b (#7)');
    sh(dir, 'checkout', '-q', 'feature');
    commit(dir, 'd.txt', 'after the merge\n', 'more work');
    expect(await contentIn(dir, 'feature', 'main')).toBe(false);
  });

  it('is not, when merging would conflict', async () => {
    const dir = repo();
    sh(dir, 'checkout', '-q', '-b', 'feature');
    commit(dir, 'a.txt', 'mine\n', 'change a');
    sh(dir, 'checkout', '-q', 'main');
    commit(dir, 'a.txt', 'theirs\n', 'change a too');
    expect(await contentIn(dir, 'feature', 'main')).not.toBe(true);
  });
});

describe('what Claude is asked', () => {
  const pr = { number: 7, url: 'https://github.com/bob/api/pull/7' } as PullRequest;

  it('resolves a PR’s conflicts by merging the base in, never rewriting what is pushed', () => {
    const text = resolvePrConflictsPrompt(pr, 'main');
    expect(text).toContain('#7');
    expect(text).toContain('git merge origin/main');
    expect(text).toMatch(/never force-push/);
    expect(text).toMatch(/both intents/);
  });

  it('catches a carried-on branch up without pushing', () => {
    const text = catchUpPrompt(pr, 'main');
    expect(text).toContain('git merge origin/main');
    expect(text).toMatch(/Don't push/);
  });
});
