import { describe, expect, it } from 'vitest';
import { SubAgentTracker } from '../src/agent/subagents.js';
import { initialState, reduce, channelOf, type AppState } from '../src/core/store.js';
import { derive } from '../src/ui/derive.js';
import { initialUi } from '../src/ui/keymap.js';
import { activityOf, contextMeter, isCompacting, overviewModel, projectsModel, reviewModel, stateOf, tabsModel, workspaceHeaderModel } from '../src/ui/workspace-models.js';
import { confirmMenu } from '../src/ui/menus.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const text = (lines: readonly (readonly { text: string }[])[]) => lines.map((l) => l.map((s) => s.text).join(''));
const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w1', projectRoot: '/p', name: 'fix-auth', path: '/wt/fix-auth', kind: 'worktree', branch: 'klaude/fix-auth', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 2, ahead: 3, behind: 0 }, ...over,
});
const project: Project = {
  id: 'p1', name: 'app', root: '/p', base: 'origin/main',
  workspaces: [
    ws({ id: 'main', name: 'main', kind: 'main', branch: 'main', status: { changed: 0, ahead: 0, behind: 0 } }),
    ws({}),
    ws({ id: 'c1', name: 'question', kind: 'chat', status: undefined }),
    ws({ id: 'old', name: 'old', archived: true }),
  ],
};
const base = (): AppState => reduce(initialState('room'), { type: 'projects', projects: [project] });

