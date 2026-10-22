import { type AppState, channelOf, shownChannel } from '@klaud/core/store.js';
import { runId } from '@klaud/shared/terminal-keys.js';
import { isRunning } from '@klaud/ui/format.js';
import { type WorkspaceAction, findWorkspace, workspaceButtons } from '@klaud/ui/workspace-models.js';
import { worktreeOrigin } from '@klaud/workspaces/origin.js';
import type { Workspace } from '@klaud/workspaces/types.js';
import type { SocketClient } from '@klaud/ipc/socket-client.js';
import type { Actions } from './actions.js';
import type { UiStore } from './klaud.js';

/**
 * The window's commands that the menu bar, the keyboard and the buttons share: what each does,
 * whether it can run right now (and why not), so a menu item is greyed out exactly when its
 * button is, and a shortcut pressed at the wrong moment says why instead of doing nothing.
 */

export interface CommandCtx {
  readonly client: SocketClient;
  readonly ui: UiStore;
  readonly actions: Actions;
}

export interface CommandState {
  readonly enabled: boolean;
  /** Why it can't run (said in a toast when its shortcut is pressed anyway). */
  readonly why?: string;
  /** For a toggle (Plan First): on or off. */
  readonly checked?: boolean;
  /** A label that changes with the state (Run / Stop Running). */
  readonly label?: string;
}

