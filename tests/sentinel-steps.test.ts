import { describe, expect, it } from 'vitest';
import type { NoticeEvent } from '../src/core/notify.js';
import type { Sentinel } from '../src/core/sentinel/model.js';
import { type ActiveRun, type FriendAnswer, type PrLook, type SentinelChat, type SentinelFriends, type SentinelGitHub, SentinelRunner } from '../src/core/sentinel/runner.js';
import { RunFolders } from '../src/core/sentinel/files.js';
import { setup, until } from './sentinel-fakes.js';

/** Phase 2's steps (docs/sentinel.md §4, §5): Call a service, pull requests and the merge gate, messages, a friend's Claude, other sentinels. */

type S = ReturnType<typeof setup>;
const ended = (s: S, runId: string) => () => !['queued', 'running', 'needs-you'].includes(s.sentinels.runGet(runId).run.state);
const waiting = (s: S, runId: string) => () => s.sentinels.runGet(runId).run.state === 'needs-you';

// ---------------------------------------------------------------- fakes

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response('{"results": []}', { status: 200 })) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer(String(url), init ?? {});
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const HEAD = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const look = (patch: Partial<PrLook> = {}): PrLook => ({ number: 7, url: 'https://github.com/acme/bob-api/pull/7', state: 'OPEN', draft: false, conflicts: false, checks: 'passing', failed: [], count: 3, head: HEAD, ...patch });

function fakeGitHub(opts: { looks?: Array<PrLook | string>; review?: { verdict: 'ship' | 'hold'; line: string; head?: string } | undefined; merge?: true | string } = {}) {
  const opened: Array<{ workspaceId: string; draft: boolean }> = [];
  const merged: Array<{ workspaceId?: string; number: number; method: string; head?: string }> = [];
  const looks = [...(opts.looks ?? [look()])];
  let looked = 0;
  const github: SentinelGitHub = {
    openPr: async (workspaceId, o) => {
      opened.push({ workspaceId, draft: o.draft });
      return { number: 7, url: 'https://github.com/acme/bob-api/pull/7' };
    },
    look: async () => {
      looked++;
      return looks.length > 1 ? looks.shift()! : looks[0]!;
    },
    review: async () => ('review' in opts ? opts.review : { verdict: 'ship', line: 'A two-line fix with a test.', head: HEAD }),
    merge: async (where, pr, method, head) => {
      merged.push({ ...(where.workspaceId ? { workspaceId: where.workspaceId } : {}), number: pr.number, method, head });
      return opts.merge ?? true;
    },
  };
  return { github, opened, merged, looked: () => looked };
}

const shipping = (merge: { approval: boolean } = { approval: true }) => ({
  name: 'Fix it',
  projectId: 'api',
  access: 'ship' as const,
  steps: [
    { kind: 'claude' as const, name: 'Fix', where: 'worktree' as const, prompt: 'Fix the failing test' },
    { kind: 'pr' as const, name: 'Open a PR' },
    { kind: 'merge' as const, name: 'Merge', require: { checks: true as const, approval: merge.approval }, method: 'squash' as const },
    { kind: 'notify' as const, name: 'Tell me', phone: false },
  ],
});

// ---------------------------------------------------------------- Call a service

