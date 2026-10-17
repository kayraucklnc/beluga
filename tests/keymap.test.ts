import { describe, expect, it } from 'vitest';
import { handleKey, initialUi, type KeyContext, type KeyInfo, type UiState } from '../src/ui/keymap.js';
import type { Suggestion } from '../src/ui/suggest.js';

const ctx: KeyContext = { hasApproval: false, hasViewer: false, overlay: false, page: 20, maxChatScroll: 50, suggestions: [], peopleCount: 3, menuSize: 0 };
const type = (ui: UiState, text: string, c = ctx): UiState => [...text].reduce((u, ch) => handleKey(u, ch, {}, c).ui, ui);
const key = (ui: UiState, k: KeyInfo, input = '', c = ctx) => handleKey(ui, input, k, c);
const sugg = (...values: string[]): Suggestion[] => values.map((v) => ({ label: v, hint: '', value: v, enter: 'complete' as const }));

describe('keymap: typing', () => {
  it('types and submits chat right away (no modes)', () => {
    const ui = type(initialUi, 'hi there');
    expect(ui.buffer).toBe('hi there');
    const res = key(ui, { return: true });
    expect(res.effect).toEqual({ type: 'submit', text: 'hi there' });
    expect(res.ui).toMatchObject({ buffer: '', history: ['hi there'] });
    expect(key(initialUi, { return: true }).effect).toBeUndefined();
  });

  it('submits when Enter arrives in the same chunk as text', () => {
    const res = key(type(initialUi, 'hi'), {}, ' there\r');
    expect(res.effect).toEqual({ type: 'submit', text: 'hi there' });
  });

  it('edits with cursor keys and readline shortcuts', () => {
    let ui = type(initialUi, 'hello world');
    ui = key(ui, { leftArrow: true }).ui;
    ui = key(ui, { backspace: true }).ui;
    expect(ui.buffer).toBe('hello word');
    ui = key(ui, { ctrl: true }, 'e').ui;
    ui = key(ui, { ctrl: true }, 'w').ui;
    expect(ui.buffer).toBe('hello ');
    ui = key(ui, { ctrl: true }, 'a').ui;
    ui = key(ui, { rightArrow: true }).ui;
    ui = key(ui, { ctrl: true }, 'u').ui;
    expect(ui.buffer).toBe('ello ');
    expect(key({ ...ui, cursor: 0 }, { backspace: true }).ui.buffer).toBe('ello ');
    expect(key(ui, {}, 'a\nb').ui.buffer).toBe('a bello ');
    expect(key(ui, { ctrl: true }, 'z').ui).toBe(ui);
  });

  it('recalls history with arrows', () => {
    let ui = key(type(initialUi, 'one'), { return: true }).ui;
    ui = key(type(ui, 'two'), { return: true }).ui;
    ui = key(ui, { upArrow: true }).ui;
    expect(ui.buffer).toBe('two');
    ui = key(ui, { upArrow: true }).ui;
    expect(ui.buffer).toBe('one');
    ui = key(key(ui, { downArrow: true }).ui, { downArrow: true }).ui;
    expect(ui.buffer).toBe('');
    expect(key(initialUi, { upArrow: true }).ui).toBe(initialUi);
  });

  it('scrolls chat with PgUp/PgDn within bounds', () => {
    const up = key(initialUi, { pageUp: true }).ui;
    expect(up.chatScroll).toBe(10);
    expect(key(up, { pageDown: true }).ui.chatScroll).toBe(0);
    expect(key(initialUi, { pageUp: true }, '', { ...ctx, maxChatScroll: 3 }).ui.chatScroll).toBe(3);
  });
});

