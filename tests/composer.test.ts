import { describe, expect, it } from 'vitest';
import { RAMP_AFTER_MS, cleanText, repeatStep, rowOf, wordLeft, wordRight, wrapBuffer } from '../src/ui/composer-text.js';
import { handleKey, initialUi, insertText, type KeyContext, type KeyInfo, type UiState } from '../src/ui/keymap.js';
import { actionButtons } from '../src/ui/actions.js';
import { initialAppState as initialState } from '../src/client/screen.js';

const ctx: KeyContext = { hasApproval: false, hasViewer: false, overlay: false, page: 20, maxChatScroll: 0, suggestions: [], peopleCount: 1, menuSize: 0 };
const at = (buffer: string, cursor = buffer.length): UiState => ({ ...initialUi, buffer, cursor });
const key = (ui: UiState, k: KeyInfo, input = '', c: KeyContext = ctx) => handleKey(ui, input, k, c).ui;
const texts = (buffer: string, width: number): string[] => wrapBuffer(buffer, width).map((r) => buffer.slice(r.start, r.end));

describe('composer: wrapping', () => {
  it('wraps at spaces, breaks long words, and keeps newlines', () => {
    expect(texts('hello there world', 11)).toEqual(['hello ', 'there world']);
    expect(texts('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(texts('one\n\ntwo', 10)).toEqual(['one', '', 'two']);
    expect(texts('', 10)).toEqual(['']);
    expect(texts('日本語です', 4)).toEqual(['日本', '語で', 'す']);
  });

  it('puts the cursor on the right row (a soft wrap belongs to the next row)', () => {
    const rows = wrapBuffer('hello there', 6);
    expect(rowOf(rows, 0)).toBe(0);
    expect(rowOf(rows, 6)).toBe(1);
    expect(rowOf(rows, 11)).toBe(1);
    const nl = wrapBuffer('ab\ncd', 10);
    expect(rowOf(nl, 2)).toBe(0);
    expect(rowOf(nl, 3)).toBe(1);
  });

  it('memoises and stays fast on a long draft', () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(4000);
    const t0 = performance.now();
    const a = wrapBuffer(long, 80);
    expect(wrapBuffer(long, 80)).toBe(a);
    let ui = at(long);
    for (let i = 0; i < 200; i++) ui = key(ui, {}, 'x', { ...ctx, composerWidth: 80 });
    expect(performance.now() - t0).toBeLessThan(2000);
  });

});

describe('composer: word editing', () => {
  it('finds word boundaries like macOS (punctuation separates words)', () => {
    const s = 'fix src/ui/keymap.ts now';
    expect(wordLeft(s, s.length)).toBe(21);
    expect(wordLeft(s, 21)).toBe(18);
    expect(wordLeft(s, 18)).toBe(11);
    expect(wordRight(s, 0)).toBe(3);
    expect(wordRight(s, 3)).toBe(7);
  });

  it('Option+Backspace and Ctrl+W delete the word before; Option+Delete the word after', () => {
    expect(key(at('hello big world'), { backspace: true, meta: true }).buffer).toBe('hello big ');
    expect(key(at('hello big world'), { ctrl: true }, 'w').buffer).toBe('hello big ');
    expect(key(at('hello big world', 5), { meta: true }, 'd').buffer).toBe('hello world');
    expect(key(at('hello big world', 5), { delete: true, meta: true }).buffer).toBe('hello world');
    expect(key(at('abc', 1), { delete: true }).buffer).toBe('ac');
  });

  it('Option+← → move by word (ESC b/f or CSI 1;3 D/C)', () => {
    expect(key(at('one two three'), { meta: true }, 'b').cursor).toBe(8);
    expect(key(at('one two three'), { leftArrow: true, meta: true }).cursor).toBe(8);
    expect(key(at('one two three', 0), { meta: true }, 'f').cursor).toBe(3);
    expect(key(at('one two three', 3), { rightArrow: true, meta: true }).cursor).toBe(7);
  });

  it('Cmd+← → (Home/End, Ctrl+A/E) and Cmd+Backspace (Ctrl+U) work on the current line', () => {
    const ui = at('first line\nsecond line', 15);
    expect(key(ui, { home: true }).cursor).toBe(11);
    expect(key(ui, { ctrl: true }, 'e').cursor).toBe(22);
    expect(key(ui, { ctrl: true }, 'u').buffer).toBe('first line\nnd line');
    expect(key(at('ab\ncd', 3), { ctrl: true }, 'u').buffer).toBe('abcd');
    expect(key(ui, { ctrl: true }, 'k').buffer).toBe('first line\nseco');
    // A wrapped row: End stays on the row instead of jumping to the next one.
    const wrapped = { ...ctx, composerWidth: 6 };
    expect(key(at('hello there', 0), { end: true }, '', wrapped).cursor).toBe(5);
  });
});

describe('composer: lines', () => {
  it('Ctrl+J and Shift+Enter add a new line instead of sending', () => {
    const r = handleKey(at('one'), '\n', {}, ctx);
    expect(r.effect).toBeUndefined();
    expect(r.ui.buffer).toBe('one\n');
    expect(key(at('one'), { return: true, shift: true }).buffer).toBe('one\n');
  });

  it('pastes keep their lines; typed "text\\r" still sends', () => {
    expect(insertText(at('x', 0), 'a\r\nb\tc\x1b').buffer).toBe('a\nb  cx');
    const pasted = handleKey(at(''), 'l1\rl2\r', {}, ctx);
    expect(pasted.effect).toBeUndefined();
    expect(pasted.ui.buffer).toBe('l1\nl2\n');
    expect(handleKey(at('hi'), ' there\r', {}, ctx).effect).toEqual({ type: 'submit', text: 'hi there' });
  });

  it('↑↓ move between rows, and recall history only from the first/last row', () => {
    const ui = { ...at('abc\ndef', 6), history: ['old'] };
    const up = key(ui, { upArrow: true });
    expect(up.cursor).toBe(2);
    expect(key(up, { upArrow: true }).buffer).toBe('old');
    expect(key(up, { downArrow: true }).cursor).toBe(6);
    const wrapped = { ...ctx, composerWidth: 6 };
    expect(key(at('hello there', 9), { upArrow: true }, '', wrapped).cursor).toBe(3);
  });

});

describe('composer: accelerating Backspace', () => {
  it('ramps from one character to words while held, and resets when let go', () => {
    let s = repeatStep(undefined, 0);
    expect(s.step).toEqual({ kind: 'chars', n: 1 });
    const steps: string[] = [];
    for (let t = 30; t <= 2400; t += 30) {
      s = repeatStep(s.state, t);
      steps.push(s.step.kind === 'word' ? 'w' : String(s.step.n));
    }
    expect(steps[0]).toBe('1');
    expect(steps).toContain('2');
    expect(steps).toContain('4');
    expect(steps.at(-1)).toBe('w');
    // A pause ends the stream.
    expect(repeatStep(s.state, 2400 + 500).step).toEqual({ kind: 'chars', n: 1 });
  });

  it('a backlog in one chunk counts once once accelerated (no deletions left over after release)', () => {
    let s = repeatStep(undefined, 0);
    for (let t = 30; t <= RAMP_AFTER_MS + 60; t += 30) s = repeatStep(s.state, t);
    const t = RAMP_AFTER_MS + 90;
    const first = repeatStep(s.state, t);
    expect(first.step).toEqual({ kind: 'chars', n: 2 });
    expect(repeatStep(first.state, t).step).toEqual({ kind: 'chars', n: 0 });
  });

  it('deletes faster through the keymap with the injected clock', () => {
    let ui = at('word '.repeat(200));
    const len0 = ui.buffer.length;
    for (let t = 0; t <= 2400; t += 30) ui = key(ui, { backspace: true }, '', { ...ctx, now: t });
    const deleted = len0 - ui.buffer.length;
    expect(deleted).toBeGreaterThan(81 * 2);
    // Separate taps delete one character each.
    let tap = at('abcdef');
    for (let t = 0; t < 1000; t += 200) tap = key(tap, { backspace: true }, '', { ...ctx, now: t });
    expect(tap.buffer).toBe('a');
  });
});

describe('composer: buttons', () => {
  it('offers Queue / Send now while your Claude works, and the queued message controls', () => {
    const s = initialState('r');
    const ids = (c: Parameters<typeof actionButtons>[4]) => actionButtons('chat', s, false, undefined, c).map((b) => b.id);
    expect(ids({ typing: true, busy: false, queued: 0 })[0]).toBe('ask');
    expect(ids({ typing: true, busy: true, queued: 0 }).slice(0, 2)).toEqual(['queue', 'send-now']);
    expect(ids({ typing: false, busy: true, queued: 1 }).slice(0, 2)).toEqual(['queued-now', 'queued-cancel']);
  });
});
