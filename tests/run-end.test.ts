import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceController } from '../src/core/workspace-controller.js';
import type { BodyOf } from '../src/protocol.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { waitFor } from './helpers.js';

/**
 * What a run ending does to its worktree (agent-host.ts, runAgent's finally): its git status is read
 * again (that folder only) and shown, and test runs or servers its Claude's Bash left are stopped,
 * with ps only when a command may have left any.
 */

const ME = 'me';
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

/** A pretend Claude: each prompt is a Bash command it "runs" (a step), and `touch <file>` also writes the file. */
const backend: AgentBackend = {
  async run(input: AgentRunInput) {
    for (const command of input.prompt.split(' ; ')) {
      input.onStep?.({ id: command, kind: 'tool', tool: 'Bash', title: command, status: 'done', startedAt: Date.now(), input: { command, ...(command.startsWith('bg ') ? { run_in_background: true } : {}) } });
      const touch = /^touch (\S+)$/.exec(command);
      if (touch && input.place) writeFileSync(path.join(input.place.cwd, touch[1]!), 'x\n');
    }
    return 'done';
  },
};

let base: string;
let tree: string;
let ctl: WorkspaceController;
let store: Store;
let wsId: string;

beforeAll(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-run-end-')));
  // Never the real machine-wide e2e lock.
  process.env.KLAUD_E2E_DIR = path.join(base, 'e2e');
  const repo = path.join(base, 'code', 'app');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  writeFileSync(path.join(repo, '.gitignore'), '.klaud/\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-m', 'init');
  tree = path.join(base, 'trees', 'feature');
  sh(repo, 'worktree', 'add', '-b', 'feature', tree);
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  store = new Store(initialState('room', 'auto'));
  ctl = new WorkspaceController({
    manager: new WorkspaceManager(wsStore),
    store,
    shares: new ShareService([]),
    selfId: () => ME,
    toast: () => undefined,
    intend: () => undefined,
    askClaude: () => undefined,
    claudeHome: path.join(base, 'claude'),
  });
  await ctl.refresh();
  wsId = store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.path === tree)!.id;
}, 30_000);

afterAll(() => {
  ctl.stop();
  delete process.env.KLAUD_E2E_DIR;
});

function host() {
  const stopTests = vi.fn(async (_dir: string, _opts?: { keep?: boolean }) => 0);
  const send = (body: { kind: string } & Record<string, unknown>): boolean => {
    if (body.kind !== 'agent_event') return true;
    const e = body as unknown as BodyOf<'agent_event'>;
    store.dispatch({ type: 'agent_event', owner: ME, requestId: e.requestId, requester: e.requester, event: e.event, text: e.text, ts: Date.now(), channel: e.channel });
    return true;
  };
  const h = new AgentHost({
    store,
    selfId: () => ME,
    send: send as never,
    agent: () => backend,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
    workspaces: ctl,
    stopTests,
  });
  let n = 0;
  const run = async (prompt: string): Promise<void> => {
    const requestId = `r${++n}-${Math.random().toString(36).slice(2)}`;
    await h.onAgentRequest(ME, { kind: 'agent_request', requestId, prompt, viaAgent: false, channel: `ws:${wsId}`, urgent: false, plan: false });
    await waitFor(() => store.getState().log.some((l) => l.type === 'agent' && l.requestId === requestId && l.status === 'done'), 10_000);
  };
  return { run, stopTests };
}

const shown = () => store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId);

describe('a run ending in a worktree', () => {
  it("shows that worktree's new git status", async () => {
    const t = host();
    const before = shown()?.status?.changed ?? 0;
    await t.run('touch new-1.txt');
    await waitFor(() => (shown()?.status?.changed ?? 0) === before + 1, 10_000);
    // Two endings close together: both land, the later reading last.
    await Promise.all([t.run('touch new-2.txt'), ctl.refreshWorkspace(tree)]);
    await t.run('touch new-3.txt');
    await waitFor(() => (shown()?.status?.changed ?? 0) === before + 3, 10_000);
  }, 30_000);

  it('runs ps only when a Bash command may have left something running, dev servers included', async () => {
    const t = host();
    await t.run('git status ; npx tsc --noEmit');
    await new Promise((r) => setTimeout(r, 50));
    expect(t.stopTests).not.toHaveBeenCalled();
    for (const command of ['npm run dev', 'node server.js', 'bg ./serve-it', 'sleep 600 &', 'npm test']) {
      t.stopTests.mockClear();
      await t.run(`ls ; ${command}`);
      await waitFor(() => t.stopTests.mock.calls.length > 0, 5_000);
      expect(t.stopTests.mock.calls.map((c) => c[0])).toEqual([tree]);
    }
    // Stopped once: the next quiet turn doesn't look again.
    t.stopTests.mockClear();
    await t.run('git diff');
    await new Promise((r) => setTimeout(r, 50));
    expect(t.stopTests).not.toHaveBeenCalled();
  }, 30_000);

  it('keeps what you asked to keep running, and says so in the conversation', async () => {
    const t = host();
    const notes = () => store.getState().log.flatMap((l) => (l.type === 'system' && l.channel === `ws:${wsId}` && l.text.startsWith('Left running on purpose') ? [l] : []));
    const before = notes().length;
    // Marked by Claude: stopTests runs (it spares the marked processes), and the turn says what was kept.
    await t.run('KLAUD_KEEP=1 npm run dev &');
    await waitFor(() => t.stopTests.mock.calls.length > 0, 5_000);
    expect(t.stopTests.mock.calls[0]).toEqual([tree, undefined]);
    expect(notes().at(-1)?.text).toContain('KLAUD_KEEP=1 npm run dev &');
    // You asked: everything it started is kept (from then on), not stopped.
    t.stopTests.mockClear();
    await t.run('npm run dev & ; keep it running please');
    await waitFor(() => t.stopTests.mock.calls.length > 0, 5_000);
    expect(t.stopTests.mock.calls[0]).toEqual([tree, { keep: true }]);
    expect(notes().length).toBe(before + 2);
  }, 30_000);
});
