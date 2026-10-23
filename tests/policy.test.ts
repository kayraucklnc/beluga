import { describe, expect, it } from 'vitest';
import { decideTool } from '../src/agent/policy.js';

const ctx = { cwd: '/work/proj', roots: ['/work/proj', '/work/docs'], autoEdit: false };
const rw = { ...ctx, autoEdit: true };

describe('decideTool', () => {
  it('allows room tools, planning, and reads inside shares', () => {
    for (const t of ['mcp__beluga__send_chat', 'TodoWrite', 'ToolSearch']) expect(decideTool(t, {}, ctx)).toBe('allow');
    expect(decideTool('Read', { file_path: 'src/a.ts' }, ctx)).toBe('allow');
    expect(decideTool('Grep', { pattern: 'TODO' }, ctx)).toBe('allow');
    expect(decideTool('Glob', { path: '/work/docs/guides' }, ctx)).toBe('allow');
  });

  it('asks before shell commands, even "read-only" ones Claude Code would auto-approve', () => {
    expect(decideTool('Bash', { command: 'ls' }, ctx)).toBe('ask');
    expect(decideTool('Bash', { command: 'cat NOTES.md' }, rw)).toBe('ask');
  });

  it('asks the owner before reading outside the shared folders, and blocks edits there', () => {
    expect(decideTool('Read', { file_path: '/etc/hosts' }, ctx)).toBe('ask');
    expect(decideTool('Read', { file_path: '../other/x' }, ctx)).toBe('ask');
    expect(decideTool('LS', { path: '/work/proj-evil' }, ctx)).toBe('ask');
    expect(decideTool('Write', { file_path: '/tmp/x' }, rw)).toBe('deny');
  });

  it('treats sending a file like reading it', () => {
    expect(decideTool('mcp__beluga__send_file', { path: '/work/proj/NOTES.md' }, ctx)).toBe('allow');
    // Relative paths are refused: the file checked must be the file sent.
    expect(decideTool('mcp__beluga__send_file', { path: 'NOTES.md' }, ctx)).toBe('deny');
    expect(decideTool('mcp__beluga__send_file', { path: '/Users/me/Desktop/a.pdf' }, ctx)).toBe('ask');
    expect(decideTool('mcp__beluga__send_file', { path: '/Users/me/Desktop/a.pdf' }, { ...ctx, scope: 'full' })).toBe('allow');
    expect(decideTool('mcp__beluga__send_file', { path: '/Users/me/.ssh/id_rsa' }, { ...ctx, scope: 'full' })).toBe('deny');
    expect(decideTool('mcp__beluga__send_file', { path: '/work/proj/.env' }, ctx)).toBe('deny');
  });

  it('lets whole-computer access read anywhere, but still asks before edits outside :rw', () => {
    const full = { ...ctx, scope: 'full' as const };
    expect(decideTool('Read', { file_path: '/etc/hosts' }, full)).toBe('allow');
    expect(decideTool('Write', { file_path: '/tmp/x' }, full)).toBe('ask');
    expect(decideTool('Read', { file_path: '/Users/me/.ssh/id_rsa' }, full)).toBe('deny');
  });

  it('asks before anything powerful', () => {
    for (const tool of ['WebFetch', 'WebSearch', 'mcp__beluga__ask_agent']) expect(decideTool(tool, {}, ctx)).toBe('ask');
  });

  it('lets edits through only inside a :rw share', () => {
    expect(decideTool('Edit', { file_path: 'src/a.ts' }, ctx)).toBe('ask');
    expect(decideTool('Edit', { file_path: 'src/a.ts' }, rw)).toBe('allow');
    expect(decideTool('Write', { file_path: '/work/docs/x.md' }, rw)).toBe('ask'); // other share, not the primary
  });

  it('denies credential files anywhere, by path or in shell commands', () => {
    expect(decideTool('Read', { file_path: '.env' }, ctx)).toBe('deny');
    expect(decideTool('Read', { file_path: '/Users/me/.ssh/id_ed25519' }, ctx)).toBe('deny');
    expect(decideTool('Read', { file_path: 'config/.AWS/credentials' }, ctx)).toBe('deny');
    expect(decideTool('Glob', { pattern: '**/.env.local' }, ctx)).toBe('deny');
    expect(decideTool('NotebookRead', { notebook_path: 'keys/server.pem' }, ctx)).toBe('deny');
    expect(decideTool('Write', { file_path: '.env' }, rw)).toBe('deny');
    for (const command of ['cat .env', 'cat ~/.ssh/id_rsa', "grep KEY '.env.local'", 'cp ~/.aws/credentials /tmp']) {
      expect(decideTool('Bash', { command }, ctx)).toBe('deny');
    }
    expect(decideTool('Bash', { command: 'echo environment' }, ctx)).toBe('ask');
    // A search limited to .env files reads them too.
    expect(decideTool('Grep', { pattern: 'KEY', glob: '.env*' }, ctx)).toBe('deny');
  });

  it("asks you about a .env file when it's your own Claude, and still refuses other credentials", () => {
    const own = { ...rw, dotenv: true };
    for (const [tool, input] of [
      ['Read', { file_path: '.env' }],
      ['Read', { file_path: '/work/proj/apps/web/.env.local' }],
      ['Edit', { file_path: '.env' }],
      ['Write', { file_path: '.env.production' }],
      ['Glob', { pattern: '**/.env.local' }],
      ['Grep', { pattern: 'DATABASE_URL', glob: '.env' }],
      ['Bash', { command: 'cat .env' }],
      ['Bash', { command: "grep SUPABASE '.env.local'" }],
    ] as const) {
      expect(decideTool(tool, input, own), `${tool} ${JSON.stringify(input)}`).toBe('secret');
    }
    // Never more than a .env: keys, ~/.ssh, Beluga's own files, or a .env inside a credential store.
    expect(decideTool('Read', { file_path: '/Users/me/.ssh/id_rsa' }, own)).toBe('deny');
    expect(decideTool('Read', { file_path: '/Users/me/.aws/.env' }, own)).toBe('deny');
    expect(decideTool('Grep', { path: '/Users/me/.ssh', glob: '.env' }, own)).toBe('deny');
    expect(decideTool('Bash', { command: 'cat .env ~/.ssh/id_rsa' }, own)).toBe('deny');
    // Edits outside your folders are still refused, .env or not.
    expect(decideTool('Write', { file_path: '/tmp/.env' }, own)).toBe('deny');
    // Sending one, or running it on a friend's computer, never.
    expect(decideTool('mcp__beluga__send_file', { path: '/work/proj/.env' }, own)).toBe('deny');
    expect(decideTool('mcp__beluga__run_on_peer', { command: 'cat .env' }, own)).toBe('deny');
    // Ordinary files are as before.
    expect(decideTool('Read', { file_path: 'src/a.ts' }, own)).toBe('allow');
  });

  it('treats .env templates as ordinary files', () => {
    expect(decideTool('Read', { file_path: '.env.example' }, ctx)).toBe('allow');
    expect(decideTool('Read', { file_path: 'apps/web/.env.sample' }, ctx)).toBe('allow');
    expect(decideTool('Bash', { command: 'cp .env.example .env.examples' }, ctx)).toBe('deny');
    expect(decideTool('Bash', { command: 'cat .env.example' }, ctx)).toBe('ask');
  });
});
