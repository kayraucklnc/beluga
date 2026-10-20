import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveWorktree, dropArchive, freeSpace, planArchive, readManifest, restoreWorktree } from '../src/workspaces/archive.js';
import { regenRule, remakeSteps } from '../src/workspaces/regenerable.js';

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const put = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe('what can be thrown away and made again', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-regen-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('only where the tool that makes it is there', () => {
    put(path.join(root, 'package.json'), '{}');
    put(path.join(root, 'android/app/build.gradle'), '');
    put(path.join(root, 'crates/x/Cargo.toml'), '');
    expect(regenRule(root, 'node_modules/')?.what).toBe('npm packages');
    expect(regenRule(root, 'dist/')?.remake).toBe('npm run build');
    expect(regenRule(root, 'android/app/build/')?.what).toBe('Gradle and Android build output');
    expect(regenRule(root, 'crates/x/target/')?.what).toBe('Rust and Maven build output');
    expect(regenRule(root, 'node_modules/left-pad/index.js')?.what).toBe('npm packages');
    expect(regenRule(root, '.next/')?.what).toBe('JavaScript build caches');
    expect(regenRule(root, 'pkg/foo.egg-info/')?.what).toBe('Python caches');
    // Without its tool beside it, a folder called "target" or "vendor" is yours.
    expect(regenRule(root, 'target/')).toBeUndefined();
    expect(regenRule(root, 'vendor/')).toBeUndefined();
    expect(regenRule(root, 'crates/build/')).toBeUndefined();
    // Never a file of yours, whatever it's called.
    expect(regenRule(root, '.env')).toBeUndefined();
    expect(regenRule(root, 'thesis/Thesis.pdf')).toBeUndefined();
    expect(regenRule(root, 'apps/web/.DS_Store')?.what).toBe('Finder’s folder settings');
    expect(regenRule(root, 'tsconfig.tsbuildinfo')?.what).toBe('TypeScript build info');
    expect(regenRule(root, 'node_modules')).toBeUndefined();
    expect(remakeSteps([regenRule(root, 'dist/')!, regenRule(root, 'node_modules/')!, regenRule(root, '.next/')!])).toEqual(['npm install', 'npm run build']);
  });
});

