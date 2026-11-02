/**
 * Claude Code sessions running outside Beluga (in a terminal, through Conductor…), as screens see
 * them: each live session, where it runs, what it's doing, and its sub-agents. Read-only: Beluga
 * only watches the transcripts Claude Code writes (see watch.ts). Only what a list needs to
 * draw; the steps themselves come on demand (`claudeCode.steps`). Browser-safe: the Mac app runs it.
 */

/** Sessions running outside Beluga (Activity's): Beluga's own are watched only for their sub-agents. */
export const outsideSessions = (sessions: readonly CcSession[]): readonly CcSession[] => (sessions.some((s) => s.own) ? sessions.filter((s) => !s.own) : sessions);

/** The app a session runs in, for people: "Codex", or "Claude Code". */
export const sessionApp = (s: Pick<CcSession, 'agent'>): string => (s.agent === 'codex' ? 'Codex' : 'Claude Code');

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
  /** The name it was given, to be messaged by (Agent's `name`). */
  readonly name?: string;
  /** The model it runs on (its transcript's, else the one it was asked for) and the effort of its last answer. */
  readonly model?: string;
  readonly effort?: string;
  /** The folder it works in. */
  readonly cwd?: string;
  /** Its own worktree, when it was started in isolation (and that worktree's branch). */
  readonly worktree?: { readonly path: string; readonly branch?: string };
  /** The tool call that started it (Beluga's chat knows its sub-agents by it). */
  readonly toolUseId?: string;
  /** The agent that started it, when it wasn't the session itself. */
  readonly parentAgentId?: string;
}

export interface CcSession {
  readonly id: string;
  /** Claude Code's title for it, else its first message. */
  readonly title: string;
  /** The folder it runs in. */
  readonly cwd: string;
  /** The project and workspace of Beluga's that folder belongs to, if any. */
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
  /**
   * One of Beluga's own conversations (a worktree's chat). It's shown in that chat, not in Activity;
   * it's watched for its sub-agents, so they can be followed live.
   */
  readonly own?: true;
  /** Agents working as a team, and the messages between them (when any are named or message each other). */
  readonly team?: CcTeam;
  /** Background commands and watches it or its agents started (running first, then the latest). */
  readonly tasks?: readonly CcTask[];
  /** The agent running it: 'codex' (see codex-watch.ts); unset: Claude Code. */
  readonly agent?: string;
}

/**
 * A background command (a dev server, the full tests, a build) or a watch (Monitor) that Claude
 * or one of its agents started. running · finished · failed · stopped · idle: no word on it, and
 * nothing written for a while (its session may be gone).
 */
export interface CcTask {
  /** Claude Code's id for it (its tool call's, until it has one). */
  readonly id: string;
  readonly kind: 'command' | 'monitor';
  /** What it's for ("Start the dev server"). */
  readonly description: string;
  /** The command (secrets redacted). */
  readonly command: string;
  readonly status: CcAgentStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly exitCode?: number;
  /** How it ended, in Claude Code's words. */
  readonly summary?: string;
  /** The agent that started it (none: the session itself). */
  readonly agentId?: string;
}

/** The end of a background command's output, cleaned for reading. */
export interface CcTaskOutput {
  readonly text: string;
  /** The whole file's size (bytes); only its end is in `text` when `truncated`. */
  readonly size: number;
  readonly truncated?: boolean;
  /** The file it comes from (its own output, or the log its command writes to). */
  readonly file: string;
  /** Last written (ms). */
  readonly mtime: number;
}

/** One step of a transcript, ready to show. `seq` grows along the transcript (for paging and updates). */
export interface CcStep {
  readonly seq: number;
  readonly ts: number;
  /**
   * user: a message to Claude · text: Claude's words · tool: a tool call (summarised) · thinking:
   * Claude thinking · message: another session or agent messaged this one (SendMessage) · note: a
   * task reporting back, a compaction…
   */
  readonly kind: 'user' | 'text' | 'tool' | 'thinking' | 'message' | 'note';
  readonly text: string;
  /** For tools: its name ("Read", "Bash", "Agent"). */
  readonly tool?: string;
  /** For tools: still running, done, or failed. */
  readonly status?: 'running' | 'done' | 'error';
  /** How long the tool call (from it until its result) or the thinking took. */
  readonly durationMs?: number;
  /** Thinking whose words Claude didn't write down. */
  readonly hidden?: boolean;
  /** There's more to see when it's opened (`claudeCode.step`): the input and output, or the thinking. */
  readonly detail?: boolean;
  /** A message: who sent it ('lead' for the session that started the agents, else an agent's id or name). */
  readonly from?: string;
  /** A message: its sender in words ("the lead session", "Reviewer"). */
  readonly who?: string;
  /** A message that is an agent's final report handed back to the session. */
  readonly report?: boolean;
  /** SendMessage: whom it went to (an agent's id or name, or 'main' for the lead session). */
  readonly to?: string;
}

