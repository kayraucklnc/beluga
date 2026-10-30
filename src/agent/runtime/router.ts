import type { AgentBackend, AgentRunInput } from '../types.js';
import type { RuntimeId } from './types.js';

/**
 * One backend for the session layer that runs each turn on its place's runtime (BLG-445): this
 * worktree's Claude and that one's Codex side by side. `backendFor` makes (once) and returns a
 * runtime's backend, already guarded (guard.ts); undefined for one this Beluga doesn't run.
 * Everything that isn't a turn (naming a worktree, usage, side calls) stays with the default's.
 */
export function routedBackend(fallback: AgentBackend, fallbackRuntime: RuntimeId, backendFor: (id: RuntimeId) => AgentBackend | undefined): AgentBackend {
  const made = new Map<RuntimeId, AgentBackend>([[fallbackRuntime, fallback]]);
  const pick = (id: RuntimeId): AgentBackend | undefined => {
    if (!made.has(id)) {
      const b = backendFor(id);
      if (b) made.set(id, b);
    }
    return made.get(id);
  };
  return Object.assign(Object.create(fallback) as AgentBackend, {
    run: (input: AgentRunInput) => {
      const id = input.place?.agent?.runtime ?? fallbackRuntime;
      const backend = pick(id);
      if (!backend) return Promise.reject(new Error(`${input.place?.agent?.label ?? id} isn't set up on this Mac. Pick another agent for this worktree.`));
      return backend.run(input);
    },
  });
}