describe('Call a service', () => {
  it('fills in your $VARs and the templates, JSON-escaped in a JSON body; no secret or header reaches the outputs', async () => {
    const f = fakeFetch(() => new Response('{"answer": "found 2 things", "echo": "Bearer sekret-123"}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const s = setup({ fetch: f.fetch, envFor: () => ({ GROQBOT_KEY: 'sekret-123' }), shell: async () => ({ exitCode: 0, output: 'say "hi" $GROQBOT_KEY\n', truncated: false, timedOut: false, ms: 5 }) });
    const made = s.sentinels.create({
      name: 'Web',
      projectId: 'api',
      steps: [
        { kind: 'script', name: 'What to search', command: 'echo', cwd: 'project', timeoutSec: 5 },
        { kind: 'http', name: 'Search', method: 'POST', url: 'https://api.groqbot.example/search?for={{trigger}}', headers: { Authorization: 'Bearer $GROQBOT_KEY', 'Content-Type': 'application/json' }, body: '{"query": "{{previous}}"}', timeoutSec: 10, preset: 'groqbot' },
      ],
    });
    const run = s.sentinels.start(made.id, 'you');
    await until(ended(s, run.id));
    const detail = s.sentinels.runGet(run.id);
    expect(detail.run.state).toBe('done');
    const sent = f.calls[0]!;
    expect(sent.url).toBe('https://api.groqbot.example/search?for=You%20pressed%20Run');
    expect((sent.init.headers as Record<string, string>).Authorization).toBe('Bearer sekret-123');
    // The earlier output goes in as text: its quotes escaped, its "$GROQBOT_KEY" never filled in.
    expect(JSON.parse(sent.init.body as string)).toEqual({ query: 'say "hi" $GROQBOT_KEY\n' });
    const out = detail.run.steps[1]!.output!;
    expect(out).toContain('found 2 things');
    expect(JSON.stringify(detail)).not.toContain('sekret-123');
    expect(JSON.stringify(detail)).not.toMatch(/authorization/i);
    expect(out).toContain('Bearer [redacted]');
  });

  it('a $VAR that isn’t set, a missing address and an error answer fail in words', async () => {
    const f = fakeFetch(() => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }));
    const s = setup({ fetch: f.fetch, envFor: () => ({}) });
    const one = async (step: object) => {
      const run = s.sentinels.start(s.sentinels.create({ name: 'X', steps: [{ kind: 'http', method: 'GET', headers: {}, timeoutSec: 5, url: 'https://x.dev', ...step } as never] }).id, 'you');
      await until(ended(s, run.id));
      return s.sentinels.runGet(run.id).run;
    };
    expect((await one({ headers: { Authorization: 'Bearer $NOPE' } })).why).toBe('$NOPE isn’t set: add it in Settings › Environment');
    expect((await one({ url: '' })).why).toBe('it has no address yet: fill in the URL');
    expect(f.calls).toHaveLength(0);
    expect(await one({})).toMatchObject({ state: 'failed', why: 'x.dev answered 429 Too Many Requests: rate limited' });
  });

  it('a service that doesn’t answer in its time is cut off', async () => {
    const f = fakeFetch((_u, init) => new Promise((_ok, no) => (init.signal as AbortSignal).addEventListener('abort', () => no(Object.assign(new Error('timed out'), { name: 'TimeoutError' })))));
    const s = setup({ fetch: f.fetch });
    const run = s.sentinels.start(s.sentinels.create({ name: 'Slow', steps: [{ kind: 'http', method: 'GET', url: 'https://slow.dev', headers: {}, timeoutSec: 1 }] }).id, 'you');
    await until(ended(s, run.id), 4000);
    expect(s.sentinels.runGet(run.id).run).toMatchObject({ state: 'failed', why: 'slow.dev didn’t answer in 1 s' });
  });
});

// ---------------------------------------------------------------- pull requests

