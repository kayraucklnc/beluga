import { z } from 'zod';

/**
 * Claude Code sessions running outside Beluga (see api.ts): their recent steps, for a screen
 * showing one live. The list itself is in the shared state (`claudeCode.sessions`). Read-only.
 * Browser-safe: zod only.
 */

const sessionId = z.string().regex(/^[0-9a-f-]{8,64}$/i);
const agentId = z.string().regex(/^[\w-]{1,64}$/);
const seq = z.number().int().min(0);
const filePath = z.string().min(2).max(4096).refine((p) => p.startsWith('/') && !p.includes('\0'), 'a full path');
const Page = z.object({ before: seq.optional(), after: seq.optional(), limit: z.number().int().min(1).max(200).optional() }).strict();

export const CLAUDE_CODE_API = {
  // A session's steps (or one of its agents'): the newest, or before/after a step → { steps, more, missing? }.
  'claudeCode.steps': { args: z.tuple([sessionId, agentId.optional(), Page.optional()]) },
  // One step with its details (input and output, or thinking) → a StepRecord, or undefined once it's no longer kept.
  'claudeCode.step': { args: z.tuple([sessionId, agentId.optional(), seq]) },
  // Find a sub-agent by its id however old (its worktree is open, say) and keep it watched a while → its session's id, or undefined.
  'claudeCode.findAgent': { args: z.tuple([agentId]) },
  // What a sub-agent made or looked at (screenshots, logs, test output) still on disk → { outputs, scratch?, missing? }.
  'claudeCode.outputs': { args: z.tuple([sessionId, agentId]) },
  // One of them, to show it (only a file that agent made or looked at) → its contents, or undefined.
  'claudeCode.output': { args: z.tuple([sessionId, agentId, filePath]) },
  // The end of a background command's output (the session's, or one of its agents') → { text, size, file, mtime, truncated? }, or undefined.
  'claudeCode.taskOutput': { args: z.tuple([sessionId, agentId.optional(), agentId]) },
  // The skills and custom commands Claude can use in a conversation (its folder's, yours, your plugins') → ClaudeSkill[].
  'claudeCode.skills': { args: z.tuple([z.string().min(1).max(200)]) },
} as const;
