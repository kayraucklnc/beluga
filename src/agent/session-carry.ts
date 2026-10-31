import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { claudeConfigDir, encodeProjectDir, pathVariants } from './runtime/claude/claude-sessions.js';

/**
 * Make a Claude Code conversation resumable from another folder. Claude Code files sessions
 * under the folder they ran in (~/.claude/projects/<folder>/<id>.jsonl) and looks there when
 * resuming, so a conversation that moves (main folder → new worktree) is copied next to the new
 * folder first. Nothing happens when it's already there or can't be found. True when it's there.
 */
export function carrySession(sessionId: string, fromDir: string, toDir: string, configDir = claudeConfigDir()): boolean {
  if (!/^[\w-]{1,100}$/.test(sessionId)) return false;
  const projects = path.join(configDir, 'projects');
  const file = `${sessionId}.jsonl`;
  const target = path.join(projects, encodeProjectDir(path.resolve(toDir)), file);
  if (pathVariants(toDir).some((d) => existsSync(path.join(projects, encodeProjectDir(d), file)))) return true;
  const source = pathVariants(fromDir)
    .map((d) => path.join(projects, encodeProjectDir(d), file))
    .find((f) => existsSync(f));
  if (!source) return false;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    return true;
  } catch {
    return false;
  }
}

/** The runtime a stored session id belongs to when none was recorded: everything before BLG-445 was Claude's. */
export const SESSION_RUNTIME_DEFAULT = 'claude';

/**
 * Can a run on `runtime` resume a session `made` (the runtime that made it) left? Its own, always.
 * A local model runs Claude Code too, on your same ~/.claude, so it also picks up Claude's
 * conversations (no handoff). Not the other way: a local model's turns can hold thinking without
 * Anthropic's signatures, which Claude's API may refuse, so Claude starts fresh (with a handoff) after one.
 */
export function resumable(made: string | undefined, runtime: string): boolean {
  const by = made ?? SESSION_RUNTIME_DEFAULT;
  return by === runtime || (runtime === 'local' && by === SESSION_RUNTIME_DEFAULT);
}

/**
 * The session a run on `runtime` may resume: a stored one only when a runtime that can read it made
 * it (see resumable). Session ids are each runtime's own (a Codex thread id means nothing to Claude
 * Code, and the other way round), so a place whose agent changed runtime starts a new conversation
 * instead (BLG-447 hands the old one off). `pending`: a Claude Code conversation found outside Beluga.
 */
export function resumeFor(
  stored: { readonly sessionId?: string; readonly forkFromSession?: string; readonly sessionRuntime?: string },
  runtime: string,
  pending?: string,
): { readonly resume?: string; readonly forkSession: boolean } {
  const own = resumable(stored.sessionRuntime, runtime);
  if (own && stored.forkFromSession) return { resume: stored.forkFromSession, forkSession: true };
  if (own && stored.sessionId) return { resume: stored.sessionId, forkSession: false };
  if (pending && resumable(SESSION_RUNTIME_DEFAULT, runtime) && !stored.sessionId && !stored.forkFromSession) return { resume: pending, forkSession: false };
  return { resume: undefined, forkSession: false };
}
