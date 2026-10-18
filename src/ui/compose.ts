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
