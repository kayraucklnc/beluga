import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Run, type Status, compareVersions, decide, parseCommits, readStatus } from '../src/update/check.js';
import { runUpdate } from '../src/update/update.js';

const base: Status = { branch: 'main', upstream: 'origin/main', head: 'aaa', behind: 0, ahead: 0, dirty: false, incoming: [], depsChanged: false };

function fakeGit(o: { behind: number; ahead?: number; dirty?: boolean; deps?: boolean; git?: boolean; failBuild?: boolean; toplevel?: string }) {
  const calls: string[] = [];
  const run: Run = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    if (key.includes('--show-toplevel')) {
      if (o.git === false) throw new Error('not a repo');
      return o.toplevel ?? '/k\n';
    }
    if (key.includes('@{u}')) return 'origin/main\n';
    if (key.includes('--abbrev-ref HEAD')) return 'main\n';
    if (key.includes('rev-parse --short HEAD')) return calls.some((c) => c.includes('merge --ff-only')) ? 'bbb\n' : 'aaa\n';
    if (key.includes('rev-list')) return `${o.behind}\t${o.ahead ?? 0}\n`;
    if (key.includes('status --porcelain')) return o.dirty ? ' M src/x.ts\n' : '';
    if (key.includes('git log')) return Array.from({ length: o.behind }, (_, i) => `c${i} change ${i}`).join('\n');
    if (key.includes('diff --name-only')) return o.deps ? 'package.json\nsrc/a.ts\n' : 'src/a.ts\n';
    if (key.includes('run --silent build') && o.failBuild) throw new Error('tsc: error TS1005');
    return '';
  };
  let text = '';
  return { run, calls, out: { write: (s: string) => void (text += s), tty: false }, text: () => text };
}

