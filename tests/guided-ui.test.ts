import { describe, expect, it } from 'vitest';
import { initialState, reduce, type AppState } from '../src/core/store.js';
import type { PeerInfo } from '../src/protocol.js';
import { actionButtons, buttonLabel } from '../src/ui/actions.js';
import { APPROVAL_BUTTONS, hitTest, type HitContext } from '../src/ui/hit.js';
import { computeLayout, fileWindow, placeButtons } from '../src/ui/layout.js';
import { menuSpec, personMenu, welcomeMenu } from '../src/ui/menus.js';
import { parseMouse } from '../src/ui/mouse.js';
import { viewerLegend } from '../src/ui/components/Viewer.js';

const peers: PeerInfo[] = [
  { peerId: 'me', name: 'kay', agent: true, shares: [{ name: 'app', writable: true }] },
  { peerId: 'b', name: 'bob', agent: true, shares: [{ name: 'api', writable: false }] },
  { peerId: 'c', name: 'cat', agent: false, shares: [] },
];
const room = (): AppState => reduce(reduce(initialState("kay's room"), { type: 'peers', peers }), { type: 'welcome', self: peers[0]! });

describe('mouse parsing', () => {
  it('extracts SGR clicks and wheel events and keeps keyboard input', () => {
    const { events, rest } = parseMouse('a\x1b[<0;10;5Mb\x1b[<0;10;5m\x1b[<64;3;4M\x1b[<65;3;4M\x1b[<2;1;1M');
    expect(rest).toBe('ab');
    expect(events).toEqual([
      { x: 9, y: 4, button: 'left', kind: 'press' },
      { x: 9, y: 4, button: 'left', kind: 'release' },
      { x: 2, y: 3, button: 'wheelUp', kind: 'press' },
      { x: 2, y: 3, button: 'wheelDown', kind: 'press' },
      { x: 0, y: 0, button: 'right', kind: 'press' },
    ]);
    expect(parseMouse('\x1b[<3;1;1M').events).toEqual([]); // "no button" motion reports are ignored
  });
});

describe('menus', () => {
  it('welcomes you and asks who can use your Claude', () => {
    const spec = welcomeMenu(room());
    expect(spec.title).toBe("Welcome to kay's room");
    expect(spec.intro[0]).toBe("You're kay. bob, cat are here.");
    expect(spec.options.map((o) => o.id)).toEqual(['share-ask', 'share-auto', 'share-deny']);
    const alone = reduce(room(), { type: 'peers', peers: [peers[0]!] });
    expect(welcomeMenu(alone).intro[0]).toContain('Nobody else is here yet');
  });

  it('offers actions for a friend', () => {
    const spec = personMenu(room(), 1)!;
    expect(spec.options.map((o) => o.id)).toEqual(['ask', 'person-invite-ws', 'person-share', 'access-full', 'follow', 'browse', 'fulltrust', 'trust']);
    const followed = reduce(reduce(room(), { type: 'follow', peerId: 'b' }), { type: 'trust', peerId: 'b', trusted: true });
    expect(personMenu(followed, 1)!.options.map((o) => o.id)).toEqual(['ask', 'person-invite-ws', 'person-share', 'access-full', 'unfollow', 'browse', 'fulltrust', 'untrust']);
    expect(personMenu(reduce(room(), { type: 'full_trust', peerId: 'b', trusted: true }), 1)!.options.map((o) => o.id)).toContain('unfulltrust');
    expect(personMenu(room(), 2)!.options.map((o) => o.id)).toEqual(['person-invite-ws', 'person-share', 'access-full', 'follow', 'fulltrust', 'trust']); // no Claude, no shares
    expect(personMenu(room(), 9)).toBeUndefined();
  });

  it('offers your own actions', () => {
    expect(personMenu(room(), 0)!.options.map((o) => o.id)).toEqual(['ask-self', 'share-folder', 'leave-room', 'sharing', 'settings']);
    const withInvite = reduce(room(), { type: 'invite', invite: 'https://x#y' });
    expect(menuSpec(withInvite, { kind: 'person', index: 0 })!.options.map((o) => o.id)).toEqual(['ask-self', 'share-folder', 'invite', 'leave-room', 'sharing', 'settings']);
    expect(menuSpec(room(), { kind: 'settings' })!.options.map((o) => o.id)).toEqual(['set-name', 'set-theme', 'set-policy', 'set-self-approval', 'set-mouse', 'set-tunnel', 'size-in', 'size-out', 'size-reset', 'close']);
    expect(menuSpec(room(), { kind: 'welcome' })?.title).toContain('Welcome');
  });
});

