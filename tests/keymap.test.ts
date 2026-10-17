import { describe, expect, it } from 'vitest';
import { handleKey, initialUi, type KeyContext, type KeyInfo, type UiState } from '../src/ui/keymap.js';
import type { Suggestion } from '../src/ui/suggest.js';

const ctx: KeyContext = { hasApproval: false, hasViewer: false, overlay: false, page: 20, maxChatScroll: 50, suggestions: [] };
const type = (ui: UiState, text: string, c = ctx): UiState => [...text].reduce((u, ch) => handleKey(u, ch, {}, c).ui, ui);
const key = (ui: UiState, k: KeyInfo, input = '', c = ctx) => handleKey(ui, input, k, c);
const sugg = (...values: string[]): Suggestion[] => values.map((v) => ({ label: v, hint: '', value: v }));

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

  it('runs an exact command on Enter', () => {
    const exact = { ...ctx, suggestions: sugg('/help') };
    expect(key(type(initialUi, '/help', exact), { return: true }, '', exact).effect).toEqual({ type: 'submit', text: '/help' });
  });

  it('hides suggestions with Esc until the next edit', () => {
    const hidden = key(type(initialUi, '/f', c), { escape: true }, '', c).ui;
    expect(hidden.suggestHidden).toBe(true);
    expect(key(hidden, { tab: true }, '', c).ui.focus).toBe('files'); // Tab now moves focus
    expect(key(hidden, {}, 'o', c).ui.suggestHidden).toBe(false);
    expect(key(initialUi, { escape: true }).ui).toBe(initialUi);
  });
});

describe('keymap: panels', () => {
  it('cycles focus with Tab and returns with Esc', () => {
    const files = key(initialUi, { tab: true }).ui;
    expect(files.focus).toBe('files');
    expect(key(files, { tab: true }).ui.focus).toBe('chat');
    const viewerCtx = { ...ctx, hasViewer: true };
    expect(key(files, { tab: true }, '', viewerCtx).ui.focus).toBe('viewer');
    expect(key(initialUi, { tab: true, shift: true }, '', viewerCtx).ui.focus).toBe('viewer');
    expect(key(files, { escape: true }).ui.focus).toBe('chat');
    expect(key({ ...initialUi, focus: 'viewer' }, { tab: true }).ui.focus).toBe('files'); // viewer gone
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
