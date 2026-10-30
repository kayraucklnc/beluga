import type { AgentRuntime, RuntimeCapabilities } from '../types.js';
import { createClaudeBackend } from './runner.js';

/** Claude Code through the Agent SDK can do everything Beluga asks of a runtime. */
export const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  // The PreToolUse hook runs before Claude Code's own permission logic, for every tool.
  canGateEveryTool: true,
  canSteer: true,
  canInterrupt: true,
  hasPlanMode: true,
  hasSubagents: true,
  hasBackgroundAgents: true,
  hasUsage: true,
  canResume: true,
  canFork: true,
  canAskUser: true,
  hasCompaction: true,
  hasModelList: true,
  hasProcess: true,
  promptImages: true,
  toolMounts: ['in-process'],
};

/** The Claude runtime: today's runner (runner.ts), unchanged, behind the seam. */
export const claudeRuntime: AgentRuntime = {
  id: 'claude',
  label: 'Claude',
  capabilities: CLAUDE_CAPABILITIES,
  create: ({ executablePath, ...opts }) => createClaudeBackend({ ...opts, ...(executablePath ? { claudePath: executablePath } : {}) }),
  // Side calls still go to their own modules (namer.ts, task-drafter.ts…) until BLG-441.
  complete: async () => undefined,
};