describe('action bar', () => {
  it('shows what you can do in each panel', () => {
    const s = room();
    expect(actionButtons('chat', s, false).map((b) => b.id)).toEqual(['ask', 'commands', 'projects', 'invite', 'share-folder', 'clear', 'settings', 'help']);
    expect(actionButtons('chat', s, false).find((b) => b.id === 'invite')?.text).toBe('Invite friends');
    expect(actionButtons('chat', reduce(s, { type: 'view', view: { kind: 'workspace', id: 'w', tab: 'chat' } }), false).map((b) => b.id)).toEqual(['actions', 'review', 'overview', 'clear', 'settings', 'help']);
    expect(actionButtons('projects', s, false).map((b) => b.id)).toEqual(['open-project-item', 'overview', 'chat']);
    expect(actionButtons('main', s, false).map((b) => b.id)).toContain('review-claude');
    expect(actionButtons('main', reduce(s, { type: 'view', view: { kind: 'overview' } }), false).map((b) => b.id)).toEqual(['scroll', 'chat']);
    expect(actionButtons('chat', reduce(s, { type: 'invite', invite: 'x' }), false).find((b) => b.id === 'invite')?.text).toBe('Copy invite');
    expect(actionButtons('chat', s, true).map((b) => b.id)).toEqual(['accept', 'hide']);
    expect(actionButtons('people', s, false).map((b) => b.id)).toEqual(['menu', 'chat']);
    expect(actionButtons('viewer', s, false).map((b) => b.text)).toEqual(['Scroll', 'Back to chat']);
    expect(actionButtons('viewer', s, false, { full: true, raw: false }).map((b) => b.text)).toEqual(['Scroll', 'Leave fullscreen']);
    const md = reduce(s, { type: 'viewer_open', at: { owner: 'b', share: 'api', path: 'README.md' } });
    expect(viewerLegend(md.viewer!, false, false).map((b) => b.id)).toEqual(['fullscreen', 'raw', 'download', 'close']);
    expect(viewerLegend({ ...md.viewer!, path: 'a.ts' }, true, true).map((b) => b.label)).toEqual(['Exit fullscreen f', '↓ Download d', '✕ Close ⌫']);
    expect(actionButtons('files', s, false).map((b) => b.id)).toEqual(['open', 'chat']);
    const at = { owner: 'b', share: 'api', path: '' };
    const inFolder = reduce(reduce(s, { type: 'browser_loading', at }), { type: 'browser_entries', at, entries: [{ name: 'a.md', dir: false, size: 1 }] });
    const onFile = reduce(inFolder, { type: 'browser_cursor', delta: 1 });
    expect(actionButtons('files', onFile, false).map((b) => b.id)).toEqual(['open', 'download', 'up', 'chat']);
    expect(buttonLabel({ id: 'x', text: 'Help', key: '' })).toBe('Help');
  });
});

