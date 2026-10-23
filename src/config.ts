import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { type Settings, loadSettings } from './core/settings.js';
import { type ShareConfig, parseShareSpec } from './core/shares.js';
import type { Policy } from './core/store.js';
import type { TunnelKind } from './net/tunnel.js';

export interface Config {
  readonly mode: 'host' | 'join' | 'help' | 'demo';
  readonly invite?: string;
  readonly name: string;
  readonly shares: readonly ShareConfig[];
  readonly agent: boolean;
  readonly policy: Policy;
  readonly model?: string;
  readonly tunnel: TunnelKind;
  readonly lan: boolean;
  readonly port: number;
  /** Warnings to show in the room once Beluga starts. */
  readonly notes: readonly string[];
  /** True when --policy was given, so the welcome screen can be skipped. */
  readonly policyChosen: boolean;
  readonly mouse: boolean;
  readonly theme: Settings['theme'];
  readonly selfApproval: Settings['selfApproval'];
  /** Open the tunnel and create an invite right away (otherwise only when you click Invite). */
  readonly inviteNow: boolean;
}

const TUNNELS: readonly TunnelKind[] = ['auto', 'p2p', 'ngrok', 'cloudflared', 'none'];
const POLICIES: readonly Policy[] = ['ask', 'auto', 'deny'];

export function sanitizeName(raw: string): string {
  return raw.replace(/[^\w.-]/g, '').slice(0, 32) || 'anon';
}

/** Folders too broad to share implicitly: someone ran Beluga from ~ or /. */
function isTooBroad(dir: string, home: string): boolean {
  const resolved = path.resolve(dir);
  return resolved === path.resolve(home) || resolved === path.parse(resolved).root;
}

export function parseConfig(
  argv: readonly string[],
  cwd: string = process.cwd(),
  home: string = os.homedir(),
  saved: Settings = loadSettings(),
): Config {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      name: { type: 'string', short: 'n' },
      share: { type: 'string', short: 's', multiple: true },
      'no-share': { type: 'boolean' },
      'no-agent': { type: 'boolean' },
      'no-mouse': { type: 'boolean' },
      invite: { type: 'boolean' },
      policy: { type: 'string' },
      model: { type: 'string' },
      tunnel: { type: 'string' },
      lan: { type: 'boolean' },
      port: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const [command, invite] = positionals;
  // Bare `beluga` means "host a room with my usual settings".
  const mode = values.help || command === 'help' ? 'help' : (command ?? 'host');
  if (mode !== 'help' && mode !== 'host' && mode !== 'join' && mode !== 'demo') throw new Error(`Unknown command "${command}"`);

  const tunnel = (values.tunnel ?? saved.tunnel) as TunnelKind;
  if (!TUNNELS.includes(tunnel)) throw new Error(`--tunnel must be one of ${TUNNELS.join(', ')}`);
  const policy = (values.policy ?? saved.policy ?? 'ask') as Policy;
  if (!POLICIES.includes(policy)) throw new Error(`--policy must be one of ${POLICIES.join(', ')}`);
  const port = values.port ? Number(values.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535');

  const notes: string[] = [];
  // Nothing is shared unless you ask: pass --share, or use /share inside Beluga.
  const specs = values['no-share'] ? [] : (values.share ?? []);
  if (specs.some((spec) => isTooBroad(parseShareSpec(spec, cwd).root, home))) {
    notes.push('Sharing your whole home folder or disk exposes a lot. Consider sharing a project folder instead.');
  }
  const shares = specs.map((s) => parseShareSpec(s, cwd));
  const names = new Set<string>();
  for (const s of shares) {
    if (names.has(s.name)) throw new Error(`Two shares are named "${s.name}"; use name=path to rename one`);
    names.add(s.name);
  }

  return {
    mode,
    invite,
    name: sanitizeName(values.name ?? saved.name ?? os.userInfo().username),
    shares,
    agent: !values['no-agent'],
    policy,
    model: values.model,
    tunnel,
    lan: Boolean(values.lan),
    port,
    notes,
    policyChosen: values.policy !== undefined || saved.policy !== undefined,
    mouse: values['no-mouse'] ? false : saved.mouse,
    inviteNow: Boolean(values.invite),
    theme: saved.theme,
    selfApproval: saved.selfApproval,
  };
}
