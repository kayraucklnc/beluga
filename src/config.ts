import os from 'node:os';
import { parseArgs } from 'node:util';
import { type ShareConfig, parseShareSpec } from './core/shares.js';
import type { Policy } from './core/store.js';
import type { TunnelKind } from './net/tunnel.js';

export const USAGE = `klaude — a multiplayer terminal for you, your friends, and everyone's Claude

Usage:
  klaude host [options]            start a room and print an invite code
  klaude join <invite> [options]   join a friend's room

Options:
  -n, --name <name>        display name (default: your OS username)
  -s, --share <spec>       share a folder: [name=]path[:rw]  (repeatable)
                           :rw lets your claude edit there without asking
      --no-share           share nothing (default shares the current folder read-only)
      --no-agent           don't offer your claude to the room
      --policy <p>         requests from friends for your claude: ask | auto | deny (default ask)
      --model <id>         model for your claude (default: your Claude Code default)
  host only:
      --tunnel <kind>      auto | ngrok | cloudflared | none (default auto)
      --lan                listen on all interfaces so LAN peers can dial ws://<your-ip>:<port>
  -p, --port <port>        hub port (default random)
  -h, --help               show this help
`;

export interface Config {
  readonly mode: 'host' | 'join' | 'help';
  readonly invite?: string;
  readonly name: string;
  readonly shares: readonly ShareConfig[];
  readonly agent: boolean;
  readonly policy: Policy;
  readonly model?: string;
  readonly tunnel: TunnelKind;
  readonly lan: boolean;
  readonly port: number;
}

const TUNNELS: readonly TunnelKind[] = ['auto', 'ngrok', 'cloudflared', 'none'];
const POLICIES: readonly Policy[] = ['ask', 'auto', 'deny'];

export function sanitizeName(raw: string): string {
  return raw.replace(/[^\w.-]/g, '').slice(0, 32) || 'anon';
}

export function parseConfig(argv: readonly string[], cwd: string = process.cwd()): Config {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      name: { type: 'string', short: 'n' },
      share: { type: 'string', short: 's', multiple: true },
      'no-share': { type: 'boolean' },
      'no-agent': { type: 'boolean' },
      policy: { type: 'string' },
      model: { type: 'string' },
      tunnel: { type: 'string' },
      lan: { type: 'boolean' },
      port: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const [command, invite] = positionals;
  const mode = values.help || !command ? 'help' : command;
  if (mode !== 'help' && mode !== 'host' && mode !== 'join') throw new Error(`Unknown command "${command}". Try klaude --help`);
  if (mode === 'join' && !invite) throw new Error('Usage: klaude join <invite-code>');

  const tunnel = (values.tunnel ?? 'auto') as TunnelKind;
  if (!TUNNELS.includes(tunnel)) throw new Error(`--tunnel must be one of ${TUNNELS.join(', ')}`);
  const policy = (values.policy ?? 'ask') as Policy;
  if (!POLICIES.includes(policy)) throw new Error(`--policy must be one of ${POLICIES.join(', ')}`);
  const port = values.port ? Number(values.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535');

  const specs = values['no-share'] ? [] : (values.share ?? ['.']);
  const shares = specs.map((s) => parseShareSpec(s, cwd));
  const names = new Set<string>();
  for (const s of shares) {
    if (names.has(s.name)) throw new Error(`Two shares are named "${s.name}"; use name=path to rename one`);
    names.add(s.name);
  }

  return {
    mode,
    invite,
    name: sanitizeName(values.name ?? os.userInfo().username),
    shares,
    agent: !values['no-agent'],
    policy,
    model: values.model,
    tunnel,
    lan: Boolean(values.lan),
    port,
  };
}
