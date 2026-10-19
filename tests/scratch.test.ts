import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCRATCH_DIR, ensureScratch, listScratch } from '../src/workspaces/scratch.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-scratch-'));
  git(dir, 'init', '-q');
  return dir;
}

describe('the scratch folder (.klaud/scratch/)', () => {
  it('is made once and kept out of git, also from a worktree, without touching .gitignore', async () => {
    const dir = repo();
    await ensureScratch(dir);
    await ensureScratch(dir);
    writeFileSync(path.join(dir, SCRATCH_DIR, 'shot.png'), 'x');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    const exclude = readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/^\/\.klaud\/scratch\/$/gm)).toHaveLength(1);
    // Never Conductor's (or anyone's) .context/.
    expect(exclude).not.toContain('.context');
    // A worktree shares the main checkout's exclude file.
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = path.join(dir, '..', `${path.basename(dir)}-wt`);
    git(dir, 'worktree', 'add', '-q', wt);
    await ensureScratch(wt);
    writeFileSync(path.join(wt, SCRATCH_DIR, 'notes.json'), '{}');
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('works in a folder that isn’t a git repo', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-scratch-plain-'));
    await ensureScratch(dir);
    expect(await listScratch(dir)).toEqual([]);
  });

  it('lists what’s in it, newest first, a few folders deep', async () => {
    const dir = repo();
    await ensureScratch(dir);
    const at = (rel: string, secs: number, body = 'x'): void => {
      const file = path.join(dir, SCRATCH_DIR, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
      utimesSync(file, secs, secs);
    };
    at('old.json', 1000);
    at('shots/new.png', 3000, 'abc');
    at('mid.md', 2000);
    const list = await listScratch(dir);
    expect(list.map((f) => f.path)).toEqual(['.klaud/scratch/shots/new.png', '.klaud/scratch/mid.md', '.klaud/scratch/old.json']);
    expect(list[0]).toMatchObject({ size: 3, mtime: 3_000_000 });
  });

  it('is empty when there is no folder yet', async () => {
    expect(await listScratch(mkdtempSync(path.join(os.tmpdir(), 'klaud-scratch-none-')))).toEqual([]);
  });
});
