import { describe, expect, it } from 'vitest';
import type { Action, AppState } from '../src/core/store.js';
import type { CcSession } from '../src/core/claude-code/model.js';
import type { Notice } from '../src/core/work-store.js';
import { type ScreenAction, initialAppState, reduceApp } from '../src/client/screen.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { dockCount, groupTally, groupWorking, needOf, projectTally, projectWorking, signalOf, tally, tallyTip, unreadEntries, workspaceSignal } from '../packages/mac/src/layout/attention-model.js';

/** The sidebar's unread and needs-you marks (packages/mac/src/layout/attention-model.ts), and the core's unread counts behind them. */

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w', projectRoot: '/p', name: 'w', path: '/wt/w', kind: 'worktree', branch: 'klaud/w', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over,
});
const api: Project = {
  id: 'p1', name: 'api', root: '/p', base: 'origin/main',
  workspaces: [ws({ id: 'main', name: 'main', kind: 'main' }), ws({ id: 'auth', name: 'add-auth' }), ws({ id: 'hooks', name: 'webhooks' }), ws({ id: 'old', name: 'old', archived: true })],
};
const site: Project = { id: 'p2', name: 'site', root: '/s', base: 'origin/main', workspaces: [ws({ id: 'hero', name: 'new-hero', projectId: 'p2' })] };
const chats: Project = { id: 'chats', name: 'Chats', root: '', base: '', workspaces: [ws({ id: 'q', name: 'How do deploys work?', kind: 'chat', projectId: 'chats' })] };

const apply = (s: AppState, ...actions: Array<Action | ScreenAction>): AppState => actions.reduce<AppState>((st, a) => reduceApp(st, a), s);
const base = (): AppState =>
  apply(initialAppState('room'), { type: 'welcome', self: { peerId: 'me', name: 'kay', agent: true, shares: [] } }, { type: 'projects', projects: [chats, api, site] });
const run = (event: 'queued' | 'started' | 'done' | 'error' | 'awaiting_approval', channel = 'ws:auth', requestId = 'r1'): Action => ({ type: 'agent_event', owner: 'me', requestId, requester: 'me', event, text: event === 'done' ? 'All set.' : '', ts: 5, channel });
const view = (id: string): ScreenAction => ({ type: 'view', view: { kind: 'workspace', id, tab: 'chat' } });
const overview: ScreenAction = { type: 'view', view: { kind: 'overview' } };
const question = (qid: string, channel: string, kind: 'plan' | 'question' = 'question'): Action => ({
  type: 'question_add',
  question: { qid, requestId: 'r1', owner: 'me', channel, picked: {}, question: kind === 'plan' ? { kind: 'plan', plan: 'Do it' } : { kind: 'question', questions: [{ question: 'Which?', header: '', options: [], multiSelect: false }] } },
});
const session = (over: Partial<CcSession>): CcSession => ({ id: 's1', title: 'fix', cwd: '/wt/hooks', projectId: 'p1', workspaceId: 'hooks', status: 'working', lastAt: 1, steps: 0, agents: [], ...over });

describe('the core counts what you missed', () => {
  it("counts Claude's answer when a run finishes in a workspace you aren't looking at", () => {
    let s = apply(base(), view('auth'), run('started'));
    expect(s.unread['ws:auth']).toBeUndefined();
    s = apply(s, overview, run('done'));
    expect(s.unread['ws:auth']).toBe(1);
    // Opening it reads it.
    expect(apply(s, view('auth')).unread['ws:auth']).toBeUndefined();
  });

  it('never counts a run that finishes while you look at it, nor counts one finish twice', () => {
    let s = apply(base(), view('auth'), run('started'), run('done'));
    expect(s.unread['ws:auth']).toBeUndefined();
    s = apply(base(), view('auth'), run('started'), overview, run('done'), run('done'));
    expect(s.unread['ws:auth']).toBe(1);
  });

  it('counts a Claude Code session in one of your worktrees ending its turn', () => {
    let s = apply(base(), overview, { type: 'claude_code', sessions: [session({})] });
    expect(s.unread['ws:hooks']).toBeUndefined();
    s = apply(s, { type: 'claude_code', sessions: [session({ status: 'waiting' })] });
    expect(s.unread['ws:hooks']).toBe(1);
    // Shown: not news.
    s = apply(base(), view('hooks'), { type: 'claude_code', sessions: [session({})] }, { type: 'claude_code', sessions: [session({ status: 'waiting' })] });
    expect(s.unread['ws:hooks']).toBeUndefined();
  });
});

