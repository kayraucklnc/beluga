import { CLAUDE_AI_CONNECTORS_URL, type McpServerRow } from '@beluga/shared/mcp.js';
import { Button, Dot } from '../components/ui.js';
import { fallbackFor } from '@beluga/shared/runtime-fallbacks.js';
import { useBeluga } from '../lib/beluga.js';
import { agentName, useMyAgent } from '../lib/agent-words.js';
import { MCP_FROM, MCP_STATUS, checkMcp, signInMcp, useMcp } from '../lib/mcp.js';
import { openExternal } from '../lib/system.js';
import { Group, Row } from './settings-controls.js';
import s from './settings.module.css';

/**
 * Settings › Claude › MCP servers (BLG-251): the servers your own Claude gets from Claude Code
 * (agent/owner-mcp.ts), how each is, and Sign In for one that needs it. Signing in opens your
 * browser; Claude Code keeps the login, so it counts for Claude Code too.
 */
export function McpSettings() {
  const { client } = useBeluga();
  const { rows, checking, signingIn } = useMcp(client);
  const check = (): Promise<void> => checkMcp(client);
  const signIn = (row: McpServerRow): Promise<void> => signInMcp(client, row);
  // Your agent is Codex: these are Claude Code's, and it says where Codex's own are (BLG-461).
  const mine = useMyAgent();
  const elsewhere = fallbackFor(mine.runtime, 'mcp_servers');
  // They're Claude Code's: your agent's when it is Claude, else Claude Code's own.
  const whose = mine.runtime === 'claude' ? `Servers your ${agentName(mine)} uses` : 'Servers Claude Code uses';

  return (
    <Group title="MCP servers">
      <Row label={whose} detail="Yours, your projects’ and your plugins’, as Claude Code has them. Only runs you start get them, never a friend’s.">
        <Button variant="quiet" icon="refresh" disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check Again'}
        </Button>
      </Row>
      {elsewhere ? <div className={s.note}>{elsewhere}</div> : null}
      {rows === undefined ? (
        <div className={s.note}>Asking Claude Code…</div>
      ) : rows.length === 0 ? (
        <div className={s.note}>None yet. Add one in Claude Code (claude mcp add) or turn on a plugin that has one.</div>
      ) : (
        rows.map((row) => {
          const status = MCP_STATUS[row.status];
          const why = row.status === 'failed' && row.error ? `: ${row.error}` : '';
          return (
            <Row key={row.name} label={row.label} detail={`${MCP_FROM[row.from](row.where)} · ${status.words}${why}`}>
              {row.canSignIn ? (
                <Button disabled={signingIn !== undefined} onClick={() => void signIn(row)}>
                  {signingIn === row.name ? 'Waiting for Browser…' : 'Sign In…'}
                </Button>
              ) : row.from === 'claude.ai' && row.status === 'needs-auth' ? (
                <Button variant="quiet" onClick={() => void openExternal(CLAUDE_AI_CONNECTORS_URL)}>
                  Open claude.ai
                </Button>
              ) : (
                <Dot tone={status.tone} />
              )}
            </Row>
          );
        })
      )}
    </Group>
  );
}
