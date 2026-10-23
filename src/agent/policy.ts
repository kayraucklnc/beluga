import path from 'node:path';
import { isSecretPath } from '../core/shares.js';
import { isReadOnlyCommand } from './read-only.js';
import { SourceSchema } from '../shared/view-spec.js';
import { SYNC_MAIN_REASON, type SyncScope, isSyncMainCommand } from './sync-main.js';

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
  // continue_in_worktree is only offered in main folders, and decides who must confirm itself.
  ...['send_chat', 'list_peers', 'list_peer_files', 'read_peer_file', 'write_report', 'continue_in_worktree'].map((n) => `mcp__beluga__${n}`),
  // The gateway's look-and-wait tools (core/gateway); ask_person and run_on ask, and the gateway checks trust itself.
  ...['who_can', 'wait_for', 'check', 'cancel', 'answer_question'].map((n) => `mcp__beluga__${n}`),
  // The task board: only your own runs have it, and it only changes your tasks (each change is in their activity).
  ...['task_define', 'task_get', 'task_list', 'task_create', 'task_update', 'task_brief_edit', 'task_note', 'task_relate', 'task_attach_proof'].map((n) => `mcp__beluga_board__${n}`),
  // A plan's tools: only its home conversation has them (core/plans); changes to an approved plan wait for you.
  ...['plan_get', 'plan_write', 'plan_update', 'plan_gate', 'plan_start_task', 'plan_message_task'].map((n) => `mcp__beluga_plan__${n}`),
  // A friend's task only has these when its owner allowed them for that request (core/gateway/serve.ts).
  ...['screenshot', 'device_info'].map((n) => `mcp__beluga_task__${n}`),
]);

/**
 * Shell commands that mention credential stores are refused outright. A name counts when it isn't
 * part of a longer word, so shell punctuation around it (`cat .env|base64`, `(cat .env)`) still matches.
 */
export const SECRET_IN_COMMAND = /(?<![\w.-])(\.env(\.[\w-]+)?|id_(rsa|ed25519|ecdsa|dsa)|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.npmrc|\.netrc|\.git-credentials|credentials(\.json)?)(?![\w-])/;

