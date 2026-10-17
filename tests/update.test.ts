import { describe, expect, it } from 'vitest';
import { type Run, type Status, decide, parseCommits, readStatus } from '../src/update/check.js';
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

describe('klaude update', () => {
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
    expect(g.text()).toContain("You're on the latest klaude");
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

    const nogit = fakeGit({ behind: 0, git: false });
    expect(await runUpdate({ run: nogit.run, out: nogit.out, root: '/k' })).toBe(1);
    expect(nogit.text()).toContain('git clone');
  });

  it('never updates a project that merely contains klaude (e.g. in node_modules)', async () => {
    const g = fakeGit({ behind: 2, toplevel: '/my-app\n' });
    expect(await runUpdate({ run: g.run, out: g.out, root: '/my-app/node_modules/klaude' })).toBe(1);
    expect(g.calls.some((c) => c.includes('fetch') || c.includes('merge'))).toBe(false);
  });
});
