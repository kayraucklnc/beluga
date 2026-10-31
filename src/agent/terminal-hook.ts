import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { belugaHome } from '../core/home.js';
import { type PolicyContext, decideTool, denyReason } from './policy.js';
import type { AgentRunInput } from './types.js';

/**
 * Beluga's rules for Claude Code in its own terminal (BLG-534). A run in the chat checks every
 * tool call in a PreToolUse hook in-process (claude/runner.ts); the terminal's Claude Code is its
 * own program, so the same hook is a command in its `--settings` that asks the daemon (over the
 * tool host, with the terminal's token) and prints the answer. Its own permission prompts still
 * ask you in the terminal.
 */

/** The variables the hook reads: where to ask, and the terminal's token. */
export const GATE_URL_ENV = 'BELUGA_GATE_URL';
export const GATE_TOKEN_ENV = 'BELUGA_GATE_TOKEN';

/**
 * The hook itself: plain Node, no Beluga code, so it starts in a moment for every tool call. It
 * sends Claude Code's JSON to the daemon and prints what comes back. When the daemon can't be
 * asked, the call is refused: Beluga's rules never silently stop applying.
 */
export const GATE_HOOK_SCRIPT = `// Beluga: asks the Beluga daemon about each tool call of Claude Code in Beluga's terminal view.
const proc = process;
const url = process.env.${GATE_URL_ENV};
const token = process.env.${GATE_TOKEN_ENV};
const refuse = (why) => {
  proc.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }));
  process.exit(0);
};
let body = '';
proc.stdin.setEncoding('utf8');
proc.stdin.on('data', (chunk) => (body += chunk));
proc.stdin.on('end', async () => {
  if (!url || !token) return refuse('Beluga could not check this action (its terminal lost its settings). Open the terminal again from Beluga.');
  try {
    const res = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok) return refuse('Beluga could not check this action (' + res.status + '). Open the terminal again from Beluga.');
    proc.stdout.write(await res.text());
    process.exit(0);
  } catch {
    refuse('Beluga could not check this action: is Beluga still running?');
  }
});
`;

/** The hook's file, written (again when it changed) under Beluga's home. */
export function gateHookFile(home = belugaHome()): string {
  const file = path.join(home, 'terminal', 'gate-hook.mjs');
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== GATE_HOOK_SCRIPT) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, GATE_HOOK_SCRIPT, { mode: 0o600 });
  }
  return file;
}

/** A word for a shell, quoted (the hook's command is run by one). */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The settings that add the hook (merged by Claude Code with yours; your own hooks run too). */
export function gateHookSettings(node: string, file: string): Record<string, unknown> {
  return { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${shellQuote(node)} ${shellQuote(file)}`, timeout: 600 }] }] } };
}

const verdict = (permissionDecision: 'deny' | 'ask', permissionDecisionReason: string): Record<string, unknown> => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } });

/**
 * Beluga's answer to one tool call in the terminal, as the chat's hook decides it: a friend's
 * limits (vetTool) and Beluga's policy deny what they deny (the main folder, outside the
 * worktree, credential files); a .env file always asks you, in the terminal; the rest is up to
 * Claude Code's own rules and prompts. Beluga's own tools are checked by the tool host (gateTool).
 */
export function terminalHookAnswer(hook: Record<string, unknown>, input: Pick<AgentRunInput, 'vetTool'>, policy: PolicyContext): Record<string, unknown> {
  if (hook.hook_event_name !== 'PreToolUse') return {};
  const tool = typeof hook.tool_name === 'string' ? hook.tool_name : '';
  if (!tool || /^mcp__beluga(_\w+)?__/.test(tool)) return {};
  const toolInput = hook.tool_input && typeof hook.tool_input === 'object' && !Array.isArray(hook.tool_input) ? (hook.tool_input as Record<string, unknown>) : {};
  const veto = input.vetTool?.(tool, toolInput);
  if (veto) return verdict('deny', veto);
  const decision = decideTool(tool, toolInput, policy);
  if (decision === 'deny') return verdict('deny', denyReason(tool, toolInput, policy));
  if (decision === 'secret') return verdict('ask', 'Beluga: this touches a secrets file (.env). Allow it only if you mean to.');
  return {};
}
