import type { Suggestion } from './suggest.js';

export type Focus = 'chat' | 'files' | 'viewer';

export interface UiState {
  readonly focus: Focus;
  readonly buffer: string;
  readonly cursor: number;
  readonly chatScroll: number;
  readonly history: readonly string[];
  readonly historyIndex: number;
  readonly selected: number;
  /** Suggestions hidden with Esc until the next edit. */
  readonly suggestHidden: boolean;
  /** First Ctrl-C arms quitting; a second one quits. */
  readonly quitArmed: boolean;
  /** Scroll offset inside the help overlay. */
  readonly overlayScroll: number;
}

/** Subset of Ink's Key we rely on, so the keymap stays framework-agnostic. */
export interface KeyInfo {
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly tab?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
}

export type Effect =
  | { readonly type: 'submit'; readonly text: string }
  | { readonly type: 'quit' }
  | { readonly type: 'toast'; readonly text: string }
  | { readonly type: 'approve'; readonly answer: 'yes' | 'no' | 'always' }
  | { readonly type: 'close_overlay' }
  | { readonly type: 'browser_move'; readonly delta: number }
  | { readonly type: 'browser_enter' }
  | { readonly type: 'browser_up' }
  | { readonly type: 'viewer_scroll'; readonly delta: number }
  | { readonly type: 'viewer_close' };

export interface KeyContext {
  readonly hasApproval: boolean;
  readonly hasViewer: boolean;
  readonly overlay: boolean;
  readonly page: number;
  readonly maxChatScroll: number;
  readonly suggestions: readonly Suggestion[];
}

export interface KeyResult {
  readonly ui: UiState;
  readonly effect?: Effect;
}

export const initialUi: UiState = {
  focus: 'chat',
  buffer: '',
  cursor: 0,
  chatScroll: 0,
  history: [],
  historyIndex: -1,
  selected: 0,
  suggestHidden: false,
  quitArmed: false,
  overlayScroll: 0,
};

const HISTORY_LIMIT = 200;

const setBuffer = (ui: UiState, buffer: string, cursor = buffer.length): UiState => ({
  ...ui,
  buffer,
  cursor,
  selected: 0,
  suggestHidden: false,
});

