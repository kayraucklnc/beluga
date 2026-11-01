/**
 * The parts of Codex's app-server protocol (v2) Beluga uses, as `codex app-server generate-ts`
 * writes them (codex-cli 0.135). Types only; anything else Codex sends is ignored.
 */

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type AskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type SandboxPolicy =
  | { readonly type: 'dangerFullAccess' }
  | { readonly type: 'readOnly'; readonly networkAccess: boolean }
  | { readonly type: 'workspaceWrite'; readonly writableRoots: readonly string[]; readonly networkAccess: boolean; readonly excludeTmpdirEnvVar: boolean; readonly excludeSlashTmp: boolean };
/** Lowest to highest; newer models list 'max' (and 'ultra') in their supportedReasoningEfforts. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type UserInput =
  | { readonly type: 'text'; readonly text: string; readonly text_elements: readonly unknown[] }
  | { readonly type: 'localImage'; readonly path: string }
  | { readonly type: 'skill'; readonly name: string; readonly path: string };

export interface Thread {
  readonly id: string;
  readonly cwd?: string;
  /** Set only on a sub-agent's thread: the thread that spawned it (multi_agent, BLG-519; codex-cli 0.166). */
  readonly parentThreadId?: string | null;
  /** A spawned sub-agent's random nickname, and the role it was given (agent_role). */
  readonly agentNickname?: string | null;
  readonly agentRole?: string | null;
  /** Usually the thread's first user message. */
  readonly preview?: string;
}

/** Codex's multi-agent tools (codex-cli 0.166's CollabAgentTool). */
export type CollabAgentTool = 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent' | 'sendMessage' | 'followupTask' | 'interruptAgent' | 'listAgents';
/** Where a sub-agent stands, as its lead last heard (CollabAgentStatus). */
export type CollabAgentStatus = 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound';
export interface CollabAgentState {
  readonly status: CollabAgentStatus;
  readonly message: string | null;
}
/** A lead's call to one of its sub-agent tools (ThreadItem `collabAgentToolCall`). */
export interface CollabAgentToolCall {
  readonly type: 'collabAgentToolCall';
  readonly id: string;
  readonly tool: CollabAgentTool;
  readonly status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  readonly senderThreadId: string;
  /** The sub-agents it's about: for a spawn, the new one's thread (once spawned). */
  readonly receiverThreadIds: readonly string[];
  readonly prompt: string | null;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly agentsStates: Readonly<Record<string, CollabAgentState | undefined>>;
}
/** A sub-agent's lifecycle as its lead's item (ThreadItem `subAgentActivity`, multi_agent_v2). */
export interface SubAgentActivity {
  readonly type: 'subAgentActivity';
  readonly id: string;
  readonly kind: 'started' | 'interacted' | 'interrupted' | 'completed';
  readonly agentThreadId: string;
  readonly agentPath: string;
  readonly model?: string | null;
}
export interface ThreadStartResponse {
  readonly thread: Thread;
  readonly model: string;
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export interface TurnError {
  readonly message: string;
  readonly codexErrorInfo?: unknown;
  readonly additionalDetails?: string | null;
}
export interface Turn {
  readonly id: string;
  readonly status: TurnStatus;
  readonly error: TurnError | null;
}

export interface FileUpdateChange {
  readonly path: string;
  readonly kind: { readonly type: 'add' | 'delete' | 'update'; readonly move_path?: string | null };
  readonly diff: string;
}

export type ThreadItem =
  | { readonly type: 'userMessage'; readonly id: string }
  | { readonly type: 'agentMessage'; readonly id: string; readonly text: string; readonly phase?: string | null }
  | { readonly type: 'plan'; readonly id: string; readonly text: string }
  | { readonly type: 'reasoning'; readonly id: string; readonly summary: readonly string[]; readonly content: readonly string[] }
  | {
      readonly type: 'commandExecution';
      readonly id: string;
      readonly command: string;
      readonly cwd: string;
      readonly status: 'inProgress' | 'completed' | 'failed' | 'declined';
      readonly aggregatedOutput: string | null;
      readonly exitCode: number | null;
      readonly durationMs: number | null;
    }
  | { readonly type: 'fileChange'; readonly id: string; readonly changes: readonly FileUpdateChange[]; readonly status: 'inProgress' | 'completed' | 'failed' | 'declined' }
  | {
      readonly type: 'mcpToolCall';
      readonly id: string;
      readonly server: string;
      readonly tool: string;
      readonly status: 'inProgress' | 'completed' | 'failed';
      readonly arguments: unknown;
      readonly result: { readonly content: readonly unknown[] } | null;
      readonly error: { readonly message: string } | null;
    }
  | { readonly type: 'webSearch'; readonly id: string; readonly query: string }
  | { readonly type: 'imageView'; readonly id: string; readonly path: string }
  | { readonly type: 'contextCompaction'; readonly id: string }
  | CollabAgentToolCall
  | SubAgentActivity
  | { readonly type: string; readonly id: string };

export interface TokenUsageBreakdown {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

/** `thread/tokenUsage/updated`'s tokenUsage: the last response's tokens, the thread's, and the model's window. */
export interface ThreadTokenUsage {
  readonly last?: TokenUsageBreakdown;
  readonly total?: Partial<TokenUsageBreakdown>;
  readonly modelContextWindow?: number | null;
}

export interface Model {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly supportedReasoningEfforts: ReadonlyArray<{ readonly reasoningEffort: string; readonly description?: string }>;
}
