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

/** File-editing tools and the input field that names the file they change. */
const WRITE_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Tools that only touch the chat, plan, or go through the remote owner's own checks. */
const ALWAYS_OK = new Set([
  'TodoWrite',
  'ToolSearch',
  ...['send_chat', 'list_peers', 'list_peer_files', 'read_peer_file', 'write_report'].map((n) => `mcp__klaud__${n}`),
]);

/** Shell commands that mention credential stores are refused outright. */
export const SECRET_IN_COMMAND = /(^|[\s'"/=])(\.env(\.[\w-]+)?|id_(rsa|ed25519|ecdsa|dsa)|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.npmrc|\.netrc|\.git-credentials|credentials(\.json)?)([\s'"/]|$)/;

export type Decision = 'allow' | 'deny' | 'ask';

export interface PolicyContext {
  readonly cwd: string;
  readonly roots: readonly string[];
  /** The primary share was marked :rw, so edits inside it don't need approval. */
  readonly autoEdit: boolean;
  /** 'folder': reading outside the shared folders asks the owner; 'full': it just runs. */
  readonly scope?: 'folder' | 'full';
}

const inside = (root: string, target: string): boolean => target === root || target.startsWith(root + path.sep);
const resolveTarget = (cwd: string, raw: unknown): string => path.resolve(cwd, typeof raw === 'string' && raw ? raw : '.');

/**
 * Decide whether a tool call can run without asking the machine owner.
 * This runs as a PreToolUse hook, so it applies even to tools Claude Code would
 * auto-approve on its own (e.g. "read-only" shell commands).
 *  - credential files (by path or in a shell command) are always denied
 *  - read-only tools inside the shared folders are allowed; outside them the owner is asked
 *  - edits inside a :rw share are allowed
 *  - everything else (Bash, web, other edits, reads outside shares, ask_agent) asks the owner
 */
export function decideTool(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): Decision {
  if (ALWAYS_OK.has(toolName)) return 'allow';
  // Sending a file reads it: same rules as Read (secrets never leave; outside shared folders asks).
  if (toolName === 'mcp__klaud__send_file') {
    const raw = typeof input.path === 'string' ? input.path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~') : '';
    // Only full paths: the same file is checked here and read when it's sent.
    if (!path.isAbsolute(raw)) return 'deny';
    const target = path.resolve(raw);
    if (isSecretPath(target)) return 'deny';
    if (ctx.roots.some((r) => inside(path.resolve(r), target))) return 'allow';
    return ctx.scope === 'full' ? 'allow' : 'ask';
  }
  // Commands on a friend's computer: their klaud decides; secrets are refused on both ends.
  if (toolName === 'mcp__klaud__run_on_peer') return typeof input.command === 'string' && SECRET_IN_COMMAND.test(input.command) ? 'deny' : 'ask';
  if (toolName === 'Bash') return typeof input.command === 'string' && SECRET_IN_COMMAND.test(input.command) ? 'deny' : 'ask';
  const readField = READ_TOOLS[toolName];
  if (readField) {
    const target = resolveTarget(ctx.cwd, input[readField]);
    if (isSecretPath(target) || (typeof input.pattern === 'string' && isSecretPath(input.pattern))) return 'deny';
    if (ctx.roots.some((r) => inside(path.resolve(r), target))) return 'allow';
    // Outside the shared folders the owner decides (or it just runs, with full trust).
    return ctx.scope === 'full' ? 'allow' : 'ask';
  }
  const writeField = WRITE_TOOLS[toolName];
  if (writeField) {
    const target = resolveTarget(ctx.cwd, input[writeField]);
    if (isSecretPath(target)) return 'deny';
    if (ctx.autoEdit && inside(path.resolve(ctx.cwd), target)) return 'allow';
    if (ctx.scope !== 'full' && !ctx.roots.some((r) => inside(path.resolve(r), target))) return 'deny';
    return 'ask';
  }
  return 'ask';
}

export const DENY_REASON = 'klaud blocked this: credential files are off-limits, and this request may only use the shared folders.';
