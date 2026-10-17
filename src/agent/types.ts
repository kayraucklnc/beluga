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
  readonly onEvent: (kind: 'text' | 'tool', text: string) => void;
  /** Called with absolute paths the agent wrote to, so the room can follow along. */
  readonly onFileTouched: (absPath: string) => void;
  /** Ask the owner whether a non-preapproved tool may run. */
  readonly canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
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
