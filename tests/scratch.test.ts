import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

describe('the scratch folder (.beluga/scratch/)', () => {
  it('is made once and kept out of git, also from a worktree, without touching .gitignore', async () => {
    const dir = repo();
    await ensureScratch(dir);
    await ensureScratch(dir);
    writeFileSync(path.join(dir, SCRATCH_DIR, 'shot.png'), 'x');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    const exclude = readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/^\/\.beluga\/scratch\/$/gm)).toHaveLength(1);
    // Never Conductor's (or anyone's) .context/.
    expect(exclude).not.toContain('.context');
    // A worktree shares the main checkout's exclude file.
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
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
    expect(list.map((f) => f.path)).toEqual(['.beluga/scratch/shots/new.png', '.beluga/scratch/mid.md', '.beluga/scratch/old.json']);
    expect(list[0]).toMatchObject({ size: 3, mtime: 3_000_000 });
  });

  it('refuses a scratch folder (or its .beluga, or an old .klaud) that is a link to somewhere else', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'klaud-scratch-outside-'));
    writeFileSync(path.join(outside, 'secret.png'), 'x');
    const a = repo();
    mkdirSync(path.join(a, '.beluga'));
    symlinkSync(outside, path.join(a, SCRATCH_DIR));
    expect(await ensureScratch(a)).toBeUndefined();
    expect(await listScratch(a)).toEqual([]);
    const b = repo();
    symlinkSync(outside, path.join(b, '.beluga'));
    expect(await ensureScratch(b)).toBeUndefined();
    expect(await listScratch(b)).toEqual([]);
    // The folder from before the rename is only read, and never through a link either.
    const c = repo();
    symlinkSync(outside, path.join(c, '.klaud'));
    expect(await listScratch(c)).toEqual([]);
  });

  it('also lists .context/ (Claude saves there under other tools), mixed in newest first, without making it', async () => {
    const dir = repo();
    await ensureScratch(dir);
    const at = (rel: string, secs: number): void => {
      const file = path.join(dir, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'x');
      utimesSync(file, secs, secs);
    };
    at(`${SCRATCH_DIR}/ours.png`, 1000);
    at('.context/shots/theirs.png', 2000);
    at('.context/notes.md', 500);
    expect((await listScratch(dir)).map((f) => f.path)).toEqual(['.context/shots/theirs.png', `${SCRATCH_DIR}/ours.png`, '.context/notes.md']);
    // Only looked at: never made, never added to the exclude file.
    const fresh = repo();
    await ensureScratch(fresh);
    expect(existsSync(path.join(fresh, '.context'))).toBe(false);
    expect(readFileSync(path.join(fresh, '.git', 'info', 'exclude'), 'utf8')).not.toContain('.context');
  });

  it('skips a .context that is a link to somewhere else, and still lists its own folder', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'klaud-scratch-outside-'));
    writeFileSync(path.join(outside, 'secret.png'), 'x');
    const dir = repo();
    await ensureScratch(dir);
    writeFileSync(path.join(dir, SCRATCH_DIR, 'mine.png'), 'x');
    symlinkSync(outside, path.join(dir, '.context'));
    expect((await listScratch(dir)).map((f) => f.path)).toEqual([`${SCRATCH_DIR}/mine.png`]);
  });

  it('is empty when there is no folder yet', async () => {
    expect(await listScratch(mkdtempSync(path.join(os.tmpdir(), 'klaud-scratch-none-')))).toEqual([]);
  });
});