/** True when a shell command touches secrets, also through quoting tricks like `".e"nv` or `\.env`. */
export const mentionsSecret = (command: string): boolean => SECRET_IN_COMMAND.test(command) || SECRET_IN_COMMAND.test(command.replace(/['"\\]/g, ''));

export type Decision = 'allow' | 'deny' | 'ask';

export interface PolicyContext {
  readonly cwd: string;
  readonly roots: readonly string[];
  /** The primary share was marked :rw, so edits inside it don't need approval. */
  readonly autoEdit: boolean;
  /** 'folder': reading outside the shared folders asks the owner; 'full': it just runs. */
  readonly scope?: 'folder' | 'full';
  /**
   * A project's main folder: questions only. Nothing may change there (work happens in
   * worktrees): edits are denied, and shell commands that aren't clearly read-only too.
   */
  readonly askOnly?: boolean;
  /**
   * With askOnly, for one run: Claude is bringing main up to date, so git syncing (and editing
   * files with conflict markers) is allowed too; nothing else changes (see sync-main.ts).
   */
  readonly syncMain?: SyncScope;
  /**
   * With askOnly: a hidden worktree where the plan's Claude fixes a conflict combining the
   * branches a task starts from. Files there may be edited (nothing else changes).
   */
  readonly fixup?: string;
  /** A guest invited into one project asked: they never reach the room through your Claude. */
  readonly guest?: boolean;
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
  if (ctx.askOnly && changesMain(toolName, input, ctx)) return 'deny';
  if (ctx.guest && toolName.startsWith('mcp__beluga__')) return 'deny';
  if (ALWAYS_OK.has(toolName)) return 'allow';
  // Sending a file reads it: same rules as Read (secrets never leave; outside shared folders asks).
  if (toolName === 'mcp__beluga__send_file') {
    const raw = typeof input.path === 'string' ? input.path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~') : '';
    // Only full paths: the same file is checked here and read when it's sent.
    if (!path.isAbsolute(raw)) return 'deny';
    const target = path.resolve(raw);
    if (isSecretPath(target)) return 'deny';
    if (ctx.roots.some((r) => inside(path.resolve(r), target))) return 'allow';
    return ctx.scope === 'full' ? 'allow' : 'ask';
  }
  // Commands on a friend's computer: their Beluga decides; secrets are refused on both ends.
  if (toolName === 'mcp__beluga__run_on_peer' || toolName === 'mcp__beluga__run_on') return typeof input.command === 'string' && mentionsSecret(input.command) ? 'deny' : 'ask';
  if (toolName === 'Bash') return typeof input.command === 'string' && mentionsSecret(input.command) ? 'deny' : 'ask';
  if (toolName === 'mcp__beluga_view__show') return decideShow(input, ctx);
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
    if (ctx.fixup && inside(path.resolve(ctx.fixup), target)) return 'allow';
    if (ctx.scope !== 'full' && !ctx.roots.some((r) => inside(path.resolve(r), target))) return 'deny';
    return 'ask';
  }
  return 'ask';
}

/**
 * Showing a view runs its source once: a command asks like Bash; a file, folder or SQLite file is
 * read like Read; a web address runs (asking when it would send one of your variables along).
 */
function decideShow(input: Record<string, unknown>, ctx: PolicyContext): Decision {
  const view = input.view && typeof input.view === 'object' ? (input.view as Record<string, unknown>) : {};
  if (view.source === undefined) return 'allow';
  const parsed = SourceSchema.safeParse(view.source);
  if (!parsed.success) return 'allow'; // the tool says what's wrong; nothing runs
  const source = parsed.data;
  if (source.kind === 'command') return mentionsSecret(source.command) ? 'deny' : ctx.askOnly && !isReadOnlyCommand(source.command) ? 'deny' : 'ask';
  if (source.kind === 'http') return Object.values(source.headers ?? {}).some((v) => /\$\{?[A-Za-z_]/.test(v)) ? 'ask' : 'allow';
  if (source.kind === 'postgres') return 'allow';
  const target = resolveTarget(ctx.cwd, source.path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  if (isSecretPath(target)) return 'deny';
  if (ctx.roots.some((r) => inside(path.resolve(r), target))) return 'allow';
  return ctx.scope === 'full' ? 'allow' : 'ask';
}

/** In a main folder (ask-only): would this tool change something there? */
function changesMain(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): boolean {
  const writeField = WRITE_TOOLS[toolName];
  if (writeField) {
    const target = resolveTarget(ctx.cwd, input[writeField]);
    return !(ctx.fixup && inside(path.resolve(ctx.fixup), target)) && !ctx.syncMain?.conflicted?.(target);
  }
  if (toolName === 'Bash') return !(typeof input.command === 'string' && (isReadOnlyCommand(input.command) || (ctx.syncMain !== undefined && isSyncMainCommand(input.command, ctx.syncMain))));
  // A file fetched from a friend may not land in the main folder.
  if (toolName === 'mcp__beluga__get_peer_file') return typeof input.save_to === 'string' && inside(path.resolve(ctx.cwd), resolveTarget(ctx.cwd, input.save_to.replace(/^~(?=$|\/)/, process.env.HOME ?? '~')));
  return false;
}

export const DENY_REASON = 'Beluga blocked this: credential files are off-limits, and this request may only use the shared folders.';

/** Why an ask-only run can't do it, and what to do instead. */
export const ASK_ONLY_REASON =
  "Beluga blocked this: you're in the project's main folder, which is read-only (questions only; work happens in worktrees). " +
  "Don't try another way to change it here. If a change is wanted, call mcp__beluga__continue_in_worktree with the task.";

/** The reason to give Claude for a denied tool call. */
export function denyReason(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): string {
  if (!ctx.askOnly || !changesMain(toolName, input, ctx)) return DENY_REASON;
  return ctx.syncMain ? SYNC_MAIN_REASON : ASK_ONLY_REASON;
}
