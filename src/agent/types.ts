import type { FsEntry, PeerInfo, Usage } from '../protocol.js';

/** How far a request may reach on the owner's computer. */
export type AccessScope = 'folder' | 'full';

export interface AgentRunInput {
  readonly prompt: string;
  readonly requesterName: string;
  readonly viaAgent: boolean;
  readonly context: readonly string[];
  /** 'folder': only the shared folders. 'full': the whole computer (secrets still blocked). */
  readonly scope: AccessScope;
  readonly signal: AbortSignal;
  readonly onEvent: (kind: 'text' | 'tool' | 'sub' | 'context' | 'compact', text: string) => void;
  /** Where to run: a workspace folder with its own Claude conversation. Defaults to the room's folder. */
  readonly place?: AgentPlace;
  /** Called with absolute paths the agent wrote to, so the room can follow along. */
  readonly onFileTouched: (absPath: string) => void;
  /** Ask the owner whether a non-preapproved tool may run. */
  readonly canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
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
}

/** What an agent may do to the room, exposed to it as MCP tools. */
export interface RoomBridge {
  selfName(): string;
  sendChat(text: string): void;
  listPeers(): readonly PeerInfo[];
  askAgent(peerName: string, prompt: string): Promise<string>;
  listPeerFiles(peerName: string, share: string, path: string): Promise<readonly FsEntry[]>;
  readPeerFile(peerName: string, share: string, path: string): Promise<string>;
  writeReport(title: string, markdown: string): Promise<string>;
  /** Plan usage observed while running (rate-limit events). */
  reportUsage(usage: Partial<Usage>): void;
}
