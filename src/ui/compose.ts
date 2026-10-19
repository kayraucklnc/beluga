import type { AppState } from '../core/store.js';
import { isRunning } from './format.js';
import type { UiState } from './keymap.js';
import type { ComposeState } from './actions.js';

/** Is your Claude busy in this conversation, would the draft go to it, and what of yours is waiting? */
export function composeState(state: AppState, ui: UiState, selfId: string, channel: string, shared: boolean): ComposeState & { ids: string[] } {
  const mine = state.log.filter((l): l is Extract<AppState['log'][number], { type: 'agent' }> => l.type === 'agent' && l.channel === channel && l.owner === selfId);
  const ids = mine.filter((l) => l.status === 'queued').map((l) => l.requestId);
  const busy = !shared && mine.some((l) => isRunning(l.status) && l.status !== 'queued' && l.status !== 'awaiting_approval');
  const draft = ui.buffer.trim();
  // In a group room plain chat goes to people; only a mention reaches your Claude.
  const toClaude = channel !== 'room' || state.peers.length <= 1 || draft.startsWith('@');
  return { typing: Boolean(draft) && !draft.startsWith('/') && !ui.pending && toClaude, busy, queued: ids.length, ids };
}

/** A message waiting its turn with a Claude in this conversation (the queue above the box). */
export interface QueuedMessage {
  readonly requestId: string;
  /** What was asked ('' when its Claude didn't say). */
  readonly prompt: string;
  /** Who asked. */
  readonly by: string;
  /** Whose Claude it waits for. */
  readonly claude: string;
  /** You asked your own Claude: you can run it now, edit it, drop it or move it. */
  readonly yours: boolean;
}

/** What waits in this conversation for your Claude, and what you asked others' Claudes, in run order. */
export function queueIn(state: Pick<AppState, 'log'>, channel: string, selfId: string): QueuedMessage[] {
  return state.log.flatMap((l) => {
    if (l.type !== 'agent' || l.channel !== channel || l.status !== 'queued') return [];
    const askedBySelf = l.requester !== undefined ? l.requester === selfId : l.owner === selfId && l.requesterName === l.ownerName;
    if (l.owner !== selfId && !askedBySelf) return [];
    return [{ requestId: l.requestId, prompt: l.prompt ?? '', by: l.requesterName, claude: l.ownerName, yours: l.owner === selfId && askedBySelf }];
  });
}
