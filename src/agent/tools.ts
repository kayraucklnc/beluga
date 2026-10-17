import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RoomBridge } from './types.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

async function guarded(fn: () => Promise<string> | string): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

export const ROOM_TOOL_NAMES = [
  'send_chat',
  'list_peers',
  'ask_agent',
  'list_peer_files',
  'read_peer_file',
  'write_report',
].map((n) => `mcp__klaude__${n}`);

export function createRoomToolDefs(bridge: RoomBridge) {
  return [
      tool('send_chat', 'Post a mid-task update or question to the group chat. Do not use it to repeat your final answer; the room already sees that.', { text: z.string().min(1).max(4000) }, (a) =>
        guarded(() => {
          bridge.sendChat(a.text);
          return 'sent';
        }),
      ),
      tool('list_peers', 'List people in the room, their shared folders and agent availability.', {}, () =>
        guarded(() =>
          JSON.stringify(
            bridge.listPeers().map((p) => ({ name: p.name, agent: p.agent, shares: p.shares, you: p.name === bridge.selfName() })),
            null,
            2,
          ),
        ),
      ),
      tool(
        'ask_agent',
        "Send a task to another peer's Claude agent (runs on their machine). Returns its final answer.",
        { peer: z.string().describe('Peer name from list_peers'), prompt: z.string().min(1).max(16000) },
        (a) => guarded(() => bridge.askAgent(a.peer, a.prompt)),
      ),
      tool(
        'list_peer_files',
        "List a directory in a peer's shared folder.",
        { peer: z.string(), share: z.string(), path: z.string().default('') },
        (a) => guarded(async () => JSON.stringify(await bridge.listPeerFiles(a.peer, a.share, a.path))),
      ),
      tool(
        'read_peer_file',
        "Read a text file from a peer's shared folder.",
        { peer: z.string(), share: z.string(), path: z.string() },
        (a) => guarded(() => bridge.readPeerFile(a.peer, a.share, a.path)),
      ),
      tool(
        'write_report',
        'Write a Markdown report to .klaude/reports/ and announce it so everyone can follow it live.',
        { title: z.string().min(1).max(200), markdown: z.string().min(1).max(200_000) },
        (a) => guarded(async () => `Report written to ${await bridge.writeReport(a.title, a.markdown)}`),
      ),
  ];
}

export function createRoomTools(bridge: RoomBridge) {
  return createSdkMcpServer({ name: 'klaude', version: '0.1.0', tools: createRoomToolDefs(bridge) });
}
