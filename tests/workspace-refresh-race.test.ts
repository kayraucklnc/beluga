import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Status } from '../src/workspaces/git.js';

/** git status, held when a test asks: each call waits until the test hands it a reading. */
const held = vi.hoisted(() => ({ on: false, calls: [] as Array<{ dir: string; give: (s: Status) => void }> }));
vi.mock('../src/workspaces/git.js', async (original) => {
  const real = await original<typeof import('../src/workspaces/git.js')>();
  return { ...real, status: (dir: string, base?: string) => (held.on ? new Promise<Status>((give) => held.calls.push({ dir, give })) : real.status(dir, base)) };
});

const { WorkspaceManager } = await import('../src/workspaces/manager.js');
const { WorkspaceStore } = await import('../src/workspaces/store.js');

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('two run endings on one worktree at once', () => {
  it('both land, in order: the later reading is the one shown', async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-race-')));
    const repo = path.join(base, 'code', 'app');
    mkdirSync(repo, { recursive: true });
    sh(repo, 'init', '-b', 'main');
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-m', 'init');
    const tree = path.join(base, 'trees', 't');
    sh(repo, 'worktree', 'add', '-b', 'feature', tree);
    const store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
    const mgr = new WorkspaceManager(store);
    await mgr.refresh();
    const shown = () => mgr.list.flatMap((p) => p.workspaces).find((w) => w.path === tree)?.status;

    held.on = true;
    const first = mgr.refreshWorkspace(tree);
    const second = mgr.refreshWorkspace(tree);
    await tick();
    // One git status at a time for the folder: the second waits for the first.
    expect(held.calls).toHaveLength(1);
    held.calls[0]!.give({ branch: 'feature', changed: 1, ahead: 0, behind: 0 });
    expect(await first).toBe(true);
    expect(shown()?.changed).toBe(1);
    await tick();
    expect(held.calls).toHaveLength(2);
    held.calls[1]!.give({ branch: 'feature', changed: 2, ahead: 0, behind: 0 });
    expect(await second).toBe(true);
    expect(shown()?.changed).toBe(2);

    // A full refresh landing while one folder's status is read: that one reads the workspace again, never reports a lost change.
    held.calls.length = 0;
    const third = mgr.refreshWorkspace(tree);
    await tick();
    held.on = false;
    await mgr.refresh();
    held.calls[0]!.give({ branch: 'feature', changed: 7, ahead: 0, behind: 0 });
    expect(await third).toBe(true);
    expect(shown()?.changed).toBe(7);
  }, 30_000);
});
