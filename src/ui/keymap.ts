import type { MenuKind } from './menus.js';
import type { Suggestion } from './suggest.js';
import type { UiAction } from './workspace-models.js';

export type Focus = 'chat' | 'projects' | 'header' | 'people' | 'files' | 'main' | 'viewer' | 'terminal';

export interface MenuState {
  readonly menu: MenuKind;
  readonly selected: number;
}

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
  /** Highlighted person in the People panel. */
  readonly peopleCursor: number;
  /** An open choice menu (welcome screen, person actions). */
  readonly menu?: MenuState;
  /** File viewer takes the whole screen. */
  readonly viewerFull: boolean;
  /** Show Markdown as source instead of rendered. */
  readonly viewerRaw: boolean;
  /** Claude's plan open full screen (question id), and how far it's scrolled. */
  readonly planFull?: string;
  readonly planScroll: number;
  /** Keyboard cursor in the Projects tree (index into its clickable rows). */
  readonly projectsCursor: number;
  /** Keyboard cursor over the workspace's action buttons (Chat/Files/Diff, Review, Merge…). */
  readonly headerCursor: number;
  /** Scroll offset of the Overview cards. */
  readonly overviewScroll: number;
  /** Projects folded closed in the sidebar. */
  readonly collapsed: readonly string[];
  /**
   * Inside the focused area (Enter goes in, Esc comes out). Outside, Tab jumps between areas
   * (chat, top bar, projects, people…); inside, Tab and the arrows move between its items.
   */
  readonly entered: boolean;
  /**
   * The box is asking for something specific: a name for a new worktree/chat/group, a setup
   * or run command for a project, or a task for a friend's Claude (`projectId` is then their project's name).
   */
  readonly pending?: { readonly kind: 'worktree' | 'chat' | 'group' | 'setup' | 'run' | 'remote' | 'peer_run'; readonly projectId: string; readonly peerId?: string };
  /** Lines scrolled back in the built-in terminal (0 = following its output). */
  readonly terminalScroll?: number;
  /** Which terminal session is showing (shell, setup or run). */
  readonly termKey?: string;
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
  readonly meta?: boolean;
}

export type Effect =
  | { readonly type: 'submit'; readonly text: string; readonly urgent?: boolean }
  | { readonly type: 'quit' }
  | { readonly type: 'toast'; readonly text: string }
  | { readonly type: 'approve'; readonly answer: 'yes' | 'no' | 'always' }
  | { readonly type: 'close_overlay' }
  | { readonly type: 'browser_move'; readonly delta: number }
  | { readonly type: 'browser_enter' }
  | { readonly type: 'browser_up' }
  | { readonly type: 'viewer_scroll'; readonly delta: number }
  | { readonly type: 'viewer_close' }
  | { readonly type: 'download' }
  | { readonly type: 'menu_select'; readonly menu: MenuKind; readonly index: number }
  | { readonly type: 'zoom'; readonly dir: 'in' | 'out' }
  | { readonly type: 'ui_action'; readonly action: UiAction }
  | { readonly type: 'review_move'; readonly delta: number }
  | { readonly type: 'review_scroll'; readonly delta: number }
  | { readonly type: 'cancel_draft' }
  | { readonly type: 'question_number'; readonly n: number }
  /** Shift+Tab in the chat: plan first, or act right away. */
  | { readonly type: 'toggle_plan' }
  /** ↑↓ in Search: choose a result. */
  | { readonly type: 'search_move'; readonly delta: number };

export interface KeyContext {
  readonly hasApproval: boolean;
  readonly hasViewer: boolean;
  readonly overlay: boolean;
  readonly page: number;
  readonly maxChatScroll: number;
  readonly suggestions: readonly Suggestion[];
  readonly peopleCount: number;
  /** Number of options in the open menu (0 when none). */
  readonly menuSize: number;
  /** Clickable rows of the Projects tree, in order (for keyboard navigation). */
  readonly projectItems?: readonly UiAction[];
  /** The main area has keyboard-navigable content (review). */
  readonly mainFocusable?: boolean;
  /** Workspace action buttons, in order (for keyboard use). */
  readonly headerItems?: readonly UiAction[];
  /** The shared-files panel is showing. */
  readonly filesVisible?: boolean;
  /** Viewing an unsent new chat (Esc leaves it without creating anything). */
  readonly draft?: boolean;
  /** Options on Claude's waiting question card (number keys pick them while the composer is empty). */
  readonly questionOptions?: number;
  /** Where the top bar's keyboard cursor starts (the workspace's own buttons, past the tabs). */
  readonly headerStart?: number;
  /** The Search tab is open: ↑↓ choose a result instead of recalling history. */
  readonly searching?: boolean;
  /** The Terminal tab is showing (Tab can move into it). */
  readonly terminalVisible?: boolean;
  /** Claude is waiting on a plan (Ctrl+F opens it full screen); its id. */
  readonly planId?: string;
  /** How far the full-screen plan can scroll. */
  readonly planMaxScroll?: number;
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
  peopleCursor: 0,
  viewerFull: false,
  planScroll: 0,
  viewerRaw: false,
  projectsCursor: 0,
  headerCursor: 0,
  entered: false,
  overviewScroll: 0,
  collapsed: [],
};

