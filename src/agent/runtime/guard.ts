import type { AgentBackend } from '../types.js';
import { type RuntimeCapabilities, safetyFor } from './types.js';

/**
 * A runtime's backend as the session layer runs it: the safety rule applied to every run (see
 * safetyFor). A runtime that gates every tool runs as it is; one that can't is told to run
 * sandboxed, and refuses friends' tasks and guests.
 */
export function guardedBackend(backend: AgentBackend, caps: RuntimeCapabilities): AgentBackend {
  if (caps.canGateEveryTool) return backend;
  return Object.assign(Object.create(backend) as AgentBackend, {
    run: (input: Parameters<AgentBackend['run']>[0]) => {
      const safety = safetyFor(caps, input);
      if (safety.kind === 'sandbox' && safety.refuse) return Promise.reject(new Error(safety.refuse));
      return backend.run({ ...input, sandbox: true });
    },
  });
}
