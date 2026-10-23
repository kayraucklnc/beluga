import { describe, expect, it } from 'vitest';
import { newShares, type AppState } from '../src/core/store.js';
import { initialAppState as initialState, reduceApp as reduce } from '../src/client/screen.js';
import { globalShellDir, globalShellId, isGlobalShell } from '../src/core/workbench.js';
import type { PeerInfo } from '../src/protocol.js';
import { lineWidth } from '../src/ui/text.js';
import { globalTerminalBarModel } from '../src/ui/work-models.js';
import { overviewNews, stepTab, tabKey, tabsModel, topTabs } from '../src/ui/workspace-models.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const text = (lines: readonly (readonly { text: string }[])[]) => lines.map((l) => l.map((s) => s.text).join(''));
const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w1', projectRoot: '/p', name: 'a-rather-long-workspace-name', path: '/wt/x', kind: 'worktree', branch: 'klaud/x', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over,
});
const project: Project = { id: 'p1', name: 'app', root: '/p', base: 'origin/main', workspaces: [ws({}), ws({ id: 'w2', name: 'other' })] };
const base = (): AppState => reduce(initialState('room'), { type: 'projects', projects: [project] });
const peer = (id: string, shares: string[] = []): PeerInfo => ({ peerId: id, name: id, shares: shares.map((name) => ({ name })), agent: true }) as PeerInfo;

