import type { AppState } from '../../../../src/core/store.js';
import { defaultAgentOf } from '../../../../src/protocol.js';
import { runtimeOf } from '../../../../src/shared/agent-picker.js';

/**
 * How a conversation shows in the middle of the window (BLG-534): the chat, the agent's own
 * terminal app on the same conversation, or both side by side. Remembered per conversation;
 * one you haven't switched opens your default. Pure: the prefs keep it (lib/prefs.ts).
 */

export type ConvoMode = 'chat' | 'terminal' | 'both';

export const CONVO_MODES: readonly ConvoMode[] = ['chat', 'terminal', 'both'];

/** Conversations remembered (the oldest switch is forgotten past this). */
const KEEP = 200;

export const isConvoMode = (v: unknown): v is ConvoMode => typeof v === 'string' && (CONVO_MODES as readonly string[]).includes(v);

/** A conversation's mode: the one you picked there, else your default. */
/** How a conversation shows given your settings: always the chat while the terminal view is off. */
export function shownMode(prefs: { readonly termView: boolean; readonly convoModes: Readonly<Record<string, ConvoMode>>; readonly convoDefault: ConvoMode }, wsId: string): ConvoMode {
  return prefs.termView ? convoModeOf(prefs.convoModes, prefs.convoDefault, wsId) : 'chat';
}

export function convoModeOf(modes: Readonly<Record<string, ConvoMode>>, fallback: ConvoMode, wsId: string): ConvoMode {
  const m = modes[wsId];
  return isConvoMode(m) ? m : fallback;
}

/** The modes with this conversation's switched (the newest last, so the oldest goes first). */
export function withConvoMode(modes: Readonly<Record<string, ConvoMode>>, wsId: string, mode: ConvoMode): Record<string, ConvoMode> {
  const { [wsId]: _was, ...rest } = modes;
  const entries = [...Object.entries(rest).filter(([, m]) => isConvoMode(m)), [wsId, mode] as const];
  return Object.fromEntries(entries.slice(-KEEP));
}

/** The next mode for the Chat ⇄ Terminal shortcut: Both and Terminal go to Chat; Chat goes to Terminal. */
export const toggledMode = (mode: ConvoMode): ConvoMode => (mode === 'chat' ? 'terminal' : 'chat');

/** Bounds of the chat's share in Both. */
export const BOTH_MIN = 0.25;
export const BOTH_MAX = 0.6;
export const clampBoth = (share: number): number => Math.min(BOTH_MAX, Math.max(BOTH_MIN, Number.isFinite(share) ? share : 0.38));

/** Bounds of the visuals panel beside the terminal. */
export const VISUALS_MIN = 360;
export const clampVisuals = (width: number, room: number): number => Math.round(Math.min(Math.max(VISUALS_MIN, width), Math.max(VISUALS_MIN, room * 0.62)));

/**
 * Whether a workspace's conversation can show as a terminal: yours, made, not a project's main
 * checkout, and on Claude Code (a local model runs in it too). Codex's stays in the chat.
 */
export function terminalCapable(state: AppState, wsId: string | undefined): boolean {
  const ws = wsId ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId) : undefined;
  if (!ws || ws.archived || ws.kind === 'main' || (ws.kind === 'worktree' && ws.external)) return false;
  return runtimeOf(state, `ws:${ws.id}`, defaultAgentOf(state.self).runtime) !== 'codex';
}