describe('a conversation’s signal: needs you > unread > working > idle', () => {
  it('is idle with nothing going on, and working while Claude runs', () => {
    const s = base();
    expect(workspaceSignal(s, api.workspaces[1]!)).toMatchObject({ level: 'idle', unread: 0, tip: '' });
    const busy = apply(s, view('auth'), run('started'));
    expect(signalOf(busy, 'ws:auth', 'auth')).toMatchObject({ level: 'working', working: true, tip: 'Your agent is working' });
    const cc = apply(s, { type: 'claude_code', sessions: [session({})] });
    expect(signalOf(cc, 'ws:hooks', 'hooks').level).toBe('working');
  });

  it('is unread once Claude finished elsewhere, and says so', () => {
    const s = apply(base(), view('auth'), run('started'), overview, run('done'));
    expect(signalOf(s, 'ws:auth', 'auth')).toMatchObject({ level: 'unread', unread: 1, tip: 'Your agent finished · 1 new message' });
    const stopped = apply(base(), view('auth'), run('started'), overview, run('error'));
    expect(signalOf(stopped, 'ws:auth', 'auth').tip).toBe('Your agent stopped · 1 new message');
    const chat = apply(base(), overview, { type: 'chat', id: 'c1', from: 'bob', text: 'hi', ts: 3, byAgent: false, channel: 'ws:hooks' }, { type: 'chat', id: 'c2', from: 'bob', text: 'there?', ts: 4, byAgent: false, channel: 'ws:hooks' });
    expect(signalOf(chat, 'ws:hooks', 'hooks')).toMatchObject({ level: 'unread', unread: 2, tip: '2 new messages' });
  });

  it('needs you for an approval, a question, a plan, a conflict or failed checks, until it is resolved', () => {
    const s = base();
    expect(needOf(apply(s, run('awaiting_approval')), 'ws:auth', 'auth')).toBe('approval');
    expect(needOf(apply(s, { type: 'approval_add', approval: { id: 'a1', kind: 'tool', title: 'Bash', detail: '', channel: 'ws:auth' } }), 'ws:auth', 'auth')).toBe('approval');
    expect(needOf(apply(s, question('q1', 'ws:auth')), 'ws:auth', 'auth')).toBe('question');
    expect(needOf(apply(s, question('q1', 'ws:auth', 'plan')), 'ws:auth', 'auth')).toBe('plan');
    expect(needOf(apply(s, { type: 'conflicts', id: 'auth', files: ['a.ts'] }), 'ws:auth', 'auth')).toBe('conflict');
    const pr = { number: 1, url: 'u', state: 'OPEN' as const, title: 't', draft: false, checks: 'failing' as const };
    expect(needOf(apply(s, { type: 'pr', id: 'auth', pr }), 'ws:auth', 'auth')).toBe('checks');
    expect(needOf(apply(s, { type: 'pr', id: 'auth', pr: { ...pr, state: 'MERGED' } }), 'ws:auth', 'auth')).toBeUndefined();
    // Someone else's question is theirs.
    expect(needOf(apply(s, question('q1', 'ws:hooks')), 'ws:auth', 'auth')).toBeUndefined();
    // Answered: it no longer needs you.
    expect(needOf(apply(s, question('q1', 'ws:auth'), { type: 'question_remove', qid: 'q1' }), 'ws:auth', 'auth')).toBeUndefined();
  });

  it('keeps needing you after you open it, while the unread part clears', () => {
    let s = apply(base(), view('auth'), run('started'), overview, question('q1', 'ws:auth'), { type: 'chat', id: 'c1', from: 'me', text: 'hm', ts: 6, byAgent: true, channel: 'ws:auth' });
    expect(signalOf(s, 'ws:auth', 'auth')).toMatchObject({ level: 'needs', need: 'question', unread: 1, tip: 'Your agent asks a question · 1 new message' });
    s = apply(s, view('auth'));
    expect(signalOf(s, 'ws:auth', 'auth')).toMatchObject({ level: 'needs', unread: 0, tip: 'Your agent asks a question' });
  });

  it('archived conversations stay quiet', () => {
    const s = apply(base(), overview, { type: 'chat', id: 'c1', from: 'bob', text: 'hi', ts: 3, byAgent: false, channel: 'ws:old' });
    expect(workspaceSignal(s, api.workspaces[3]!).level).toBe('idle');
  });
});