/** One message between the sessions of a team (SendMessage), for its timeline. */
export interface CcMessage {
  /** 'lead' (the session that started the agents) or an agent's id. */
  readonly from: string;
  /** 'lead', an agent's id, or a name nobody here answers to. */
  readonly to: string;
  /** What it's about, in a few words (its summary, else its start). */
  readonly summary: string;
  readonly ts: number;
}

/**
 * Agents that work as a team: named (so they can be messaged) or messaging each other, and the
 * messages between them and the lead session, newest last.
 */
export interface CcTeam {
  /** Its members' agent ids (each is in the session's `agents`). */
  readonly members: readonly string[];
  readonly messages: readonly CcMessage[];
}

/** A page of steps: the newest `limit` before `before`, or everything after `after`. */
export interface CcSteps {
  readonly steps: readonly CcStep[];
  /** Earlier steps exist (in what Beluga keeps). */
  readonly more: boolean;
  /** Nothing to show: no such session or agent being watched. */
  readonly missing?: boolean;
}

/** Something an agent made or looked at (a screenshot, a log, test output), still on disk. */
export interface CcOutput {
  /** A full path. */
  readonly path: string;
  /** wrote: it saved it · read: it looked at it · ran: a command wrote it or named it. */
  readonly how: 'wrote' | 'read' | 'ran';
  readonly kind: 'image' | 'pdf' | 'video' | 'json' | 'markdown' | 'text' | 'file';
  readonly size: number;
  /** Last written (ms). */
  readonly mtime: number;
}

export interface CcOutputs {
  /** Newest first. */
  readonly outputs: readonly CcOutput[];
  /** Its own scratch folder (`.beluga/scratch/agents/<name>/` where its session runs), when it has one. */
  readonly scratch?: string;
  /** No such session or agent being watched. */
  readonly missing?: true;
}

/** One output's contents: pictures as base64, text (secrets redacted, cut when long); neither for the rest. */
export interface CcOutputFile extends CcOutput {
  readonly mime?: string;
  readonly data?: string;
  readonly text?: string;
  readonly truncated?: boolean;
}

/**
 * Who started a sub-agent's worktree, from Claude Code's files on disk: kept for as long as the
 * worktree is there (Beluga follows an agent live only for a while after it finishes).
 */
export interface AgentOrigin {
  /** The worktree. */
  readonly path: string;
  readonly agentId: string;
  /** What it was asked to do. */
  readonly description?: string;
  readonly type?: string;
  readonly branch?: string;
  /** The session that started it, the folder it ran in, and what it's called. */
  readonly sessionId: string;
  readonly sessionCwd?: string;
  readonly sessionTitle?: string;
  /** That conversation in Beluga: the workspace whose chat it is (one of Beluga's own) or whose folder it ran in. */
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly own?: true;
  /** The agent's last write, ms. */
  readonly lastAt: number;
  readonly finished?: true;
}

export interface ClaudeCodeSlice {
  /** `sessions`: every outside session, Claude Code's and Codex's (each watcher publishes its own; they're merged here). */
  readonly claudeCode: { readonly sessions: readonly CcSession[]; readonly origins: readonly AgentOrigin[] };
}

export const initialClaudeCode: ClaudeCodeSlice = { claudeCode: { sessions: [], origins: [] } };

export type ClaudeCodeAction = { type: 'claude_code'; sessions: readonly CcSession[] } | { type: 'codex_sessions'; sessions: readonly CcSession[] } | { type: 'agent_origins'; origins: readonly AgentOrigin[] };

const isCodex = (s: CcSession): boolean => s.agent === 'codex';
const byLatest = (a: CcSession, b: CcSession): number => Number(sessionLive(b)) - Number(sessionLive(a)) || b.lastAt - a.lastAt;

export function reduceClaudeCode(state: ClaudeCodeSlice, action: ClaudeCodeAction): ClaudeCodeSlice {
  const cc = state.claudeCode;
  if (action.type === 'agent_origins') return { claudeCode: { ...cc, origins: action.origins } };
  // One watcher's list replaces its own sessions only, keeping the other's.
  const kept = cc.sessions.filter((s) => (action.type === 'codex_sessions' ? !isCodex(s) : isCodex(s)));
  return { claudeCode: { ...cc, sessions: kept.length ? [...kept, ...action.sessions].sort(byLatest) : action.sessions } };
}

const ENDED: ReadonlySet<CcAgentStatus> = new Set(['finished', 'failed', 'stopped']);

export const agentEnded = (a: Pick<CcAgent, 'status'>): boolean => ENDED.has(a.status);

/** Agents working now. */
export const runningAgents = (sessions: readonly CcSession[]): number => sessions.reduce((n, s) => n + s.agents.filter((a) => a.status === 'running').length, 0);

/** A session counts as live while it writes, or any of its agents works. */
export const sessionLive = (s: CcSession): boolean => s.status === 'working' || s.agents.some((a) => a.status === 'running');

/** The live sessions in one workspace (a Conductor worktree, a project's main folder…). */
export const sessionsIn = (sessions: readonly CcSession[], workspaceId: string): CcSession[] => sessions.filter((s) => s.workspaceId === workspaceId);
