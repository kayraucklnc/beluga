import type { AgentBackend, AgentRunInput } from '../types.js';
import type { RuntimeId } from './types.js';

/**
 * One backend for the session layer that runs each turn on its place's runtime (BLG-445): this
 * worktree's Claude and that one's Codex side by side. `backendFor` makes (once) and returns a
 * runtime's backend, already guarded (guard.ts); undefined for one this Beluga doesn't run.
 * Everything that isn't a turn (naming a worktree, side calls) stays with the default's; usage is
 * asked of every runtime in `alsoUsage` too.
 */
export function routedBackend(fallback: AgentBackend, fallbackRuntime: RuntimeId, backendFor: (id: RuntimeId) => AgentBackend | undefined, alsoUsage: readonly RuntimeId[] = []): AgentBackend {
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
    // A side question (/btw) forks the conversation's own session: on its runtime, or not at all.
    btw: (req: Parameters<NonNullable<AgentBackend['btw']>>[0]) => {
      const id = req.runtime ?? fallbackRuntime;
      const backend = pick(id);
      if (!backend?.btw) return Promise.reject(new Error(`Side questions aren’t available on ${id === 'codex' ? 'Codex' : 'this agent'} yet`));
      return backend.btw(req);
    },
    // Usage: the default's comes back (Claude's, filed by the session); the others in `alsoUsage`
    // report their own through the bridge, under their own agent (Codex's plan windows, BLG-474).
    refreshUsage: async () => {
      for (const id of alsoUsage) if (id !== fallbackRuntime) void pick(id)?.refreshUsage?.().catch(() => undefined);
      return fallback.refreshUsage?.();
    },
  });
}
