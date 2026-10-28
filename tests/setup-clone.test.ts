import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clonedSetup, installedAsLocked } from '../src/workspaces/setup-clone.js';

const LOCK = JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/left-pad': { version: '1.3.0' }, 'node_modules/@esbuild/linux-x64': { version: '0.20.0', optional: true } } });

/** A package at `dir/rel`: its lockfile, and (installed) node_modules with npm's record of it. */
function pkg(dir: string, rel = '.', opts: { lock?: string; installed?: string | false; scripts?: Record<string, string> } = {}): void {
  const at = path.join(dir, rel);
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, 'package.json'), JSON.stringify({ name: 'app', scripts: opts.scripts ?? {} }));
  writeFileSync(path.join(at, 'package-lock.json'), opts.lock ?? LOCK);
  if (opts.installed === false) return;
  mkdirSync(path.join(at, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(path.join(at, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(path.join(at, 'node_modules', '.vite'), { recursive: true });
  writeFileSync(path.join(at, 'node_modules', '.package-lock.json'), opts.installed ?? JSON.stringify({ packages: { 'node_modules/left-pad': { version: '1.3.0' } } }));
}

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'setup-clone-'));

describe('a new worktree copies node_modules from a checkout with the same lockfile (BLG-366)', () => {
  it('knows when a checkout installed exactly its lockfile (another platform’s optional builds may be missing)', () => {
    const d = tmp();
    pkg(d);
    expect(installedAsLocked(d)).toBe(true);
    const old = tmp();
    pkg(old, '.', { installed: JSON.stringify({ packages: { 'node_modules/left-pad': { version: '1.2.0' } } }) });
    expect(installedAsLocked(old)).toBe(false);
    const missing = tmp();
    pkg(missing, '.', { installed: JSON.stringify({ packages: {} }) });
    expect(installedAsLocked(missing)).toBe(false);
  });

  it('copies each package that matches, keeps the installs that don’t, and leaves other commands alone', () => {
    const [main, ws] = [tmp(), tmp()];
    pkg(main);
    pkg(main, 'packages/mac', { lock: LOCK.replace('1.3.0', '9.9.9'), installed: JSON.stringify({ packages: { 'node_modules/left-pad': { version: '9.9.9' } } }) });
    pkg(ws, '.', { installed: false });
    pkg(ws, 'packages/mac', { installed: false });
    const out = clonedSetup('npm ci && npm ci --prefix packages/mac && make gen', ws, [main], 'darwin')!;
    expect(out).toContain(`cp -c -R '${path.join(main, 'node_modules')}' '${path.join(ws, 'node_modules')}'`);
    expect(out).toContain('|| { rm -rf');
    // The sub-package's lockfile differs: it installs as before.
    expect(out).toContain(' && npm ci --prefix packages/mac && make gen');
    expect(out).not.toContain(path.join(main, 'packages/mac', 'node_modules'));
  });

  it('copies nothing off macOS, into a worktree that has node_modules already, or from one not fully installed', () => {
    const [main, ws] = [tmp(), tmp()];
    pkg(main);
    pkg(ws, '.', { installed: false });
    expect(clonedSetup('npm ci', ws, [main], 'linux')).toBeUndefined();
    expect(clonedSetup('npm ci', ws, [ws], 'darwin')).toBeUndefined();
    const half = tmp();
    pkg(half, '.', { installed: JSON.stringify({ packages: {} }) });
    expect(clonedSetup('npm ci', ws, [half], 'darwin')).toBeUndefined();
    const done = tmp();
    pkg(done);
    expect(clonedSetup('npm ci', done, [main], 'darwin')).toBeUndefined();
    expect(clonedSetup('pnpm install', ws, [main], 'darwin')).toBeUndefined();
  });

  it.runIf(process.platform === 'darwin')('runs: the copy lands, its caches are dropped, and the package’s own install scripts run', () => {
    const [main, ws] = [tmp(), tmp()];
    pkg(main, 'packages/app', { scripts: { postinstall: 'echo ran > post.txt' } });
    pkg(ws, 'packages/app', { installed: false, scripts: { postinstall: 'echo ran > post.txt' } });
    const run = clonedSetup('npm ci --prefix packages/app', ws, [main])!;
    execFileSync('/bin/sh', ['-c', run], { cwd: ws, stdio: 'pipe' });
    const nm = path.join(ws, 'packages/app/node_modules');
    expect(readFileSync(path.join(nm, 'left-pad', 'index.js'), 'utf8')).toContain('module.exports');
    expect(existsSync(path.join(nm, '.vite'))).toBe(false);
    expect(readFileSync(path.join(ws, 'packages/app/post.txt'), 'utf8').trim()).toBe('ran');
    expect(installedAsLocked(path.join(ws, 'packages/app'))).toBe(true);
  });
});
