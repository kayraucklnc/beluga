import type { ChatAnswerRequest } from '../core/chat/claude-prompt.js';
import type { ClaudeAnswer, ClaudeQuestion, FsEntry, PeerInfo, Usage } from '../protocol.js';
import type { StepRecord } from '../shared/steps.js';

/** How far a request may reach on the owner's computer. */
export type AccessScope = 'folder' | 'full';

export interface AgentRunInput {
  readonly prompt: string;
  readonly requesterName: string;
  readonly viaAgent: boolean;
  readonly context: readonly string[];
  /** 'folder': only the shared folders. 'full': the whole computer (secrets still blocked). */
  readonly scope: AccessScope;
  /** The request's first answer, as soon as it's there (the run may stay open for background agents). */
  readonly onAnswered?: (text: string) => void;
  /** Asked by a guest invited into one project: the room tools (other people, their files, the room chat) are off. */
  readonly guest?: boolean;
  readonly signal: AbortSignal;
  readonly onEvent: (kind: 'text' | 'tool' | 'sub' | 'context' | 'compact' | 'usage', text: string) => void;
  /**
   * Each step in detail as it happens (the tool's input and output, thinking), for the screens on
   * this computer only: kept beside the chat, never sent anywhere (see core/step-book.ts).
   */
  readonly onStep?: (record: StepRecord) => void;
  /** Model for this run (an alias like "sonnet" or a full id); unset: the default. */
  readonly model?: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Your environment variables for this run, over klaud's own (only for runs you asked for). */
  readonly env?: Readonly<Record<string, string>>;
  /** Auto-compact threshold (percent) for Claude Code's own compaction; unset: auto-compact is off. */
  readonly autoCompactAt?: number;
  /** Where to run: a workspace folder with its own Claude conversation. Defaults to the room's folder. */
  readonly place?: AgentPlace;
  /** Called with absolute paths the agent wrote to, so the room can follow along. */
  readonly onFileTouched: (absPath: string) => void;
  /**
   * Checked before every tool call, before any other rule (a friend's task: what its owner's
   * capabilities and rules forbid). A reason: denied, whatever else would allow it.
   */
  readonly vetTool?: (toolName: string, input: Record<string, unknown>) => string | undefined;
  /** Ask the owner whether a non-preapproved tool may run. */
  readonly canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  /** Ask the person who made the request: Claude's questions, or a plan to approve. */
  readonly askUser?: (question: ClaudeQuestion) => Promise<ClaudeAnswer>;
  /** Plan first (read-only investigation, then a plan to approve) instead of acting right away. */
  readonly plan?: boolean;
  /**
   * Called with a way to send more messages into this run once Claude has answered but its
   * background agents are still working (so they aren't cut off), and with undefined when that ends.
   */
  readonly onFollowUps?: (send: ((followUp: FollowUp) => boolean) | undefined) => void;
  /**
   * In a project's main folder (ask-only): carry this conversation into a new worktree and do
   * `task` there (Claude's continue_in_worktree tool). Resolves with what to tell Claude.
   */
  readonly continueInWorktree?: (task: string) => Promise<string>;
  /** A friend's task: the extra tools its owner allowed (the screen, device info). */
  readonly taskTools?: TaskTools;
}

/** What a friend's task may look at on this Mac (see agent/task-tools.ts). */
export interface TaskTools {
  readonly screenshot?: (app?: string) => Promise<{ readonly text: string; readonly image?: { readonly data: string; readonly mimeType: string } }>;
  readonly deviceInfo?: () => Promise<string>;
}

/** A message sent into a run that is still waiting on its background agents. */
export interface FollowUp extends Pick<AgentRunInput, 'prompt' | 'requesterName' | 'viaAgent' | 'context' | 'onEvent' | 'onStep'> {
  readonly onDone: (final: string) => void;
  readonly onError: (reason: string) => void;
}

export interface AgentPlace {
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly autoEdit: boolean;
  /** Claude conversation to continue. */
  readonly resume?: string;
  /** Branch `resume` into a new conversation (used by forks). */
  readonly forkSession?: boolean;
  readonly onSession: (sessionId: string) => void;
  /** The model picked for this conversation. */
  readonly model?: string;
  /** A project's main folder: questions only, nothing may change (see policy.ts). */
  readonly askOnly?: { readonly project: string };
  /** With askOnly, for one run: Claude brings the default branch up to date (git syncing only; see sync-main.ts). */
  readonly syncMain?: { readonly branch: string; readonly upstream: string };
}

export interface SubAgentEvent {
  readonly id: string;
  readonly phase: 'start' | 'step' | 'done';
  readonly title?: string;
  readonly step?: string;
  /** 'agent' for sub-agents, 'background' for background terminals/agents. */
  readonly kind?: 'agent' | 'background';
  readonly failed?: boolean;
}

/** Something that can run an agent turn and return its final answer. */
export interface AgentBackend {
  run(input: AgentRunInput): Promise<string>;
  /** Fetch current plan usage without running a turn, when supported. */
  refreshUsage?(): Promise<Usage | undefined>;
  /** A short worktree name for a task (a small model names it). */
  nameTask?(prompt: string): Promise<string>;
  /** Answer in a friends' chat from its history (one turn, no tools; core/chat/claude.ts). */
  answerChat?(req: ChatAnswerRequest): Promise<string>;
  /** Models this Claude Code offers, for the model picker. */
  listModels?(): Promise<ReadonlyArray<{ value: string; label: string; description: string; efforts?: readonly string[] }> | undefined>;
}

/** One person as the agent sees them in list_peers. */
export interface PeerSummary {
  readonly name: string;
  readonly you: boolean;
  readonly agent: boolean;
  readonly shares: readonly string[];
  /** Their projects you may name in ask_agent / run_on_peer. */
  readonly projects: readonly string[];
  /** Their workspaces shared with you (ask_agent with project=<name> works there). */
  readonly workspaces: ReadonlyArray<{ name: string; project: string; role: string }>;
  /** What they let you do on their computer (as they told you; unknown for older klaud). */
  readonly lets_you?: { trust: string; means: string };
}

/** What an agent may do to the room, exposed to it as MCP tools. */
export interface RoomBridge {
  selfName(): string;
  sendChat(text: string): void;
  listPeers(): readonly PeerInfo[];
  /** `project`: one of their projects (from list_peers) to work in. */
  askAgent(peerName: string, prompt: string, project?: string): Promise<string>;
  /** Run a shell command on a peer's computer through their klaud; returns exit code and output. */
  runOnPeer?(peerName: string, command: string, opts?: { cwd?: string; project?: string; timeoutSec?: number; why?: string }): Promise<string>;
  /** People with what they offer you and what their trust in you lets you do (for list_peers). */
  describePeers?(): readonly PeerSummary[];
  listPeerFiles(peerName: string, share: string, path: string): Promise<readonly FsEntry[]>;
  readPeerFile(peerName: string, share: string, path: string): Promise<string>;
  writeReport(title: string, markdown: string): Promise<string>;
  /** Plan usage observed while running (rate-limit events). */
  reportUsage(usage: Partial<Usage>): void;
  /** Get a file from anywhere on a peer's computer (they approve); returns where it was saved here. */
  getPeerFile(peerName: string, path: string, saveTo?: string, why?: string): Promise<string>;
  /** Send a file from this computer to a peer; it's saved on their side. */
  sendFile(peerName: string, path: string, note?: string): Promise<string>;
  /** Tasks between Claudes (the klaud app only; see agent/gateway-tools.ts). */
  readonly gateway?: import('./gateway-tools.js').GatewayBridge;
}
