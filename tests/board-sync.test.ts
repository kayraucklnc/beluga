import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import type { Actor, IssueStatus } from '../src/core/board/model.js';
import { briefToMarkdown, markdownToBrief } from '../src/core/board/sync/fields.js';
import { LinearProvider, stateFor, statusFromLinear } from '../src/core/board/sync/linear.js';
import { type FetchLike, type IssueFields, type Provider, type RemoteIssue, SyncError } from '../src/core/board/sync/provider.js';
import { TaskSync } from '../src/core/board/sync/sync.js';
import { linearKeyProblem } from '../src/shared/tracker-keys.js';
import { Store, initialState } from '../src/core/store.js';
import type { Project } from '../src/workspaces/types.js';

/** Two-way sync with another tracker (Linear): what comes over, what goes out, who wins, and the key kept out of sight. */

const me: Actor = { kind: 'person', id: 'p-me', name: 'Kay' };
const KEY = `lin_api_${'a'.repeat(40)}`;
const project = (id: string, name: string): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces: [] });

/** A tracker in memory, on its own clock, counting what's asked of it. */
class FakeTracker implements Provider {
  readonly kind = 'linear' as const;
  issues = new Map<string, RemoteIssue>();
  calls = { changed: 0, create: 0, update: 0 };
  fail?: SyncError;
  private n = 0;
  constructor(private readonly clock: { t: number }) {}

  add(fields: Partial<RemoteIssue> & { title: string }): RemoteIssue {
    const id = `r${++this.n}`;
    const issue: RemoteIssue = { id, key: `ENG-${this.n}`, url: `https://linear.app/acme/issue/ENG-${this.n}`, description: '', status: 'todo', priority: 'none', labels: [], updatedAt: ++this.clock.t, ...fields };
    this.issues.set(id, issue);
    return issue;
  }

  edit(id: string, fields: Partial<RemoteIssue>): void {
    this.issues.set(id, { ...this.issues.get(id)!, ...fields, updatedAt: ++this.clock.t });
  }

  async teams() {
    if (this.fail) throw this.fail;
    return { workspace: 'Acme', teams: [{ id: 't1', key: 'ENG', name: 'Engineering' }] };
  }

  async changed(_team: string, since: number | undefined) {
    this.calls.changed++;
    if (this.fail) throw this.fail;
    return [...this.issues.values()].filter((i) => since === undefined || i.updatedAt > since).sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async create(_team: string, f: IssueFields) {
    this.calls.create++;
    return this.add({ ...f, title: f.title });
  }

  async update(_team: string, id: string, f: Partial<IssueFields>) {
    this.calls.update++;
    const was = this.issues.get(id)!;
    const next: Record<string, unknown> = { ...was, ...f, updatedAt: ++this.clock.t };
    for (const [k, v] of Object.entries(f)) if (v === undefined) delete next[k];
    this.issues.set(id, next as unknown as RemoteIssue);
    return next as unknown as RemoteIssue;
  }
}

function setup() {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api')] });
  const clock = { t: 1_000_000 };
  const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name, now: () => clock.t, saveDelayMs: 0 });
  const tracker = new FakeTracker(clock);
  const sync = new TaskSync({ store, board, file: null, provider: () => tracker, now: () => clock.t, soonMs: 0 });
  const tick = (ms = 10): void => void (clock.t += ms);
  return { store, board, tracker, sync, clock, tick };
}

const connect = async (sync: TaskSync, more: { pushExisting?: boolean; auto?: boolean } = {}): Promise<void> => {
  await sync.connect('api', { provider: 'linear', key: KEY, teamId: 't1', auto: false, ...more });
  await sync.settled();
};

