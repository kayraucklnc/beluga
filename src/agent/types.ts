import type { ChatAnswerRequest } from '../core/chat/claude-prompt.js';
import type { SetupFix } from './setup-fixer.js';
import type { DraftContext, TaskDraft } from './task-drafter.js';
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
  /** A folder (relative to the run's folder, git-ignored) for screenshots and scratch output; the owner watches it live. */
  readonly scratchDir?: string;
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
   * Called when the run starts with a way to steer it: a message sent in while Claude works,
   * which Claude Code takes in at its next step (between tool calls) without stopping the turn,
   * or answers in a turn of its own right after. Undefined once the run ends.
   */
  readonly onSteer?: (steer: ((followUp: FollowUp) => boolean) | undefined) => void;
  /**
   * In a project's main folder (ask-only): carry this conversation into a new worktree and do
   * `task` there (Claude's continue_in_worktree tool). Resolves with what to tell Claude.
   */
  readonly continueInWorktree?: (task: string) => Promise<string>;
  /** A friend's task: the extra tools its owner allowed (the screen, device info). */
  readonly taskTools?: TaskTools;
  /** Your own runs: the task board (Claude reads and keeps tasks true; see core/board). */
  readonly board?: BoardTools;
  /** The task this run's worktree is doing (its brief), or a note that the board is there: added to the instructions. */
  readonly taskBrief?: string;
  /**
   * Plan mode with the board: whether the plan's task still has to be defined (task_define) before
   * the plan goes to you, and what to do when you approve it (its task goes on the board).
   */
  readonly planTask?: { readonly needsDefinition: () => boolean; readonly approved: () => void };
  /** A plan (Plans): its tools for this run (its home conversation), and what Claude is told about it. */
  readonly planTools?: PlanTools;
  readonly planBrief?: string;
}

/** What Claude writes down about a piece of work: the task in its own words, never the request pasted in. */
export interface TaskDefinition {
  readonly title: string;
  readonly goal: string;
  readonly context?: string;
  readonly acceptance?: readonly string[];
  readonly decisions?: readonly string[];
  readonly questions?: readonly string[];
  readonly estimate?: 1 | 2 | 3 | 5 | 8;
  readonly priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  readonly labels?: readonly string[];
}

/** A plan as Claude's tools (agent/plan-tools.ts, server `klaud_plan`): each answers in words. */
export interface PlanTools {
  get(): string;
  write(body: import('../core/plans/edit.js').BodyInput): string;
  update(ops: readonly import('../core/plans/edit.js').PlanOp[], reason?: string): string;
  gate(milestone: string, verdict: 'pass' | 'fail', notes: string): string;
  start(task: string): Promise<string>;
  message(task: string, text: string): string;
}

/**
 * The task board as Claude's tools (agent/board-tools.ts): each answers in words for Claude.
 * `key`: a task's key ("BOB-12"); left out, the task this run's worktree is doing.
 */
export interface BoardTools {
  /** The task this run's worktree is doing, if any. */
  readonly current?: string;
  /** Define the work this conversation is for (planning: once you approve the plan). */
  define(def: TaskDefinition): string;
  get(key?: string): string;
  list(filter: { readonly scope?: 'open' | 'mine' | 'all'; readonly project?: string; readonly query?: string }): string;
  create(input: {
    readonly title: string;
    readonly goal?: string;
    readonly context?: string;
    readonly acceptance?: string;
    readonly decisions?: string;
    readonly questions?: string;
    readonly estimate?: number;
    readonly project?: string;
    readonly parent?: string;
    readonly blockedBy?: readonly string[];
    readonly status?: 'backlog' | 'todo';
    readonly priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
    readonly labels?: readonly string[];
  }): string;
  update(
    key: string | undefined,
    patch: {
      readonly title?: string;
      readonly status?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled';
      readonly priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
      readonly labels?: readonly string[];
      readonly estimate?: number | null;
      readonly assign?: 'me' | 'claude' | 'nobody';
    },
  ): string;
  editBrief(key: string | undefined, section: 'goal' | 'context' | 'acceptance' | 'decisions' | 'questions' | 'handoff', content: string, reason?: string, mode?: 'replace' | 'append'): string;
  note(key: string | undefined, text: string): string;
  relate(key: string | undefined, relation: 'blocked_by' | 'blocks' | 'related', other: string, remove?: boolean): string;
  attachProof(key: string | undefined, proof: { readonly kind: 'image' | 'url' | 'file' | 'graph' | 'text'; readonly title: string; readonly path?: string; readonly url?: string; readonly body?: string }): string;
}

/** What a friend's task may look at on this Mac (see agent/task-tools.ts). */
export interface TaskTools {
  readonly screenshot?: (app?: string) => Promise<{ readonly text: string; readonly image?: { readonly data: string; readonly mimeType: string } }>;
  readonly deviceInfo?: () => Promise<string>;
}

/** A message sent into a live run: while it waits on its background agents, or steering it. */
export interface FollowUp extends Pick<AgentRunInput, 'prompt' | 'requesterName' | 'viaAgent' | 'context' | 'onEvent' | 'onStep'> {
  readonly onDone: (final: string) => void;
  readonly onError: (reason: string) => void;
  /** Its own turn begins (see TurnRoute.onStart). */
  readonly onStart?: () => void;
  /** Claude took it into the turn it was working on (see TurnRoute.onFolded). */
  readonly onFolded?: () => void;
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
  /** What a project's setup should be after `failed` failed in `dir` (a small model looks). */
  fixSetup?(dir: string, failed: string, output: string): Promise<SetupFix | undefined>;
  /** A task written from a description: title, goal, criteria, labels from the board's own (Sonnet). */
  draftTask?(text: string, ctx: DraftContext): Promise<TaskDraft | undefined>;
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
