/**
 * Claude Code sessions running outside klaud (in a terminal, through Conductor…), as screens see
 * them: each live session, where it runs, what it's doing, and its sub-agents. Read-only: klaud
 * only watches the transcripts Claude Code writes (see watch.ts). Only what a list needs to
 * draw; the steps themselves come on demand (`claudeCode.steps`). Browser-safe: the Mac app runs it.
 */

/** running: working now · finished · failed · stopped (killed or interrupted) · idle: no writes for a while and no final answer. */
export type CcAgentStatus = 'running' | 'finished' | 'failed' | 'stopped' | 'idle';

/** working: writing now · waiting: answered, waiting for you · idle: quiet for a while. */
export type CcSessionStatus = 'working' | 'waiting' | 'idle';

export interface CcAgent {
  /** Claude Code's agent id (its transcript is agent-<id>.jsonl). */
  readonly id: string;
  /** What it was asked to do, in a few words ("Fix Other worktrees experience"). */
  readonly description: string;
  /** "general-purpose", "typescript-reviewer"… */
  readonly type: string;
  /** Started in the background (the session went on while it works). */
  readonly background: boolean;
  readonly status: CcAgentStatus;
  readonly startedAt: number;
  /** Its last write. */
  readonly lastAt: number;
  /** When it finished, failed or stopped. */
  readonly endedAt?: number;
  /** What it's doing (or did last), in words: "Reading src/core/store.ts". */
  readonly step?: string;
  /** Steps seen (tool calls and answers). */
  readonly steps: number;
  /** How full its context was at its last answer (tokens). */
  readonly tokens?: number;
}

export interface CcSession {
  readonly id: string;
  /** Claude Code's title for it, else its first message. */
  readonly title: string;
  /** The folder it runs in. */
  readonly cwd: string;
  /** The project and workspace of klaud's that folder belongs to, if any. */
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly status: CcSessionStatus;
  readonly startedAt?: number;
  readonly lastAt: number;
  readonly step?: string;
  readonly steps: number;
  readonly tokens?: number;
  readonly model?: string;
  /** Its sub-agents that are running or ended lately, newest first. */
  readonly agents: readonly CcAgent[];
}

/** One step of a transcript, ready to show. `seq` grows along the transcript (for paging and updates). */
export interface CcStep {
  readonly seq: number;
  readonly ts: number;
  /** user: a message to Claude · text: Claude's words · tool: a tool call (summarised) · note: a task reporting back, a compaction… */
  readonly kind: 'user' | 'text' | 'tool' | 'note';
  readonly text: string;
  /** For tools: its name ("Read", "Bash", "Agent"). */
  readonly tool?: string;
  /** For tools: still running, done, or failed. */
  readonly status?: 'running' | 'done' | 'error';
}

/** A page of steps: the newest `limit` before `before`, or everything after `after`. */
export interface CcSteps {
  readonly steps: readonly CcStep[];
  /** Earlier steps exist (in what klaud keeps). */
  readonly more: boolean;
  /** Nothing to show: no such session or agent being watched. */
  readonly missing?: boolean;
}

export interface ClaudeCodeSlice {
  readonly claudeCode: { readonly sessions: readonly CcSession[] };
}

export const initialClaudeCode: ClaudeCodeSlice = { claudeCode: { sessions: [] } };

export type ClaudeCodeAction = { type: 'claude_code'; sessions: readonly CcSession[] };

export function reduceClaudeCode(_state: ClaudeCodeSlice, action: ClaudeCodeAction): ClaudeCodeSlice {
  return { claudeCode: { sessions: action.sessions } };
}

const ENDED: ReadonlySet<CcAgentStatus> = new Set(['finished', 'failed', 'stopped']);

export const agentEnded = (a: Pick<CcAgent, 'status'>): boolean => ENDED.has(a.status);

/** Agents working now. */
export const runningAgents = (sessions: readonly CcSession[]): number => sessions.reduce((n, s) => n + s.agents.filter((a) => a.status === 'running').length, 0);

/** A session counts as live while it writes, or any of its agents works. */
export const sessionLive = (s: CcSession): boolean => s.status === 'working' || s.agents.some((a) => a.status === 'running');

/** The live sessions in one workspace (a Conductor worktree, a project's main folder…). */
export const sessionsIn = (sessions: readonly CcSession[], workspaceId: string): CcSession[] => sessions.filter((s) => s.workspaceId === workspaceId);
