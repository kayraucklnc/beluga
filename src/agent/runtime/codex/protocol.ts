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
