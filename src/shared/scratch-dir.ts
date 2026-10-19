/**
 * Where a workspace's scratch folder is, from its root: in klaud's own `.klaud/` (beside reports),
 * never `.context/`, which other tools (Conductor) keep for themselves in the same worktrees.
 */
export const SCRATCH_DIR = '.klaud/scratch';

/** Each sub-agent's own folder in it: `.klaud/scratch/agents/<name>/`. */
export const AGENT_SCRATCH_DIR = `${SCRATCH_DIR}/agents`;

/** A sub-agent's folder name, from the tool call that started it (Claude Code records it for the agent too). */
export const agentScratchName = (toolUseId: string): string => toolUseId.replace(/[^\w-]/g, '').slice(-10) || 'agent';