describe('projects and groups add up', () => {
  it('counts conversations with news, and how many need you', () => {
    const s = apply(
      base(),
      overview,
      { type: 'chat', id: 'c1', from: 'bob', text: 'a', ts: 3, byAgent: false, channel: 'ws:auth' },
      { type: 'chat', id: 'c2', from: 'bob', text: 'b', ts: 4, byAgent: false, channel: 'ws:auth' },
      { type: 'chat', id: 'c3', from: 'bob', text: 'c', ts: 5, byAgent: false, channel: 'ws:hero' },
      question('q1', 'ws:hooks'),
      // The main folder and archived ones aren't listed, so they don't count.
      { type: 'chat', id: 'c4', from: 'bob', text: 'd', ts: 6, byAgent: false, channel: 'ws:main' },
    );
    expect(projectTally(s, api)).toEqual({ unread: 1, needs: 1, working: false });
    expect(projectTally(s, site)).toEqual({ unread: 1, needs: 0, working: false });
    expect(groupTally(s, [api, site])).toEqual({ unread: 2, needs: 1, working: false });
    expect(tallyTip(groupTally(s, [api, site]))).toBe('1 needs you · 2 unread');
    expect(tallyTip(tally([]))).toBe('');
  });
});

describe('the Unread section and the Dock', () => {
  const busy = (): AppState =>
    apply(
      base(),
      view('hooks'),
      run('started', 'ws:hooks', 'r2'),
      overview,
      run('done', 'ws:hooks', 'r2'),
      { type: 'chat', id: 'c1', from: 'bob', text: 'a', ts: 9, byAgent: false, channel: 'ws:q' },
      question('q1', 'ws:hero'),
    );

  it('lists what needs you first, then the latest; empty when nothing waits', () => {
    expect(unreadEntries(base())).toEqual([]);
    const list = unreadEntries(busy());
    expect(list.map((e) => [e.name, e.signal.level])).toEqual([
      ['new-hero', 'needs'],
      ['How do deploys work?', 'unread'],
      ['webhooks', 'unread'],
    ]);
    // Chats have no project; worktrees carry theirs (for its icon).
    expect(list.map((e) => (e.kind === 'workspace' ? e.project?.name : undefined))).toEqual(['site', undefined, 'api']);
  });

  it('includes friends and groups with unread messages on the klaud network', () => {
    const s = busy();
    const net = { ...s, network: { ...s.network, enabled: true, friends: [{ peerId: 'b'.repeat(32), name: 'bob', online: true, presence: { state: 'online' as const }, addedAt: 0, unread: 2, last: { id: 'm', from: 'b', name: 'bob', text: 'yo', ts: 99, mine: false } }], groups: [] } } as unknown as AppState;
    expect(unreadEntries(net).map((e) => e.channel)).toContain(`dm:${'b'.repeat(32)}`);
  });

  it('counts one per conversation on the Dock, with other notices and waiting things once each', () => {
    let s = busy();
    expect(dockCount(s)).toBe(3);
    const notice = (id: number, over: Partial<Notice>): Action => ({ type: 'notice_add', notice: { kind: 'done', title: 't', body: '', ...over } as Notice, ts: id }) as Action;
    // A notice about a listed conversation (its run, its question) doesn't add another.
    s = apply(s, notice(1, { channel: 'ws:hooks' }), notice(2, { kind: 'needsYou', tag: 'question', ref: 'q1', channel: 'ws:hero' }));
    expect(dockCount(s)).toBe(3);
    // One elsewhere (the room) does, and so does an approval that holds up nothing listed.
    s = apply(s, notice(3, { channel: 'room' }), { type: 'approval_add', approval: { id: 'a1', kind: 'request', title: 'bob wants…', detail: '' } });
    expect(dockCount(s)).toBe(5);
    // An approval in a listed conversation (and its notice) is that conversation.
    s = apply(s, { type: 'approval_add', approval: { id: 'a2', kind: 'tool', title: 'Bash', detail: '', channel: 'ws:hooks' } }, notice(4, { kind: 'needsYou', tag: 'approval', ref: 'a2' }));
    expect(dockCount(s)).toBe(5);
  });
});

describe('a folded project or group says Claude is working inside it', () => {
  it('for klaud’s own runs, Claude Code sessions in any worktree (also ones made outside klaud) and the main folder', () => {
    expect(projectWorking(base(), api)).toBe(false);
    expect(projectWorking(apply(base(), run('started')), api)).toBe(true);
    // Claude Code running in a worktree, even while another conversation there has news.
    const cc = apply(base(), view('auth'), run('started'), overview, run('done'), { type: 'claude_code', sessions: [session({})] });
    expect(projectTally(cc, api).unread).toBe(1);
    expect(projectWorking(cc, api)).toBe(true);
    expect(projectWorking(apply(base(), { type: 'claude_code', sessions: [session({ workspaceId: 'main' })] }), api)).toBe(true);
    // Not an archived one.
    expect(projectWorking(apply(base(), { type: 'claude_code', sessions: [session({ workspaceId: 'old' })] }), api)).toBe(false);
    expect(groupWorking(cc, [site, api])).toBe(true);
    expect(groupWorking(cc, [site])).toBe(false);
  });
});
