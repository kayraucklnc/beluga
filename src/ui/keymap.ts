export type Mode = 'normal' | 'insert' | 'command';
export type Pane = 'chat' | 'files' | 'viewer';

export interface UiState {
  readonly mode: Mode;
  readonly pane: Pane;
  readonly buffer: string;
  readonly cursor: number;
  readonly chatScroll: number;
  readonly history: readonly string[];
  readonly historyIndex: number;
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
  | { readonly type: 'approve'; readonly answer: 'yes' | 'no' | 'always' }
  | { readonly type: 'browser_move'; readonly delta: number }
  | { readonly type: 'browser_enter' }
  | { readonly type: 'browser_up' }
  | { readonly type: 'viewer_scroll'; readonly delta: number }
  | { readonly type: 'viewer_close' };

export interface KeyContext {
  readonly hasApproval: boolean;
  readonly hasViewer: boolean;
  readonly page: number;
  /** Largest useful chat scroll offset (lines above the bottom). */
  readonly maxChatScroll: number;
}

export interface KeyResult {
  readonly ui: UiState;
  readonly effect?: Effect;
}

export const initialUi: UiState = {
  mode: 'insert',
  pane: 'chat',
  buffer: '',
  cursor: 0,
  chatScroll: 0,
  history: [],
  historyIndex: -1,
};

const HISTORY_LIMIT = 200;

function edit(ui: UiState, input: string, key: KeyInfo): UiState | undefined {
  const { buffer, cursor } = ui;
  if (key.backspace || key.delete) {
    if (cursor === 0) return ui;
    return { ...ui, buffer: buffer.slice(0, cursor - 1) + buffer.slice(cursor), cursor: cursor - 1 };
  }
  if (key.leftArrow) return { ...ui, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { ...ui, cursor: Math.min(buffer.length, cursor + 1) };
  if (key.ctrl && input === 'a') return { ...ui, cursor: 0 };
  if (key.ctrl && input === 'e') return { ...ui, cursor: buffer.length };
  if (key.ctrl && input === 'u') return { ...ui, buffer: buffer.slice(cursor), cursor: 0 };
  if (key.ctrl && input === 'w') {
    const before = buffer.slice(0, cursor).replace(/\S+\s*$/, '');
    return { ...ui, buffer: before + buffer.slice(cursor), cursor: before.length };
  }
  if (key.upArrow || key.downArrow) {
    const { history } = ui;
    if (history.length === 0) return ui;
    const idx = key.upArrow
      ? Math.min(history.length - 1, ui.historyIndex + 1)
      : Math.max(-1, ui.historyIndex - 1);
    const text = idx === -1 ? '' : (history[history.length - 1 - idx] ?? '');
    return { ...ui, buffer: text, cursor: text.length, historyIndex: idx };
  }
  if (key.ctrl || !input) return undefined;
  const clean = input.replace(/\r?\n/g, ' ');
  return { ...ui, buffer: buffer.slice(0, cursor) + clean + buffer.slice(cursor), cursor: cursor + clean.length };
}

function handleEditing(ui: UiState, input: string, key: KeyInfo): KeyResult {
  if (key.escape) return { ui: { ...ui, mode: 'normal', buffer: '', cursor: 0, historyIndex: -1 } };
  if (key.return) {
    const raw = ui.buffer.trim();
    const next: UiState = {
      ...ui,
      mode: ui.mode === 'command' ? 'normal' : 'insert',
      buffer: '',
      cursor: 0,
      historyIndex: -1,
      chatScroll: 0,
      history: raw ? [...ui.history, ui.mode === 'command' ? `:${raw}` : raw].slice(-HISTORY_LIMIT) : ui.history,
    };
    if (!raw) return { ui: next };
    return { ui: next, effect: { type: 'submit', text: ui.mode === 'command' ? `:${raw}` : raw } };
  }
  if (ui.mode === 'command' && (key.backspace || key.delete) && ui.buffer === '') {
    return { ui: { ...ui, mode: 'normal' } };
  }
  return { ui: edit(ui, input, key) ?? ui };
}

function nextPane(ui: UiState, ctx: KeyContext, dir: 1 | -1): Pane {
  const panes: Pane[] = ctx.hasViewer ? ['files', 'chat', 'viewer'] : ['files', 'chat'];
  const idx = panes.indexOf(ui.pane);
  return panes[(idx + dir + panes.length) % panes.length] ?? 'chat';
}

function move(ui: UiState, ctx: KeyContext, delta: number): KeyResult {
  if (ui.pane === 'files') return { ui, effect: { type: 'browser_move', delta } };
  if (ui.pane === 'viewer') return { ui, effect: { type: 'viewer_scroll', delta } };
  // Chat scroll counts lines up from the bottom, so "down" reduces it.
  return { ui: { ...ui, chatScroll: Math.min(ctx.maxChatScroll, Math.max(0, ui.chatScroll - delta)) } };
}

function handleNormal(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  if (ctx.hasApproval && (input === 'y' || input === 'n' || input === 'a')) {
    return { ui, effect: { type: 'approve', answer: input === 'y' ? 'yes' : input === 'n' ? 'no' : 'always' } };
  }
  if (key.tab) return { ui: { ...ui, pane: nextPane(ui, ctx, key.shift ? -1 : 1) } };
  if (input === ':') return { ui: { ...ui, mode: 'command', buffer: '', cursor: 0 } };
  if (input === '@') return { ui: { ...ui, mode: 'insert', pane: 'chat', buffer: '@', cursor: 1 } };
  if (input === 'i' || input === 'a' || (key.return && ui.pane === 'chat')) {
    return { ui: { ...ui, mode: 'insert', pane: 'chat' } };
  }
  if (input === 'q') return { ui, effect: { type: 'quit' } };
  const half = Math.max(1, Math.floor(ctx.page / 2));
  if (input === 'j' || key.downArrow) return move(ui, ctx, 1);
  if (input === 'k' || key.upArrow) return move(ui, ctx, -1);
  if ((key.ctrl && input === 'd') || key.pageDown) return move(ui, ctx, half);
  if ((key.ctrl && input === 'u') || key.pageUp) return move(ui, ctx, -half);
  if (input === 'G') return move(ui, ctx, 100_000);
  if (input === 'g') return move(ui, ctx, -100_000);
  if (ui.pane === 'files') {
    if (input === 'l' || key.return || key.rightArrow) return { ui, effect: { type: 'browser_enter' } };
    if (input === 'h' || input === '-' || key.leftArrow) return { ui, effect: { type: 'browser_up' } };
  }
  if (ui.pane === 'viewer' && input === 'x') return { ui: { ...ui, pane: 'chat' }, effect: { type: 'viewer_close' } };
  return { ui };
}

/** Pure vim-flavoured key handling: (state, key) -> (state, side effect). */
export function handleKey(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  if (key.ctrl && input === 'c') return { ui, effect: { type: 'quit' } };
  // Ctrl-Y / Ctrl-N answer approvals from any mode; plain y/n would be too easy to hit while typing.
  if (ctx.hasApproval && key.ctrl && (input === 'y' || input === 'n')) {
    return { ui, effect: { type: 'approve', answer: input === 'y' ? 'yes' : 'no' } };
  }
  if (ui.mode === 'normal') return handleNormal(ui, input, key, ctx);
  if (key.tab && ui.mode === 'insert') return { ui: { ...ui, mode: 'normal', pane: nextPane(ui, ctx, 1) } };
  // Fast typing or pasting can deliver "text\r" as one chunk: type the text, then press Enter.
  if (!key.return && input.length > 1 && /[\r\n]$/.test(input)) {
    const typed = handleEditing(ui, input.replace(/[\r\n]+$/, ''), key).ui;
    return handleEditing(typed, '', { return: true });
  }
  return handleEditing(ui, input, key);
}
