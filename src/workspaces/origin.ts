import type { Workspace } from './types.js';

export type WorktreeOrigin = 'klaud' | 'agent' | 'external';

/** Who made a workspace: klaud (incl. main and chats), a Claude Code sub-agent, or another tool. */
export function worktreeOrigin(ws: Pick<Workspace, 'external' | 'path'>): WorktreeOrigin {
  if (!ws.external) return 'klaud';
  return /[\\/]\.claude[\\/]worktrees[\\/]/.test(ws.path) ? 'agent' : 'external';
}
