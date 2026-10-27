import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/**
 * Your own MCP servers, as your Claude Code has them, for your own runs.
 *
 * Runs load no settings files (settingSources: [], so a friend with :rw access can't plant hooks
 * or permission rules), and with them went every MCP server. These are read straight from the
 * files Claude Code keeps in your home folder, never from a shared folder:
 *  - user scope: `mcpServers` in ~/.claude.json
 *  - local scope: `projects[<folder>].mcpServers` in ~/.claude.json, for the run's folder and,
 *    in a worktree, its main checkout (minus the ones you turned off there, `disabledMcpServers`)
 *  - plugins you turned on (`enabledPlugins` in ~/.claude/settings.json): only their MCP servers,
 *    named `plugin:<plugin>:<server>` as Claude Code names them
 * Same names and settings as Claude Code, so a server you signed in to there (/mcp) is signed in here.
 * A project's .mcp.json is left out: it sits in the folder friends may write to.
 */
export function ownerMcpServers(cwd: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Record<string, McpServerConfig> {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const global = readJson(env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json'));
  const projects = asRecord(global?.projects) ?? {};
  const local = [...new Set([cwd, mainCheckout(cwd)].filter((p): p is string => Boolean(p)).map((p) => path.resolve(p)))]
    .map((p) => asRecord(projects[p]))
    .filter((p): p is Record<string, unknown> => Boolean(p));
  const off = new Set(local.flatMap((p) => (Array.isArray(p.disabledMcpServers) ? p.disabledMcpServers.filter((n): n is string => typeof n === 'string') : [])));
  const servers: Record<string, McpServerConfig> = {
    ...pluginServers(configDir, env),
    ...serversIn(global?.mcpServers, env),
    ...Object.assign({}, ...local.map((p) => serversIn(p.mcpServers, env))),
  };
  for (const name of off) delete servers[name];
  return servers;
}

/** The MCP servers of the plugins you turned on, from where Claude Code installed them. */
function pluginServers(configDir: string, env: NodeJS.ProcessEnv): Record<string, McpServerConfig> {
  const enabled = asRecord(readJson(path.join(configDir, 'settings.json'))?.enabledPlugins) ?? {};
  const installed = asRecord(asRecord(readJson(path.join(configDir, 'plugins', 'installed_plugins.json')))?.plugins) ?? {};
  const out: Record<string, McpServerConfig> = {};
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const installs = Array.isArray(installed[id]) ? (installed[id] as unknown[]).map(asRecord).filter(Boolean) : [];
    const install = installs.find((i) => i?.scope === 'user') ?? installs[0];
    const root = typeof install?.installPath === 'string' ? install.installPath : undefined;
    if (!root) continue;
    const plugin = id.split('@')[0] ?? id;
    const vars = { ...env, CLAUDE_PLUGIN_ROOT: root };
    for (const [name, config] of Object.entries(serversIn(pluginMcp(root), vars))) out[`plugin:${plugin}:${name}`] = config;
  }
  return out;
}

/** A plugin's servers: .mcp.json at its root, or plugin.json's `mcpServers` (inline, or a path or paths to such files). */
function pluginMcp(root: string): Record<string, unknown> {
  const declared = readJson(path.join(root, '.claude-plugin', 'plugin.json'))?.mcpServers;
  const files = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared.filter((f): f is string => typeof f === 'string') : [];
  if (asRecord(declared) && !files.length) return asRecord(declared) ?? {};
  if (!files.length) files.push('.mcp.json');
  return Object.assign(
    {},
    ...files.map((f) => {
      const file = readJson(path.resolve(root, f));
      return asRecord(file?.mcpServers) ?? file ?? {};
    }),
  );
}

/** Server configs as written, with ${VAR} and ${VAR:-default} filled in as Claude Code does. */
function serversIn(raw: unknown, vars: NodeJS.ProcessEnv): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(asRecord(raw) ?? {})) {
    const config = asRecord(value);
    if (!config) continue;
    const { _meta: _skip, ...rest } = config;
    const kind = rest.type ?? (typeof rest.command === 'string' ? 'stdio' : undefined);
    if (kind === 'stdio' ? typeof rest.command !== 'string' : typeof rest.url !== 'string') continue;
    out[name] = expand(rest, vars) as McpServerConfig;
  }
  return out;
}

function expand(value: unknown, vars: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name: string, fallback?: string) => vars[name] ?? fallback ?? whole);
  if (Array.isArray(value)) return value.map((v) => expand(v, vars));
  const record = asRecord(value);
  return record ? Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expand(v, vars)])) : value;
}

/** A worktree's main checkout (its .git file points into <main>/.git/worktrees/<name>). */
function mainCheckout(cwd: string): string | undefined {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(cwd, '.git'), 'utf8'))?.[1]?.trim();
    if (!gitdir) return undefined;
    const parts = path.resolve(cwd, gitdir).split(path.sep);
    const at = parts.lastIndexOf('worktrees');
    return at > 1 && parts[at - 1] === '.git' ? parts.slice(0, at - 1).join(path.sep) : undefined;
  } catch {
    return undefined;
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
