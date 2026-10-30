import { type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { ToolSuite } from '../../tool-kit.js';

/** Claude's fast path: a suite of Beluga's tools as an in-process SDK server (no transport, no token). */
export function sdkServer(suite: ToolSuite): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: suite.name, version: suite.version, tools: suite.tools as SdkMcpToolDefinition[] });
}

/** Every suite of a run, by its server name, mounted in-process. */
export function sdkServers(suites: Readonly<Record<string, ToolSuite | undefined>>): Record<string, McpSdkServerConfigWithInstance> {
  return Object.fromEntries(Object.entries(suites).flatMap(([name, suite]) => (suite ? [[name, sdkServer(suite)]] : [])));
}
