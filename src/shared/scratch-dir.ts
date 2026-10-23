/** Beluga's own folder in each workspace (reports, scratch), kept out of git. */
export const PROJECT_DIR = '.beluga';
/** The same folder from before the rename: still read where it's there, never made again. */
export const LEGACY_PROJECT_DIR = '.klaud';

/**
 * Where a workspace's scratch folder is, from its root: in Beluga's own `.beluga/` (beside reports),
 * never `.context/`, which other tools (Conductor) keep for themselves in the same worktrees.
 */
export const SCRATCH_DIR = `${PROJECT_DIR}/scratch`;

/**
 * The folders the Scratch tab shows, from the workspace's root: Beluga's own, the one from before the
 * rename (`.klaud/scratch`, where older runs saved), then `.context/`, where Claude saves the same kind
 * of files when another tool (Conductor) runs it in this worktree. Those are only looked at: Beluga never
 * makes them, writes to them or keeps them out of git.
 */
export const SHOWN_SCRATCH_DIRS = [SCRATCH_DIR, `${LEGACY_PROJECT_DIR}/scratch`, '.context'] as const;

/** Each sub-agent's own folder in it: `.beluga/scratch/agents/<name>/`. */
export const AGENT_SCRATCH_DIR = `${SCRATCH_DIR}/agents`;

/** A sub-agent's folder name, from the tool call that started it (Claude Code records it for the agent too). */
export const agentScratchName = (toolUseId: string): string => toolUseId.replace(/[^\w-]/g, '').slice(-10) || 'agent';
