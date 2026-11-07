import type { ChatJump } from './keymap.js';

/** How long a jump waits for its conversation to show its message; after that it's not what you just asked for. */
export const JUMP_TTL_MS = 10_000;
/** How long the message you jumped to stays marked. */
export const JUMP_MARK_MS = 2_000;
/** Said when a jump can't find its row: the conversation keeps only its latest items (store.ts, LOG_LIMIT). */
export const JUMP_LOST_TEXT = 'That message is too old to show here. The chat shows its latest messages.';

export type ChatJumpState = { readonly state: 'none' | 'wait' | 'drop' | 'lost' } | { readonly state: 'go'; readonly index: number };

/**
 * What a conversation does about a jump: scroll to a row, wait for its history to land (it comes
 * whole, so any rows mean it's here), say the row is not there, or forget a jump from a while ago.
 */
export function chatJumpState(jump: ChatJump | undefined, channel: string, rows: ReadonlyArray<{ readonly id: string; readonly ts: number }>, now: number): ChatJumpState {
  if (!jump || jump.channel !== channel) return { state: 'none' };
  if (now - jump.at > JUMP_TTL_MS) return { state: rows.length ? 'drop' : 'lost' };
  if (!rows.length) return { state: 'wait' };
  const index = rows.findIndex((r) => (jump.id ? r.id === jump.id : r.ts === jump.ts));
  return index < 0 ? { state: 'lost' } : { state: 'go', index };
}
