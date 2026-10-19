import type { CcSession } from '../../../../src/core/claude-code/model.js';
import type { AppState } from '../../../../src/core/store.js';

/**
 * The chat a session belongs to in Klaud: a worktree made outside Klaud (by another app), whose
 * conversation Klaud carries on in its own chat. A session in a project's main folder or in one of
 * Klaud's worktrees is a separate conversation (a terminal's): it has no chat here.
 */
export function chatOf(state: Pick<AppState, 'projects'>, s: Pick<CcSession, 'workspaceId'>): string | undefined {
  const ws = s.workspaceId ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === s.workspaceId) : undefined;
  return ws && !ws.archived && ws.kind === 'worktree' && ws.external ? ws.id : undefined;
}