describe('beluga update', () => {
  it('parses one-line logs', () => {
    expect(parseCommits('abc fix: a thing\ndef feat: b\n')).toEqual([
      { sha: 'abc', subject: 'fix: a thing' },
      { sha: 'def', subject: 'feat: b' },
    ]);
  });

  it('decides latest, available, or blocked', () => {
    expect(decide(base).kind).toBe('latest');
    expect(decide({ ...base, behind: 2 })).toEqual({ kind: 'available', count: 2 });
    expect(decide({ ...base, behind: 2, dirty: true }).kind).toBe('blocked');
    expect(decide({ ...base, behind: 2, ahead: 1 }).kind).toBe('blocked');
    // Local edits don't matter when there's nothing to pull.
    expect(decide({ ...base, dirty: true }).kind).toBe('latest');
  });

  it('reads status including incoming commits and dependency changes', async () => {
    const g = fakeGit({ behind: 2, deps: true });
    const s = await readStatus(g.run);
    expect(s).toMatchObject({ behind: 2, ahead: 0, upstream: 'origin/main', depsChanged: true });
    expect(s.incoming).toHaveLength(2);
  });

  it('says so when already up to date and installs nothing', async () => {
    const g = fakeGit({ behind: 0 });
    expect(await runUpdate({ run: g.run, out: g.out, root: '/k' })).toBe(0);
    expect(g.text()).toContain("You're on the latest Beluga");
    expect(g.calls.some((c) => c.includes('merge'))).toBe(false);
  });

  it('only reports with --check', async () => {
    const g = fakeGit({ behind: 3 });
    expect(await runUpdate({ run: g.run, out: g.out, root: '/k', checkOnly: true })).toBe(0);
    expect(g.text()).toContain('3 updates available');
    expect(g.text()).toContain('change 0');
    expect(g.calls.some((c) => c.includes('merge'))).toBe(false);
  });

  it('fast-forwards and rebuilds, running npm install only when dependencies changed', async () => {
    const plain = fakeGit({ behind: 1 });
    expect(await runUpdate({ run: plain.run, out: plain.out, root: '/k' })).toBe(0);
    expect(plain.calls).toContain('git merge --ff-only --quiet origin/main');
    expect(plain.calls.some((c) => c.startsWith('npm install'))).toBe(false);
    expect(plain.calls).toContain('npm run --silent build');
    expect(plain.text()).toContain('aaa → bbb');
    expect(plain.text()).toContain('is installed');

    const deps = fakeGit({ behind: 1, deps: true });
    await runUpdate({ run: deps.run, out: deps.out, root: '/k' });
    expect(deps.calls.some((c) => c.startsWith('npm ci'))).toBe(true);
  });

  it('refuses to touch local edits', async () => {
    const g = fakeGit({ behind: 1, dirty: true });
    expect(await runUpdate({ run: g.run, out: g.out, root: '/k' })).toBe(1);
    expect(g.text()).toContain('local edits');
    expect(g.calls.some((c) => c.includes('merge'))).toBe(false);
  });

  it('explains failures and non-git installs', async () => {
    const fail = fakeGit({ behind: 1, failBuild: true });
    expect(await runUpdate({ run: fail.run, out: fail.out, root: '/k' })).toBe(1);
    expect(fail.text()).toContain('TS1005');
    expect(fail.text()).toContain('npm run build'); // tells you how to finish

  });

  it('updates an npm install from npm', async () => {
    const calls: string[] = [];
    const npm = (latest: string, globalRoot = '/usr/lib/node_modules') => async (cmd: string, args: readonly string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      if (key.includes('--show-toplevel')) throw new Error('not a repo');
      if (key === 'npm root -g') return `${globalRoot}\n`;
      if (key === 'npm view beluga-code version') return `${latest}\n`;
      return '';
    };
    let text = '';
    const out = { write: (s: string) => void (text += s), tty: false };
    const root = '/usr/lib/node_modules/beluga-code';
    // installedVersion reads root/package.json, which doesn't exist here → "unknown" (0.0.0)
    expect(await runUpdate({ run: npm('9.9.9'), out, root })).toBe(0);
    expect(calls).toContain('npm install -g --no-audit --no-fund --loglevel=error beluga-code@9.9.9');
    expect(calls.some((c) => c.includes('uninstall'))).toBe(false);
    expect(text).toContain('Beluga 9.9.9 is installed');

    text = '';
    expect(await runUpdate({ run: npm('9.9.9'), out, root, checkOnly: true })).toBe(0);
    expect(text).toContain('available');

    text = '';
    expect(await runUpdate({ run: npm('9.9.9', '/elsewhere'), out, root })).toBe(1);
    expect(text).toContain('part of another project');
  });

  it('moves an install under the old npm name (klaudcode) to beluga-code, and puts it back if that fails', async () => {
    const globalRoot = mkdtempSync(path.join(os.tmpdir(), 'beluga-npm-'));
    const root = path.join(globalRoot, 'klaudcode');
    mkdirSync(root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'klaudcode', version: '0.6.2' }));
    const calls: string[] = [];
    let installFails = false;
    const run = async (cmd: string, args: readonly string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      if (key.includes('--show-toplevel')) throw new Error('not a repo');
      if (key === 'npm root -g') return `${globalRoot}\n`;
      if (key === 'npm view beluga-code version') return '9.9.9\n';
      if (installFails && key.endsWith('beluga-code@9.9.9')) throw new Error('E404 not found');
      return '';
    };
    const out = { write: () => undefined, tty: false };
    expect(await runUpdate({ run, out, root })).toBe(0);
    const uninstall = calls.findIndex((c) => c === 'npm uninstall -g --loglevel=error klaudcode');
    const install = calls.findIndex((c) => c.endsWith('install -g --no-audit --no-fund --loglevel=error beluga-code@9.9.9'));
    expect(uninstall).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(uninstall);

    calls.length = 0;
    installFails = true;
    expect(await runUpdate({ run, out, root })).toBe(1);
    expect(calls).toContain('npm install -g --no-audit --no-fund --loglevel=error klaudcode@0.6.2');
  });

  it('compares versions', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBe(1);
    expect(compareVersions('0.2.1', '0.2.1')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
  });

  it('never updates a project that merely contains Beluga (e.g. in node_modules)', async () => {
    const g = fakeGit({ behind: 2, toplevel: '/my-app\n' });
    expect(await runUpdate({ run: g.run, out: g.out, root: '/my-app/node_modules/beluga-code' })).toBe(1);
    expect(g.calls.some((c) => c.includes('fetch') || c.includes('merge'))).toBe(false);
  });
});