describe('Open a pull request', () => {
  it('opens one from the run’s worktree (a draft when asked) and keeps it on the run', async () => {
    const gh = fakeGitHub();
    const s = setup({ github: gh.github, reply: () => 'Fixed', changes: true });
    const run = s.sentinels.start(s.sentinels.create({ name: 'Deps', projectId: 'api', access: 'work', steps: [{ kind: 'claude', where: 'worktree', prompt: 'Update' }, { kind: 'pr', draft: true }] }).id, 'you');
    await until(ended(s, run.id));
    const r = s.sentinels.runGet(run.id).run;
    expect(gh.opened).toEqual([{ workspaceId: 'w1', draft: true }]);
    expect(r).toMatchObject({ state: 'done', pr: { number: 7 } });
    expect(r.steps[1]!.output).toBe('Opened #7 as a draft: https://github.com/acme/bob-api/pull/7');
  });

  it('without a worktree it fails in words', async () => {
    const s = setup({ github: fakeGitHub().github });
    const run = s.sentinels.start(s.sentinels.create({ name: 'PR', projectId: 'api', access: 'work', steps: [{ kind: 'pr' }] }).id, 'you');
    await until(ended(s, run.id));
    expect(s.sentinels.runGet(run.id).run.why).toBe('there’s no worktree to open a pull request from: an “Ask your agent” step in a new worktree comes first');
  });

  it('access: a pull request needs Work, a merge Ship, when added and when it runs', async () => {
    const s = setup();
    expect(() => s.sentinels.create({ name: 'X', access: 'look', steps: [{ kind: 'pr' }] })).toThrow('needs Work access; this sentinel has Look');
    expect(() => s.sentinels.create({ name: 'X', access: 'work', steps: [{ kind: 'merge' }] as never })).toThrow('needs Ship access; this sentinel has Work');
    // A sentinel whose access was lowered by hand in its file: the runner refuses in words.
    const runner = new SentinelRunner({ now: Date.now, shell: async () => ({ output: '', truncated: false, timedOut: false, ms: 0 }), envFor: () => ({}), notify: () => undefined, folders: new RunFolders(null), project: () => undefined, beluga: () => ({ tasks: '', worktrees: '', plans: '' }), home: '/', claudeTurn: async () => () => undefined });
    const sentinel = { id: 'sn', name: 'Low', icon: 'eye', trigger: { kind: 'manual' }, steps: [{ id: 'm', name: 'Merge', kind: 'merge', require: { checks: true, approval: true }, method: 'squash' }], access: 'work', limits: { minutes: 5, pauseAfter: 3 }, notify: 'mac', paused: false, failures: 0, createdAt: 0, updatedAt: 0 } as Sentinel;
    const active: ActiveRun = { run: { id: 'r', sentinelId: 'sn', by: 'you', trigger: { kind: 'manual', summary: 'x' }, state: 'running', startedAt: Date.now(), headline: '', steps: [{ id: 'm', state: 'waiting' }], tasks: [] }, sentinel, abort: new AbortController(), deadline: Date.now() + 60_000, places: {} };
    const out = await runner.execute(active, () => undefined);
    expect(out).toMatchObject({ state: 'failed', why: 'it needs Ship access, and this sentinel has Work' });
  });
});

// ---------------------------------------------------------------- the merge gate (§5)

