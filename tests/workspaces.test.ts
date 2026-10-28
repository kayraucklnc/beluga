import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findProjects } from '../src/workspaces/discovery.js';
import { parseWorktreeList } from '../src/workspaces/git.js';
import { WorkspaceManager, slug } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function makeRepo(parent: string, name: string): string {
  const origin = path.join(parent, `${name}.git`);
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  const dir = path.join(parent, 'code', name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 'T');
  writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-m', 'init');
  sh(dir, 'remote', 'add', 'origin', origin);
  sh(dir, 'push', '-u', 'origin', 'main');
  sh(dir, 'remote', 'set-head', 'origin', 'main');
  return dir;
}

let base: string;
let repo: string;
let mgr: WorkspaceManager;
const repos = () => mgr.list.filter((p) => p.root);

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-ws-')));
  repo = makeRepo(base, 'app');
  const store = new WorkspaceStore(path.join(base, 'home'));
  store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  mgr = new WorkspaceManager(store);
  await mgr.refresh();
});

const commitIn = (dir: string, file: string, content: string, msg: string) => {
  writeFileSync(path.join(dir, file), content);
  sh(dir, 'add', '.');
  sh(dir, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', msg);
};

describe('projects', () => {
  it('discovers git projects in parent folders and adds individual ones', async () => {
    expect(repos().map((p) => p.name)).toEqual(['app']);
    const project = repos()[0]!;
    expect(project.base).toBe('origin/main');
    expect(project.workspaces.map((w) => [w.kind, w.name, w.branch])).toEqual([['main', 'main', 'main']]);
    const other = makeRepo(path.join(base, 'elsewhere'), 'lib');
    mgr.addProject(other);
    await mgr.refresh();
    expect(repos().map((p) => p.name)).toEqual(['app', 'lib']);
    expect(() => mgr.addProject(base)).toThrow(/not a git project/);
    mgr.hideProject(repos()[1]!.id);
    await mgr.refresh();
    expect(repos().map((p) => p.name)).toEqual(['app']);
    expect(findProjects([path.join(base, 'nope')])).toEqual([]);
    expect(mgr.addFolder(path.join(base, 'code'))).toBe(1);
    expect(() => mgr.addFolder(path.join(base, 'missing'))).toThrow(/doesn't exist/);
  });

  it('shows worktrees made by other tools', async () => {
    sh(repo, 'worktree', 'add', '-b', 'other-tool', path.join(base, 'ext'));
    await mgr.refresh();
    const ext = repos()[0]!.workspaces.find((w) => w.branch === 'other-tool')!;
    expect(ext).toMatchObject({ kind: 'worktree', external: true, name: 'ext' });
  });
});

describe('worktree lifecycle', () => {
  it('creates a worktree from origin, tracks status, reviews and merges it', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'Fix Auth!');
    expect(ws).toMatchObject({ name: 'fix-auth', branch: 'beluga/fix-auth', base: 'origin/main', kind: 'worktree', external: false });
    expect(existsSync(path.join(ws.path, 'README.md'))).toBe(true);
    expect(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.beluga/');

    writeFileSync(path.join(ws.path, 'new.txt'), 'x');
    await mgr.refresh();
    expect(mgr.find(ws.id)?.status).toMatchObject({ changed: 1, ahead: 0 });
    await expect(mgr.merge(ws.id)).rejects.toThrow(/uncommitted/);
    expect(await mgr.commitAll(ws.id, 'add new')).toBe(true);
    expect(await mgr.commitAll(ws.id, 'nothing')).toBe(false);
    commitIn(ws.path, 'README.md', '# hi\nmore\n', 'edit readme');
    await mgr.refresh();
    expect(mgr.find(ws.id)?.status).toMatchObject({ changed: 0, ahead: 2 });

    const review = await mgr.review(ws.id);
    expect(review.commits.map((c) => c.subject)).toEqual(['edit readme', 'add new']);
    expect(review.files.map((f) => [f.path, f.state, f.added])).toEqual([
      ['README.md', 'modified', 1],
      ['new.txt', 'added', 1],
    ]);
    expect(await mgr.fileDiff(ws.id, 'README.md')).toContain('+more');

    expect(await mgr.merge(ws.id)).toEqual({ ok: true });
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toContain('more');
  });

  it('refuses to merge into a dirty main folder and aborts conflicts cleanly', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'conflict');
    commitIn(ws.path, 'README.md', 'theirs\n', 'theirs');
    writeFileSync(path.join(repo, 'README.md'), 'dirty\n');
    await mgr.refresh();
    expect(await mgr.merge(ws.id)).toEqual({ ok: false, reason: 'dirty', files: ['README.md'] });
    commitIn(repo, 'README.md', 'ours\n', 'ours');
    expect(await mgr.merge(ws.id)).toEqual({ ok: false, reason: 'conflict', files: ['README.md'] });
    expect(sh(repo, 'status', '--porcelain')).toBe(''); // merge was aborted
  });

  it('forks with history, archives, restores and deletes', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'idea');
    mgr.rememberSession(ws.id, 'session-1');
    mgr.saveHistory(ws.id, [{ text: 'hello' }]);
    commitIn(ws.path, 'idea.txt', 'v1', 'idea v1');
    await mgr.refresh();

    const fork = await mgr.fork(ws.id, 'idea 2');
    expect(fork).toMatchObject({ name: 'idea-2', forkedFrom: ws.id, forkFromSession: 'session-1', branch: 'beluga/idea-2' });
    expect(existsSync(path.join(fork.path, 'idea.txt'))).toBe(true); // starts from the parent's state
    expect(mgr.loadHistory(fork.id)).toEqual([{ text: 'hello' }]);
    mgr.rememberSession(fork.id, 'session-2');
    expect(mgr.find(fork.id)).toMatchObject({ sessionId: 'session-2', forkFromSession: undefined });

    // Uncommitted work is kept by the archive (it used to be lost to "archive anyway").
    writeFileSync(path.join(ws.path, 'wip.txt'), 'x');
    await mgr.refresh();
    const kept = await mgr.archive(ws.id);
    expect(mgr.find(ws.id)).toMatchObject({ archived: true, archive: { keptBytes: kept!.keptBytes } });
    expect(existsSync(ws.path)).toBe(false);
    expect(await mgr.restore(ws.id)).toMatchObject({ snapshot: kept!.snapshot });
    expect(existsSync(path.join(ws.path, 'idea.txt'))).toBe(true);
    expect(readFileSync(path.join(ws.path, 'wip.txt'), 'utf8')).toBe('x');
    expect(mgr.find(ws.id)?.archive).toBeUndefined();

    await mgr.remove(fork.id);
    expect(mgr.find(fork.id)).toBeUndefined();
    expect(sh(repo, 'branch', '--list', 'beluga/idea-2')).toBe('');
    await expect(mgr.archive(repos()[0]!.workspaces[0]!.id)).rejects.toThrow(/main folder/);
    const again = await mgr.createWorktree(repos()[0]!.id, 'idea'); // name taken by a live worktree → idea-2
    expect(again.name).toBe('idea');
    expect(path.basename(again.path)).toBe('idea-2');
    expect(again.id).not.toBe(ws.id);
  });

  it('deleting an archived worktree for good deletes its archive too', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'gone');
    writeFileSync(path.join(ws.path, 'wip.txt'), 'x');
    await mgr.archive(ws.id);
    expect(existsSync(path.join(base, 'home', 'archives', ws.id))).toBe(true);
    await mgr.remove(ws.id);
    expect(existsSync(path.join(base, 'home', 'archives', ws.id))).toBe(false);
    expect(sh(repo, 'for-each-ref', 'refs/beluga/')).toBe('');
  });

  it('creates chats in the main folder without a worktree', async () => {
    const chat = await mgr.createChat(repos()[0]!.id, 'Quick question');
    expect(chat).toMatchObject({ kind: 'chat', name: 'Quick question', path: repo });
    mgr.rename(chat.id, 'Renamed');
    await mgr.refresh();
    expect(mgr.find(chat.id)?.name).toBe('Renamed');
    await mgr.archive(chat.id);
    expect(mgr.find(chat.id)?.archived).toBe(true);
    await mgr.remove(chat.id);
    expect(mgr.find(chat.id)).toBeUndefined();
  });

  it('creates stand-alone Claude chats with their own folder', async () => {
    expect(mgr.list[0]).toMatchObject({ id: 'chats', name: 'Chats', workspaces: [] });
    const chat = await mgr.createChat('chats', 'Ideas');
    expect(chat).toMatchObject({ kind: 'chat', name: 'Ideas', projectId: 'chats', projectRoot: '' });
    expect(existsSync(chat.path)).toBe(true);
    expect(mgr.list[0]!.workspaces.map((w) => w.name)).toEqual(['Ideas']);
    await mgr.remove(chat.id);
    expect(existsSync(chat.path)).toBe(false);
  });

  it('gives a stand-alone chat its own folder when the client has no launch folder', async () => {
    // The Mac app connects without one, so it asks for the chat in ''.
    const chat = await mgr.createChat('chats', 'Hello', '');
    expect(chat.path).not.toBe('');
    expect(existsSync(chat.path)).toBe(true);
  });

  it('persists across restarts', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'keep');
    mgr.rememberSession(ws.id, 's-9');
    const again = new WorkspaceManager(new WorkspaceStore(path.join(base, 'home')));
    await again.refresh();
    expect(again.find(ws.id)).toMatchObject({ name: 'keep', sessionId: 's-9', external: false });
  });
});