describe('keymap: suggestions', () => {
  const c = { ...ctx, suggestions: sugg('/follow ', '/files') };

  it('completes with Tab and moves the selection with arrows', () => {
    const ui = type(initialUi, '/f', c);
    expect(key(ui, { tab: true }, '', c).ui.buffer).toBe('/follow ');
    const down = key(ui, { downArrow: true }, '', c).ui;
    expect(down.selected).toBe(1);
    expect(key(down, { tab: true }, '', c).ui.buffer).toBe('/files');
    expect(key(ui, { upArrow: true }, '', c).ui.selected).toBe(1); // wraps
  });

  it('completes a partial command on Enter instead of running it', () => {
    const res = key(type(initialUi, '/fo', c), { return: true }, '', c);
    expect(res.effect).toBeUndefined();
    expect(res.ui.buffer).toBe('/follow ');
  });

  it('completes a half-typed @mention on Enter instead of sending it', () => {
    const c2 = { ...ctx, suggestions: sugg('@claude ') };
    const res = key(type(initialUi, '@cla', c2), { return: true }, '', c2);
    expect(res.effect).toBeUndefined();
    expect(res.ui.buffer).toBe('@claude ');
  });

  it('sends "submit" suggestions straight away (e.g. a file for /open)', () => {
    const c2 = { ...ctx, suggestions: [{ label: 'README.md', hint: 'file', value: '/open bob:api/README.md', enter: 'submit' as const }] };
    const res = key(type(initialUi, '/open bob:api/RE', c2), { return: true }, '', c2);
    expect(res.effect).toEqual({ type: 'submit', text: '/open bob:api/README.md' });
  });

  it('runs an exact command on Enter', () => {
    const exact = { ...ctx, suggestions: sugg('/help') };
    expect(key(type(initialUi, '/help', exact), { return: true }, '', exact).effect).toEqual({ type: 'submit', text: '/help' });
  });

  it('hides suggestions with Esc until the next edit', () => {
    const hidden = key(type(initialUi, '/f', c), { escape: true }, '', c).ui;
    expect(hidden.suggestHidden).toBe(true);
    expect(key(hidden, { tab: true }, '', c).ui.focus).toBe('projects'); // Tab now moves focus
    expect(key(hidden, {}, 'o', c).ui.suggestHidden).toBe(false);
    expect(key(initialUi, { escape: true }).ui).toBe(initialUi);
  });
});

