import path from 'node:path';
import { isSecretPath } from '../core/shares.js';

/** Read-only tools and the input field that names their target path. */
const READ_TOOLS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Glob: 'path',
  Grep: 'path',
  LS: 'path',
  NotebookRead: 'notebook_path',
};

/** Room tools that only touch the chat or go through the remote owner's own checks. */
const ROOM_SAFE = new Set(['send_chat', 'list_peers', 'list_peer_files', 'read_peer_file', 'write_report'].map((n) => `mcp__klaude__${n}`));

export type Decision = 'allow' | 'deny' | 'ask';

const inside = (root: string, target: string): boolean => target === root || target.startsWith(root + path.sep);

/**
 * Decide whether a tool call can run without asking the machine owner.
 *  - credential files are always denied
 *  - read-only tools inside the shared roots are allowed
 *  - everything else (Bash, web, edits, reads outside shares, ask_agent) asks the owner
 */
export function decideTool(toolName: string, input: Record<string, unknown>, cwd: string, roots: readonly string[]): Decision {
  if (ROOM_SAFE.has(toolName) || toolName === 'TodoWrite') return 'allow';
  const field = READ_TOOLS[toolName];
  if (!field) return 'ask';
  const raw = input[field];
  const target = path.resolve(cwd, typeof raw === 'string' && raw ? raw : '.');
  if (isSecretPath(target) || (typeof input.pattern === 'string' && isSecretPath(input.pattern))) return 'deny';
  return roots.some((r) => inside(path.resolve(r), target)) ? 'allow' : 'ask';
}