describe('env files and safe merges', () => {
  it('copies env files into new worktrees and offers to bring key changes back', async () => {
    writeFileSync(path.join(repo, '.env'), 'API=1\nKEEP=yes\n');
    mkdirSync(path.join(repo, '.aws'));
    writeFileSync(path.join(repo, '.aws', 'config'), '[default]\n');
    writeFileSync(path.join(repo, '.env.example'), 'API=\n');
    const ws = await mgr.createWorktree(repos()[0]!.id, 'envs');
    expect(readFileSync(path.join(ws.path, '.env'), 'utf8')).toBe('API=1\nKEEP=yes\n');
    expect(existsSync(path.join(ws.path, '.aws', 'config'))).toBe(true);
    expect(Object.keys(ws.envSnapshot ?? {})).toEqual(['.aws/config', '.env']);
    expect(mgr.envChanges(ws.id)).toEqual([]); // untouched

    writeFileSync(path.join(ws.path, '.env'), 'API=2\nKEEP=yes\nNEW=x\n');
    expect(mgr.envChanges(ws.id)).toEqual([{ file: '.env', added: ['NEW'], changed: ['API'], removed: [], binary: false }]);
    expect(mgr.applyEnvBack(ws.id)).toBe(1);
    expect(readFileSync(path.join(repo, '.env'), 'utf8')).toBe('API=2\nKEEP=yes\nNEW=x\n');
    writeFileSync(path.join(ws.path, '.aws', 'config'), '[changed]\n');
    expect(mgr.envChanges(ws.id).map((c) => [c.file, c.binary])).toEqual([['.aws/config', true]]);
  });

  it('copies deep, direnv, Wrangler and .worktreeinclude files too, never tracked ones or examples', async () => {
    const deep = path.join(repo, 'apps', 'web', 'config', 'local');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, '.env'), 'DEEP=1\n');
    writeFileSync(path.join(repo, '.envrc'), 'export A=1\n');
    writeFileSync(path.join(repo, '.dev.vars'), 'B=2\n');
    writeFileSync(path.join(repo, 'secrets.json'), '{}\n');
    writeFileSync(path.join(repo, 'notes.txt'), 'not mine to copy\n');
    writeFileSync(path.join(repo, '.worktreeinclude'), 'secrets.json\n');
    mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(repo, 'node_modules', 'pkg', '.env'), 'X=1\n');
    const ws = await mgr.createWorktree(repos()[0]!.id, 'deep');
    expect(readFileSync(path.join(ws.path, 'apps', 'web', 'config', 'local', '.env'), 'utf8')).toBe('DEEP=1\n');
    expect(existsSync(path.join(ws.path, '.envrc'))).toBe(true);
    expect(existsSync(path.join(ws.path, '.dev.vars'))).toBe(true);
    expect(existsSync(path.join(ws.path, 'secrets.json'))).toBe(true);
    expect(existsSync(path.join(ws.path, 'notes.txt'))).toBe(false);
    expect(existsSync(path.join(ws.path, 'node_modules', 'pkg', '.env'))).toBe(false);
  });

  it('only merges into the main folder when it is on the base branch', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'side');
    commitIn(ws.path, 'x.txt', 'x', 'x');
    sh(repo, 'checkout', '-b', 'other');
    await mgr.refresh();
    expect(await mgr.merge(ws.id)).toEqual({ ok: false, reason: 'wrong_branch', files: [], current: 'other', expected: 'main' });
    sh(repo, 'checkout', 'main');
    expect(await mgr.merge(ws.id)).toEqual({ ok: true });
  });

  it('never force-removes worktrees made by other tools', async () => {
    sh(repo, 'worktree', 'add', '-b', 'tool', path.join(base, 'tool'));
    writeFileSync(path.join(base, 'tool', 'wip.txt'), 'unsaved');
    await mgr.refresh();
    const ext = repos()[0]!.workspaces.find((w) => w.external)!;
    await expect(mgr.remove(ext.id)).rejects.toThrow();
    expect(existsSync(path.join(base, 'tool', 'wip.txt'))).toBe(true);
  });

  it('deletes a worktree whose folder was removed by hand, branch and all', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'gone');
    rmSync(ws.path, { recursive: true, force: true });
    await mgr.remove(ws.id);
    await mgr.refresh();
    expect(repos()[0]!.workspaces.some((w) => w.name === 'gone')).toBe(false);
    expect(sh(repo, 'branch', '--list', 'beluga/gone').trim()).toBe('');
  });

  it('deletes a worktree git already let go of, whatever was left in its folder', async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'husk');
    // A delete that stopped halfway: git's link is gone, files are still there.
    rmSync(path.join(repo, '.git', 'worktrees', path.basename(ws.path)), { recursive: true, force: true });
    await mgr.remove(ws.id);
    await mgr.refresh();
    expect(existsSync(ws.path)).toBe(false);
    expect(repos()[0]!.workspaces.some((w) => w.name === 'husk')).toBe(false);
    expect(sh(repo, 'branch', '--list', 'beluga/husk').trim()).toBe('');
  });

  it("reports why a merge failed when it isn't a conflict", async () => {
    const ws = await mgr.createWorktree(repos()[0]!.id, 'nobranch');
    commitIn(ws.path, 'x.txt', 'x', 'x');
    await mgr.refresh();
    const { mergeInto } = await import('../src/workspaces/git.js');
    await expect(mergeInto(repo, 'no-such-branch', 'main')).rejects.toThrow(/no-such-branch/);
  });
});

