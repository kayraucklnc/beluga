import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceController } from '../src/core/workspace-controller.js';
import { envChanges, envChangesAsync, envSnapshot, findEnvFiles, followMainEnv, followMainEnvAsync, scanEnvFiles } from '../src/workspaces/env.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

let base: string;
let repo: string;

/** A checkout with env files everywhere findEnvFiles looks: the walk, git's lists, .worktreeinclude, and places it skips. */
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-envscan-')));
  repo = path.join(base, 'app');
  mkdirSync(repo);
  sh(repo, 'init', '-b', 'main');
  writeFileSync(path.join(repo, '.gitignore'), '.env*\nnode_modules/\nsecrets.json\nbuild-out/\n');
  writeFileSync(path.join(repo, 'README.md'), '# hi\n');
  sh(repo, 'add', '.');
  sh(repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'init');
  writeFileSync(path.join(repo, '.env'), 'API=1\nKEEP=yes\n');
  writeFileSync(path.join(repo, '.env.example'), 'API=\n');
  writeFileSync(path.join(repo, '.envrc'), 'export A=1\n');
  mkdirSync(path.join(repo, '.aws'));
  writeFileSync(path.join(repo, '.aws', 'config'), '[default]\n');
  const deep = path.join(repo, 'apps', 'web', 'config', 'local');
  mkdirSync(deep, { recursive: true });
  writeFileSync(path.join(deep, '.env'), 'DEEP=1\n');
  mkdirSync(path.join(repo, '.config', 'tool'), { recursive: true });
  writeFileSync(path.join(repo, '.config', 'tool', '.dev.vars'), 'B=2\n');
  mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules', 'pkg', '.env'), 'X=1\n');
  mkdirSync(path.join(repo, 'build-out'));
  writeFileSync(path.join(repo, 'build-out', '.env'), 'Y=1\n');
  writeFileSync(path.join(repo, 'secrets.json'), '{}\n');
  writeFileSync(path.join(repo, '.worktreeinclude'), 'secrets.json\n');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('env files, listed without blocking the daemon (BLG-406)', () => {
  it('lists exactly what findEnvFiles lists', async () => {
    const want = findEnvFiles(repo);
    expect(want).toEqual(['.aws/config', '.config/tool/.dev.vars', '.env', '.envrc', 'apps/web/config/local/.env', 'build-out/.env', 'secrets.json']);
    expect(await scanEnvFiles(repo)).toEqual(want);
    // Not a checkout at all: the walk alone, as before.
    const plain = path.join(base, 'plain');
    mkdirSync(path.join(plain, 'a'), { recursive: true });
    writeFileSync(path.join(plain, 'a', '.env.local'), 'Z=1\n');
    expect(await scanEnvFiles(plain)).toEqual(findEnvFiles(plain));
    expect(await scanEnvFiles(path.join(base, 'missing'))).toEqual([]);
  });

  it('never scans one folder twice at once: a call meanwhile gets one more scan after it, shared by every such call', async () => {
    const first = scanEnvFiles(repo);
    // Made after the first scan started: it may or may not see it, the one after it must.
    writeFileSync(path.join(repo, 'apps', 'web', '.env.test'), 'T=1\n');
    const second = scanEnvFiles(repo);
    const third = scanEnvFiles(repo);
    expect(second).not.toBe(first);
    expect(third).toBe(second);
    await first;
    expect(await second).toContain('apps/web/.env.test');
    expect(await second).toEqual(findEnvFiles(repo));
    // Settled: the next call starts a fresh scan.
    const later = scanEnvFiles(repo);
    expect(later).not.toBe(second);
    expect(await later).toEqual(findEnvFiles(repo));
  });

  it('a snapshot, changes and following the main folder come out the same as the blocking ones', async () => {
    const wt = path.join(base, 'wt');
    cpSync(repo, wt, { recursive: true });
    const snapshot = await envSnapshot(wt);
    expect(Object.keys(snapshot)).toEqual(findEnvFiles(wt));
    writeFileSync(path.join(wt, '.env'), 'API=2\nKEEP=yes\nNEW=x\n');
    writeFileSync(path.join(wt, '.aws', 'config'), '[changed]\n');
    rmSync(path.join(wt, '.envrc'));
    expect(await envChangesAsync(wt, repo, snapshot)).toEqual(envChanges(wt, repo, snapshot));
    expect((await envChangesAsync(wt, repo, snapshot)).map((c) => c.file)).toEqual(['.aws/config', '.env']);
    // Given the list it would make itself: the same again.
    expect(await envChangesAsync(wt, repo, snapshot, {}, findEnvFiles(wt))).toEqual(envChanges(wt, repo, snapshot));

    // The main folder changes an untouched file and gains one: both sides, from two identical copies.
    writeFileSync(path.join(repo, 'apps', 'web', 'config', 'local', '.env'), 'DEEP=2\n');
    writeFileSync(path.join(repo, '.env.local'), 'L=1\n');
    const other = path.join(base, 'wt2');
    cpSync(wt, other, { recursive: true });
    const mainFiles = findEnvFiles(repo);
    const sync = followMainEnv(other, repo, snapshot, mainFiles);
    const async = await followMainEnvAsync(wt, repo, snapshot, mainFiles);
    expect(async).toEqual(sync);
    expect(async.updated).toEqual(['.env.local', 'apps/web/config/local/.env']);
    expect(readFileSync(path.join(wt, '.env.local'), 'utf8')).toBe('L=1\n');
    expect(findEnvFiles(wt)).toEqual(findEnvFiles(other));
  });
});

