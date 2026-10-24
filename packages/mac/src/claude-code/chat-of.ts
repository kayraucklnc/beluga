import type { CcSession } from '../../../../src/core/claude-code/model.js';
import type { AppState } from '../../../../src/core/store.js';

/**
 * The chat a session opens in Beluga: the chat of the folder it runs in (any worktree Beluga knows,
 * not archived). A session there is often a separate conversation (a terminal's), so that chat
 * shows it live as a strip at the top (LiveStrip) beside Beluga's own. A session in a project's
 * main folder (no conversation of its own, BLG-70) or a folder Beluga doesn't know has no chat:
 * it opens as its transcript.
 */
export function chatOf(state: Pick<AppState, 'projects'>, s: Pick<CcSession, 'workspaceId'>): string | undefined {
  const ws = s.workspaceId ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === s.workspaceId) : undefined;
  return ws && !ws.archived && ws.kind !== 'main' ? ws.id : undefined;
}
