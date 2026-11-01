import type { OtherTools } from '../core/other-worktrees.js';
import { readConductorWorkspaces } from '../workspaces/conductor.js';
import { conversationsUnder, listConversations } from './runtime/claude/claude-sessions.js';
import { findCreators } from './runtime/claude/worktree-creators.js';

/** The real readers of other tools' data on this Mac (read-only): Claude Code's transcripts and Conductor's database. */
export const otherTools: OtherTools = {
  conversations: (dir) => listConversations(dir),
  conversationsUnder: (dir) => conversationsUnder(dir),
  conductor: () => readConductorWorkspaces(),
  creators: (paths, since) => findCreators(paths, { since }),
};
