/**
 * What an agent runtime does instead where it can't do what Claude does (BLG-461): one reason per
 * feature, said in the UI where that feature is (greyed with the reason, or the reason beside a
 * control that still works another way), never a dead control. docs/parity.md's "Agent runs, per
 * runtime" table names each one as `fallback:<id>`, and tests/parity.test.ts checks the two agree
 * and that every one is shown somewhere. Browser-safe and dependency-free: the daemon, the Mac app
 * and the phone import it.
 */

export type FallbackId = 'compact' | 'fork' | 'rewind' | 'skills' | 'mcp_servers' | 'guests';

export interface RuntimeFallback {
  /** The RuntimeCapabilities flag it stands in for (runtime/types.ts), when there's one. */
  readonly capability?: string;
  /** Why, in the words the UI shows. */
  readonly reason: string;
}

/** Per runtime, what it does differently. A runtime (or a feature) missing here works as Claude's does. */
export const RUNTIME_FALLBACKS: Readonly<Record<string, Readonly<Partial<Record<FallbackId, RuntimeFallback>>>>> = {
  codex: {
    compact: { capability: 'hasCompaction', reason: 'Codex compacts its own context when it fills up, so there’s no Compact on Codex.' },
    fork: { capability: 'canFork', reason: 'On Codex a fork starts a new conversation: the files come along, the chat so far doesn’t.' },
    rewind: { capability: 'canFork', reason: 'On Codex, going back puts the files back but starts a new conversation from your edited message.' },
    skills: { capability: 'skills', reason: 'Skills and commands are translated for Codex; what can’t be says “Not on Codex”.' },
    mcp_servers: { reason: 'Codex uses the MCP servers in its own settings (~/.codex/config.toml). This list is Claude Code’s; Beluga’s own tools reach both.' },
    guests: { capability: 'canGateEveryTool', reason: 'Codex can’t check each step, so it can’t answer guests. Switch this conversation to Claude for them.' },
  },
};

type Ref = { readonly runtime: string };

/** The runtime a conversation runs on: its own agent's, else your default's (a profile's `defaultAgent`, then its first agent), else Claude. */
export function runtimeHere(agent: Ref | undefined, self?: { readonly defaultAgent?: Ref; readonly agents?: readonly Ref[] }): string {
  return agent?.runtime ?? self?.defaultAgent?.runtime ?? self?.agents?.[0]?.runtime ?? 'claude';
}

/** Why `feature` works differently (or not at all) on `runtime`; undefined when it works as on Claude. */
export function fallbackFor(runtime: string | undefined, feature: FallbackId): string | undefined {
  return runtime ? RUNTIME_FALLBACKS[runtime]?.[feature]?.reason : undefined;
}
