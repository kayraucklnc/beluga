import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cloneFromBundle, cloneUrl, copyTarget, packProject } from '../src/core/friend-share/copy.js';

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('a friend’s copy of a project shared whole (BLG-258)', () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-copy-test-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('clones from https without the user or token in the remote, and never from a path', () => {
    expect(cloneUrl('git@github.com:kay/app.git')).toBe('https://github.com/kay/app');
    expect(cloneUrl('https://x-access-token:secret@github.com/kay/app.git')).toBe('https://github.com/kay/app');
    expect(cloneUrl('ssh://git@gitlab.acme.io:22/team/app')).toBe('https://gitlab.acme.io/team/app');
    expect(cloneUrl('/Users/kay/app')).toBeUndefined();
    expect(cloneUrl('file:///Users/kay/app')).toBeUndefined();
    expect(cloneUrl('../app')).toBeUndefined();
    expect(cloneUrl(undefined)).toBeUndefined();
  });

  it('puts it in ~/Beluga/<owner>/<project>, numbered when that is taken', () => {
    const home = tmp();
    expect(copyTarget('Kayra', 'beluga', home)).toBe(path.join(home, 'Kayra', 'beluga'));
    mkdirSync(path.join(home, 'Kayra', 'beluga'), { recursive: true });
    expect(copyTarget('Kayra', 'beluga', home)).toBe(path.join(home, 'Kayra', 'beluga 2'));
    expect(copyTarget('../evil', 'a/b', home)).toBe(path.join(home, '-evil', 'a-b'));
  });

  it('sends every branch in a bundle, and the copy has them all with origin on the real repository', async () => {
    const root = tmp();
    run(root, 'init', '-q', '-b', 'main');
    run(root, 'config', 'user.email', 't@t');
    run(root, 'config', 'user.name', 't');
    writeFileSync(path.join(root, 'a.txt'), 'main\n');
    run(root, 'add', '.');
    run(root, 'commit', '-qm', 'one');
    run(root, 'checkout', '-qb', 'feature');
    writeFileSync(path.join(root, 'b.txt'), 'feature\n');
    run(root, 'add', '.');
    run(root, 'commit', '-qm', 'two');
    run(root, 'checkout', '-q', 'main');

    const out = tmp();
    const { file, size } = await packProject(root, path.join(out, 'outbox'));
    expect(size).toBeGreaterThan(0);
    const dest = path.join(out, 'Beluga', 'Kayra', 'app');
    await cloneFromBundle(readFileSync(file), dest, 'https://github.com/kay/app');
    expect(readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('main\n');
    expect(run(dest, 'branch', '--format=%(refname:short)').split('\n').sort()).toEqual(['feature', 'main']);
    expect(run(dest, 'remote', 'get-url', 'origin')).toBe('https://github.com/kay/app');

    const bare = path.join(out, 'bare');
    await cloneFromBundle(readFileSync(file), bare, undefined);
    expect(run(bare, 'remote')).toBe('');
  });
});