describe('a smart archive', () => {
  let base: string;
  let repo: string;
  let wt: string;
  let archives: string;
  const files = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const f of ['src/app.ts', 'src/new.ts', 'notes.md', '.env', 'data/local.db', 'target/keep.txt', 'staged.ts']) if (existsSync(path.join(wt, f))) out[f] = readFileSync(path.join(wt, f), 'utf8');
    return out;
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-archive-')));
    repo = path.join(base, 'repo');
    archives = path.join(base, 'archives');
    mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    put(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n.env\ndata/\ntarget/\n.DS_Store\n');
    put(path.join(repo, 'package.json'), '{"name":"x"}');
    put(path.join(repo, 'src/app.ts'), 'one\n');
    put(path.join(repo, 'gone.ts'), 'bye\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'first');
    wt = path.join(base, 'wt');
    sh(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
    put(path.join(wt, 'src/app.ts'), 'one\ntwo\n');
    rmSync(path.join(wt, 'gone.ts'));
    put(path.join(wt, 'staged.ts'), 'staged\n');
    sh(wt, 'add', 'staged.ts');
    put(path.join(wt, 'src/new.ts'), 'untracked\n');
    put(path.join(wt, 'notes.md'), 'mine\n');
    put(path.join(wt, '.env'), 'SECRET=1\n');
    put(path.join(wt, 'data/local.db'), 'rows');
    put(path.join(wt, 'target/keep.txt'), 'no Cargo.toml: yours');
    put(path.join(wt, 'node_modules/left-pad/index.js'), 'x'.repeat(50_000));
    put(path.join(wt, 'dist/app.js'), 'built');
    put(path.join(wt, 'data/sub/more.db'), 'more');
    put(path.join(wt, '.DS_Store'), 'finder');
    symlinkSync('src/app.ts', path.join(wt, 'link.ts'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('says what goes and what stays before doing anything', async () => {
    const plan = await planArchive(wt);
    expect(plan.drop.map((d) => d.path).sort()).toEqual(['.DS_Store', 'dist/', 'node_modules/']);
    expect([...plan.keep].sort()).toEqual(['.env', 'data/', 'target/']);
    expect(plan.dropBytes).toBeGreaterThan(40_000);
    expect(plan.remake).toEqual(['npm install', 'npm run build']);
    expect(existsSync(path.join(wt, 'node_modules'))).toBe(true);
  });

  it('keeps everything that isn’t made again, frees the rest, and brings it all back as it was', async () => {
    const before = files();
    const status = sh(wt, 'status', '--porcelain');
    const phases: string[] = [];
    const m = await archiveWorktree({ repo, dir: wt, id: 'w1', archivesDir: archives, onPhase: (p) => phases.push(p) });
    expect(existsSync(wt)).toBe(false);
    expect(phases).toEqual(['saving', 'compressing', 'removing']);
    expect(m.branch).toBe('feature');
    expect(m.freedBytes).toBeGreaterThan(40_000);
    expect(m.dropped.map((d) => d.path).sort()).toEqual(['.DS_Store', 'dist/', 'node_modules/']);
    // The branch stays; the snapshot is kept by a ref of its own (so git never cleans it away).
    expect(sh(repo, 'branch', '--list', 'feature')).toContain('feature');
    expect(sh(repo, 'rev-parse', `refs/klaud/archive/w1`).trim()).toBe(m.snapshot);
    expect(readManifest(archives, 'w1')?.snapshot).toBe(m.snapshot);

    await restoreWorktree({ repo, dir: wt, id: 'w1', archivesDir: archives });
    expect(files()).toEqual(before);
    expect(sh(wt, 'status', '--porcelain')).toBe(status);
    expect(existsSync(path.join(wt, 'gone.ts'))).toBe(false);
    expect(lstatSync(path.join(wt, 'link.ts')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(wt, 'link.ts'))).toBe('src/app.ts');
    // Made again, not kept.
    expect(existsSync(path.join(wt, 'node_modules'))).toBe(false);
    // Restored: the archive is gone with its ref.
    expect(readManifest(archives, 'w1')).toBeUndefined();
    expect(sh(repo, 'for-each-ref', 'refs/klaud/')).toBe('');
  });

  it('a clean worktree with nothing ignored but dependencies keeps no file at all', async () => {
    rmSync(path.join(wt, '.env'));
    rmSync(path.join(wt, 'data'), { recursive: true });
    rmSync(path.join(wt, 'target'), { recursive: true });
    const m = await archiveWorktree({ repo, dir: wt, id: 'w2', archivesDir: archives });
    expect(m.keptFile).toBeUndefined();
    await restoreWorktree({ repo, dir: wt, id: 'w2', archivesDir: archives });
    expect(readFileSync(path.join(wt, 'notes.md'), 'utf8')).toBe('mine\n');
  });

  it('a branch that moved on meanwhile: back at the commit it was on, nothing mixed up', async () => {
    const m = await archiveWorktree({ repo, dir: wt, id: 'w4', archivesDir: archives });
    const other = path.join(base, 'other');
    sh(repo, 'worktree', 'add', '-q', other, 'feature');
    put(path.join(other, 'later.ts'), 'later\n');
    sh(other, 'add', '-A');
    sh(other, 'commit', '-qm', 'later');
    sh(repo, 'worktree', 'remove', other);
    await restoreWorktree({ repo, dir: wt, id: 'w4', archivesDir: archives });
    expect(sh(wt, 'rev-parse', 'HEAD').trim()).toBe(m.head);
    expect(existsSync(path.join(wt, 'later.ts'))).toBe(false);
    expect(readFileSync(path.join(wt, 'src/app.ts'), 'utf8')).toBe('one\ntwo\n');
  });

  it('forgets an archive for good when the worktree is deleted', async () => {
    await archiveWorktree({ repo, dir: wt, id: 'w5', archivesDir: archives });
    await dropArchive(repo, archives, 'w5');
    expect(readManifest(archives, 'w5')).toBeUndefined();
    expect(sh(repo, 'for-each-ref', 'refs/klaud/')).toBe('');
  });

  it('changes nothing when it can’t save everything', async () => {
    await expect(archiveWorktree({ repo, dir: path.join(base, 'nowhere'), id: 'w3', archivesDir: archives })).rejects.toThrow();
    expect(existsSync(wt)).toBe(true);
    expect(readManifest(archives, 'w3')).toBeUndefined();
  });

  it('frees space in a worktree you keep: only what’s made again', async () => {
    const freed = await freeSpace(wt);
    expect(freed.bytes).toBeGreaterThan(40_000);
    expect(existsSync(path.join(wt, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(wt, '.env'))).toBe(true);
    expect(existsSync(path.join(wt, 'target/keep.txt'))).toBe(true);
  });
});
