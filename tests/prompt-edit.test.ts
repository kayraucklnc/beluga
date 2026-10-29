import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { findPrompt } from '../src/agent/session-rewind.js';
import { PromptQueue } from '../src/agent/live-run.js';
import { applySnapshot, dropSnapshots, promptRef, restoreSnapshot, snapshot, snapshotAt, snapshotBase } from '../src/workspaces/snapshots.js';

/** Editing a message you sent (BLG-385): a worktree's files as they were then, and Claude's session cut there. */

let repo: string;
const run = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@x.dev', ...args], { cwd, stdio: 'pipe' }).toString();
const write = (file: string, text: string): void => writeFileSync(path.join(repo, file), text);
const read = (file: string): string | undefined => (existsSync(path.join(repo, file)) ? readFileSync(path.join(repo, file), 'utf8') : undefined);

beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-edit-')));
  run(repo, 'init', '-q', '-b', 'main');
  write('.gitignore', 'node_modules/\n');
  write('app.ts', 'one\n');
  run(repo, 'add', '.');
  run(repo, 'commit', '-q', '-m', 'Initial commit');
});

describe('snapshots', () => {
  it('keeps the files as they are, touching nothing', async () => {
    write('app.ts', 'one\nuncommitted\n');
    write('notes.md', 'untracked\n');
    run(repo, 'add', 'app.ts');
    const before = run(repo, 'status', '--porcelain');
    const ref = promptRef('wt-1', '6f1c1a2e-0000-4000-8000-000000000001');
    const commit = await snapshot(repo, ref);
    expect(run(repo, 'status', '--porcelain')).toBe(before);
    expect(await snapshotAt(repo, ref)).toBe(commit);
    expect(await snapshotBase(repo, commit)).toBe(run(repo, 'rev-parse', 'HEAD').trim());
    expect(run(repo, 'show', `${commit}:notes.md`)).toBe('untracked\n');
  });

  it('puts the worktree back the way it was: commits, changes, new files, ignored files left alone', async () => {
    write('app.ts', 'one\nmine\n');
    write('notes.md', 'mine\n');
    const head = run(repo, 'rev-parse', 'HEAD').trim();
    const commit = await snapshot(repo, promptRef('wt-1', 'p1'));
    // Claude works: commits, edits, adds a file, deletes one, installs dependencies.
    write('app.ts', 'claude\n');
    run(repo, 'commit', '-q', '-am', 'Claude did things');
    write('extra.ts', 'new\n');
    run(repo, 'rm', '-q', '--cached', 'app.ts');
    write('notes.md', 'changed\n');
    execFileSync('mkdir', ['-p', path.join(repo, 'node_modules')]);
    write('node_modules/x.js', 'dep\n');
    await restoreSnapshot(repo, 'wt-1', commit);
    expect(run(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(read('app.ts')).toBe('one\nmine\n');
    expect(read('notes.md')).toBe('mine\n');
    expect(read('extra.ts')).toBeUndefined();
    expect(read('node_modules/x.js')).toBe('dep\n');
    // Uncommitted again, as it was: nothing staged.
    expect(run(repo, 'diff', '--cached', '--name-only').trim()).toBe('');
    expect(run(repo, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([' M app.ts', '?? notes.md']);
    // How it was just before is kept.
    expect(run(repo, 'for-each-ref', '--format=%(refname)', 'refs/beluga/before-edit/wt-1/').trim()).not.toBe('');
  });

  it('lays a snapshot over a fresh checkout of its base (a fork)', async () => {
    write('app.ts', 'one\nmine\n');
    const commit = await snapshot(repo, promptRef('wt-1', 'p1'));
    const fork = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-fork-')));
    run(repo, 'worktree', 'add', '-q', '-b', 'fork', path.join(fork, 'wt'), await snapshotBase(repo, commit));
    await applySnapshot(path.join(fork, 'wt'), commit);
    expect(readFileSync(path.join(fork, 'wt', 'app.ts'), 'utf8')).toBe('one\nmine\n');
    expect(run(path.join(fork, 'wt'), 'status', '--porcelain').trim()).toBe('M app.ts');
  });

  it('forgets a workspace’s snapshots', async () => {
    await snapshot(repo, promptRef('wt-1', 'p1'));
    await snapshot(repo, promptRef('wt-2', 'p1'));
    await dropSnapshots(repo, 'wt-1');
    expect(await snapshotAt(repo, promptRef('wt-1', 'p1'))).toBeUndefined();
    expect(await snapshotAt(repo, promptRef('wt-2', 'p1'))).toBeDefined();
  });
});

describe('the session cut', () => {
  const msg = (uuid: string, type: SessionMessage['type'], content: unknown, tool: string | null = null): SessionMessage => ({ type, uuid, session_id: 's', message: { content }, parent_tool_use_id: tool, parent_agent_id: null });
  const messages = [
    msg('a', 'user', 'Request from Kayra:\nAdd a health check'),
    msg('b', 'assistant', [{ type: 'text', text: 'Done.' }]),
    msg('c', 'user', [{ type: 'text', text: 'Request from Kayra:\nNow   add a test' }]),
    msg('d', 'assistant', [{ type: 'text', text: 'Added.' }]),
  ];

  it('finds the prompt by its id', () => {
    expect(findPrompt(messages, { id: 'c', text: 'whatever' })).toBe(2);
  });

  it('falls back to the words of your prompt (sent before ids were kept)', () => {
    expect(findPrompt(messages, { id: 'gone', text: 'Now add a test' })).toBe(2);
    expect(findPrompt(messages, { text: 'Add a health check' })).toBe(0);
    expect(findPrompt(messages, { text: 'Done.' })).toBe(-1);
  });

  it('gives a prompt the id it is asked to (the message’s request id)', async () => {
    const q = new PromptQueue();
    expect(q.push('hi', { uuid: '6f1c1a2e-0000-4000-8000-000000000002' })).toBe('6f1c1a2e-0000-4000-8000-000000000002');
    q.close();
    const sent = [];
    for await (const m of q) sent.push(m.uuid);
    expect(sent).toEqual(['6f1c1a2e-0000-4000-8000-000000000002']);
  });
});
