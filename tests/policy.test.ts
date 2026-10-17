import { describe, expect, it } from 'vitest';
import { decideTool } from '../src/agent/policy.js';

const ctx = { cwd: '/work/proj', roots: ['/work/proj', '/work/docs'], autoEdit: false };
const rw = { ...ctx, autoEdit: true };

describe('decideTool', () => {
  it('allows room tools, planning, and reads inside shares', () => {
    for (const t of ['mcp__klaud__send_chat', 'TodoWrite', 'ToolSearch']) expect(decideTool(t, {}, ctx)).toBe('allow');
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
    expect(decideTool('mcp__klaud__send_file', { path: '/work/proj/NOTES.md' }, ctx)).toBe('allow');
    // Relative paths are refused: the file checked must be the file sent.
    expect(decideTool('mcp__klaud__send_file', { path: 'NOTES.md' }, ctx)).toBe('deny');
    expect(decideTool('mcp__klaud__send_file', { path: '/Users/me/Desktop/a.pdf' }, ctx)).toBe('ask');
    expect(decideTool('mcp__klaud__send_file', { path: '/Users/me/Desktop/a.pdf' }, { ...ctx, scope: 'full' })).toBe('allow');
    expect(decideTool('mcp__klaud__send_file', { path: '/Users/me/.ssh/id_rsa' }, { ...ctx, scope: 'full' })).toBe('deny');
    expect(decideTool('mcp__klaud__send_file', { path: '/work/proj/.env' }, ctx)).toBe('deny');
  });

  it('lets whole-computer access read anywhere, but still asks before edits outside :rw', () => {
    const full = { ...ctx, scope: 'full' as const };
    expect(decideTool('Read', { file_path: '/etc/hosts' }, full)).toBe('allow');
    expect(decideTool('Write', { file_path: '/tmp/x' }, full)).toBe('ask');
    expect(decideTool('Read', { file_path: '/Users/me/.ssh/id_rsa' }, full)).toBe('deny');
  });

  it('asks before anything powerful', () => {
    for (const tool of ['WebFetch', 'WebSearch', 'mcp__klaud__ask_agent']) expect(decideTool(tool, {}, ctx)).toBe('ask');
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
  });
});
