import { claudeRuntime } from './claude/index.js';
import { codexRuntime } from './codex/index.js';
import type { AgentRuntime, RuntimeId, RuntimeStatus } from './types.js';

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

/** Every runtime but the default one, with whether it's ready here (Codex: installed, signed in) and its models. */
export async function otherRuntimes(): Promise<Array<{ readonly id: RuntimeId; readonly label: string } & RuntimeStatus>> {
  const others = [...RUNTIMES.values()].filter((rt) => rt.id !== DEFAULT_RUNTIME && rt.status);
  return Promise.all(others.map(async (rt) => ({ id: rt.id, label: rt.label, ...(await rt.status!()) })));
}
