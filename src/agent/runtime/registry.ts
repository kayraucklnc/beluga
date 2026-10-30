import { claudeRuntime } from './claude/index.js';
import type { AgentRuntime, RuntimeId } from './types.js';

/** The runtime an agent runs on when none is named. */
export const DEFAULT_RUNTIME: RuntimeId = 'claude';

const RUNTIMES: ReadonlyMap<RuntimeId, AgentRuntime> = new Map([[claudeRuntime.id, claudeRuntime]]);

/** The runtime an AgentRef names (only 'claude' is registered yet); undefined for one this Beluga doesn't know. */
export function runtimeFor(id: RuntimeId = DEFAULT_RUNTIME): AgentRuntime | undefined {
  return RUNTIMES.get(id);
}
