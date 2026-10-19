import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { claudeConfigDir, encodeProjectDir, pathVariants } from './claude-sessions.js';

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
