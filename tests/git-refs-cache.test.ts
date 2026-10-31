import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Every git the code runs goes through this, so a test can see which ones it skipped (set before git.js reads PATH).
const shim = await vi.hoisted(async () => {
  const { execFileSync: run } = await import('node:child_process');
  const fs = await import('node:fs');
  const { default: p } = await import('node:path');
  const { default: o } = await import('node:os');
  // The shim is a shell script: not on Windows (the tests below skip there).
  if (process.platform === 'win32') return { dir: '', log: '' };
  const real = run('/usr/bin/which', ['git']).toString().trim();
  const dir = fs.mkdtempSync(p.join(o.tmpdir(), 'beluga-gitshim-'));
  const log = p.join(dir, 'calls.log');
  fs.writeFileSync(p.join(dir, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return { dir, log };
});

import { REFS_RECOUNT_MS, refsMark, status } from '../src/workspaces/git.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();
const counts = (): number => readFileSync(shim.log, 'utf8').split('\n').filter((l) => l.startsWith('rev-list')).length;
/** Files changed this recently aren't trusted yet (a disk may keep whole seconds): wait them out. */
const settle = () => new Promise((r) => setTimeout(r, 2_100));

let base: string;
let repo: string;
let wt: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-refs-')));
  repo = path.join(base, 'app');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-m', 'init');
  wt = path.join(base, 'wt');
  sh(repo, 'worktree', 'add', '-b', 'beluga/x', wt, 'main');
  writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  sh(wt, 'add', '.');
  sh(wt, 'commit', '-m', 'b');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  if (shim.dir) rmSync(shim.dir, { recursive: true, force: true });
});

// Not on Windows: git is watched through a shell-script shim.

describe.skipIf(process.platform === 'win32')('a worktree’s commits against its base, counted only when its refs moved (BLG-407)', () => {
  it('reuses the count while nothing git keeps refs in changed, and counts again the moment one does', async () => {
    await settle();
    expect(await status(wt, 'main')).toEqual({ branch: 'beluga/x', changed: 0, ahead: 1, behind: 0 });
    const once = counts();
    expect(once).toBe(1);
    // Untracked and edited files never touch refs: git status still sees them on every look.
    writeFileSync(path.join(wt, 'new.txt'), 'n\n');
    writeFileSync(path.join(wt, 'b.txt'), 'edited\n');
    expect(await status(wt, 'main')).toEqual({ branch: 'beluga/x', changed: 2, ahead: 1, behind: 0 });
    expect(counts()).toBe(once);

    // A commit on the base (from the main folder): counted again at once.
    writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-m', 'c');
    expect(await status(wt, 'main')).toMatchObject({ ahead: 1, behind: 1 });
    expect(counts()).toBe(once + 1);
  }, 15_000);

  it('a ref written in place, a new branch or a moved HEAD changes the mark; nothing else does', async () => {
    await settle();
    const before = await refsMark(wt);
    expect(before).toBeDefined();
    expect(await refsMark(wt)).toBe(before);
    // Just changed: not trusted until it settles.
    sh(repo, 'branch', 'other', 'main');
    expect(await refsMark(wt)).toBeUndefined();
    await settle();
    const withBranch = await refsMark(wt);
    expect(withBranch).toBeDefined();
    expect(withBranch).not.toBe(before);
    // Written over in place, the way a tool that skips git's lock files would.
    const ref = path.join(repo, '.git', 'refs', 'heads', 'other');
    const sha = sh(repo, 'rev-parse', 'beluga/x').trim();
    writeFileSync(ref, `${sha}\n`);
    await settle();
    expect(await refsMark(wt)).not.toBe(withBranch);
    // Not a checkout's own folder: nothing to mark, git is asked every time.
    expect(await refsMark(base)).toBeUndefined();
    expect(REFS_RECOUNT_MS).toBe(5 * 60_000);
  }, 20_000);
});