describe('the env check (BLG-369), run one at a time without blocking (BLG-406)', () => {
  const setup = async (newKeysBack = false) => {
    const store = new Store(initialState('room'));
    const wsStore = new WorkspaceStore(path.join(base, 'home'));
    wsStore.saveConfig({ roots: [], projects: [repo], hidden: [] });
    const manager = new WorkspaceManager(wsStore);
    const toasts: string[] = [];
    const ctl = new WorkspaceController({
      manager,
      store,
      shares: new ShareService([]),
      selfId: () => 'me',
      toast: (text) => void toasts.push(text),
      intend: () => undefined,
      askClaude: () => undefined,
      claudeHome: path.join(base, 'claude'),
      env: { newKeysBack: () => newKeysBack, merge: () => 0 },
    });
    await ctl.refresh();
    const project = manager.list.find((p) => p.root)!;
    const a = await manager.createWorktree(project.id, 'env-a');
    const b = await manager.createWorktree(project.id, 'env-b');
    await ctl.refresh();
    return { store, ctl, manager, project, a, b, toasts };
  };

  it('asks about a worktree’s changes and brings the main folder’s into untouched copies', async () => {
    const { store, ctl, project, a, b, toasts } = await setup();
    await ctl.checkEnv(project.id);
    expect(store.getState().envAsks).toEqual({});
    writeFileSync(path.join(a.path, '.env'), 'API=2\nKEEP=yes\n');
    writeFileSync(path.join(repo, 'apps', 'web', 'config', 'local', '.env'), 'DEEP=2\n');
    // Asked several times at once: one check after another, and the ones waiting their turn share one.
    const first = ctl.checkEnv();
    const second = ctl.checkEnv();
    const third = ctl.checkEnv(project.id);
    expect(third).toBe(second);
    await Promise.all([first, second, third]);
    expect(store.getState().envAsks).toEqual({ [a.id]: [{ file: '.env', added: [], changed: ['API'], removed: [], binary: false }] });
    expect(readFileSync(path.join(b.path, 'apps', 'web', 'config', 'local', '.env'), 'utf8')).toBe('DEEP=2\n');
    expect(readFileSync(path.join(a.path, 'apps', 'web', 'config', 'local', '.env'), 'utf8')).toBe('DEEP=2\n');
    expect(toasts.some((t) => /The main folder’s env changed: updated 2 worktrees too/.test(t))).toBe(true);
    // A deep file made in a worktree is asked about on the next check.
    writeFileSync(path.join(b.path, 'apps', 'web', '.env.test'), 'T=1\n');
    await ctl.checkEnv(project.id);
    expect(Object.keys(store.getState().envAsks).sort()).toEqual([a.id, b.id].sort());
    expect(store.getState().envAsks[b.id]?.map((c) => c.file)).toEqual(['apps/web/.env.test']);
    ctl.stop();
  });

  it('brings a worktree’s brand-new keys into the main folder on its own, and still asks about the rest', async () => {
    const { store, ctl, project, a, toasts } = await setup(true);
    writeFileSync(path.join(a.path, '.env'), 'API=staging\nKEEP=yes\nSTRIPE=sk\n');
    await ctl.checkEnv(project.id);
    expect(readFileSync(path.join(repo, '.env'), 'utf8')).toBe('API=1\nKEEP=yes\nSTRIPE=sk\n');
    expect(toasts.some((t) => t.startsWith('env-a added STRIPE'))).toBe(true);
    expect(store.getState().envAsks).toEqual({ [a.id]: [{ file: '.env', added: [], changed: ['API'], removed: [], binary: false }] });
    ctl.stop();
  });
});
