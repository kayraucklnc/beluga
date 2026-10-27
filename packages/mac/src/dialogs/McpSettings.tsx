import { useCallback, useEffect, useState } from 'react';
import { CLAUDE_AI_CONNECTORS_URL, type McpServerRow } from '@beluga/shared/mcp.js';
import { Button, Dot } from '../components/ui.js';
import { toast, useApi, useBeluga } from '../lib/beluga.js';
import { openExternal } from '../lib/system.js';
import { Group, Row } from './settings-controls.js';
import s from './settings.module.css';

const FROM: Record<McpServerRow['from'], (where?: string) => string> = {
  user: () => 'Yours, in every project',
  project: (where) => (where ? `Set for ${where}` : 'Set for one project'),
  plugin: (where) => (where ? `From the ${where} plugin` : 'From a plugin'),
  'claude.ai': () => 'A claude.ai connector',
};

const STATUS: Record<McpServerRow['status'], { readonly words: string; readonly tone: 'ok' | 'warn' | 'error' | 'muted' }> = {
  connected: { words: 'Connected', tone: 'ok' },
  'needs-auth': { words: 'Needs you to sign in', tone: 'warn' },
  failed: { words: 'Couldn’t connect', tone: 'error' },
  pending: { words: 'Still starting', tone: 'muted' },
  disabled: { words: 'Turned off', tone: 'muted' },
};

/**
 * Settings › Claude › MCP servers (BLG-251): the servers your own Claude gets from Claude Code
 * (agent/owner-mcp.ts), how each is, and Sign In for one that needs it. Signing in opens your
 * browser; Claude Code keeps the login, so it counts for Claude Code too.
 */
export function McpSettings() {
  const api = useApi();
  const { client } = useBeluga();
  const [rows, setRows] = useState<readonly McpServerRow[] | undefined>();
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState<string | undefined>();

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setRows(await api.claudeCode.mcpServers());
    } catch {
      setRows((r) => r ?? []);
    } finally {
      setChecking(false);
    }
  }, [api]);

  useEffect(() => void check(), [check]);

  const signIn = async (row: McpServerRow): Promise<void> => {
    setSigningIn(row.name);
    try {
      const started = await api.claudeCode.mcpSignIn(row.name);
      if ('error' in started) return toast(client, started.error, 'error');
      if ('url' in started) {
        await openExternal(started.url);
        const ok = await api.claudeCode.mcpSignedIn(row.name);
        toast(client, ok ? `Signed in to ${row.label}` : `Didn’t hear back from ${row.label}. Try again when you’re ready.`, ok ? 'success' : 'warn');
      }
      await check();
    } finally {
      setSigningIn(undefined);
    }
  };

  return (
    <Group title="MCP servers">
      <Row label="Servers your Claude uses" detail="Yours, your projects’ and your plugins’, as Claude Code has them. Only runs you start get them, never a friend’s.">
        <Button variant="quiet" icon="refresh" disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check Again'}
        </Button>
      </Row>
      {rows === undefined ? (
        <div className={s.note}>Asking Claude Code…</div>
      ) : rows.length === 0 ? (
        <div className={s.note}>None yet. Add one in Claude Code (claude mcp add) or turn on a plugin that has one.</div>
      ) : (
        rows.map((row) => {
          const status = STATUS[row.status];
          const why = row.status === 'failed' && row.error ? `: ${row.error}` : '';
          return (
            <Row key={row.name} label={row.label} detail={`${FROM[row.from](row.where)} · ${status.words}${why}`}>
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