describe('connecting', () => {
  it('checks the key first, keeps it out of the shared state, and says how the project syncs', async () => {
    const { sync, store } = setup();
    await expect(sync.teams('linear', 'nope')).rejects.toThrow('starts with lin_api_');
    expect((await sync.teams('linear', KEY)).teams.map((t) => t.key)).toEqual(['ENG']);
    await connect(sync);
    const shown = store.getState().board.sync?.api;
    expect(shown).toMatchObject({ provider: 'linear', workspace: 'Acme', team: 'Engineering', teamKey: 'ENG', auto: false, linked: 0 });
    expect(shown?.syncedAt).toBeDefined();
    expect(JSON.stringify(store.getState())).not.toContain(KEY);
  });

  it('refuses a team the key can’t see', async () => {
    const { sync } = setup();
    await expect(sync.connect('api', { provider: 'linear', key: KEY, teamId: 'other' })).rejects.toThrow('pick another');
  });

  it('says when the tracker turns the key down, and autosync waits for a new one', async () => {
    const { sync, tracker, store } = setup();
    await connect(sync, { auto: true });
    tracker.fail = new SyncError('auth', 'Linear doesn’t accept this key.');
    await sync.sync('api');
    expect(store.getState().board.sync?.api?.error?.code).toBe('auth');
    const before = tracker.calls.changed;
    await sync.tick();
    expect(tracker.calls.changed).toBe(before);
  });
});