describe('sub-agent tracking', () => {
  it('follows Task tool calls through the stream', () => {
    const t = new SubAgentTracker('/repo');
    const launch = { type: 'tool_use', id: 't1', name: 'Task', input: { subagent_type: 'Explore', description: 'find auth' } };
    expect(t.isLaunch(launch)).toBe(true);
    expect(t.assistant(null, [launch, { type: 'text' }])).toEqual([{ id: 't1', phase: 'start', title: 'Explore · find auth' }]);
    expect(t.assistant('t1', [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/a.ts' } }])).toEqual([{ id: 't1', phase: 'step', step: 'Read src/a.ts' }]);
    expect(t.assistant('other', [{ type: 'tool_use', name: 'Read', input: {} }])).toEqual([]);
    expect(t.user([{ type: 'tool_result', tool_use_id: 't1' }])).toEqual([{ id: 't1', phase: 'done' }]);
    expect(t.user([{ type: 'tool_result', tool_use_id: 't1' }])).toEqual([]);
    expect(t.user('plain text')).toEqual([]);
    expect(t.assistant(null, [{ type: 'tool_use', id: 't2', name: 'Agent', input: {} }])[0]?.title).toBe('sub-agent');
  });

  it('follows background tasks (terminals and agents)', () => {
    const t = new SubAgentTracker();
    expect(t.task({ subtype: 'task_started', task_id: 'b1', description: 'npm run dev' })).toEqual([{ id: 'b1', phase: 'start', title: 'npm run dev', kind: 'background' }]);
    expect(t.task({ subtype: 'task_progress', task_id: 'b1', description: 'listening on 3000' })).toEqual([{ id: 'b1', phase: 'step', step: 'listening on 3000' }]);
    expect(t.task({ subtype: 'task_updated', task_id: 'b1', patch: { status: 'running' } })).toEqual([]);
    expect(t.task({ subtype: 'task_notification', task_id: 'b1', status: 'failed', summary: 'exit 1' })).toEqual([{ id: 'b1', phase: 'done', failed: true, step: 'exit 1' }]);
    expect(t.task({ subtype: 'task_progress', task_id: 'b1', description: 'late' })).toEqual([]); // finished
    expect(t.task({ subtype: 'task_started' })).toEqual([]);
    t.assistant(null, [{ type: 'tool_use', id: 'sub1', name: 'Task', input: {} }]);
    expect(t.task({ subtype: 'task_started', task_id: 'x', tool_use_id: 'sub1' })).toEqual([]); // already shown as a sub-agent
    t.task({ subtype: 'task_started', task_id: 'b2', description: 'watch' });
    expect(t.task({ subtype: 'task_updated', task_id: 'b2', patch: { status: 'completed' } })).toEqual([{ id: 'b2', phase: 'done', failed: false }]);
  });
});

describe('store: channels, views and sub-agents', () => {
  it('keeps workspace conversations separate and counts unread ones', () => {
    let s = base();
    s = reduce(s, { type: 'chat', id: '1', from: 'me', text: 'hi room', ts: 1, byAgent: false });
    s = reduce(s, { type: 'chat', id: '2', from: 'me', text: 'hi claude', ts: 2, byAgent: false, channel: 'ws:w1' });
    expect(s.log.map((l) => l.channel)).toEqual(['room', 'ws:w1']);
    expect(s.unread).toEqual({ 'ws:w1': 1 });
    s = reduce(s, { type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    expect(s.unread).toEqual({});
    expect(s.tabs).toEqual(['w1']);
    expect(channelOf(s.view)).toBe('ws:w1');
    s = reduce(s, { type: 'close_tab', id: 'w1' });
    expect(s).toMatchObject({ tabs: [], view: { kind: 'overview' } });
    s = reduce(s, { type: 'history', channel: 'ws:w1', items: [{ id: 'h', type: 'system', channel: 'x', text: 'old', ts: 0, level: 'info' }] });
    expect(s.log.filter((l) => l.channel === 'ws:w1').map((l) => l.id)).toEqual(['h']);
    expect(reduce(s, { type: 'review', review: { workspaceId: 'w1', selected: 0, diffScroll: 0, loading: true } }).review?.loading).toBe(true);
    // tabs for workspaces that disappear are dropped
    const withTab = reduce(s, { type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    expect(reduce(withTab, { type: 'projects', projects: [] }).tabs).toEqual([]);
  });

  it('tracks sub-agents inside a Claude run', () => {
    let s = base();
    const ev = (event: 'started' | 'sub' | 'done', t = '') => ({ type: 'agent_event' as const, owner: 'me', requestId: 'r', requester: 'me', event, text: t, ts: 1, channel: 'ws:w1' });
    s = reduce(s, ev('started'));
    s = reduce(s, ev('sub', JSON.stringify({ id: 'a', phase: 'start', title: 'Explore' })));
    s = reduce(s, ev('sub', JSON.stringify({ id: 'a', phase: 'step', step: 'Grep x' })));
    s = reduce(s, ev('sub', 'not json'));
    s = reduce(s, ev('sub', JSON.stringify({ phase: 'start' })));
    const item = s.log[0];
    expect(item?.type === 'agent' && item.subagents).toEqual([{ id: 'a', title: 'Explore', steps: ['Grep x'], status: 'running', kind: 'agent' }]);
    expect(activityOf(s.log, 'ws:w1')).toMatchObject({ running: true, subagents: 1 });
    s = reduce(s, ev('done', 'all good'));
    const done = s.log[0];
    expect(done?.type === 'agent' && done.subagents[0]?.status).toBe('done');
    expect(activityOf(s.log, 'ws:w1')).toMatchObject({ running: false, last: 'all good' });
  });
});

describe('workspace UI models', () => {
  const chatsProject: Project = { id: 'chats', name: 'Chats', root: '', base: '', workspaces: [ws({ id: 'free', name: 'ideas', kind: 'chat', projectId: 'chats', projectRoot: '', status: undefined })] };
  const withChats = (s: AppState): AppState => reduce(s, { type: 'projects', projects: [chatsProject, project], groups: [] });

  it('draws CHATS and PROJECTS sections; projects start folded; buttons sit on the project row', () => {
    const s = withChats(base());
    const folded = projectsModel(s, new Set(), 0, 34);
    const lines = text(folded.lines);
    expect(lines[0]).toMatch(/^CHATS +\+ new$/);
    expect(lines.some((l) => l.includes('◇ ideas'))).toBe(true);
    expect(lines.some((l) => /^PROJECTS +\+ add$/.test(l))).toBe(true);
    const projectRow = lines.find((l) => l.includes('▣ app'))!;
    expect(projectRow).toMatch(/^▸ ▣ app/); // folded by default
    expect(projectRow).toContain('+⌥ +◇ ⋯');
    expect(lines.some((l) => l.includes('fix-auth'))).toBe(false);
    const actions = folded.zones.map((z) => z.action.type);
    expect(actions).toEqual(expect.arrayContaining(['new_chat', 'open_ws', 'add_project', 'new_worktree', 'project_menu', 'toggle_project']));
    expect(folded.zones.find((z) => z.action.type === 'new_worktree')?.hint).toContain('New worktree in app');

    const open = projectsModel(s, new Set(['p1']), 0, 34);
    const openLines = text(open.lines);
    expect(openLines.some((l) => l.includes('⌂ main'))).toBe(true);
    expect(openLines.some((l) => l.includes('⌥ fix-auth'))).toBe(true);
    expect(openLines.some((l) => l.includes('◇ question'))).toBe(true);
    expect(openLines.some((l) => l.includes('▸ Archived (1)'))).toBe(true);
    expect(openLines.some((l) => /\bold\b/.test(l))).toBe(false); // archived list folded
    const archiveOpen = text(projectsModel(s, new Set(['p1', 'archive:p1']), 0, 34).lines);
    expect(archiveOpen.some((l) => l.includes('○ old'))).toBe(true);

    // the project you're in opens itself
    const inside = reduce(s, { type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    expect(text(projectsModel(inside, new Set(), 0, 34).lines).some((l) => l.startsWith('▌') && l.includes('fix-auth'))).toBe(true);
  });

  it('shows your groups as collapsible sections', () => {
    const s = reduce(withChats(base()), { type: 'projects', projects: [chatsProject, project], groups: [{ name: 'work', projects: ['/p'] }] });
    const lines = text(projectsModel(s, new Set(), 0, 34).lines);
    expect(lines.some((l) => l.startsWith('▾ WORK 1'))).toBe(true);
    expect(text(projectsModel(s, new Set(['group:work']), 0, 34).lines).some((l) => l.includes('▣ app'))).toBe(false);
  });

  it('draws three clear tabs plus where you are', () => {
    const s = reduce(base(), { type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    const m = tabsModel(s, 100);
    expect(text(m.lines)[0]).toContain('Group chat');
    expect(text(m.lines)[0]).toContain('Overview');
    expect(text(m.lines)[0]).toContain('›  fix-auth');
    expect(m.zones.map((z) => z.action.type)).toEqual(['view', 'view', 'view']);
    expect(m.zones[0]?.hint).toContain('everyone');
  });

  it('draws a simple Overview card per workspace', () => {
    let s = base();
    s = reduce(s, { type: 'agent_event', owner: 'me', requestId: 'r', requester: 'me', event: 'started', text: '', ts: 1000, channel: 'ws:w1' });
    const m = overviewModel(s, 0, 100, 6000);
    const lines = text(m.lines);
    expect(lines[0]).toContain('2 active');
    expect(lines[0]).toContain('1 working');
    expect(lines.some((l) => l.includes('⌥ fix-auth  app'))).toBe(true);
    expect(lines.some((l) => l.includes('Claude working 5s'))).toBe(true);
    expect(lines.some((l) => l.includes(' Open '))).toBe(true);
    expect(m.zones.some((z) => z.action.type === 'open_ws')).toBe(true);
    expect(text(overviewModel(initialState('r'), 0, 100).lines).join('\n')).toContain('Nothing in progress');
  });

  it('describes each workspace state in plain words', () => {
    const s = base();
    expect(stateOf(s, project.workspaces[1]!, 0).label).toBe('2 uncommitted changes');
    expect(stateOf(s, ws({ status: { changed: 0, ahead: 2, behind: 0 } }), 0).label).toBe('Ready to merge · 2 commits');
    expect(stateOf(s, project.workspaces[0]!, 0).label).toBe('Main folder');
    expect(stateOf(reduce(s, { type: 'conflicts', id: 'w1', files: ['a.ts'] }), project.workspaces[1]!, 0).label).toBe('Merge conflict');
    expect(stateOf(s, project.workspaces[3]!, 0).label).toBe('Archived');
    expect(stateOf(s, project.workspaces[2]!, 0).label).toBe('New chat');
  });

  it('header: tabs, actions with descriptions, disabled buttons, and the conflict banner', () => {
    const s = reduce(base(), { type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'review' } });
    const m = workspaceHeaderModel(s, project.workspaces[1]!, 140);
    const [title, bar] = text(m.lines);
    expect(title).toContain('app › fix-auth');
    expect(title).toContain('⌥ klaude/fix-auth');
    expect(title).toContain('2 uncommitted changes');
    expect(bar).toContain(' Diff ');
    expect(bar).toContain(' Review ');
    const byLabel = Object.fromEntries(m.zones.filter((z) => z.action.type === 'ws').map((z) => [(z.action as { action: string }).action, z]));
    expect(byLabel.commit?.disabled).toBeFalsy();
    expect(byLabel.merge).toMatchObject({ disabled: true, hint: 'Commit your changes first' });
    expect(byLabel.review_claude?.hint).toContain('security');
    const clean = workspaceHeaderModel(s, ws({ status: { changed: 0, ahead: 0, behind: 0 } }), 140);
    const cleanBy = Object.fromEntries(clean.zones.filter((z) => z.action.type === 'ws').map((z) => [(z.action as { action: string }).action, z]));
    expect(cleanBy.commit).toMatchObject({ disabled: true, hint: 'Nothing to commit' });
    expect(cleanBy.merge).toMatchObject({ disabled: true, hint: 'Nothing to merge yet' });
    const conflict = workspaceHeaderModel(reduce(s, { type: 'conflicts', id: 'w1', files: ['a.ts'] }), project.workspaces[1]!, 140);
    expect(text(conflict.lines)[2]).toContain('Merge conflict in a.ts');
    expect(conflict.zones.some((z) => z.action.type === 'ws' && z.action.action === 'merge_claude')).toBe(true);
    expect(workspaceHeaderModel(s, project.workspaces[3]!, 140).zones.map((z) => (z.action.type === 'ws' ? z.action.action : ''))).toContain('restore');
    expect(workspaceHeaderModel(s, project.workspaces[0]!, 140).zones.map((z) => (z.action.type === 'ws' ? z.action.action : ''))).not.toContain('archive');
  });

  it('draws the review screen: commits, files and a colored diff', () => {
    const review = {
      workspaceId: 'w1', selected: 0, diffScroll: 0, loading: false,
      data: { base: 'abc', commits: [{ hash: 'abc1234', subject: 'Add auth' }], files: [{ path: 'src/auth.ts', added: 3, removed: 0, state: 'added' as const }, { path: 'new.md', added: 0, removed: 0, state: 'untracked' as const }] },
      diff: 'diff --git a b\n@@ -0,0 +1 @@\n+export const x = 1;\n-old',
    };
    const m = reviewModel(review, 100, 10);
    const lines = text(m.lines);
    expect(lines[0]).toContain('1 commit · 2 files');
    expect(lines[0]).toContain('@@ -0,0 +1 @@');
    expect(lines.some((l) => l.includes('▸ + src/auth.ts') && l.includes('+3 −0'))).toBe(true);
    expect(m.zones.map((z) => z.action)).toEqual([{ type: 'review_file', index: 0 }, { type: 'review_file', index: 1 }]);
    expect(text(reviewModel(undefined, 100, 10).lines)[0]).toContain('Loading');
    expect(text(reviewModel({ ...review, error: 'boom' }, 100, 10).lines)[0]).toBe('boom');
    expect(text(reviewModel({ ...review, data: { base: 'a', commits: [], files: [] } }, 100, 10).lines)[0]).toContain('No changes');
  });
});

const addZone = (s: AppState) => derive({ state: s, ui: initialUi, selfId: 'me', columns: 120, rows: 40, frame: 0 }).zones.find((z) => z.action.type === 'add_project')!;
const addProjectX = (s: AppState) => addZone(s).x0 + 1;
const addProjectY = (s: AppState) => addZone(s).y;

describe('derive', () => {
  it('lays out the screen and turns model zones into screen coordinates', () => {
    const s = reduce(base(), { type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    const d = derive({ state: s, ui: initialUi, selfId: 'me', columns: 120, rows: 40, frame: 0 });
    expect(d.channel).toBe('ws:w1');
    expect(d.workspace?.name).toBe('fix-auth');
    expect(d.geometry.headerHeight).toBe(3);
    expect(d.header).toBeDefined();
    expect(d.projectItems).toEqual(expect.arrayContaining([{ type: 'toggle_project', id: 'p1' }]));
    expect(d.headerItems.length).toBeGreaterThan(3);
    const hovered = derive({ state: s, ui: initialUi, selfId: 'me', columns: 120, rows: 40, frame: 0, hover: { x: addProjectX(s), y: addProjectY(s) } });
    expect(hovered.hint).toBe('Add a project, or a folder of projects');
    const addProject = d.zones.find((z) => z.action.type === 'add_project')!;
    expect(addProject.x0).toBeGreaterThan(2); // the "+ add" button on the PROJECTS header
    expect(d.zones.some((z) => z.action.type === 'ws' && z.y === d.geometry.headerTop + 1)).toBe(true);
    const review = derive({ state: reduce(s, { type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'review' } }), ui: { ...initialUi, focus: 'main' }, selfId: 'me', columns: 120, rows: 40, frame: 0 });
    expect(review.focus).toBe('main');
    expect(review.review).toBeDefined();
    const overview = derive({ state: reduce(s, { type: 'view', view: { kind: 'overview' } }), ui: initialUi, selfId: 'me', columns: 120, rows: 40, frame: 0 });
    expect(overview.overview).toBeDefined();
    expect(overview.zones.some((z) => z.action.type === 'open_ws')).toBe(true);
  });
});

describe('context meter and compaction', () => {
  const ev = (event: 'context' | 'compact', data: object, ts = 1000) =>
    ({ type: 'agent_event' as const, owner: 'me', requestId: 'r', requester: 'me', event, text: JSON.stringify(data), ts, channel: 'ws:w1' });

  it('tracks context usage and animates compaction', () => {
    let s = base();
    s = reduce(s, ev('context', { used: 150_000, window: 200_000 }));
    expect(s.context['ws:w1']).toEqual({ used: 150_000, window: 200_000 });
    expect(s.log).toHaveLength(0); // no chat noise
    expect(contextMeter(s, 'ws:w1', 10).map((x) => x.text).join('')).toBe('context ▰▰▰▰▰▰▰▰▱▱ 75% · 150k/200k');
    s = reduce(s, ev('compact', { pre: 168_000, post: 21_000 }, 10_000));
    expect(s.context['ws:w1']?.used).toBe(21_000);
    expect(s.log.at(-1)).toMatchObject({ type: 'system', text: 'Context compacted: 168k → 21k tokens (88% freed)' });
    const mid = contextMeter(s, 'ws:w1', 10, 10_400).map((x) => x.text).join('');
    expect(mid).toContain('compacting…');
    const after = contextMeter(s, 'ws:w1', 10, 12_000).map((x) => x.text).join('');
    expect(after).toContain('11% · 21k/200k');
    expect(after).toContain('compacted 168k→21k');
    expect(isCompacting(s, 12_000)).toBe(true);
    expect(isCompacting(s, 99_000)).toBe(false);
    expect(contextMeter(s, 'ws:other', 10)).toEqual([]);
    expect(reduce(s, ev('context', {}))).toBe(s);
    expect(reduce(s, { ...ev('context', {}), text: 'not json' })).toBe(s);
  });

  it('shows the meter and a Compact button in the workspace header', () => {
    let s = reduce(base(), { type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    s = reduce(s, ev('context', { used: 190_000, window: 200_000 }));
    const m = workspaceHeaderModel(s, project.workspaces[1]!, 140);
    expect(text(m.lines)[0]).toContain('95% · 190k/200k');
    expect(m.zones.some((z) => z.action.type === 'ws' && z.action.action === 'compact')).toBe(true);
  });
});

describe('store: per-conversation history', () => {
  it('/clear only clears the conversation you are in and caps history per conversation', () => {
    let s = base();
    s = reduce(s, { type: 'chat', id: '1', from: 'me', text: 'room', ts: 1, byAgent: false });
    s = reduce(s, { type: 'chat', id: '2', from: 'me', text: 'ws', ts: 1, byAgent: false, channel: 'ws:w1' });
    expect(reduce(s, { type: 'clear' }).log.map((l) => l.channel)).toEqual(['ws:w1']);
    expect(reduce(s, { type: 'clear', channel: 'ws:w1' }).log.map((l) => l.channel)).toEqual(['room']);
    for (let i = 0; i < 1005; i++) s = reduce(s, { type: 'system', text: `n${i}` });
    expect(s.log.filter((l) => l.channel === 'room')).toHaveLength(1000);
    expect(s.log.some((l) => l.channel === 'ws:w1')).toBe(true); // never trimmed by another conversation
  });
});

describe('confirm dialogs', () => {
  it('lists env key changes (names only) and offers to copy them back', () => {
    const s = reduce(base(), { type: 'env_changes', id: 'w1', changes: [{ file: '.env', added: ['NEW'], changed: ['API'], removed: ['OLD'], binary: false }, { file: '.aws/config', added: [], changed: [], removed: [], binary: true }] });
    const archive = confirmMenu(s, 'archive', 'w1')!;
    expect(archive.intro.join('\n')).toContain('.env  +NEW  ~API  −OLD');
    expect(archive.intro.join('\n')).toContain('.aws/config  (file differs)');
    expect(archive.options.map((o) => o.id)).toEqual(['confirm-archive-env', 'confirm-commit-archive', 'confirm-archive-force', 'close']);
    expect(confirmMenu(s, 'delete', 'w1')!.options.map((o) => o.id)).toEqual(['confirm-delete-env', 'confirm-delete', 'close']);
    expect(confirmMenu(base(), 'archive', 'main')!.options.map((o) => o.id)).toEqual(['confirm-archive', 'close']);
    expect(confirmMenu(base(), 'archive', 'nope')).toBeUndefined();
  });
});