describe('keymap: panels', () => {
  it('cycles focus with Tab (chat → projects → people → files/main/viewer) and returns with Esc', () => {
    const projects = key(initialUi, { tab: true }).ui;
    expect(projects.focus).toBe('projects');
    const people = key(projects, { tab: true }).ui;
    expect(people.focus).toBe('people');
    expect(key(people, { tab: true }).ui.focus).toBe('chat');
    const all = { ...ctx, hasViewer: true, filesVisible: true, mainFocusable: true };
    const files = key(people, { tab: true }, '', all).ui;
    expect(files.focus).toBe('files');
    expect(key(files, { tab: true }, '', all).ui.focus).toBe('main');
    expect(key({ ...files, focus: 'main' }, { tab: true }, '', all).ui.focus).toBe('viewer');
    expect(key(initialUi, { tab: true, shift: true }, '', all).ui.focus).toBe('viewer');
    expect(key(files, { escape: true }).ui.focus).toBe('chat');
    expect(key({ ...initialUi, focus: 'viewer' }, { tab: true }).ui.focus).toBe('projects'); // viewer gone → chat → projects
  });

  it('navigates the Projects tree and opens items with Enter', () => {
    const items = [{ type: 'toggle_project', id: 'p' }, { type: 'open_ws', id: 'w' }] as const;
    const c = { ...ctx, projectItems: items };
    const p: UiState = { ...initialUi, focus: 'projects' };
    const down = key(p, { downArrow: true }, '', c).ui;
    expect(down.projectsCursor).toBe(1);
    expect(key(down, { downArrow: true }, '', c).ui.projectsCursor).toBe(1);
    expect(key(down, { upArrow: true }, '', c).ui.projectsCursor).toBe(0);
    expect(key(down, { return: true }, '', c).effect).toEqual({ type: 'ui_action', action: { type: 'open_ws', id: 'w' } });
    expect(key(p, { pageDown: true }, '', c).ui.projectsCursor).toBe(1);
    expect(key(down, { pageUp: true }, '', c).ui.projectsCursor).toBe(0);
    expect(key(p, {}, 'x', c).ui).toMatchObject({ focus: 'chat', buffer: 'x' });
  });

  it('moves through review files and scrolls the diff', () => {
    const m: UiState = { ...initialUi, focus: 'main' };
    expect(key(m, { downArrow: true }).effect).toEqual({ type: 'review_move', delta: 1 });
    expect(key(m, { upArrow: true }).effect).toEqual({ type: 'review_move', delta: -1 });
    expect(key(m, { pageDown: true }).effect).toEqual({ type: 'review_scroll', delta: 18 });
    expect(key(m, { pageUp: true }).effect).toEqual({ type: 'review_scroll', delta: -18 });
    expect(key(m, {}, 'q').ui).toMatchObject({ focus: 'chat', buffer: 'q' });
  });

  it('Esc cancels naming a new worktree', () => {
    const naming: UiState = { ...initialUi, buffer: 'half', cursor: 4, pending: { kind: 'worktree', projectId: 'p' } };
    expect(key(naming, { escape: true }).ui).toMatchObject({ buffer: '', pending: undefined });
  });

  it('moves through people and opens their action menu', () => {
    const people: UiState = { ...initialUi, focus: 'people' };
    const down = key(people, { downArrow: true }).ui;
    expect(down.peopleCursor).toBe(1);
    expect(key({ ...people, peopleCursor: 2 }, { downArrow: true }).ui.peopleCursor).toBe(2);
    expect(key(people, { upArrow: true }).ui.peopleCursor).toBe(0);
    expect(key(down, { return: true }).ui.menu).toEqual({ menu: { kind: 'person', index: 1 }, selected: 0 });
    expect(key(people, {}, 'h').ui).toMatchObject({ focus: 'chat', buffer: 'h' });
  });

  it('toggles fullscreen and source view in the viewer; Esc leaves fullscreen first', () => {
    const c = { ...ctx, hasViewer: true };
    const viewer: UiState = { ...initialUi, focus: 'viewer' };
    const full = key(viewer, {}, 'f', c).ui;
    expect(full.viewerFull).toBe(true);
    expect(key(full, {}, 'f', c).ui.viewerFull).toBe(false);
    expect(key(viewer, {}, 'r', c).ui.viewerRaw).toBe(true);
    const esc = key(full, { escape: true }, '', c).ui;
    expect(esc).toMatchObject({ focus: 'viewer', viewerFull: false });
    expect(key(esc, { escape: true }, '', c).ui.focus).toBe('chat');
    expect(key(full, { backspace: true }, '', c).ui.viewerFull).toBe(false);
  });

  it('downloads the selected file with d', () => {
    expect(key({ ...initialUi, focus: 'files' }, {}, 'd').effect).toEqual({ type: 'download' });
    expect(key({ ...initialUi, focus: 'viewer' }, {}, 'd', { ...ctx, hasViewer: true }).effect).toEqual({ type: 'download' });
  });

  it('navigates files and jumps back to chat when you type', () => {
    const files: UiState = { ...initialUi, focus: 'files' };
    expect(key(files, { downArrow: true }).effect).toEqual({ type: 'browser_move', delta: 1 });
    expect(key(files, { upArrow: true }).effect).toEqual({ type: 'browser_move', delta: -1 });
    expect(key(files, { pageDown: true }).effect).toEqual({ type: 'browser_move', delta: 20 });
    expect(key(files, { pageUp: true }).effect).toEqual({ type: 'browser_move', delta: -20 });
    expect(key(files, { return: true }).effect).toEqual({ type: 'browser_enter' });
    expect(key(files, { leftArrow: true }).effect).toEqual({ type: 'browser_up' });
    expect(key(files, {}, 'h').ui).toMatchObject({ focus: 'chat', buffer: 'h' });
    expect(key(files, { ctrl: true }, 'x').ui).toBe(files);
  });

  it('scrolls and closes the viewer', () => {
    const c = { ...ctx, hasViewer: true };
    const viewer: UiState = { ...initialUi, focus: 'viewer' };
    expect(key(viewer, { downArrow: true }, '', c).effect).toEqual({ type: 'viewer_scroll', delta: 1 });
    expect(key(viewer, { upArrow: true }, '', c).effect).toEqual({ type: 'viewer_scroll', delta: -1 });
    expect(key(viewer, { pageDown: true }, '', c).effect).toEqual({ type: 'viewer_scroll', delta: 18 });
    expect(key(viewer, { pageUp: true }, '', c).effect).toEqual({ type: 'viewer_scroll', delta: -18 });
    expect(key(viewer, { backspace: true }, '', c)).toMatchObject({ ui: { focus: 'chat' }, effect: { type: 'viewer_close' } });
    expect(key(viewer, {}, 'y', c).ui).toMatchObject({ focus: 'chat', buffer: 'y' });
  });
});

