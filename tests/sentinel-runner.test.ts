import { describe, expect, it } from 'vitest';
import { runSentinelShell } from '../src/core/sentinel/runner.js';
import { brief, setup, until } from './sentinel-fakes.js';

/** A run's steps (docs/sentinel.md §4, "Runner"), with fakes for Claude, its places, the shell and notifications. */

const ended = (s: ReturnType<typeof setup>, runId: string) => () => !['queued', 'running'].includes(s.sentinels.runGet(runId).run.state);

describe('Ask Claude, then Notify me', () => {
  it('asks in a quiet project chat, keeps its conversation, makes its last message the report', async () => {
    const s = setup();
    const made = s.sentinels.create(brief);
    expect(made.paused).toBe(true);
    const run = s.sentinels.start(made.id, 'you');
    await until(() => s.asked.length === 1);
    const asked = s.asked[0]!;
    expect(asked.prompt).toMatch(/^Brief for bob-api on \w{3} \d+ \w{3} \d{4}$/);
    expect(s.made).toEqual([{ kind: 'chat', projectId: 'api', name: expect.stringContaining('Morning brief') }]);
    // While it runs, the conversation's Claude is told it's a sentinel run (your own runs only).
    const told = s.sentinels.forRun(asked.channel, 'p-me')!;
    expect(told.inRun).toBe(true);
    expect(told.brief).toContain('This is a run of the sentinel “Morning brief”');
    expect(told.brief).toContain('<sentinel_trigger>\nYou pressed Run');
    expect(told.brief).toContain('label sentinel:morning-brief');
    expect(told.tools.stop).toBeDefined();
    expect(s.sentinels.forRun(asked.channel, 'p-friend')).toBeUndefined();
    expect(s.store.getState().sentinel.live[run.id]).toEqual({ stepId: made.steps[0]!.id, state: 'running' });
    asked.answer('## 3 commits landed, CI is green\n\n- details');
    await until(ended(s, run.id));
    const detail = s.sentinels.runGet(run.id);
    expect(detail.run).toMatchObject({ state: 'done', headline: '3 commits landed, CI is green', channel: asked.channel });
    expect(detail.run.steps.map((st) => st.state)).toEqual(['done', 'done']);
    expect(detail.run.steps[0]).toMatchObject({ channel: asked.channel, output: '## 3 commits landed, CI is green\n\n- details' });
    expect(detail.report).toBe('## 3 commits landed, CI is green\n\n- details');
    // The Notify step: once, keyed by the run.
    expect(s.notices).toEqual([{ kind: 'done', tag: 'sentinel', title: 'Morning brief', body: '3 commits landed, CI is green', key: run.id, channel: asked.channel }]);
    expect(s.store.getState().sentinel.live).toEqual({});
    // Other runs of yours: a short note, the tools, no stop.
    const other = s.sentinels.forRun('ws:else', 'p-me')!;
    expect(other).toMatchObject({ inRun: false });
    expect(other.brief).toContain('sentinel_create');
    expect(other.tools.stop).toBeUndefined();
  });

  it('nothing to do: sentinel_stop ends the run as skipped with the reason', async () => {
    const s = setup();
    const made = s.sentinels.create(brief);
    const run = s.sentinels.start(made.id, 'you');
    await until(() => s.asked.length === 1);
    s.sentinels.forRun(s.asked[0]!.channel, 'p-me')!.tools.stop!('nothing changed since yesterday');
    s.asked[0]!.answer('Nothing changed.');
    await until(ended(s, run.id));
    expect(s.sentinels.runGet(run.id).run).toMatchObject({ state: 'skipped', headline: 'Nothing changed since yesterday', why: 'nothing changed since yesterday' });
    expect(s.sentinels.runGet(run.id).run.steps.map((st) => st.state)).toEqual(['done', 'skipped']);
    expect(s.notices).toEqual([]);
  });

  it('Claude hitting the usage limit fails the run in those words', async () => {
    const s = setup();
    const run = s.sentinels.start(s.sentinels.create(brief).id, 'you');
    await until(() => s.asked.length === 1);
    s.asked[0]!.fail('Claude usage limit reached · resets at 5pm');
    await until(ended(s, run.id));
    expect(s.sentinels.runGet(run.id).run).toMatchObject({ state: 'failed', why: 'usage limit' });
  });

  it('a worktree step: a quiet worktree, archived at the end when it made no commit', async () => {
    const s = setup({ reply: () => 'Updated 3 dependencies' });
    const made = s.sentinels.create({ name: 'Deps', projectId: 'api', access: 'work', steps: [{ kind: 'claude', where: 'worktree', prompt: 'Update' }] });
    const run = s.sentinels.start(made.id, 'you');
    await until(ended(s, run.id));
    expect(s.made[0]).toMatchObject({ kind: 'worktree', projectId: 'api', name: expect.stringMatching(/^sentinel Deps \d{6}$/) });
    expect(s.sentinels.runGet(run.id).run).toMatchObject({ worktreeId: 'w1', state: 'done' });
    expect(s.archived).toEqual(['w1']);
  });

  it('a worktree with commits stays', async () => {
    const s = setup({ reply: () => 'Fixed', changes: true });
    const run = s.sentinels.start(s.sentinels.create({ name: 'Fix', projectId: 'api', access: 'work', steps: [{ kind: 'claude', where: 'worktree', prompt: 'Fix' }] }).id, 'you');
    await until(ended(s, run.id));
    expect(s.archived).toEqual([]);
  });

  it('Ask Claude in the project needs a project', async () => {
    const s = setup();
    const run = s.sentinels.start(s.sentinels.create({ name: 'Mac', steps: [{ kind: 'claude', where: 'project', prompt: 'hi' }] }).id, 'you');
    await until(ended(s, run.id));
    expect(s.sentinels.runGet(run.id).run).toMatchObject({ state: 'failed', why: expect.stringContaining('needs a project') });
    expect(s.asked).toEqual([]);
  });

  it('on Your Mac: a new chat of its own', async () => {
    const s = setup({ reply: () => 'Disk is 80% full' });
    const run = s.sentinels.start(s.sentinels.create({ name: 'Disk', steps: [{ kind: 'claude', where: 'mac', prompt: 'How full is the disk?' }] }).id, 'you');
    await until(ended(s, run.id));
    expect(s.asked[0]!.channel).toBe('mac:assistant:m1');
    expect(s.sentinels.runGet(run.id).run.headline).toBe('Disk is 80% full');
  });
});