describe('Merge if acceptable', () => {
  it('no pull request: the step fails', async () => {
    const s = setup({ github: fakeGitHub().github });
    const run = s.sentinels.start(s.sentinels.create({ name: 'M', projectId: 'api', access: 'ship', steps: [{ kind: 'merge' }] as never }).id, 'you');
    await until(ended(s, run.id));
    expect(s.sentinels.runGet(run.id).run.why).toBe('there’s no pull request to merge: an “Open a pull request” step comes first');
  });

  it('a failed check fails the step with its name; a conflict or a draft does too', async () => {
    for (const [l, why] of [
      [look({ checks: 'failing', failed: ['test (ubuntu)'] }), 'the check “test (ubuntu)” failed on #7'],
      [look({ conflicts: true }), '#7 conflicts with its base branch'],
      [look({ draft: true }), '#7 is a draft: a draft can’t merge (untick Draft on the pull request step)'],
    ] as const) {
      const gh = fakeGitHub({ looks: [l] });
      const s = setup({ github: gh.github, reply: () => 'Fixed', changes: true });
      const run = s.sentinels.start(s.sentinels.create(shipping()).id, 'you');
      await until(ended(s, run.id));
      expect(s.sentinels.runGet(run.id).run).toMatchObject({ state: 'failed', why });
      expect(gh.merged).toEqual([]);
    }
  });

  it('pending checks are waited for; with approval off it merges by itself and archives the worktree', async () => {
    const gh = fakeGitHub({ looks: [look({ checks: 'pending' }), look({ checks: 'pending' }), look()] });
    const s = setup({ github: gh.github, reply: () => 'Fixed it', changes: true, pollMs: 5 });
    const run = s.sentinels.start(s.sentinels.create(shipping({ approval: false })).id, 'you');
    await until(ended(s, run.id));
    const r = s.sentinels.runGet(run.id).run;
    // Three looks while the checks ran, and one more right before merging.
    expect(gh.looked()).toBe(4);
    expect(r).toMatchObject({ state: 'done', headline: 'Merged #7' });
    expect(r.steps[2]).toMatchObject({ state: 'done', why: 'All 3 checks passed · The agent’s review: ship, a two-line fix with a test', output: 'Merged #7 (squashed); its worktree is archived' });
    expect(gh.merged).toEqual([{ workspaceId: 'w1', number: 7, method: 'squash', head: HEAD }]);
    expect(s.archived).toEqual(['w1']);
    expect(s.notices.some((n) => n.kind === 'needsYou')).toBe(false);
  });

  it('approval: the run waits for you (Mac inbox and the phone), Merge merges, the later steps run', async () => {
    const gh = fakeGitHub();
    const s = setup({ github: gh.github, reply: () => 'Fixed it', changes: true });
    const run = s.sentinels.start(s.sentinels.create(shipping()).id, 'you');
    await until(waiting(s, run.id));
    const r = s.sentinels.runGet(run.id).run;
    expect(r).toMatchObject({ headline: 'Merge #7?', pr: { number: 7 } });
    expect(r.steps[2]).toMatchObject({ state: 'running', why: 'All 3 checks passed · The agent’s review: ship, a two-line fix with a test' });
    expect(s.notices.find((n: NoticeEvent) => n.kind === 'needsYou')).toMatchObject({ tag: 'sentinel', title: 'Fix it: merge #7?', key: `${run.id}:merge` });
    expect(s.store.getState().sentinel.live[run.id]).toMatchObject({ state: 'needs-you' });
    expect(gh.merged).toEqual([]);
    await expect(s.sentinels.decide(run.id, 'merge')).resolves.toMatchObject({ id: run.id });
    await until(ended(s, run.id));
    const done = s.sentinels.runGet(run.id).run;
    expect(done).toMatchObject({ state: 'done', headline: 'Merged #7' });
    expect(done.steps.map((st) => st.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(gh.merged).toHaveLength(1);
  });

  it('a hold asks you even with approval off; Not Now stops the run with the pull request open', async () => {
    const gh = fakeGitHub({ review: { verdict: 'hold', line: 'The retry loop never stops on a 4xx.' } });
    const s = setup({ github: gh.github, reply: () => 'Fixed it', changes: true });
    const run = s.sentinels.start(s.sentinels.create(shipping({ approval: false })).id, 'you');
    await until(waiting(s, run.id));
    expect(s.sentinels.runGet(run.id).run.headline).toBe('#7: the agent says hold. Merge it anyway?');
    await s.sentinels.decide(run.id, 'skip');
    await until(ended(s, run.id));
    expect(s.sentinels.runGet(run.id).run).toMatchObject({ state: 'stopped', headline: 'Not now: #7 stays open' });
    expect(gh.merged).toEqual([]);
    expect(s.archived).toEqual([]);
  });

  it('unanswered, the run stops and says so; GitHub saying no fails the run and the Merge call', async () => {
    const s = setup({ github: fakeGitHub().github, reply: () => 'Fixed it', changes: true, approvalMs: 30 });
    const run = s.sentinels.start(s.sentinels.create(shipping()).id, 'you');
    await until(ended(s, run.id));
    expect(s.sentinels.runGet(run.id).run).toMatchObject({ state: 'stopped', headline: 'Nobody said Merge in 24 hours: #7 stays open' });

    const no = setup({ github: fakeGitHub({ merge: 'This branch conflicts with the base branch.' }).github, reply: () => 'Fixed it', changes: true });
    const r2 = no.sentinels.start(no.sentinels.create(shipping()).id, 'you');
    await until(waiting(no, r2.id));
    await expect(no.sentinels.decide(r2.id, 'merge')).rejects.toThrow('GitHub didn’t merge #7: This branch conflicts with the base branch.');
    await until(ended(no, r2.id));
    expect(no.sentinels.runGet(r2.id).run.state).toBe('failed');
  });

  it('the merge is pinned to the commit that was checked and reviewed; a push while it waits is refused', async () => {
    const OTHER = 'f'.repeat(40);
    // The first look (the checks) sees HEAD; the one right before merging sees a new push.
    const gh = fakeGitHub({ looks: [look(), look({ head: OTHER })] });
    const s = setup({ github: gh.github, reply: () => 'Fixed it', changes: true });
    const run = s.sentinels.start(s.sentinels.create(shipping()).id, 'you');
    await until(waiting(s, run.id));
    const asked = s.sentinels.runGet(run.id).run;
    expect(asked).toMatchObject({ prHead: HEAD });
    expect(asked.waitingSince).toBeTypeOf('number');
    await expect(s.sentinels.decide(run.id, 'merge')).rejects.toThrow('the branch changed since the agent reviewed it; run it again');
    await until(ended(s, run.id));
    expect(s.sentinels.runGet(run.id).run).toMatchObject({ state: 'failed', why: 'the branch changed since the agent reviewed it; run it again' });
    expect(gh.merged).toEqual([]);
  });

  it('a review of another commit than the pull request’s head is a hold, even with approval off', async () => {
    const gh = fakeGitHub({ review: { verdict: 'ship', line: 'Fine.', head: 'b'.repeat(40) } });
    const s = setup({ github: gh.github, reply: () => 'Fixed it', changes: true });
    const run = s.sentinels.start(s.sentinels.create(shipping({ approval: false })).id, 'you');
    await until(waiting(s, run.id));
    const r = s.sentinels.runGet(run.id).run;
    expect(r.headline).toBe('#7: the agent says hold. Merge it anyway?');
    expect(r.steps[2]!.why).toBe('All 3 checks passed · The agent reviewed bbbbbbb, not #7’s head a1b2c3d');
    expect(gh.merged).toEqual([]);
    // You said Merge: it merges what the checks passed on, pinned to it.
    await s.sentinels.decide(run.id, 'merge');
    expect(gh.merged).toEqual([{ workspaceId: 'w1', number: 7, method: 'squash', head: HEAD }]);
  });
});

describe('Merge after Beluga was closed (decide on a run nobody runs)', () => {
  /** A sentinel with a merge waiting for you, as Beluga left it when it closed. */
  const closedUnder = (s: S, patch: Record<string, unknown> = {}) => {
    const made = s.sentinels.create(shipping());
    const at = (patch.startedAt as number | undefined) ?? Date.now() - 60_000;
    const run = s.sentinels.addHistory(made.id, {
      by: 'you',
      trigger: { kind: 'manual', summary: 'You pressed Run' },
      state: 'needs-you',
      startedAt: at,
      headline: 'Merge #7?',
      steps: [
        { id: made.steps[0]!.id, state: 'done', startedAt: at, endedAt: at },
        { id: made.steps[1]!.id, state: 'done', startedAt: at, endedAt: at },
        { id: made.steps[2]!.id, state: 'running', startedAt: at },
        { id: made.steps[3]!.id, state: 'waiting' },
      ],
      worktreeId: 'w9',
      pr: { number: 7, url: 'https://github.com/acme/bob-api/pull/7' },
      prHead: HEAD,
      waitingSince: at,
      tasks: [],
      ...patch,
    });
    return { made, run };
  };

  it('merges pinned to the reviewed commit, ends as a run ends, and the sentinels after it start', async () => {
    const gh = fakeGitHub();
    const s = setup({ github: gh.github });
    const { made, run } = closedUnder(s);
    const after = s.sentinels.create({ name: 'After the merge', trigger: { kind: 'after', sentinelId: made.id, on: 'success' }, steps: [{ kind: 'notify', phone: false }] });
    s.sentinels.pause(after.id, false);
    await expect(s.sentinels.decide(run.id, 'merge')).resolves.toMatchObject({ state: 'done', headline: 'Merged #7' });
    expect(gh.merged).toEqual([{ workspaceId: 'w9', number: 7, method: 'squash', head: HEAD }]);
    expect(s.archived).toEqual(['w9']);
    expect(s.sentinels.runsOf(after.id)).toHaveLength(1);
    expect(s.sentinels.runsOf(after.id)[0]).toMatchObject({ by: `after:${run.id}` });
  });

  it('refused when the branch moved, when Ship access is gone, or when its merge step is gone; the run fails and counts', async () => {
    const moved = fakeGitHub({ looks: [look({ head: 'c'.repeat(40) })] });
    const s1 = setup({ github: moved.github });
    const one = closedUnder(s1);
    await expect(s1.sentinels.decide(one.run.id, 'merge')).rejects.toThrow('The branch changed since the agent reviewed it; run it again');
    expect(s1.sentinels.runGet(one.run.id).run).toMatchObject({ state: 'failed', why: 'the branch changed since the agent reviewed it; run it again' });
    expect(s1.sentinels.need(one.made.id).failures).toBe(1);
    expect(moved.merged).toEqual([]);

    const gh = fakeGitHub();
    const s2 = setup({ github: gh.github });
    const two = closedUnder(s2);
    // Its access lowered (by hand in its file) while the run waited.
    s2.sentinels.demoSet(two.made.id, { access: 'work' } as never);
    await expect(s2.sentinels.decide(two.run.id, 'merge')).rejects.toThrow('It needs Ship access, and this sentinel has Work');
    expect(s2.sentinels.runGet(two.run.id).run.state).toBe('failed');

    const three = closedUnder(s2);
    s2.sentinels.update(three.made.id, { steps: three.made.steps.filter((st) => st.kind !== 'merge') });
    await expect(s2.sentinels.decide(three.run.id, 'merge')).rejects.toThrow('This sentinel has no merge step anymore');
    expect(gh.merged).toEqual([]);
  });

  it('a second Merge while the first is going is refused', async () => {
    const gh = fakeGitHub();
    const s = setup({ github: gh.github });
    const { run } = closedUnder(s);
    const first = s.sentinels.decide(run.id, 'merge');
    await expect(s.sentinels.decide(run.id, 'merge')).rejects.toThrow('That run is being merged already');
    await first;
    expect(gh.merged).toHaveLength(1);
  });

  it('the 24 hours count from when it started waiting for you, not from when its merge step started', () => {
    const s = setup({ github: fakeGitHub().github });
    const long = Date.now() - 30 * 60 * 60_000;
    // Its merge step started 30 hours ago (the checks were slow), but it has waited only an hour.
    const { run: recent } = closedUnder(s, { startedAt: long, waitingSince: Date.now() - 60 * 60_000 });
    const { run: old } = closedUnder(s, { startedAt: long, waitingSince: Date.now() - 25 * 60 * 60_000 });
    s.sentinels.tick();
    expect(s.sentinels.runGet(recent.id).run.state).toBe('needs-you');
    expect(s.sentinels.runGet(old.id).run).toMatchObject({ state: 'stopped', headline: 'Nobody said Merge in 24 hours: #7 stays open' });
  });
});

// ---------------------------------------------------------------- Message a chat

describe('Message a chat', () => {
  function fakeChat(opts: { off?: boolean } = {}) {
    const posted: Array<[string, string]> = [];
    const told: Array<[string, string]> = [];
    const chat: SentinelChat = {
      post: (to, text) => {
        if (opts.off) throw new Error('The Beluga network is off: turn it on in Settings › Network');
        posted.push([to, text]);
      },
      nameOf: (to) => (to === 'group:g1' ? 'Launch crew' : undefined),
      friends: () => [
        { peerId: 'p-ata', name: 'Ata' },
        { peerId: 'p-bo', name: 'Bo' },
      ],
      shares: (_to, peerId) => peerId === 'p-ata',
      tell: (peerId, note) => void told.push([peerId, note]),
      me: () => 'Kayra',
    };
    return { chat, posted, told };
  }

  it('writes as you; @name tags people, and one not in the chat is told where', async () => {
    const c = fakeChat();
    const s = setup({ chat: c.chat });
    const run = s.sentinels.start(s.sentinels.create({ name: 'Notes', steps: [{ kind: 'message', to: 'group:g1', text: '{{sentinel}} ran. @ata @bo have a look' }] }).id, 'you');
    await until(ended(s, run.id));
    expect(c.posted).toEqual([['group:g1', 'Notes ran. @ata @bo have a look']]);
    expect(c.told).toEqual([['p-bo', 'Kayra mentioned you in the group “Launch crew”:\n\nNotes ran. @ata @bo have a look']]);
    expect(s.sentinels.runGet(run.id).run.steps[0]!.output).toBe('Sent to Launch crew: Notes ran. @ata @bo have a look · tagged Ata, Bo');
  });

  it('with the network off, or no chat picked, it fails in words', async () => {
    const s = setup({ chat: fakeChat({ off: true }).chat });
    const one = async (to: string) => {
      const run = s.sentinels.start(s.sentinels.create({ name: 'N', steps: [{ kind: 'message', to, text: 'hi' }] }).id, 'you');
      await until(ended(s, run.id));
      return s.sentinels.runGet(run.id).run.why;
    };
    expect(await one('dm:p-ata')).toBe('The Beluga network is off: turn it on in Settings › Network');
    expect(await one('')).toBe('pick the chat it writes in');
  });
});

// ---------------------------------------------------------------- Ask a friend's Claude

describe('Ask a friend’s Claude', () => {
  function fakeFriends(answers: FriendAnswer[]) {
    const asked: Array<Record<string, unknown>> = [];
    const cancelled: string[] = [];
    const friends: SentinelFriends = {
      ask: (input) => {
        asked.push({ ...input });
        return 'tk1';
      },
      wait: async () => answers.shift() ?? { state: 'done', final: true, summary: 'ok' },
      cancel: (id) => void cancelled.push(id),
    };
    return { friends, asked, cancelled };
  }

  it('asks through the gateway as you and waits for the answer (their questions don’t end it)', async () => {
    const f = fakeFriends([
      { state: 'working', final: false },
      { state: 'done', final: true, summary: 'Staging is up; 2 errors in the log', data: { errors: 2 }, name: 'Ata’s Claude' },
    ]);
    const s = setup({ friends: f.friends });
    const run = s.sentinels.start(s.sentinels.create({ name: 'Staging', steps: [{ kind: 'friend', peerId: 'p-ata', prompt: 'Is staging up?', project: 'infra' }] }).id, 'you');
    await until(ended(s, run.id), 5000);
    expect(f.asked).toEqual([{ person: 'p-ata', ask: 'Is staging up?', summary: 'Staging: Is staging up?', project: 'infra' }]);
    expect(s.sentinels.runGet(run.id).run.steps[0]!.output).toBe('Staging is up; 2 errors in the log\n\n{\n  "errors": 2\n}');
  });

  it('a no fails the run with who said it', async () => {
    const s = setup({ friends: fakeFriends([{ state: 'declined', final: true, summary: 'Not now', name: 'Ata’s Claude' }]).friends });
    const run = s.sentinels.start(s.sentinels.create({ name: 'Ask', steps: [{ kind: 'friend', peerId: 'p-ata', prompt: 'Hi' }] }).id, 'you');
    await until(ended(s, run.id));
    expect(s.sentinels.runGet(run.id).run.why).toBe('Ata’s Claude said no: Not now');
  });
});

// ---------------------------------------------------------------- other sentinels

describe('Run another sentinel, and after', () => {
  it('a step starts the other one with this run’s last output; it doesn’t wait for it', async () => {
    const s = setup({ reply: () => 'Report it' });
    const other = s.sentinels.create({ name: 'Report', steps: [{ kind: 'notify', phone: false }] });
    s.sentinels.pause(other.id, false);
    const first = s.sentinels.create({ name: 'First', steps: [{ kind: 'script', command: 'echo', cwd: 'home', timeoutSec: 5 }, { kind: 'trigger', sentinelId: other.id }] });
    const run = s.sentinels.start(first.id, 'you');
    await until(() => s.sentinels.runsOf(other.id).length === 1 && ended(s, s.sentinels.runsOf(other.id)[0]!.id)());
    expect(s.sentinels.runGet(run.id).run.steps[1]!.output).toBe('Started “Report”');
    const theirs = s.sentinels.runGet(s.sentinels.runsOf(other.id)[0]!.id).run;
    expect(theirs.by).toBe(`after:${run.id}`);
    expect(theirs.trigger).toMatchObject({ kind: 'after', summary: '“First” ran it', payload: { sentinel: 'First', output: 'ok\n' } });
    // A paused one doesn't start: the step says so.
    s.sentinels.pause(other.id, true);
    const again = s.sentinels.start(first.id, 'you');
    await until(ended(s, again.id));
    expect(s.sentinels.runGet(again.id).run.why).toBe('“Report” is paused: turn it on first');
  });

  it('after: a sentinel runs when another ends as it says (success, failure, always), never in a loop', async () => {
    let exit = 1;
    const s = setup({ shell: async () => ({ exitCode: exit, output: exit ? 'FAIL webhooks' : 'ok', truncated: false, timedOut: false, ms: 3 }) });
    const tests = s.sentinels.create({ name: 'Nightly tests', steps: [{ kind: 'script', command: 'npm test', cwd: 'home', timeoutSec: 5 }] });
    const fix = s.sentinels.create({ name: 'Fix the nightly failure', trigger: { kind: 'after', sentinelId: tests.id, on: 'failure' }, steps: [{ kind: 'notify', phone: false }] });
    const always = s.sentinels.create({ name: 'Log it', trigger: { kind: 'after', sentinelId: tests.id, on: 'always' }, steps: [{ kind: 'notify', phone: false }] });
    for (const x of [fix, always]) s.sentinels.pause(x.id, false);
    const failed = s.sentinels.start(tests.id, 'you');
    await until(() => s.sentinels.runsOf(fix.id).length === 1 && s.sentinels.runsOf(always.id).length === 1);
    expect(s.sentinels.runsOf(fix.id)[0]).toMatchObject({ by: `after:${failed.id}`, trigger: { summary: 'After “Nightly tests” failed: Run a script: exit 1: FAIL webhooks' } });
    expect(s.sentinels.runGet(s.sentinels.runsOf(fix.id)[0]!.id).run.trigger.payload).toMatchObject({ state: 'failed', output: 'FAIL webhooks' });
    exit = 0;
    s.sentinels.start(tests.id, 'you');
    await until(() => s.sentinels.runsOf(always.id).length === 2);
    expect(s.sentinels.runsOf(fix.id)).toHaveLength(1);
    // A loop (each runs the other): the second start is refused.
    const a = s.sentinels.create({ name: 'A', steps: [{ kind: 'notify', phone: false }] });
    const b = s.sentinels.create({ name: 'B', trigger: { kind: 'after', sentinelId: a.id, on: 'success' }, steps: [{ kind: 'trigger', sentinelId: a.id }] });
    s.sentinels.pause(b.id, false);
    s.sentinels.pause(a.id, false);
    s.sentinels.start(a.id, 'you');
    await until(() => s.sentinels.runsOf(b.id).length === 1 && ended(s, s.sentinels.runsOf(b.id)[0]!.id)());
    expect(s.sentinels.runGet(s.sentinels.runsOf(b.id)[0]!.id).run.why).toBe('“A” led to this run: starting it again would run them in a loop');
    expect(s.sentinels.runsOf(a.id)).toHaveLength(1);
  });
});
