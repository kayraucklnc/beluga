import { describe, expect, it } from 'vitest';
import { handleKey, initialUi, type KeyInfo, type UiState } from '../src/ui/keymap.js';

const ctx = { hasApproval: false, hasViewer: false, page: 20, maxChatScroll: 50 };
const type = (ui: UiState, text: string): UiState => [...text].reduce((u, ch) => handleKey(u, ch, {}, ctx).ui, ui);
const key = (ui: UiState, k: KeyInfo, input = '', c = ctx) => handleKey(ui, input, k, c);

describe('keymap', () => {
  it('types and submits chat in insert mode', () => {
    const ui = type(initialUi, 'hi there');
    expect(ui.buffer).toBe('hi there');
    const res = key(ui, { return: true });
    expect(res.effect).toEqual({ type: 'submit', text: 'hi there' });
    expect(res.ui.buffer).toBe('');
    expect(res.ui.history).toEqual(['hi there']);
  });

  it('submits when Enter arrives in the same chunk as text', () => {
    const res = key(type(initialUi, 'hi'), {}, ' there\r');
    expect(res.effect).toEqual({ type: 'submit', text: 'hi there' });
    expect(res.ui.buffer).toBe('');
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
  });

  it('recalls history with arrows', () => {
    let ui = key(type(initialUi, 'one'), { return: true }).ui;
    ui = key(type(ui, 'two'), { return: true }).ui;
    ui = key(ui, { upArrow: true }).ui;
    expect(ui.buffer).toBe('two');
    ui = key(ui, { upArrow: true }).ui;
    expect(ui.buffer).toBe('one');
    ui = key(ui, { downArrow: true }).ui;
    ui = key(ui, { downArrow: true }).ui;
    expect(ui.buffer).toBe('');
    expect(key(initialUi, { upArrow: true }).ui).toBe(initialUi);
  });

  it('switches modes vim-style', () => {
    const normal = key(initialUi, { escape: true }).ui;
    expect(normal.mode).toBe('normal');
    const cmd = key(normal, {}, ':').ui;
    expect(cmd.mode).toBe('command');
    const res = key(type(cmd, 'follow bob'), { return: true });
    expect(res.effect).toEqual({ type: 'submit', text: ':follow bob' });
    expect(res.ui.mode).toBe('normal');
    expect(key(cmd, { backspace: true }).ui.mode).toBe('normal');
    expect(key(normal, {}, '@').ui).toMatchObject({ mode: 'insert', buffer: '@' });
    expect(key(normal, {}, 'i').ui.mode).toBe('insert');
    expect(key(normal, {}, 'q').effect).toEqual({ type: 'quit' });
    expect(key(initialUi, { ctrl: true }, 'c').effect).toEqual({ type: 'quit' });
    expect(key(key(cmd, { return: true }).ui, {}).effect).toBeUndefined();
  });

  it('cycles panes and routes movement', () => {
    const normal: UiState = { ...initialUi, mode: 'normal' };
    const files = key(normal, { tab: true }).ui;
    expect(files.pane).toBe('viewer' === files.pane ? 'viewer' : 'files');
    expect(key(files, {}, 'j').effect).toEqual({ type: 'browser_move', delta: 1 });
    expect(key(files, {}, 'l').effect).toEqual({ type: 'browser_enter' });
    expect(key(files, {}, '-').effect).toEqual({ type: 'browser_up' });
    const viewerCtx = { ...ctx, hasViewer: true };
    const viewer: UiState = { ...normal, pane: 'viewer' };
    expect(key(viewer, { ctrl: true }, 'd', viewerCtx).effect).toEqual({ type: 'viewer_scroll', delta: 10 });
    expect(key(viewer, {}, 'x', viewerCtx).effect).toEqual({ type: 'viewer_close' });
    const chat = key(normal, {}, 'k').ui;
    expect(chat.chatScroll).toBe(1);
    expect(key(normal, {}, 'g').ui.chatScroll).toBe(50);
    expect(key(chat, {}, 'G').ui.chatScroll).toBe(0);
    expect(key(initialUi, { tab: true }).ui).toMatchObject({ mode: 'normal', pane: 'files' });
    expect(key(normal, { tab: true, shift: true }).ui.pane).toBe('files');
  });

  it('answers approvals with y/n/a in normal mode', () => {
    const c = { ...ctx, hasApproval: true };
    const normal: UiState = { ...initialUi, mode: 'normal' };
    expect(key(normal, {}, 'y', c).effect).toEqual({ type: 'approve', answer: 'yes' });
    expect(key(normal, {}, 'n', c).effect).toEqual({ type: 'approve', answer: 'no' });
    expect(key(normal, {}, 'a', c).effect).toEqual({ type: 'approve', answer: 'always' });
    expect(key(initialUi, { ctrl: true }, 'y', c).effect).toEqual({ type: 'approve', answer: 'yes' });
    expect(key(initialUi, { ctrl: true }, 'n', c).effect).toEqual({ type: 'approve', answer: 'no' });
    expect(key(initialUi, {}, 'y', c).ui.buffer).toBe('y'); // typing never approves by accident
  });
});