describe('both ways', () => {
  it('brings issues over with their status, priority, labels and brief, and links them', async () => {
    const { sync, tracker, board, store } = setup();
    tracker.add({ title: 'Fix login', status: 'in_progress', priority: 'high', labels: ['bug'], estimate: 3, due: '2026-11-03', description: 'Users get logged out.\n\n## Acceptance criteria\n\n- [ ] stays signed in' });
    await connect(sync);
    const [issue] = board.list();
    expect(issue).toMatchObject({ title: 'Fix login', status: 'in_progress', priority: 'high', labels: ['bug'], estimate: 3, due: '2026-11-03', origin: 'sync' });
    expect(issue!.brief).toEqual({ goal: 'Users get logged out.', acceptance: '- [ ] stays signed in' });
    expect(issue!.link).toMatchObject({ provider: 'linear', key: 'ENG-1', url: 'https://linear.app/acme/issue/ENG-1' });
    expect(issue!.activity.map((a) => a.text)).toContain('linked this to Linear ENG-1');
    expect(store.getState().board.sync?.api?.linked).toBe(1);
  });

  it('sends tasks made since connecting, and older open ones only when asked', async () => {
    const { sync, tracker, board, tick } = setup();
    board.create({ projectId: 'api', title: 'Old open' }, me);
    board.create({ projectId: 'api', title: 'Old done', status: 'done' }, me);
    tick();
    await connect(sync);
    expect(tracker.calls.create).toBe(0);
    tick();
    const fresh = board.create({ projectId: 'api', title: 'New one', priority: 'urgent', brief: { goal: 'Do it', decisions: 'Chose A' } }, me);
    await sync.sync('api');
    const sent = [...tracker.issues.values()];
    expect(sent.map((i) => i.title)).toEqual(['New one']);
    expect(sent[0]).toMatchObject({ priority: 'urgent', description: 'Do it\n\n## Decisions\n\nChose A' });
    expect(board.get(fresh.id)?.link?.key).toBe('ENG-1');

    await connect(sync, { pushExisting: true });
    expect([...tracker.issues.values()].map((i) => i.title).sort()).toEqual(['New one', 'Old open']);
  });

  it('pulls a change made there, pushes one made here, and does nothing when nothing changed', async () => {
    const { sync, tracker, board, tick } = setup();
    const remote = tracker.add({ title: 'Fix login' });
    await connect(sync);
    const id = board.list()[0]!.id;

    tracker.edit(remote.id, { title: 'Fix login on Safari', status: 'in_review' });
    await sync.sync('api');
    expect(board.get(id)).toMatchObject({ title: 'Fix login on Safari', status: 'in_review' });
    expect(board.get(id)!.activity.at(-1)!.by).toMatchObject({ kind: 'person', name: 'Linear' });

    tick();
    board.update(id, { priority: 'low', labels: ['web'] }, me);
    board.editBrief(id, 'goal', 'Safari drops the cookie', me);
    await sync.sync('api');
    expect(tracker.issues.get(remote.id)).toMatchObject({ priority: 'low', labels: ['web'], description: 'Safari drops the cookie', title: 'Fix login on Safari' });

    const calls = { ...tracker.calls };
    await sync.sync('api');
    await sync.sync('api');
    expect(tracker.calls.update).toBe(calls.update);
    expect(tracker.calls.create).toBe(calls.create);
  });

  it('keeps both sides’ changes to different fields, and the newer one to the same field', async () => {
    const { sync, tracker, board, tick } = setup();
    const remote = tracker.add({ title: 'Fix login' });
    await connect(sync);
    const id = board.list()[0]!.id;

    tick();
    board.update(id, { priority: 'high', title: 'Mine' }, me);
    tracker.edit(remote.id, { status: 'in_progress', title: 'Theirs, later' });
    await sync.sync('api');
    expect(board.get(id)).toMatchObject({ priority: 'high', status: 'in_progress', title: 'Theirs, later' });
    expect(tracker.issues.get(remote.id)).toMatchObject({ priority: 'high', status: 'in_progress', title: 'Theirs, later' });

    tracker.edit(remote.id, { title: 'Theirs again' });
    tick(100);
    board.update(id, { title: 'Mine, later' }, me);
    await sync.sync('api');
    expect(board.get(id)!.title).toBe('Mine, later');
    expect(tracker.issues.get(remote.id)!.title).toBe('Mine, later');
  });

  it('keeps sub-tasks under their parents, both ways', async () => {
    const { sync, tracker, board, tick } = setup();
    const parent = tracker.add({ title: 'Auth' });
    tracker.add({ title: 'Login page', parent: parent.id });
    await connect(sync);
    const [p, kid] = [board.list().find((i) => i.title === 'Auth')!, board.list().find((i) => i.title === 'Login page')!];
    expect(kid.parent).toBe(p.id);

    tick();
    const sub = board.create({ projectId: 'api', title: 'Logout button', parent: p.id }, me);
    await sync.sync('api');
    expect(tracker.issues.get(board.get(sub.id)!.link!.id)!.parent).toBe(parent.id);
  });

  it('a status the tracker can’t say (Merged into Plan) doesn’t bounce back', async () => {
    const { sync, tracker, board, tick } = setup();
    tracker.add({ title: 'Plan step' });
    await connect(sync);
    const id = board.list()[0]!.id;
    tick();
    board.update(id, { status: 'in_plan' }, me);
    // A tracker that only knows "in review" for it.
    const real = tracker.update.bind(tracker);
    tracker.update = async (team, rid, f) => real(team, rid, { ...f, ...(f.status === 'in_plan' ? { status: 'in_review' as IssueStatus } : {}) });
    await sync.sync('api');
    await sync.sync('api');
    expect(board.get(id)!.status).toBe('in_plan');
    expect(tracker.calls.update).toBe(1);
  });

  it('disconnecting forgets the key and unlinks tasks; nothing there changes', async () => {
    const { sync, tracker, board, store } = setup();
    tracker.add({ title: 'Fix login' });
    await connect(sync);
    sync.disconnect('api');
    expect(store.getState().board.sync?.api).toBeUndefined();
    expect(board.list()[0]!.link).toBeUndefined();
    expect(tracker.issues.size).toBe(1);
  });

  it('autosync sends a change made here by itself', async () => {
    const { sync, tracker, board, tick } = setup();
    tracker.add({ title: 'Fix login' });
    await connect(sync, { auto: true });
    sync.start();
    try {
      tick();
      board.update(board.list()[0]!.id, { priority: 'urgent' }, me);
      await new Promise((r) => setTimeout(r, 20));
      await sync.settled();
      expect([...tracker.issues.values()][0]!.priority).toBe('urgent');
    } finally {
      sync.stop();
    }
  });
});

describe('the brief as a description', () => {
  it('reads back the way it was written', () => {
    const brief = { goal: 'Ship it', acceptance: '- [ ] a\n- [x] b', handoff: 'Next: c' };
    const md = briefToMarkdown(brief);
    expect(md).toBe('Ship it\n\n## Acceptance criteria\n\n- [ ] a\n- [x] b\n\n## Notes for the next agent\n\nNext: c');
    expect(markdownToBrief(md)).toEqual(brief);
  });

  it('keeps headings of its own in the goal', () => {
    expect(markdownToBrief('# Why\nBecause\n### decisions\nA')).toEqual({ goal: '# Why\nBecause', decisions: 'A' });
  });
});