function edit(ui: UiState, input: string, key: KeyInfo): UiState | undefined {
  const { buffer, cursor } = ui;
  if (key.backspace || key.delete) {
    if (cursor === 0) return ui;
    return setBuffer(ui, buffer.slice(0, cursor - 1) + buffer.slice(cursor), cursor - 1);
  }
  if (key.leftArrow) return { ...ui, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { ...ui, cursor: Math.min(buffer.length, cursor + 1) };
  if (key.ctrl && input === 'a') return { ...ui, cursor: 0 };
  if (key.ctrl && input === 'e') return { ...ui, cursor: buffer.length };
  if (key.ctrl && input === 'u') return setBuffer(ui, buffer.slice(cursor), 0);
  if (key.ctrl && input === 'w') {
    const before = buffer.slice(0, cursor).replace(/\S+\s*$/, '');
    return setBuffer(ui, before + buffer.slice(cursor), before.length);
  }
  if (key.ctrl || !input) return undefined;
  const clean = input.replace(/\r?\n/g, ' ');
  return setBuffer(ui, buffer.slice(0, cursor) + clean + buffer.slice(cursor), cursor + clean.length);
}

function recall(ui: UiState, dir: 1 | -1): UiState {
  const { history } = ui;
  if (history.length === 0) return ui;
  const idx = dir === 1 ? Math.min(history.length - 1, ui.historyIndex + 1) : Math.max(-1, ui.historyIndex - 1);
  const text = idx === -1 ? '' : (history[history.length - 1 - idx] ?? '');
  return { ...setBuffer(ui, text), historyIndex: idx };
}

function submit(ui: UiState): KeyResult {
  const raw = ui.buffer.trim();
  const next: UiState = {
    ...setBuffer(ui, ''),
    historyIndex: -1,
    chatScroll: 0,
    history: raw ? [...ui.history, raw].slice(-HISTORY_LIMIT) : ui.history,
  };
  return raw ? { ui: next, effect: { type: 'submit', text: raw } } : { ui: next };
}

/** A bare "/fol" should complete on Enter rather than run an unknown command. */
function isPartialCommand(buffer: string, suggestions: readonly Suggestion[]): boolean {
  return /^\/\w*$/.test(buffer) && suggestions.length > 0 && !suggestions.some((s) => s.value.trim() === buffer);
}

const scrollChat = (ui: UiState, ctx: KeyContext, delta: number): UiState => ({
  ...ui,
  chatScroll: Math.min(ctx.maxChatScroll, Math.max(0, ui.chatScroll - delta)),
});

function handleChat(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  const shown = ui.suggestHidden ? [] : ctx.suggestions;
  const pick = shown[Math.min(ui.selected, shown.length - 1)];
  if (key.escape) return { ui: shown.length ? { ...ui, suggestHidden: true } : ui };
  if (key.tab && pick) return { ui: setBuffer(ui, pick.value) };
  if (key.return) {
    if (pick && isPartialCommand(ui.buffer, shown)) return { ui: setBuffer(ui, pick.value) };
    return submit(ui);
  }
  if ((key.upArrow || key.downArrow) && shown.length) {
    const delta = key.upArrow ? -1 : 1;
    return { ui: { ...ui, selected: (ui.selected + delta + shown.length) % shown.length } };
  }
  if (key.upArrow) return { ui: recall(ui, 1) };
  if (key.downArrow) return { ui: recall(ui, -1) };
  const half = Math.max(1, Math.floor(ctx.page / 2));
  if (key.pageUp) return { ui: scrollChat(ui, ctx, -half) };
  if (key.pageDown) return { ui: scrollChat(ui, ctx, half) };
  return { ui: edit(ui, input, key) ?? ui };
}

/** Printable keys in side panels jump back to the composer and start typing. */
function typeIntoChat(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult | undefined {
  if (key.ctrl || !input || input.length !== 1 || input < ' ') return undefined;
  return handleChat({ ...ui, focus: 'chat' }, input, key, ctx);
}

function handleFiles(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  if (key.upArrow) return { ui, effect: { type: 'browser_move', delta: -1 } };
  if (key.downArrow) return { ui, effect: { type: 'browser_move', delta: 1 } };
  if (key.pageUp) return { ui, effect: { type: 'browser_move', delta: -ctx.page } };
  if (key.pageDown) return { ui, effect: { type: 'browser_move', delta: ctx.page } };
  if (key.return || key.rightArrow) return { ui, effect: { type: 'browser_enter' } };
  if (key.leftArrow || key.backspace || key.delete) return { ui, effect: { type: 'browser_up' } };
  return typeIntoChat(ui, input, key, ctx) ?? { ui };
}

function handleViewer(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  const page = Math.max(1, ctx.page - 2);
  if (key.upArrow) return { ui, effect: { type: 'viewer_scroll', delta: -1 } };
  if (key.downArrow) return { ui, effect: { type: 'viewer_scroll', delta: 1 } };
  if (key.pageUp) return { ui, effect: { type: 'viewer_scroll', delta: -page } };
  if (key.pageDown) return { ui, effect: { type: 'viewer_scroll', delta: page } };
  if (key.backspace || key.delete) return { ui: { ...ui, focus: 'chat' }, effect: { type: 'viewer_close' } };
  return typeIntoChat(ui, input, key, ctx) ?? { ui };
}

function cycleFocus(ui: UiState, ctx: KeyContext, dir: 1 | -1): UiState {
  const order: Focus[] = ctx.hasViewer ? ['chat', 'files', 'viewer'] : ['chat', 'files'];
  const idx = Math.max(0, order.indexOf(ui.focus));
  return { ...ui, focus: order[(idx + dir + order.length) % order.length] ?? 'chat' };
}

/** Modeless key handling: you're always typing, Tab moves between panels, Esc comes back. */
export function handleKey(raw: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  const isCtrlC = Boolean(key.ctrl) && input === 'c';
  const ui = isCtrlC || !raw.quitArmed ? raw : { ...raw, quitArmed: false };
  if (isCtrlC) {
    if (ui.buffer) return { ui: setBuffer(ui, '') };
    if (ui.quitArmed) return { ui, effect: { type: 'quit' } };
    return { ui: { ...ui, quitArmed: true }, effect: { type: 'toast', text: 'Press Ctrl+C again to quit' } };
  }
  // Approvals come first so they can be answered even while help is open.
  if (ctx.hasApproval && key.ctrl && (input === 'y' || input === 'n' || input === 't')) {
    const answer = input === 'y' ? 'yes' : input === 'n' ? 'no' : 'always';
    return { ui, effect: { type: 'approve', answer } };
  }
  if (ctx.overlay) {
    if (key.escape || key.return || input === 'q') return { ui: { ...ui, overlayScroll: 0 }, effect: { type: 'close_overlay' } };
    const delta = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -ctx.page : key.pageDown ? ctx.page : 0;
    return { ui: { ...ui, overlayScroll: Math.max(0, ui.overlayScroll + delta) } };
  }
  const focus = ui.focus === 'viewer' && !ctx.hasViewer ? 'chat' : ui.focus;
  const current = focus === ui.focus ? ui : { ...ui, focus };
  const suggesting = current.focus === 'chat' && !current.suggestHidden && ctx.suggestions.length > 0;
  if (key.tab && !suggesting) return { ui: cycleFocus(current, ctx, key.shift ? -1 : 1) };
  if (key.escape && current.focus !== 'chat') return { ui: { ...current, focus: 'chat' } };
  // Fast typing or pasting can deliver "text\r" as one chunk: type the text, then press Enter.
  if (current.focus === 'chat' && !key.return && input.length > 1 && /[\r\n]$/.test(input)) {
    return submit(handleChat(current, input.replace(/[\r\n]+$/, ''), key, ctx).ui);
  }
  if (current.focus === 'files') return handleFiles(current, input, key, ctx);
  if (current.focus === 'viewer') return handleViewer(current, input, key, ctx);
  return handleChat(current, input, key, ctx);
}
