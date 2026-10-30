import type { AgentRunInput } from '../../types.js';
import type { AskForApproval, SandboxMode, SandboxPolicy } from './protocol.js';

/**
 * How a Codex run is confined. Codex can't ask Beluga before each of its own steps
 * (canGateEveryTool false), so its sandbox is what keeps it in its folders: a main folder and a
 * planning turn read only, everything else writes only to its own folders. Codex asks (and Beluga
 * asks you, through canUseTool) when it wants out of that: approval policy on-request.
 */
export interface CodexConfinement {
  readonly sandbox: SandboxMode;
  readonly policy: SandboxPolicy;
  readonly approval: AskForApproval;
}

export function codexConfinement(input: Pick<AgentRunInput, 'plan' | 'vetTool'>, place: { readonly askOnly: boolean; readonly writable: readonly string[] }): CodexConfinement {
  // Your own runs reach the network (installs, fetches); a friend's task doesn't.
  const networkAccess = !input.vetTool;
  if (place.askOnly || input.plan) return { sandbox: 'read-only', policy: { type: 'readOnly', networkAccess }, approval: 'on-request' };
  return {
    sandbox: 'workspace-write',
    policy: { type: 'workspaceWrite', writableRoots: [...place.writable], networkAccess, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    approval: 'on-request',
  };
}