export const COMMAND_IDS = [
  'conv-stop',
  'conv-plan',
  'conv-find',
  'conv-find-next',
  'conv-find-prev',
  'conv-copy',
  'conv-clear',
  'ws-commit',
  'ws-pr',
  'ws-merge',
  'ws-run',
  'ws-review',
  'ws-finder',
  'ws-fork',
  'ws-archive',
  'ws-next',
  'ws-prev',
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

/** Shortcuts as the menu bar shows them (the same keys work in the window, see useCommandKeys). */
export const COMMAND_KEYS: Partial<Record<CommandId, string>> = {
  'conv-stop': '⌘.',
  'conv-plan': '⌥⌘P',
  'conv-find': '⌘F',
  'conv-find-next': '⌘G',
  'conv-find-prev': '⇧⌘G',
  'conv-clear': '⇧⌘K',
  'ws-commit': '⇧⌘C',
  'ws-pr': '⇧⌘P',
  'ws-merge': '⇧⌘M',
  'ws-run': '⌘R',
  'ws-review': '⇧⌘R',
  'ws-archive': '⌃⌘A',
  'ws-next': '⌥⌘↓',
  'ws-prev': '⌥⌘↑',
};

/** The workspace action behind each workspace command (its toolbar button). */
const WS_ACTION: Partial<Record<CommandId, WorkspaceAction>> = {
  'ws-commit': 'commit',
  'ws-pr': 'pr',
  'ws-merge': 'merge',
  'ws-run': 'run',
  'ws-review': 'review_claude',
  'ws-finder': 'finder',
  'ws-fork': 'fork',
  'ws-archive': 'archive',
};

const OFF = (why: string): CommandState => ({ enabled: false, why });
const ON: CommandState = { enabled: true };

/** The workspace on screen (any of its tabs). */
export function currentWorkspace(state: AppState): Workspace | undefined {
  return state.view.kind === 'workspace' ? findWorkspace(state.projects, state.view.id) : undefined;
}

/** The conversation on screen, if one is (a workspace counts on any of its tabs). */
export function currentChannel(state: AppState): string | undefined {
  // A conversation with friends (the klaud network) has no Claude to stop, plan or clear.
  if (state.view.kind === 'conversation') return undefined;
  return state.view.kind === 'workspace' ? channelOf(state.view) : shownChannel(state.view);
}

/** Your Claude is working in this conversation right now (not just queued or waiting for approval). */
export function claudeWorkingIn(state: AppState, channel: string): boolean {
  return state.log.some((l) => l.type === 'agent' && l.channel === channel && l.owner === state.selfId && isRunning(l.status) && l.status !== 'queued' && l.status !== 'awaiting_approval');
}

/** The conversation itself is showing (not a workspace's Files, Diff or Terminal tab). */
const chatShowing = (state: AppState): boolean => {
  const v = state.view;
  return v.kind === 'room' || v.kind === 'draft' || v.kind === 'draft_worktree' || ((v.kind === 'workspace' || v.kind === 'shared') && v.tab === 'chat');
};

/** A workspace's run script is running. */
export const runRunning = (state: AppState, wsId: string): boolean => runId(wsId) in state.terminals && !(runId(wsId) in state.termExits);

/** Every live workspace in the sidebar's order: chats first, then each project's own worktrees. */
export function workspaceOrder(state: AppState): Workspace[] {
  const visible = (w: Workspace): boolean => !w.archived && worktreeOrigin(w) !== 'agent';
  const chats = state.projects.filter((p) => !p.root);
  const grouped = new Set(state.projectGroups.flatMap((g) => g.projects));
  const loose = state.projects.filter((p) => p.root && !grouped.has(p.root));
  const inGroups = state.projectGroups.flatMap((g) => state.projects.filter((p) => p.root && g.projects.includes(p.root)));
  return [...chats, ...loose, ...inGroups].flatMap((p) => p.workspaces.filter(visible));
}

/** Whether a command can run now, and why not. */
export function commandState(state: AppState, id: CommandId): CommandState {
  const channel = currentChannel(state);
  const ws = currentWorkspace(state);
  switch (id) {
    case 'conv-stop':
      if (!channel || channel === 'draft') return OFF('Open a conversation where Claude is working');
      return claudeWorkingIn(state, channel) ? ON : OFF("Your Claude isn't working here");
    case 'conv-plan':
      if (!channel || channel === 'draft' || state.view.kind === 'shared') return OFF('Plan mode is for your own conversations');
      return { enabled: true, checked: state.planMode[channel] === true };
    case 'conv-find':
    case 'conv-find-next':
    case 'conv-find-prev':
      return chatShowing(state) && state.view.kind !== 'draft' && state.view.kind !== 'draft_worktree' ? ON : OFF('Open a conversation to find in it');
    case 'conv-copy':
      return state.log.some((l) => l.type === 'agent' && l.status === 'done') ? ON : OFF('No Claude answer to copy yet');
    case 'conv-clear':
      return channel && channel !== 'draft' && state.view.kind !== 'shared' ? ON : OFF('Open a conversation to clear it');
    case 'ws-next':
    case 'ws-prev':
      return workspaceOrder(state).length ? ON : OFF('No workspaces yet');
    default: {
      const action = WS_ACTION[id];
      if (!ws || !action) return OFF('Open a workspace first');
      const button = workspaceButtons(state, ws).find((b) => b.action === action || (action === 'merge' && b.action === 'merge_claude'));
      if (id === 'ws-run') {
        if (runRunning(state, ws.id)) return { enabled: true, label: 'Stop Running' };
        if (!button) return { ...OFF(`${ws.name} has no run script yet (Terminal tab › Run)`), label: 'Run' };
        return { enabled: true, label: 'Run' };
      }
      if (!button) return OFF(ws.kind === 'chat' ? `Not for a chat` : ws.kind === 'main' ? 'Not for the main folder' : 'Not available here');
      return button.disabled ? OFF(button.hint) : ON;
    }
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Stop your Claude in one conversation. Your messages that were waiting there come back into
 * the box (ahead of anything you're typing), so nothing you wrote is lost.
 */
export function stopClaude({ client, ui }: CommandCtx, channel: string): void {
  client.api.host.stopRun(channel).then(
    ({ returned }) => {
      if (!returned.length) return;
      const state = client.store.getState();
      // In a group room only a mention reaches your Claude.
      const toClaude = (p: string): string => (channel === 'room' && state.peers.length > 1 && !p.startsWith('@') ? `@claude ${p}` : p);
      const current = ui.get().buffer.trim();
      const buffer = [...returned.map(toClaude), current].filter(Boolean).join('\n');
      ui.patch({ buffer, cursor: buffer.length });
      document.dispatchEvent(new CustomEvent('klaud:focus-composer'));
    },
    (err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn't stop Claude: ${errorText(err)}`, level: 'error' }),
  );
}

/** Go to the next (or previous) workspace in the sidebar's order. */
function stepWorkspace({ actions, client }: CommandCtx, delta: 1 | -1): void {
  const state = client.store.getState();
  const list = workspaceOrder(state);
  if (!list.length) return;
  const at = state.view.kind === 'workspace' ? list.findIndex((w) => w.id === (state.view as { id: string }).id) : -1;
  const next = at < 0 ? (delta > 0 ? list[0] : list[list.length - 1]) : list[(at + delta + list.length) % list.length];
  if (next) actions.run({ type: 'open_ws', id: next.id });
}

// A shortcut and its menu item can both see one key press; run it once.
const lastRun = new Map<CommandId, number>();
const ONCE_MS = 150;

/** Run a command (from the menu bar, a shortcut or a button); when it can't run, say why. */
export function runCommand(ctx: CommandCtx, id: CommandId): void {
  const now = Date.now();
  if (now - (lastRun.get(id) ?? 0) < ONCE_MS) return;
  lastRun.set(id, now);
  const { client, ui, actions } = ctx;
  const state = client.store.getState();
  const st = commandState(state, id);
  if (!st.enabled) {
    client.store.dispatch({ type: 'toast', text: st.why ?? 'Not available right now', level: 'info' });
    return;
  }
  const channel = currentChannel(state);
  const ws = currentWorkspace(state);
  switch (id) {
    case 'conv-stop':
      if (channel) stopClaude(ctx, channel);
      return;
    case 'conv-plan':
      if (channel) void client.api.session.setPlanMode(channel, !st.checked);
      return;
    case 'conv-find':
      document.dispatchEvent(new CustomEvent('klaud:find'));
      return;
    case 'conv-find-next':
    case 'conv-find-prev':
      document.dispatchEvent(new CustomEvent('klaud:find-step', { detail: id === 'conv-find-next' ? 1 : -1 }));
      return;
    case 'conv-copy':
      void client.api.session.copyLastAnswer();
      return;
    case 'conv-clear':
      if (channel) ui.openMenu({ kind: 'clear', channel, host: state.isHost });
      return;
    case 'ws-next':
    case 'ws-prev':
      stepWorkspace(ctx, id === 'ws-next' ? 1 : -1);
      return;
    default: {
      const action = WS_ACTION[id];
      if (!ws || !action) return;
      if (id === 'ws-run' && runRunning(state, ws.id)) return actions.run({ type: 'ws', id: ws.id, action: 'stop_run' });
      // A conflict turns Merge into "Solve conflict" (Claude finishes the merge).
      const solve = action === 'merge' && state.conflicts[ws.id]?.length;
      // Part of a plan: merging (or solving) by hand asks first, in actions.run (lib/plan-merge.ts).
      actions.run({ type: 'ws', id: ws.id, action: solve ? 'merge_claude' : action });
    }
  }
}

/** Which key press is which command (the menu bar shows the same keys). */
export function commandForKey(e: KeyboardEvent): CommandId | undefined {
  // ⌘ only: ⌃R, ⌃G… belong to the shell in a terminal.
  if (!e.metaKey) return undefined;
  const k = e.key.toLowerCase();
  if (e.ctrlKey) return !e.altKey && !e.shiftKey && e.code === 'KeyA' ? 'ws-archive' : undefined;
  if (e.altKey && !e.shiftKey && e.code === 'KeyP') return 'conv-plan';
  if (e.altKey && e.key === 'ArrowDown') return 'ws-next';
  if (e.altKey && e.key === 'ArrowUp') return 'ws-prev';
  if (e.altKey) return undefined;
  if (!e.shiftKey && e.key === '.') return 'conv-stop';
  if (!e.shiftKey && k === 'f') return 'conv-find';
  if (k === 'g') return e.shiftKey ? 'conv-find-prev' : 'conv-find-next';
  if (!e.shiftKey && k === 'r') return 'ws-run';
  if (e.shiftKey) {
    if (k === 'c') return 'ws-commit';
    if (k === 'p') return 'ws-pr';
    if (k === 'm') return 'ws-merge';
    if (k === 'r') return 'ws-review';
    if (k === 'k') return 'conv-clear';
  }
  return undefined;
}
