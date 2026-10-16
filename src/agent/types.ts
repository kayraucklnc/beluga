import type { FsEntry, PeerInfo } from '../protocol.js';

export interface AgentRunInput {
  readonly prompt: string;
  readonly requesterName: string;
  readonly viaAgent: boolean;
  readonly context: readonly string[];
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
}