describe('top tabs', () => {
  it('stay on one line at any width, shortening labels and then the breadcrumb', () => {
    const s = reduce(reduce(base(), { type: 'peers', peers: [peer('me'), peer('bob')] }), { type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    for (const width of [114, 72, 60, 40]) {
      const m = tabsModel(s, width);
      expect(m.lines).toHaveLength(1);
      expect(lineWidth(m.lines[0]!)).toBeLessThanOrEqual(width);
      // every zone is on screen and they don't overlap
      for (const [i, z] of m.zones.entries()) {
        expect(z.x1).toBeLessThan(width);
        if (i) expect(z.x0).toBeGreaterThan(m.zones[i - 1]!.x1);
      }
    }
    expect(text(tabsModel(s, 114).lines)[0]).toContain('Group chat');
    expect(text(tabsModel(s, 114).lines)[0]).toContain('› a-rather-long-workspace-name');
    const narrow = text(tabsModel(s, 72).lines)[0]!;
    expect(narrow).toContain(' Chat ');
    expect(narrow).toContain(' Files ');
    expect(narrow).toMatch(/› a-rather[-a-z]*…$/);
    expect(narrow).toContain(' Terminal ');
  });

  it("zones line up with each tab's label", () => {
    const m = tabsModel(base(), 100);
    const line = text(m.lines)[0]!;
    for (const [i, z] of m.zones.entries()) expect(line.slice(z.x0, z.x1 + 1).trim()).toBe(topTabs(base())[i]!.label);
  });

  it('marks the active tab and tells its quick key only in the hint', () => {
    const s = reduce(base(), { type: 'view', view: { kind: 'terminal' } });
    const m = tabsModel(s, 100);
    expect(m.lines[0]!.find((seg) => seg.text.includes('Terminal'))?.inverse).toBe(true);
    expect(text(m.lines)[0]).not.toContain('⌥');
    expect(m.zones[5]?.hint).toContain(tabKey(6));
    expect(tabKey(3, 'darwin')).toBe('⌥3');
    expect(tabKey(3, 'linux')).toBe('Alt+3');
  });

  it('Ctrl+Tab steps around, and from a workspace starts at either end', () => {
    expect(stepTab(base(), 1)).toBe('files');
    expect(stepTab(base(), -1)).toBe('terminal');
    const inWs = reduce(base(), { type: 'view', view: { kind: 'workspace', id: 'w1', tab: 'chat' } });
    expect(stepTab(inWs, 1)).toBe('room');
    expect(stepTab(inWs, -1)).toBe('terminal');
  });
});

describe('what is new on each tab', () => {
  it('Chat keeps its unread count while you look at another tab', () => {
    let s = reduce(base(), { type: 'view', view: { kind: 'overview' } });
    s = reduce(s, { type: 'chat', id: '1', from: 'bob', text: 'hi', ts: 1, byAgent: false });
    s = reduce(s, { type: 'view', view: { kind: 'search' } });
    expect(s.unread.room).toBe(1);
    expect(text(tabsModel(s, 100).lines)[0]).toContain(' Chat 1 ');
    expect(reduce(s, { type: 'view', view: { kind: 'room' } }).unread.room).toBeUndefined();
  });

  it('Overview counts workspaces where Claude wrote, and flags the ones that need you', () => {
    let s = reduce(base(), { type: 'agent_event', owner: 'me', requestId: 'r', requester: 'me', event: 'done', text: 'done!', ts: 1, channel: 'ws:w1' });
    expect(overviewNews(s)).toEqual({ count: 1, urgent: false });
    s = reduce(s, { type: 'conflicts', id: 'w2', files: ['a.ts'] });
    expect(overviewNews(s)).toEqual({ count: 2, urgent: true });
    expect(topTabs(s)[2]).toMatchObject({ badge: 2, urgent: true });
    expect(topTabs(reduce(s, { type: 'view', view: { kind: 'overview' } }))[2]?.badge).toBe(0);
  });

  it('Shared files counts folders shared since you last looked', () => {
    let s = reduce(base(), { type: 'welcome', self: peer('me') });
    s = reduce(s, { type: 'peers', peers: [peer('me', ['mine']), peer('bob', ['api'])] });
    expect(newShares(s)).toBe(1); // your own folders never count
    s = reduce(s, { type: 'view', view: { kind: 'files' } });
    expect(newShares(s)).toBe(0);
    s = reduce(s, { type: 'view', view: { kind: 'room' } });
    expect(newShares(s)).toBe(0);
    s = reduce(s, { type: 'peers', peers: [peer('me'), peer('bob', ['api', 'docs'])] });
    expect(newShares(s)).toBe(1);
    expect(text(tabsModel(s, 100).lines)[0]).toContain('Shared files 1');
  });
});

describe('global Terminal tab', () => {
  it("starts in the project you're working in, else the one klaud started in, else home", () => {
    const projects = [project, { ...project, id: 'p2', root: '/q', workspaces: [ws({ id: 'q1' })] }, { ...project, id: 'chats', root: '', workspaces: [ws({ id: 'c1' })] }];
    expect(globalShellDir(projects, ['w1', 'q1'], '/home/me', '/home/me')).toBe('/q');
    expect(globalShellDir(projects, ['q1', 'c1'], '/home/me', '/home/me')).toBe('/q');
    expect(globalShellDir(projects, [], '/p/src', '/home/me')).toBe('/p');
    expect(globalShellDir(projects, [], '/pother', '/home/me')).toBe('/home/me');
  });

  it('names its shells apart from workspace terminals', () => {
    expect(globalShellId(2)).toBe('shell:2');
    expect(isGlobalShell('shell:2')).toBe(true);
    expect(isGlobalShell('w1:run')).toBe(false);
  });

  it('shows its shells, a + for another one, the folder and how to leave', () => {
    const tabs = [{ key: 'shell:1', label: 'Shell 1', running: true }, { key: 'shell:2', label: 'Shell 2', running: false, exitCode: 0 }];
    const m = globalTerminalBarModel(tabs, 'shell:1', 110, { focused: true, dir: '~/app' });
    const line = text(m.lines)[0]!;
    expect(line).toContain('● Shell 1');
    expect(line).toContain('✓ Shell 2');
    expect(line).toContain('~/app');
    expect(line).toContain('Ctrl+]');
    expect(m.zones.map((z) => z.action)).toEqual([{ type: 'term_tab', key: 'shell:1' }, { type: 'term_tab', key: 'shell:2' }, { type: 'term_new' }]);
    const narrow = text(globalTerminalBarModel(tabs, 'shell:1', 80, { focused: false, dir: '~/a/very/deep/folder/somewhere' }).lines)[0]!;
    expect(narrow).not.toContain('somewhere');
    expect(narrow).toContain('click the terminal');
  });
});