describe('layout and hit testing', () => {
  const g = computeLayout({ columns: 120, rows: 40, peopleCount: 3, hasViewer: false, suggestionCount: 0 });
  const ctx = (s: AppState, extra: Partial<HitContext> = {}): HitContext => ({
    state: s,
    suggestionCount: 0,
    buttons: actionButtons('chat', s, false),
    approvalDetailLines: 0,
    ...extra,
  });

  it('computes consistent regions', () => {
    expect(g).toMatchObject({ sideWidth: 28, mainX: 28, mainWidth: 92, bodyTop: 1, tabsY: 1, headerHeight: 0, paneTop: 3, peopleHeight: 9, actionBarY: 39 });
    expect(g.projectsHeight + g.peopleHeight).toBe(g.bodyHeight);
    expect(g.composerTop + 3).toBe(g.actionBarY);
    const ws = computeLayout({ columns: 120, rows: 40, peopleCount: 3, hasViewer: true, suggestionCount: 2, approvalDetail: 'ls', workspaceHeader: true });
    expect(ws).toMatchObject({ headerHeight: 3, paneTop: 6, viewerWidth: 46, chatWidth: 46, approvalHeight: 5 });
    expect(ws.suggestionsTop).toBe(ws.approvalTop + 5);
    expect(computeLayout({ columns: 40, rows: 10, peopleCount: 9, hasViewer: false, suggestionCount: 6 }).bodyHeight).toBe(10);
    const full = computeLayout({ columns: 120, rows: 40, peopleCount: 3, hasViewer: true, suggestionCount: 0, viewerFull: true });
    expect(full).toMatchObject({ sideWidth: 0, chatWidth: 0, viewerWidth: 120, peopleHeight: 0 });
    expect(hitTest(full, 5, 10, ctx(room()))).toEqual({ kind: 'viewer' });
  });

  it('finds people, projects, chat, zones and buttons under the pointer', () => {
    const s = room();
    expect(hitTest(g, 3, g.peopleTop + 1, ctx(s))).toEqual({ kind: 'person', index: 0 });
    expect(hitTest(g, 3, g.peopleTop + 3, ctx(s))).toEqual({ kind: 'person', index: 1 });
    expect(hitTest(g, 3, g.peopleTop + 8, ctx(s))).toEqual({ kind: 'none' });
    expect(hitTest(g, 3, 5, ctx(s))).toEqual({ kind: 'projects' });
    expect(hitTest(g, 60, 10, ctx(s))).toEqual({ kind: 'chat' });
    expect(hitTest(g, 60, 2, ctx(s))).toEqual({ kind: 'main' });
    expect(hitTest(g, 60, g.composerTop + 1, ctx(s))).toEqual({ kind: 'composer' });
    expect(hitTest(g, 2, g.actionBarY, ctx(s))).toEqual({ kind: 'action', id: 'ask' });
    expect(hitTest(g, 100, g.actionBarY, ctx(s))).toEqual({ kind: 'none' });
    expect(hitTest(g, 60, 0, ctx(s))).toEqual({ kind: 'none' });
    const zone = { x0: 4, x1: 20, y: 5, action: { type: 'add_project' } as const };
    expect(hitTest(g, 10, 5, ctx(s, { zones: [zone] }))).toEqual({ kind: 'zone', action: { type: 'add_project' } });
    const overview = reduce(s, { type: 'view', view: { kind: 'overview' } });
    expect(hitTest(g, 60, 10, ctx(overview))).toEqual({ kind: 'main' });
    const files = reduce(s, { type: 'view', view: { kind: 'files' } });
    expect(hitTest(g, 40, g.paneTop + 1, ctx(files))).toEqual({ kind: 'file', index: 0 });
    expect(hitTest(g, 40, g.paneTop + 20, ctx(files))).toEqual({ kind: 'files' });
    const viewer = computeLayout({ columns: 120, rows: 40, peopleCount: 3, hasViewer: true, suggestionCount: 0 });
    expect(hitTest(viewer, 110, 10, ctx(s))).toEqual({ kind: 'viewer' });
    const legend = [{ id: 'fullscreen', label: '⤢ Fullscreen f' }, { id: 'download', label: '↓ Download d' }]; // labels are just widths here
    const legendY = viewer.paneTop + viewer.paneHeight - 2;
    const legendX = viewer.mainX + viewer.chatWidth + 2;
    expect(hitTest(viewer, legendX, legendY, ctx(s, { viewerLegend: legend }))).toEqual({ kind: 'viewer_action', id: 'fullscreen' });
    expect(hitTest(viewer, legendX + 17, legendY, ctx(s, { viewerLegend: legend }))).toEqual({ kind: 'viewer_action', id: 'download' });
    expect(hitTest(viewer, 118, legendY, ctx(s, { viewerLegend: legend }))).toEqual({ kind: 'viewer' });
  });

  it('finds menu options, suggestions and approval buttons', () => {
    const s = room();
    const menu = welcomeMenu(s);
    const firstOption = g.headerTop + 1 + menu.intro.length + 1;
    expect(hitTest(g, 60, firstOption + 1, ctx(s, { menu }))).toEqual({ kind: 'menu', index: 1 });
    expect(hitTest(g, 60, 3, ctx(s, { menu }))).toEqual({ kind: 'none' });

    const sg = computeLayout({ columns: 120, rows: 40, peopleCount: 3, hasViewer: false, suggestionCount: 3, approvalDetail: 'rm x' });
    expect(hitTest(sg, 10, sg.suggestionsTop + 2, ctx(s, { suggestionCount: 3 }))).toEqual({ kind: 'suggestion', index: 2 });
    const [allow, deny] = placeButtons(APPROVAL_BUTTONS, 2, 4);
    const row = sg.approvalTop + 2 + 1;
    expect(hitTest(sg, allow!.x0, row, ctx(s, { approvalDetailLines: 1 }))).toEqual({ kind: 'approval', answer: 'yes' });
    expect(hitTest(sg, deny!.x1, row, ctx(s, { approvalDetailLines: 1 }))).toEqual({ kind: 'approval', answer: 'no' });
    expect(hitTest(sg, 119, row, ctx(s, { approvalDetailLines: 1 }))).toEqual({ kind: 'none' });
  });

  it('windows file rows around the cursor', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ label: `f${i}`, dir: false, target: 'up' as const }));
    expect(fileWindow({ rows, cursor: 40, loading: false }, 12)).toEqual({ start: 35, count: 10, firstRowOffset: 0 });
    expect(fileWindow({ rows, cursor: 0, loading: true, error: 'x' }, 12)).toEqual({ start: 0, count: 8, firstRowOffset: 2 });
  });
});

describe('mouse input proxy', () => {
  it('passes keys through to Ink and routes clicks to the listener', async () => {
    const { EventEmitter } = await import('node:events');
    const { createMouseInput } = await import('../src/ui/mouse.js');
    const calls: string[] = [];
    const source = Object.assign(new EventEmitter(), {
      setEncoding: () => undefined,
      setRawMode: (m: boolean) => calls.push(`raw:${m}`),
      ref: () => calls.push('ref'),
      unref: () => calls.push('unref'),
    }) as unknown as NodeJS.ReadStream;
    const clicks: string[] = [];
    const proxy = createMouseInput(source, (e) => clicks.push(`${e.button}@${e.x},${e.y}`));
    expect(proxy.isTTY).toBe(true);
    proxy.setRawMode(true);
    proxy.ref();
    proxy.unref();
    expect(calls).toEqual(['raw:true', 'ref', 'unref']);
    source.emit('data', 'hi\x1b[<0;5;6M');
    expect(clicks).toEqual(['left@4,5']);
    expect(proxy.read()).toBe('hi');
    source.emit('data', '\x1b[<64;1;1M');
    expect(proxy.read()).toBeNull(); // pure mouse chunk produces no keyboard input
  });
});