describe('choosing the base branch', () => {
  const pushFeature = (): string => {
    sh(repo, 'checkout', '-b', 'feature');
    commitIn(repo, 'feature.txt', 'f', 'feature work');
    sh(repo, 'push', '-u', 'origin', 'feature');
    sh(repo, 'checkout', 'main');
    return sh(repo, 'rev-parse', 'origin/feature').trim();
  };

  it('creates a worktree on the chosen branch and compares against it', async () => {
    const tip = pushFeature();
    const ws = await mgr.createWorktree(repos()[0]!.id, 'on feature', 'origin/feature');
    expect(ws).toMatchObject({ branch: 'beluga/on-feature', base: 'origin/feature' });
    expect(sh(ws.path, 'rev-parse', 'HEAD').trim()).toBe(tip);
    expect(existsSync(path.join(ws.path, 'feature.txt'))).toBe(true);
    commitIn(ws.path, 'more.txt', 'm', 'more');
    await mgr.refresh();
    // Ahead of what it branched from, not of main (which is behind feature).
    expect(mgr.find(ws.id)?.status).toMatchObject({ ahead: 1, behind: 0 });
    // Restarting keeps the base it was made from.
    const again = new WorkspaceManager(new WorkspaceStore(path.join(base, 'home')));
    await again.refresh();
    expect(again.find(ws.id)?.base).toBe('origin/feature');
  });

  it('refuses a branch that does not exist or looks like an option', async () => {
    const id = repos()[0]!.id;
    await expect(mgr.createWorktree(id, 'x', 'no-such-branch')).rejects.toThrow("There's no branch called no-such-branch");
    await expect(mgr.createWorktree(id, 'y', '--upload-pack=touch /tmp/pwned')).rejects.toThrow(/There's no branch called --upload-pack/);
    expect(repos()[0]!.workspaces.filter((w) => w.kind === 'worktree')).toHaveLength(0);
  });

  it('lists the branches, the default base first', async () => {
    pushFeature();
    const { base: def, branches } = await mgr.branches(repos()[0]!.id);
    expect(def).toBe('origin/main');
    expect(branches[0]).toBe('origin/main');
    expect(branches).toEqual(expect.arrayContaining(['main', 'feature', 'origin/feature']));
    expect(branches).not.toContain('origin/HEAD');
    expect(new Set(branches).size).toBe(branches.length);
    await expect(mgr.branches('nope')).rejects.toThrow('Project not found');
  });
});

describe('helpers', () => {
  it('slugs names and parses worktree lists', () => {
    expect(slug('  Fix: Auth / Login!! ')).toBe('fix-auth-login');
    expect(slug('!!!')).toBe('workspace');
    expect(parseWorktreeList('worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n')).toEqual([
      { path: '/a', head: '1', branch: 'main', detached: false, bare: false },
      { path: '/b', head: '2', branch: undefined, detached: true, bare: false },
    ]);
  });
});

describe('case-insensitive disks', () => {
  it('scans a folder once even when listed with different letter case', () => {
    const roots = [path.join(base, 'code'), path.join(base, 'CODE'), path.join(base, 'code')];
    expect(findProjects(roots)).toEqual([repo]);
  });
});
