/**
 * Your MCP servers as Settings › Claude lists them (agent/mcp-connect.ts): where each comes
 * from, whether your Claude can reach it, and whether you can sign in to it from here.
 * Browser-safe: no imports.
 */
export interface McpServerRow {
  /** Claude Code's name for it (`plugin:figma:figma`): what signing in asks for. */
  readonly name: string;
  /** The name to show (`figma`). */
  readonly label: string;
  readonly from: 'user' | 'project' | 'plugin' | 'claude.ai';
  /** from 'plugin': its plugin; from 'project': the project's folder name. */
  readonly where?: string;
  readonly status: 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled';
  /** Why it failed, in Claude Code's words. */
  readonly error?: string;
  /** Needs a sign-in Beluga can start (a web server; claude.ai's own are signed in on claude.ai). */
  readonly canSignIn: boolean;
}

/** Starting a sign-in: the page to open in your browser, or why it can't start. */
export type McpSignIn = { readonly url: string } | { readonly connected: true } | { readonly error: string };

/** Where claude.ai's own connectors are signed in to. */
export const CLAUDE_AI_CONNECTORS_URL = 'https://claude.ai/settings/connectors';
