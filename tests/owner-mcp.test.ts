import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownerMcpServers } from '../src/agent/runtime/claude/owner-mcp.js';
import { decideTool } from '../src/agent/policy.js';

const write = (file: string, data: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
};

/** A home folder laid out the way Claude Code keeps it, and a repo with a worktree. */
function home(): { home: string; repo: string; worktree: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'owner-mcp-'));
  const repo = path.join(dir, 'repo');
  const worktree = path.join(dir, 'wt');
  const plugins = path.join(dir, '.claude', 'plugins', 'cache');
  write(path.join(dir, '.claude.json'), {
    mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' }, broken: { type: 'http' } },
    projects: {
      [repo]: { mcpServers: { linear: { type: 'sse', url: 'https://mcp.linear.app/sse' } }, disabledMcpServers: ['plugin:supabase:supabase'] },
      [path.join(dir, 'elsewhere')]: { mcpServers: { other: { command: 'other' } } },
    },
  });
  write(path.join(dir, '.claude', 'settings.json'), { enabledPlugins: { 'context7@official': true, 'supabase@official': true, 'tools@local': true, 'off@official': false } });
  write(path.join(dir, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'context7@official': [{ scope: 'user', installPath: path.join(plugins, 'context7') }],
      'supabase@official': [{ scope: 'user', installPath: path.join(plugins, 'supabase') }],
      'tools@local': [{ scope: 'user', installPath: path.join(plugins, 'tools') }],
      'off@official': [{ scope: 'user', installPath: path.join(plugins, 'off') }],
    },
  });
  write(path.join(plugins, 'context7', '.mcp.json'), { mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp', _meta: { icon: 'x' } } } });
  write(path.join(plugins, 'supabase', '.claude-plugin', 'plugin.json'), { name: 'supabase', mcpServers: './agents/.mcp.json' });
  write(path.join(plugins, 'supabase', 'agents', '.mcp.json'), { mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } } });
  write(path.join(plugins, 'tools', '.claude-plugin', 'plugin.json'), { name: 'tools', mcpServers: { run: { command: '${CLAUDE_PLUGIN_ROOT}/bin/run', args: ['--key', '${TOOLS_KEY:-none}'] } } });
  write(path.join(plugins, 'off', '.mcp.json'), { mcpServers: { off: { command: 'off' } } });
  mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
  write(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  return { home: dir, repo, worktree };
}

describe('ownerMcpServers', () => {
  // Not on Windows: the plugin root keeps its "/" there, which Windows takes as it is.
  it.skipIf(process.platform === 'win32')("brings your user, local and plugins' servers, named as Claude Code names them", () => {
    const h = home();
    const servers = ownerMcpServers(h.worktree, {}, h.home);
    expect(Object.keys(servers).sort()).toEqual(['figma', 'linear', 'plugin:context7:context7', 'plugin:tools:run']);
    expect(servers['plugin:context7:context7']).toEqual({ type: 'http', url: 'https://mcp.context7.com/mcp' });
    expect(servers['plugin:tools:run']).toEqual({ command: path.join(h.home, '.claude', 'plugins', 'cache', 'tools', 'bin', 'run'), args: ['--key', 'none'] });
  });

  it('keeps a server you turned off for the project off, and fills variables from your environment', () => {
    const h = home();
    expect(ownerMcpServers(h.repo, { TOOLS_KEY: 'k' }, h.home)['plugin:tools:run']).toMatchObject({ args: ['--key', 'k'] });
    expect(ownerMcpServers(path.join(h.home, 'unrelated'), {}, h.home)).toHaveProperty('plugin:supabase:supabase');
  });

  it("reads nothing from the project's own .mcp.json (a friend could write it)", () => {
    const h = home();
    write(path.join(h.worktree, '.mcp.json'), { mcpServers: { planted: { command: 'curl evil' } } });
    expect(ownerMcpServers(h.worktree, {}, h.home)).not.toHaveProperty('planted');
  });

  it('is empty without a Claude Code setup', () => {
    expect(ownerMcpServers('/nowhere', {}, mkdtempSync(path.join(os.tmpdir(), 'owner-mcp-empty-')))).toEqual({});
  });

  it('asks before their tools run, like any tool Beluga does not know', () => {
    expect(decideTool('mcp__figma__get_screenshot', {}, { cwd: '/w', roots: ['/w'], autoEdit: true })).toBe('ask');
  });
});
