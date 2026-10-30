import type { AgentRuntime, RuntimeCapabilities } from '../types.js';
import type { CodexConnect } from './app-server.js';
import { codexComplete } from './complete.js';
import { createCodexBackend } from './runner.js';
import { codexStatus } from './status.js';

/** Codex through `codex app-server` (BLG-453): what it can and can't do of what Beluga asks. */
export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  // Its own commands and edits run inside its sandbox without asking: only what leaves the
  // sandbox comes to Beluga. So the sandbox, not per-call vetting, keeps a run in its folders.
  canGateEveryTool: false,
  // Its permissions profile confines each step (runtime/codex/sandbox.ts).
  hasSandbox: true,
  // turn/steer takes a message into the running turn.
  canSteer: true,
  canInterrupt: true,
  // No plan mode: a plan is a read-only first turn, then approval (runner.ts).
  hasPlanMode: false,
  hasSubagents: false,
  hasBackgroundAgents: false,
  // Its plan windows (account/rateLimits) and per-turn tokens, filed under Codex (BLG-474).
  hasUsage: true,
  canResume: true,
  canFork: false,
  canAskUser: false,
  hasCompaction: false,
  hasModelList: true,
  hasProcess: true,
  // Skills and commands translated (runtime/codex/skills.ts); built-ins and some frontmatter can't be.
  skills: 'mapped',
  promptImages: true,
  toolMounts: ['stdio'],
};

/** A Codex runtime; `connect` swaps how its app-server is reached (tests script one). */
export function createCodexRuntime(deps: { readonly connect?: CodexConnect } = {}): AgentRuntime {
  return {
    id: 'codex',
    label: 'Codex',
    capabilities: CODEX_CAPABILITIES,
    create: ({ executablePath, ...opts }) => createCodexBackend({ ...opts, ...(executablePath ? { codexPath: executablePath } : {}), ...(deps.connect ? { connect: deps.connect } : {}) }),
    complete: (req) => codexComplete(req, deps.connect ? { connect: deps.connect } : {}),
    status: () => codexStatus(deps.connect ? { connect: deps.connect } : {}),
  };
}

export const codexRuntime: AgentRuntime = createCodexRuntime();