const HISTORY_LIMIT = 200;

const setBuffer = (ui: UiState, buffer: string, cursor = buffer.length): UiState => ({
  ...ui,
  buffer,
  cursor,
  selected: 0,
  suggestHidden: false,
});

/** UTF-16 length of the whole character before / after the cursor, so emoji move and delete as one. */
const charBefore = (s: string, at: number): number => [...s.slice(0, at)].at(-1)?.length ?? 1;
const charAfter = (s: string, at: number): number => [...s.slice(at, at + 2)][0]?.length ?? 1;

function edit(ui: UiState, input: string, key: KeyInfo): UiState | undefined {
  const { buffer, cursor } = ui;
  if (key.backspace || key.delete) {
    if (cursor === 0) return ui;
    const n = charBefore(buffer, cursor);
    return setBuffer(ui, buffer.slice(0, cursor - n) + buffer.slice(cursor), cursor - n);
  }
  if (key.leftArrow) return { ...ui, cursor: Math.max(0, cursor - charBefore(buffer, cursor)) };
  if (key.rightArrow) return { ...ui, cursor: Math.min(buffer.length, cursor + charAfter(buffer, cursor)) };
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

function submit(ui: UiState, urgent = false): KeyResult {
  const raw = ui.buffer.trim();
  const next: UiState = {
    ...setBuffer(ui, ''),
    historyIndex: -1,
    chatScroll: 0,
    history: raw ? [...ui.history, raw].slice(-HISTORY_LIMIT) : ui.history,
  };
  return raw ? { ui: next, effect: urgent ? { type: 'submit', text: raw, urgent: true } : { type: 'submit', text: raw } } : { ui: next };
}


const scrollChat = (ui: UiState, ctx: KeyContext, delta: number): UiState => ({
  ...ui,
  chatScroll: Math.min(ctx.maxChatScroll, Math.max(0, ui.chatScroll - delta)),
});

function handleChat(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  const shown = ui.suggestHidden ? [] : ctx.suggestions;
  const pick = shown[Math.min(ui.selected, shown.length - 1)];
  if (key.escape) {
    if (shown.length) return { ui: { ...ui, suggestHidden: true } };
    if (ui.pending) return { ui: { ...setBuffer(ui, ''), pending: undefined } };
    if (ctx.draft) return { ui: setBuffer(ui, ''), effect: { type: 'cancel_draft' } };
    return { ui };
  }
  if (key.tab && pick) return { ui: setBuffer(ui, pick.value) };
  const n = Number(input);
  if (!ui.buffer && ctx.questionOptions && input.length === 1 && Number.isInteger(n) && n >= 1 && n <= ctx.questionOptions) {
    return { ui, effect: { type: 'question_number', n } };
  }
  // Alt+Enter (or Ctrl+Enter where the terminal reports it) sends now instead of queueing.
  if (key.return && (key.meta || key.ctrl)) return submit(ui, true);
  // Answering a prompt (e.g. a project's setup command) with nothing is a real answer: clear it.
  if (key.return && ui.pending && !ui.buffer.trim() && !shown.length) return { ui: setBuffer(ui, ''), effect: { type: 'submit', text: '' } };
  if (key.return) {
    // Enter accepts the highlighted suggestion: "complete" keeps you typing ("@cla" -> "@claude "),
    // "submit" sends it ("/open bob:api/REA" -> opens README.md). An exact match just runs.
    if (pick && pick.value.trim() !== ui.buffer.trim()) {
      return pick.enter === 'submit' ? submit(setBuffer(ui, pick.value)) : { ui: setBuffer(ui, pick.value) };
    }
    return submit(ui);
  }
  if ((key.upArrow || key.downArrow) && shown.length) {
    const delta = key.upArrow ? -1 : 1;
    return { ui: { ...ui, selected: (ui.selected + delta + shown.length) % shown.length } };
  }
  if ((key.upArrow || key.downArrow) && ctx.searching) return { ui, effect: { type: 'search_move', delta: key.upArrow ? -1 : 1 } };
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

function handleMenu(ui: UiState, state: MenuState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  const size = Math.max(1, ctx.menuSize);
  const pick = (index: number): KeyResult => ({ ui: { ...ui, menu: undefined }, effect: { type: 'menu_select', menu: state.menu, index } });
  if (key.upArrow) return { ui: { ...ui, menu: { ...state, selected: (state.selected - 1 + size) % size } } };
  if (key.downArrow || key.tab) return { ui: { ...ui, menu: { ...state, selected: (state.selected + 1) % size } } };
  if (key.return) return pick(state.selected);
  const digit = Number(input);
  if (Number.isInteger(digit) && digit >= 1 && digit <= size) return pick(digit - 1);
  // The welcome screen needs an answer; Esc picks the safe default. Other menus just close.
  if (key.escape) return state.menu.kind === 'welcome' ? pick(state.selected) : { ui: { ...ui, menu: undefined } };
  return { ui };
}

function handleProjects(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  const items = ctx.projectItems ?? [];
  const max = Math.max(0, items.length - 1);
  if (key.tab) key = { ...key, upArrow: key.shift, downArrow: !key.shift, tab: false };
  if (key.upArrow) return { ui: { ...ui, projectsCursor: Math.max(0, Math.min(max, ui.projectsCursor) - 1) } };
  if (key.downArrow) return { ui: { ...ui, projectsCursor: Math.min(max, ui.projectsCursor + 1) } };
  if (key.pageUp) return { ui: { ...ui, projectsCursor: Math.max(0, ui.projectsCursor - ctx.page) } };
  if (key.pageDown) return { ui: { ...ui, projectsCursor: Math.min(max, ui.projectsCursor + ctx.page) } };
  const action = items[Math.min(ui.projectsCursor, max)];
  if ((key.return || key.rightArrow) && action) return { ui, effect: { type: 'ui_action', action } };
  return typeIntoChat(ui, input, key, ctx) ?? { ui };
}

function handleHeader(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  const items = ctx.headerItems ?? [];
  const max = Math.max(0, items.length - 1);
  if (key.tab) key = { ...key, leftArrow: key.shift, rightArrow: !key.shift, tab: false };
  if (key.leftArrow || key.upArrow) return { ui: { ...ui, headerCursor: Math.max(0, Math.min(max, ui.headerCursor) - 1) } };
  if (key.rightArrow || key.downArrow) return { ui: { ...ui, headerCursor: Math.min(max, ui.headerCursor + 1) } };
  const action = items[Math.min(ui.headerCursor, max)];
  if (key.return && action) return { ui, effect: { type: 'ui_action', action } };
  return typeIntoChat(ui, input, key, ctx) ?? { ui };
}

function handleMain(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  if (key.tab) key = { ...key, upArrow: key.shift, downArrow: !key.shift, tab: false };
  if (key.upArrow) return { ui, effect: { type: 'review_move', delta: -1 } };
  if (key.downArrow) return { ui, effect: { type: 'review_move', delta: 1 } };
  if (key.pageUp) return { ui, effect: { type: 'review_scroll', delta: -Math.max(1, ctx.page - 2) } };
  if (key.pageDown) return { ui, effect: { type: 'review_scroll', delta: Math.max(1, ctx.page - 2) } };
  return typeIntoChat(ui, input, key, ctx) ?? { ui };
}

function handlePeople(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  const max = Math.max(0, ctx.peopleCount - 1);
  if (key.tab) key = { ...key, upArrow: key.shift, downArrow: !key.shift, tab: false };
  if (key.upArrow) return { ui: { ...ui, peopleCursor: Math.max(0, ui.peopleCursor - 1) } };
  if (key.downArrow) return { ui: { ...ui, peopleCursor: Math.min(max, ui.peopleCursor + 1) } };
  if (key.return || key.rightArrow) {
    return { ui: { ...ui, menu: { menu: { kind: 'person', index: Math.min(ui.peopleCursor, max) }, selected: 0 } } };
  }
  return typeIntoChat(ui, input, key, ctx) ?? { ui };
}

function handleFiles(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  if (key.tab) key = { ...key, upArrow: key.shift, downArrow: !key.shift, tab: false };
  if (key.upArrow) return { ui, effect: { type: 'browser_move', delta: -1 } };
  if (key.downArrow) return { ui, effect: { type: 'browser_move', delta: 1 } };
  if (key.pageUp) return { ui, effect: { type: 'browser_move', delta: -ctx.page } };
  if (key.pageDown) return { ui, effect: { type: 'browser_move', delta: ctx.page } };
  if (key.return || key.rightArrow) return { ui, effect: { type: 'browser_enter' } };
  if (key.leftArrow || key.backspace || key.delete) return { ui, effect: { type: 'browser_up' } };
  if (input === 'd') return { ui, effect: { type: 'download' } };
  return typeIntoChat(ui, input, key, ctx) ?? { ui };
}

function handleViewer(ui: UiState, input: string, key: KeyInfo, ctx: KeyContext): KeyResult {
  const page = Math.max(1, ctx.page - 2);
  if (key.upArrow) return { ui, effect: { type: 'viewer_scroll', delta: -1 } };
  if (key.downArrow) return { ui, effect: { type: 'viewer_scroll', delta: 1 } };
  if (key.pageUp) return { ui, effect: { type: 'viewer_scroll', delta: -page } };
  if (key.pageDown) return { ui, effect: { type: 'viewer_scroll', delta: page } };
  if (key.backspace || key.delete) return { ui: { ...ui, focus: 'chat', viewerFull: false }, effect: { type: 'viewer_close' } };
  if (input === 'd') return { ui, effect: { type: 'download' } };
  if (input === 'f') return { ui: { ...ui, viewerFull: !ui.viewerFull } };
  if (input === 'r') return { ui: { ...ui, viewerRaw: !ui.viewerRaw } };
  return typeIntoChat(ui, input, key, ctx) ?? { ui };
}

function cycleFocus(ui: UiState, ctx: KeyContext, dir: 1 | -1): UiState {
  const order: Focus[] = ['chat'];
  if (ctx.headerItems?.length) order.push('header');
  order.push('projects');
  if (ctx.peopleCount > 1) order.push('people');
  if (ctx.filesVisible) order.push('files');
  if (ctx.mainFocusable) order.push('main');
  if (ctx.terminalVisible) order.push('terminal');
  if (ctx.hasViewer) order.push('viewer');
  const idx = Math.max(0, order.indexOf(ui.focus));
  const focus = order[(idx + dir + order.length) % order.length] ?? 'chat';
  // Landing on an area highlights all of it; Enter goes inside (on its first item).
  return { ...ui, focus, entered: false };
}

/**
 * When a terminal sends Option as Meta (iTerm "Esc+", Ghostty, kitty, Warp…), the Option
 * chords that type "@" on Mac layouts arrive as Meta+letter instead. Translate them back.
 * Turkish Q: Option+Q · German/Swiss: Option+L · Spanish: Option+2.
 */
const OPTION_CHARS: Readonly<Record<string, string>> = { q: '@', l: '@', '2': '@' };

/** Modeless key handling: you're always typing, Tab moves between panels, Esc comes back. */
export function handleKey(raw: UiState, rawInput: string, rawKey: KeyInfo, ctx: KeyContext): KeyResult {
  const optionChar = rawKey.meta && !rawKey.ctrl ? OPTION_CHARS[rawInput] : undefined;
  const input = optionChar ?? rawInput;
  const key = optionChar ? { ...rawKey, meta: false } : rawKey;
  const isCtrlC = Boolean(key.ctrl) && input === 'c';
  const ui = isCtrlC || !raw.quitArmed ? raw : { ...raw, quitArmed: false };
  if (isCtrlC) {
    if (ui.buffer) return { ui: setBuffer(ui, '') };
    if (ui.quitArmed) return { ui, effect: { type: 'quit' } };
    return { ui: { ...ui, quitArmed: true }, effect: { type: 'toast', text: 'Press Ctrl+C again to quit' } };
  }
  // Text size on any keyboard layout (⌘+ can be unreachable, e.g. Shift+4 on Turkish Q).
  // Option/Alt+↑↓ is the advertised key; Ctrl+↑↓ also works where the OS doesn't claim it.
  if ((key.meta || key.ctrl) && (key.upArrow || key.downArrow)) return { ui, effect: { type: 'zoom', dir: key.upArrow ? 'in' : 'out' } };
  // Approvals come first so they can be answered even while help is open.
  if (ctx.hasApproval && key.ctrl && (input === 'y' || input === 'n' || input === 't')) {
    const answer = input === 'y' ? 'yes' : input === 'n' ? 'no' : 'always';
    return { ui, effect: { type: 'approve', answer } };
  }
  if (ui.menu) return handleMenu(ui, ui.menu, input, key, ctx);
  // Claude's plan, full screen: scroll it, close it, or keep typing what to change.
  if (ctx.planId && key.ctrl && input === 'f') return { ui: { ...ui, planFull: ui.planFull ? undefined : ctx.planId, planScroll: 0, focus: 'chat' } };
  if (ui.planFull && ctx.planId === ui.planFull) {
    const max = ctx.planMaxScroll ?? 0;
    const step = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -Math.max(1, ctx.page - 2) : key.pageDown ? Math.max(1, ctx.page - 2) : 0;
    if (step) return { ui: { ...ui, planScroll: Math.min(max, Math.max(0, ui.planScroll + step)) } };
    if (key.escape) return { ui: { ...ui, planFull: undefined, planScroll: 0 } };
  }
  if (ctx.overlay) {
    if (key.escape || key.return || input === 'q') return { ui: { ...ui, overlayScroll: 0 }, effect: { type: 'close_overlay' } };
    const delta = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -ctx.page : key.pageDown ? ctx.page : 0;
    return { ui: { ...ui, overlayScroll: Math.max(0, ui.overlayScroll + delta) } };
  }
  const focus = ui.focus === 'viewer' && !ctx.hasViewer ? 'chat' : ui.focus;
  const current = focus === ui.focus ? ui : { ...ui, focus };
  const suggesting = current.focus === 'chat' && !current.suggestHidden && ctx.suggestions.length > 0;
  // Shift+Tab in the chat switches plan mode (like Claude Code); elsewhere it goes back an area.
  if (key.tab && key.shift && current.focus === 'chat' && !suggesting) return { ui: current, effect: { type: 'toggle_plan' } };
  const area = current.focus !== 'chat' && current.focus !== 'viewer';
  if (key.tab && !suggesting && !(area && current.entered)) return { ui: cycleFocus(current, ctx, key.shift ? -1 : 1) };
  if (key.escape && current.focus === 'viewer' && current.viewerFull) return { ui: { ...current, viewerFull: false } };
  if (key.escape && area && current.entered) return { ui: { ...current, entered: false } };
  if (key.escape && current.focus !== 'chat') return { ui: { ...current, focus: 'chat', entered: false } };
  // On an area (not inside yet): Enter or an arrow goes in, starting at the first item.
  if (area && !current.entered && (key.return || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) {
    const start = current.focus === 'header' ? (ctx.headerStart ?? 0) : 0;
    const inside: UiState = { ...current, entered: true, headerCursor: current.focus === 'header' ? start : current.headerCursor, projectsCursor: current.focus === 'projects' ? 0 : current.projectsCursor, peopleCursor: current.focus === 'people' ? 0 : current.peopleCursor };
    if (current.focus === 'files') return { ui: inside, effect: { type: 'browser_move', delta: -10_000 } };
    if (current.focus === 'main') return { ui: inside, effect: { type: 'review_move', delta: -10_000 } };
    return { ui: inside };
  }
  // Fast typing or pasting can deliver "text\r" as one chunk: type the text, then press Enter.
  if (current.focus === 'chat' && !key.return && input.length > 1 && /[\r\n]$/.test(input)) {
    return submit(handleChat(current, input.replace(/[\r\n]+$/, ''), key, ctx).ui);
  }
  if (current.focus === 'projects') return handleProjects(current, input, key, ctx);
  if (current.focus === 'header') return handleHeader(current, input, key, ctx);
  if (current.focus === 'main') return handleMain(current, input, key, ctx);
  if (current.focus === 'people') return handlePeople(current, input, key, ctx);
  if (current.focus === 'files') return handleFiles(current, input, key, ctx);
  if (current.focus === 'viewer') return handleViewer(current, input, key, ctx);
  return handleChat(current, input, key, ctx);
}