describe('Linear', () => {
  const states = [
    { id: 's-back', name: 'Backlog', type: 'backlog', position: 0 },
    { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
    { id: 's-prog', name: 'In Progress', type: 'started', position: 2 },
    { id: 's-rev', name: 'In Review', type: 'started', position: 3 },
    { id: 's-done', name: 'Done', type: 'completed', position: 4 },
    { id: 's-cxl', name: 'Canceled', type: 'canceled', position: 5 },
  ];

  it('maps its states to the board’s and back', () => {
    expect(statusFromLinear({ type: 'triage', name: 'Triage' })).toBe('backlog');
    expect(statusFromLinear({ type: 'started', name: 'In Review' })).toBe('in_review');
    expect(statusFromLinear({ type: 'started', name: 'Doing' })).toBe('in_progress');
    expect(stateFor(states, 'in_review')?.id).toBe('s-rev');
    expect(stateFor(states, 'in_plan')?.id).toBe('s-rev');
    expect(stateFor(states, 'in_progress')?.id).toBe('s-prog');
    expect(stateFor(states.filter((s) => s.id !== 's-rev'), 'in_review')?.id).toBe('s-prog');
  });

  it('checks a key’s shape', () => {
    expect(linearKeyProblem(KEY)).toBeUndefined();
    expect(linearKeyProblem('lin_oauth_abc')).toMatch(/OAuth/);
    expect(linearKeyProblem('lin_api_short')).toMatch(/whole key/);
  });

  it('sends the key only as the Authorization header, and maps an issue it creates', async () => {
    const sent: Array<{ op: string; variables: Record<string, unknown>; auth: string }> = [];
    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as { operationName: string; variables: Record<string, unknown> };
      sent.push({ op: body.operationName, variables: body.variables, auth: init.headers.authorization! });
      const reply = (data: unknown) => ({ status: 200, headers: { get: () => null }, json: async () => ({ data }) });
      if (body.operationName === 'Team') return reply({ team: { issueEstimationType: 'fibonacci', states: { nodes: states }, labels: { nodes: [{ id: 'l-bug', name: 'Bug' }] } }, issueLabels: { nodes: [] } });
      if (body.operationName === 'Label') return reply({ issueLabelCreate: { success: true, issueLabel: { id: 'l-web', name: 'web' } } });
      return reply({ issueCreate: { success: true, issue: { id: 'x1', identifier: 'ENG-9', url: 'u', title: 'T', description: 'D', priority: 2, estimate: 3, dueDate: null, updatedAt: '2026-10-24T10:00:00.000Z', state: { id: 's-rev', name: 'In Review', type: 'started' }, labels: { nodes: [{ name: 'Bug' }, { name: 'web' }] }, parent: null } } });
    };
    const linear = new LinearProvider(KEY, { fetch, sleep: async () => undefined });
    const made = await linear.create('t1', { title: 'T', description: 'D', status: 'in_review', priority: 'high', estimate: 3, labels: ['bug', 'web'] });
    expect(made).toMatchObject({ id: 'x1', key: 'ENG-9', status: 'in_review', priority: 'high', estimate: 3, labels: ['bug', 'web'] });
    const create = sent.find((s) => s.op === 'Create')!;
    expect(create.variables.input).toMatchObject({ teamId: 't1', stateId: 's-rev', priority: 2, estimate: 3, labelIds: ['l-bug', 'l-web'] });
    expect(sent.every((s) => s.auth === KEY)).toBe(true);
    expect(JSON.stringify(sent.map((s) => s.variables))).not.toContain(KEY);
  });

  it('says a refused key in its own words', async () => {
    const fetch: FetchLike = async () => ({ status: 400, headers: { get: () => null }, json: async () => ({ errors: [{ message: `bad key ${KEY}`, extensions: { type: 'authentication error' } }] }) });
    const err = await new LinearProvider(KEY, { fetch, sleep: async () => undefined }).teams().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).code).toBe('auth');
    expect((err as SyncError).message).not.toContain(KEY);
  });
});