describe('keymap: menus', () => {
  const c = { ...ctx, menuSize: 3 };
  const welcome: UiState = { ...initialUi, menu: { menu: { kind: 'welcome' }, selected: 0 } };
  const person: UiState = { ...initialUi, menu: { menu: { kind: 'person', index: 1 }, selected: 0 } };

  it('moves the highlight and picks with Enter or a number', () => {
    const down = key(welcome, { downArrow: true }, '', c).ui;
    expect(down.menu?.selected).toBe(1);
    expect(key(welcome, { upArrow: true }, '', c).ui.menu?.selected).toBe(2); // wraps
    expect(key(down, { return: true }, '', c)).toMatchObject({ ui: { menu: undefined }, effect: { type: 'menu_select', menu: { kind: 'welcome' }, index: 1 } });
    expect(key(welcome, {}, '3', c).effect).toEqual({ type: 'menu_select', menu: { kind: 'welcome' }, index: 2 });
    expect(key(welcome, {}, '9', c).effect).toBeUndefined();
  });

  it('Esc picks the safe default on the welcome screen but just closes other menus', () => {
    expect(key(welcome, { escape: true }, '', c).effect).toEqual({ type: 'menu_select', menu: { kind: 'welcome' }, index: 0 });
    expect(key(person, { escape: true }, '', c)).toEqual({ ui: { ...person, menu: undefined } });
  });
});

describe('keymap: global keys', () => {
  it('needs Ctrl+C twice to quit, and clears typed text first', () => {
    expect(key(type(initialUi, 'draft'), { ctrl: true }, 'c').ui.buffer).toBe('');
    const armed = key(initialUi, { ctrl: true }, 'c');
    expect(armed.effect).toEqual({ type: 'toast', text: 'Press Ctrl+C again to quit' });
    expect(key(armed.ui, { ctrl: true }, 'c').effect).toEqual({ type: 'quit' });
    expect(key(armed.ui, {}, 'x').ui.quitArmed).toBe(false);
  });

  it('answers approvals with Ctrl+Y / Ctrl+N / Ctrl+T, never with plain letters', () => {
    const c = { ...ctx, hasApproval: true };
    expect(key(initialUi, { ctrl: true }, 'y', c).effect).toEqual({ type: 'approve', answer: 'yes' });
    expect(key(initialUi, { ctrl: true }, 'n', c).effect).toEqual({ type: 'approve', answer: 'no' });
    expect(key(initialUi, { ctrl: true }, 't', c).effect).toEqual({ type: 'approve', answer: 'always' });
    expect(key(initialUi, {}, 'y', c).ui.buffer).toBe('y');
  });

  it('scrolls and closes the help overlay, swallowing other keys', () => {
    const c = { ...ctx, overlay: true };
    expect(key(initialUi, { escape: true }, '', c).effect).toEqual({ type: 'close_overlay' });
    expect(key(initialUi, {}, 'q', c).effect).toEqual({ type: 'close_overlay' });
    expect(key(initialUi, {}, 'x', c)).toEqual({ ui: initialUi });
    const down = key(initialUi, { pageDown: true }, '', c).ui;
    expect(down.overlayScroll).toBe(20);
    expect(key(down, { upArrow: true }, '', c).ui.overlayScroll).toBe(19);
    expect(key(initialUi, { pageUp: true }, '', c).ui.overlayScroll).toBe(0);
  });

  it('answers approvals even while help is open', () => {
    const c = { ...ctx, overlay: true, hasApproval: true };
    expect(key(initialUi, { ctrl: true }, 'y', c).effect).toEqual({ type: 'approve', answer: 'yes' });
  });
});

describe('keymap: queue or send now', () => {
  it('Enter queues; Alt+Enter / Ctrl+Enter send right away', () => {
    const typed = [...'fix it'].reduce((u, ch) => handleKey(u, ch, {}, ctx).ui, initialUi);
    expect(handleKey(typed, '', { return: true }, ctx).effect).toEqual({ type: 'submit', text: 'fix it' });
    expect(handleKey(typed, '', { return: true, meta: true }, ctx).effect).toEqual({ type: 'submit', text: 'fix it', urgent: true });
    expect(handleKey(typed, '', { return: true, ctrl: true }, ctx).effect).toEqual({ type: 'submit', text: 'fix it', urgent: true });
  });
});
