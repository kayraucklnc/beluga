import { claudeRuntime } from './claude/index.js';
import { codexRuntime } from './codex/index.js';
import type { AgentRuntime, RuntimeId } from './types.js';

/** The runtime an agent runs on when none is named. */
export const DEFAULT_RUNTIME: RuntimeId = 'claude';

const RUNTIMES: ReadonlyMap<RuntimeId, AgentRuntime> = new Map([
  [claudeRuntime.id, claudeRuntime],
  [codexRuntime.id, codexRuntime],
]);

/** The runtime an AgentRef names ('claude', 'codex'); undefined for one this Beluga doesn't know. */
export function runtimeFor(id: RuntimeId = DEFAULT_RUNTIME): AgentRuntime | undefined {
  return RUNTIMES.get(id);
}
