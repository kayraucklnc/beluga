/**
 * Where a workspace's scratch folder is, from its root: in klaud's own `.klaud/` (beside reports),
 * never `.context/`, which other tools (Conductor) keep for themselves in the same worktrees.
 */
export const SCRATCH_DIR = '.klaud/scratch';

/**
 * The folders the Scratch tab shows, from the workspace's root: klaud's own, then `.context/`, where
 * Claude saves the same kind of files when another tool (Conductor) runs it in this worktree. That
 * one is only looked at: klaud never makes it, writes to it or keeps it out of git.
 */
export const SHOWN_SCRATCH_DIRS = [SCRATCH_DIR, '.context'] as const;

/** Each sub-agent's own folder in it: `.klaud/scratch/agents/<name>/`. */
export const AGENT_SCRATCH_DIR = `${SCRATCH_DIR}/agents`;

/** A sub-agent's folder name, from the tool call that started it (Claude Code records it for the agent too). */
export const agentScratchName = (toolUseId: string): string => toolUseId.replace(/[^\w-]/g, '').slice(-10) || 'agent';
