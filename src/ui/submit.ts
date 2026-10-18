import { type AppState, channelOf, peerName } from '../core/store.js';
import type { KlaudClient } from '../ipc/client.js';
import { answerTyped } from './collab-actions.js';
import type { UiState } from './keymap.js';
import type { UiAction } from './workspace-models.js';

export interface SubmitContext {
  readonly client: KlaudClient;
  /** The screen's latest UI state (what the box is asking for, a plan open full screen). */
  readonly ui: () => Pick<UiState, 'pending' | 'planFull'>;
  readonly patchUi: (patch: Partial<UiState>) => void;
  readonly runUiAction: (action: UiAction) => void;
  /** Turn attachment chips into links before sending (each screen attaches its own way). */
  readonly expand?: (text: string) => string;
}

/**
 * Send what was typed in the box, wherever it belongs: an answer to Claude's question, a
 * command for a shared workspace's shell, the first message of a new chat or worktree, a name
 * the box asked for, a search, or a message in the conversation on screen. Both screens use it.
 */
export function submitTyped(c: SubmitContext, typed: string, urgent = false): void {
  const { client, patchUi } = c;
  const { api, store } = client;
  const toast = (text: string): void => store.dispatch({ type: 'toast', text, level: 'warn' });
  const latest: AppState = store.getState();
  const text = c.expand ? c.expand(typed) : typed;
  const ui = c.ui();
  // While Claude waits on a question in this conversation, what you type here is your answer.
  const question = latest.questions[0];
  if (question && (question.channel === channelOf(latest.view) || ui.planFull === question.qid) && !text.startsWith('/')) {
    answerTyped(client, question, text);
    patchUi({ planFull: undefined, planScroll: 0 });
    return;
  }
  // A shared workspace's Terminal tab: what you type is a command for its read-only shell.
  if (latest.view.kind === 'shared' && latest.view.tab === 'terminal' && !text.startsWith('/')) {
    void api.shell.run(latest.view.id, text);
    patchUi({ chatScroll: 0 });
    return;
  }
  if (latest.view.kind === 'draft' && !text.startsWith('/')) {
    void api.workspaces.startChat(latest.view.projectId, text, latest.view.dir);
    return;
  }
  if (latest.view.kind === 'draft_worktree' && !text.startsWith('/')) {
    void api.workspaces.startWorktree(latest.view.projectId, text);
    return;
  }
  const pending = ui.pending;
  if (pending?.kind === 'peer_run' && pending.peerId) {
    if (!text.trim()) return toast('Type a command first, or Esc to cancel');
    patchUi({ pending: undefined });
    void api.session.runOnPeerByHand(peerName(latest, pending.peerId), text.trim(), channelOf(latest.view));
    return;
  }
  if (pending) {
    // Only commands may be empty (to clear them); names and tasks need words.
    if (!text.trim() && pending.kind !== 'setup' && pending.kind !== 'run') {
      toast(pending.kind === 'remote' ? 'Describe the task first, or Esc to cancel' : 'Type a name first, or Esc to cancel');
      return;
    }
    patchUi({ pending: undefined });
    if (pending.kind === 'group') void api.workspaces.setGroup(pending.projectId, text);
    else if (pending.kind === 'setup' || pending.kind === 'run') void api.workbench.setScript(pending.projectId, pending.kind, text);
    else if (pending.kind === 'remote' && pending.peerId) void api.remote.requestWorktree(pending.peerId, pending.projectId, text, latest.planMode.room === true);
    else void (pending.kind === 'worktree' ? api.workspaces.newWorktree(pending.projectId, text) : api.workspaces.newChat(pending.projectId, text));
    return;
  }
  // In Search, Enter opens the highlighted result.
  if (latest.view.kind === 'search' && !text.startsWith('/')) {
    if (latest.search.hits.length) c.runUiAction({ type: 'search_hit', index: latest.search.cursor });
    return;
  }
  void api.session.submit(text, { channel: channelOf(latest.view), urgent });
}
