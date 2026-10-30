import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * `beluga mcp-serve <suite>`: one suite of Beluga's tools as a stdio MCP server, for a runtime that
 * mounts servers (agent/tool-host.ts). It only pipes: the tools run in the daemon, for the run the
 * token (BELUGA_TOOLS_TOKEN, never on the command line) names.
 */
export async function serveStdio(suite: string, url: string, token: string): Promise<void> {
  const stdio = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(new URL(`/mcp/${encodeURIComponent(suite)}`, url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  stdio.onmessage = (msg: JSONRPCMessage) => {
    remote.send(msg).catch((err: unknown) => {
      // A request must still get an answer, or the agent waits on it forever.
      if ('id' in msg && 'method' in msg) void stdio.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Beluga's tools aren't reachable: ${err instanceof Error ? err.message : String(err)}` } });
    });
  };
  remote.onmessage = (msg) => void stdio.send(msg);
  await remote.start();
  await stdio.start();
  // The agent closed its end: nothing more will come.
  await new Promise<void>((resolve) => process.stdin.once('end', resolve).once('close', resolve));
  await remote.close().catch(() => undefined);
}
