import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pushForPr, pushWhy } from '../src/workspaces/pr.js';

/**
 * Create PR after a squash-merge (the "GitHub didn't open the pull request: To https://github.com/…"
 * that Kayra hit on 2026-10-26): the worktree's branch carried on from main under the same name, so
 * GitHub's copy (the merged PR's head) is no longer behind it. Real git, a bare origin, a stand-in gh.
 */

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let dir: string;
let work: string;
let ghAnswer: string;
const before = { BELUGA_GH: process.env.BELUGA_GH, KLAUD_GH: process.env.KLAUD_GH };

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pr-push-'));
  const origin = path.join(dir, 'origin.git');
  work = path.join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@t');
  git(work, 'config', 'user.name', 'T');
  git(work, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'A');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  // The first PR's work, pushed.
  git(work, 'checkout', '-q', '-b', 'feat');
  writeFileSync(path.join(work, 'b.txt'), 'b\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'B');
  git(work, 'push', '-q', '-u', 'origin', 'feat');
  // It's squash-merged into main on GitHub…
  git(work, 'checkout', '-q', 'main');
  git(work, 'merge', '-q', '--squash', 'feat');
  git(work, 'commit', '-q', '-m', 'B (#1)');
  git(work, 'push', '-q', 'origin', 'main');
  // …and the worktree carries on from main under the same branch name, with new work.
  git(work, 'checkout', '-q', '-B', 'feat', 'main');
  writeFileSync(path.join(work, 'c.txt'), 'c\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'C');
  // A stand-in gh: `gh pr view feat --json state,headRefOid` answers what the test says.
  const gh = path.join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh\ncat "${path.join(dir, 'gh.json')}"\n`);
  chmodSync(gh, 0o755);
  process.env.BELUGA_GH = gh;
  delete process.env.KLAUD_GH;
  ghAnswer = path.join(dir, 'gh.json');
});

afterEach(() => {
  for (const [k, v] of Object.entries(before)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const remoteFeat = (): string => git(work, 'ls-remote', 'origin', 'refs/heads/feat').split(/\s+/)[0]!;

describe('pushing for a pull request after the last one was squash-merged', () => {
  // Not on Windows: a stand-in gh written as a shell script.
  it.skipIf(process.platform === 'win32')('replaces GitHub’s copy when it is exactly the merged PR’s head', async () => {
    const mergedHead = remoteFeat();
    writeFileSync(ghAnswer, JSON.stringify({ state: 'MERGED', headRefOid: mergedHead }));
    expect(await pushForPr(work, 'feat')).toBe('replaced');
    expect(remoteFeat()).toBe(git(work, 'rev-parse', 'HEAD'));
  });

  it('never replaces it when that PR is still open', async () => {
    writeFileSync(ghAnswer, JSON.stringify({ state: 'OPEN', headRefOid: remoteFeat() }));
    await expect(pushForPr(work, 'feat')).rejects.toThrow(/GitHub has commits on feat that this worktree doesn’t/);
  });

  it('never replaces commits pushed after the merge', async () => {
    const mergedHead = remoteFeat();
    writeFileSync(ghAnswer, JSON.stringify({ state: 'MERGED', headRefOid: mergedHead }));
    // Someone pushed to feat on GitHub since.
    const other = path.join(dir, 'other');
    execFileSync('git', ['clone', '-q', '-b', 'feat', path.join(dir, 'origin.git'), other], { stdio: 'ignore' });
    git(other, 'config', 'user.email', 'o@o');
    git(other, 'config', 'user.name', 'O');
    writeFileSync(path.join(other, 'd.txt'), 'd\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'D');
    git(other, 'push', '-q', 'origin', 'feat');
    const theirs = remoteFeat();
    await expect(pushForPr(work, 'feat')).rejects.toThrow(/GitHub has commits on feat/);
    expect(remoteFeat()).toBe(theirs);
  });

  it('a plain push still just pushes', async () => {
    git(work, 'checkout', '-q', '-b', 'fresh');
    expect(await pushForPr(work, 'fresh')).toBe('pushed');
  });
});

describe('why git push failed, in a line', () => {
  it('says the refusal, not "To https://…"', () => {
    const stderr = [
      'To https://github.com/kayraucklnc/beluga.git',
      ' ! [rejected]        beluga/x -> beluga/x (non-fast-forward)',
      "error: failed to push some refs to 'https://github.com/kayraucklnc/beluga.git'",
      'hint: Updates were rejected because the tip of your current branch is behind',
    ].join('\n');
    expect(pushWhy(stderr)).toBe('GitHub’s copy of the branch has commits this worktree doesn’t (non-fast-forward)');
    expect(pushWhy('remote: Permission to x/y.git denied to bob.\nfatal: unable to access \'https://github.com/x/y.git/\': The requested URL returned error: 403')).toBe('remote: Permission to x/y.git denied to bob.');
    expect(pushWhy("To https://github.com/x/y.git\n ! [remote rejected] feat -> feat (protected branch hook declined)\nerror: failed to push some refs")).toBe('[remote rejected] feat -> feat (protected branch hook declined)');
  });
});
