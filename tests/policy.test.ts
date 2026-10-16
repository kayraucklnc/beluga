import { describe, expect, it } from 'vitest';
import { decideTool } from '../src/agent/policy.js';

const cwd = '/work/proj';
const roots = [cwd, '/work/docs'];

describe('decideTool', () => {
  it('allows room tools and reads inside shares', () => {
    expect(decideTool('mcp__klaude__send_chat', {}, cwd, roots)).toBe('allow');
    expect(decideTool('TodoWrite', {}, cwd, roots)).toBe('allow');
    expect(decideTool('Read', { file_path: 'src/a.ts' }, cwd, roots)).toBe('allow');
    expect(decideTool('Grep', { pattern: 'TODO' }, cwd, roots)).toBe('allow');
    expect(decideTool('Glob', { path: '/work/docs/guides' }, cwd, roots)).toBe('allow');
  });

  it('asks before reading outside shares or using anything powerful', () => {
    expect(decideTool('Read', { file_path: '/etc/hosts' }, cwd, roots)).toBe('ask');
    expect(decideTool('Read', { file_path: '../other/x' }, cwd, roots)).toBe('ask');
    expect(decideTool('LS', { path: '/work/proj-evil' }, cwd, roots)).toBe('ask');
    for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Write', 'mcp__klaude__ask_agent']) {
      expect(decideTool(tool, {}, cwd, roots)).toBe('ask');
    }
  });

  it('denies credential files anywhere', () => {
    expect(decideTool('Read', { file_path: '.env' }, cwd, roots)).toBe('deny');
    expect(decideTool('Read', { file_path: '/Users/me/.ssh/id_ed25519' }, cwd, roots)).toBe('deny');
    expect(decideTool('Read', { file_path: 'config/.AWS/credentials' }, cwd, roots)).toBe('deny');
    expect(decideTool('Glob', { pattern: '**/.env.local' }, cwd, roots)).toBe('deny');
    expect(decideTool('NotebookRead', { notebook_path: 'keys/server.pem' }, cwd, roots)).toBe('deny');
  });
});
