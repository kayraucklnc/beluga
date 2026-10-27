import { useEffect, useSyncExternalStore } from 'react';
import type { McpServerRow } from '@beluga/shared/mcp.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { toast } from './beluga.js';
import { openExternal } from './system.js';

/** Where a server comes from, in words. */
export const MCP_FROM: Record<McpServerRow['from'], (where?: string) => string> = {
  user: () => 'Yours, in every project',
  project: (where) => (where ? `Set for ${where}` : 'Set for one project'),
  plugin: (where) => (where ? `From the ${where} plugin` : 'From a plugin'),
  'claude.ai': () => 'A claude.ai connector',
};

/** How a server is, in words, with its dot. */
export const MCP_STATUS: Record<McpServerRow['status'], { readonly words: string; readonly tone: 'ok' | 'warn' | 'error' | 'muted' }> = {
  connected: { words: 'Connected', tone: 'ok' },
  'needs-auth': { words: 'Needs you to sign in', tone: 'warn' },
  failed: { words: 'Couldn’t connect', tone: 'error' },
  pending: { words: 'Still starting', tone: 'muted' },
  disabled: { words: 'Turned off', tone: 'muted' },
};

/** How long the list stays fresh: asking means starting Claude Code, so the box and Settings share one. */
const FRESH_MS = 60_000;

interface McpState {
  readonly rows?: readonly McpServerRow[];
  readonly checking: boolean;
  /** The server a sign-in is waiting on (one at a time). */
  readonly signingIn?: string;
}

let state: McpState = { checking: false };
let checkedAt = 0;
const listeners = new Set<() => void>();
const set = (patch: Partial<McpState>): void => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

/** Ask Claude Code again how each of your MCP servers is. */
export async function checkMcp(client: SocketClient): Promise<void> {
  if (state.checking) return;
  set({ checking: true });
  try {
    set({ rows: await client.api.claudeCode.mcpServers() });
    checkedAt = Date.now();
  } catch {
    set({ rows: state.rows ?? [] });
  } finally {
    set({ checking: false });
  }
}

/** Sign in to one: its page opens in your browser, and the row waits until you're back. */
export async function signInMcp(client: SocketClient, row: McpServerRow): Promise<void> {
  set({ signingIn: row.name });
  try {
    const started = await client.api.claudeCode.mcpSignIn(row.name);
    if ('error' in started) return toast(client, started.error, 'error');
    if ('url' in started) {
      await openExternal(started.url);
      const ok = await client.api.claudeCode.mcpSignedIn(row.name);
      toast(client, ok ? `Signed in to ${row.label}` : `Didn’t hear back from ${row.label}. Try again when you’re ready.`, ok ? 'success' : 'warn');
    }
    await checkMcp(client);
  } finally {
    set({ signingIn: undefined });
  }
}

/** Your MCP servers (Settings › Claude and the box you type in), asked for once a minute at most. */
export function useMcp(client: SocketClient): McpState {
  const now = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => state,
  );
  useEffect(() => {
    if (Date.now() - checkedAt > FRESH_MS) void checkMcp(client);
  }, [client]);
  return now;
}

/** "3 of 9 connected · 2 to sign in · 1 failed", for the chip and its list. */
export function mcpSummary(rows: readonly McpServerRow[]): { readonly connected: number; readonly needYou: number; readonly line: string } {
  const connected = rows.filter((r) => r.status === 'connected').length;
  const needYou = rows.filter((r) => r.status === 'needs-auth').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const parts = [`${connected} of ${rows.length} connected`, ...(needYou ? [`${needYou} to sign in`] : []), ...(failed ? [`${failed} failed`] : [])];
  return { connected, needYou, line: parts.join(' · ') };
}
