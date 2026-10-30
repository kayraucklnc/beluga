import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

/**
 * Beluga's tools as plain definitions, apart from how they reach an agent (BLG-442): one registry,
 * two mounts. Claude mounts a suite in-process (agent/runtime/claude/sdk-mount.ts); any other
 * runtime mounts it over stdio (agent/tool-host.ts, `beluga mcp-serve`). Same tools, same schemas.
 */

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly annotations?: ToolAnnotations;
  readonly handler: (args: z.infer<z.ZodObject<S>>, extra: unknown) => Promise<CallToolResult>;
}

/** One tool (the same shape as the Agent SDK's `tool()`, so a definition reads the same). */
export function tool<S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, handler: ToolDef<S>['handler'], extras?: { readonly annotations?: ToolAnnotations }): ToolDef<S> {
  return { name, description, inputSchema, handler, ...(extras?.annotations ? { annotations: extras.annotations } : {}) };
}

/** A named set of tools: one MCP server (`beluga`, `beluga_board`…), its tools `mcp__<name>__<tool>`. */
export interface ToolSuite {
  readonly name: string;
  readonly version: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a suite mixes tools of every input shape
  readonly tools: ReadonlyArray<ToolDef<any>>;
}

export function toolSuite(suite: ToolSuite): ToolSuite {
  return suite;
}

/** A tool's full name as the agent calls it, policy sees it, and vetTool judges it. */
export const toolName = (suite: string, tool: string): string => `mcp__${suite}__${tool}`;
