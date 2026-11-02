import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

/** Runs once while a refresh reads git status (after it read the workspace records). */
let duringStatus: (() => void) | undefined;
vi.mock('../src/workspaces/git.js', async (importOriginal) => {
  const git = await importOriginal<typeof import('../src/workspaces/git.js')>();
  return {
    ...git,
    status: (...args: Parameters<typeof git.status>) => {
      const hook = duringStatus;
      duringStatus = undefined;
      hook?.();
      return git.status(...args);
    },
  };
});

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

function repo(parent: string): string {
  const origin = path.join(parent, 'app.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  const dir = path.join(parent, 'code', 'app');
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-m', 'init');
  sh(dir, 'remote', 'add', 'origin', origin);
  sh(dir, 'push', '-u', 'origin', 'main');
  sh(dir, 'remote', 'set-head', 'origin', 'main');
  return dir;
}

describe('a refresh reading git while a workspace changes (BLG-499)', () => {
  it('never puts back the agent, or the name, a workspace had when it began', async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-ws-race-')));
    repo(base);
    const store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
    const mgr = new WorkspaceManager(store);
    await mgr.refresh();
    const project = mgr.list.find((p) => p.root)!;
    const ws = await mgr.createWorktree(project.id, 'on-codex');
    const chat = await mgr.createChat(project.id, 'Quick question');
    mgr.setAgent(ws.id, { runtime: 'codex', label: 'Codex' });
    mgr.setAgent(chat.id, { runtime: 'codex', label: 'Codex' });
    // Handed back to your default (and the chat renamed) while a refresh is reading git status.
    duringStatus = () => {
      mgr.setAgent(ws.id, undefined);
      mgr.setAgent(chat.id, undefined);
      mgr.rename(chat.id, 'Renamed meanwhile');
    };
    await mgr.refresh();
    expect(duringStatus).toBeUndefined();
    expect(mgr.find(ws.id)?.agent).toBeUndefined();
    expect(mgr.find(ws.id)).toMatchObject({ branch: 'beluga/on-codex', base: 'origin/main', kind: 'worktree', status: expect.objectContaining({ changed: 0 }) });
    expect(mgr.find(chat.id)?.agent).toBeUndefined();
    expect(mgr.find(chat.id)?.name).toBe('Renamed meanwhile');
  });
});