describe('Run a script', () => {
  it('runs with your variables and the run’s own; its output goes to the next steps', async () => {
    const s = setup({ reply: () => 'All good' });
    const made = s.sentinels.create({
      name: 'Tests',
      projectId: 'api',
      steps: [
        { kind: 'script', name: 'Run the tests', command: 'npm test', cwd: 'project', timeoutSec: 60 },
        { kind: 'claude', name: 'Read them', where: 'project', prompt: 'They said: {{previous}} / {{steps.Run the tests}}' },
      ],
    });
    // The fake shell answers "ok".
    const run = s.sentinels.start(made.id, 'you');
    await until(ended(s, run.id));
    expect(s.ran).toHaveLength(1);
    expect(s.ran[0]).toMatchObject({ command: 'npm test', cwd: '/code/bob-api', timeoutMs: 60_000 });
    expect(s.ran[0]!.env).toMatchObject({ GREETING: 'hello', SENTINEL_PREVIOUS: '', SENTINEL_RUN_DIR: '' });
    expect(JSON.parse(s.ran[0]!.env.SENTINEL_TRIGGER!)).toEqual({ kind: 'manual', summary: 'You pressed Run' });
    // Earlier outputs are filled in as material, in tags (never instructions).
    const material = '<sentinel_step name="Run the tests">\nok\n</sentinel_step>';
    expect(s.asked[0]!.prompt).toBe(`They said: ${material} / ${material}`);
    expect(s.sentinels.forRun('x', 'p-me')).toBeDefined();
  });

  it('a non-zero exit fails the run with the output’s end; the steps after it are skipped', async () => {
    const s = setup();
    const made = s.sentinels.create({ name: 'Tests', projectId: 'api', steps: [{ kind: 'script', command: 'npm test', cwd: 'project', timeoutSec: 60 }, { kind: 'notify', phone: false }] });
    // A second sentinel with its own failing shell.
    const failing = setup({ shell: async () => ({ exitCode: 1, output: 'FAIL tests/webhooks.test.ts\nExpected 1 charge, got 2\n', truncated: false, timedOut: false, ms: 900 }) });
    const f = failing.sentinels.create({ name: 'Tests', projectId: 'api', steps: [{ kind: 'script', command: 'npm test', cwd: 'project', timeoutSec: 60 }, { kind: 'notify', phone: false }] });
    const run = failing.sentinels.start(f.id, 'you');
    await until(ended(failing, run.id));
    const r = failing.sentinels.runGet(run.id).run;
    expect(r.state).toBe('failed');
    expect(r.why).toBe('exit 1: FAIL tests/webhooks.test.ts\nExpected 1 charge, got 2');
    expect(r.headline).toBe('Run a script: exit 1: FAIL tests/webhooks.test.ts');
    expect(r.steps.map((st) => st.state)).toEqual(['failed', 'skipped']);
    expect(failing.notices).toEqual([{ kind: 'problems', tag: 'sentinel', title: 'Tests failed', body: r.headline, key: `${run.id}:failed` }]);
    // A script-only run that passes gets Beluga's own headline.
    const ok = s.sentinels.start(made.id, 'you');
    await until(ended(s, ok.id));
    expect(s.sentinels.runGet(ok.id).run.headline).toBe('Script ran · 2.1 s · exit 0');
  });

  it('runs in your home folder when asked, and on Your Mac', async () => {
    const s = setup();
    const run = s.sentinels.start(s.sentinels.create({ name: 'Home', steps: [{ kind: 'script', command: 'ls', cwd: 'project', timeoutSec: 5 }] }).id, 'you');
    await until(ended(s, run.id));
    expect(s.ran[0]!.cwd).toBe('/home/me');
  });

  it('the real shell: your variables, the exit code, and the process group killed at its limit', async () => {
    const ctl = new AbortController();
    const res = await runSentinelShell('echo "$GREETING"; exit 3', '/tmp', 5000, { GREETING: 'hi there' }, ctl.signal);
    expect(res).toMatchObject({ exitCode: 3, timedOut: false });
    expect(res.output.trim()).toBe('hi there');
    const slow = await runSentinelShell('sleep 5 & sleep 5; echo never', '/tmp', 200, {}, ctl.signal);
    expect(slow.timedOut).toBe(true);
    expect(slow.output).not.toContain('never');
    const stopped = new AbortController();
    const going = runSentinelShell('sleep 5', '/tmp', 5000, {}, stopped.signal);
    stopped.abort();
    expect((await going).exitCode).not.toBe(0);
  });
});

describe('steps from later phases', () => {
  it('show, but a run refuses them in words', async () => {
    const s = setup();
    const made = s.sentinels.create({ name: 'Ping', steps: [{ kind: 'http', method: 'GET', url: 'https://example.com', headers: {}, timeoutSec: 10 }] });
    const run = s.sentinels.start(made.id, 'you');
    await until(ended(s, run.id));
    expect(s.sentinels.runGet(run.id).run).toMatchObject({ state: 'failed', why: 'Call a service isn’t available yet: it comes with the next part of Sentinel' });
  });

  it('access is checked when a step is added', () => {
    const s = setup();
    expect(() => s.sentinels.create({ name: 'X', projectId: 'api', access: 'look', steps: [{ kind: 'claude', where: 'worktree', prompt: 'fix' }] })).toThrow('needs Work access; this sentinel has Look');
    const ok = s.sentinels.create({ name: 'X', projectId: 'api', access: 'work', steps: [{ kind: 'claude', where: 'worktree', prompt: 'fix' }] });
    expect(() => s.sentinels.update(ok.id, { access: 'look' })).toThrow('needs Work access');
  });
});
