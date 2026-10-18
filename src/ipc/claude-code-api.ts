import { z } from 'zod';

/**
 * Claude Code sessions running outside klaud (see api.ts): their recent steps, for a screen
 * showing one live. The list itself is in the shared state (`claudeCode.sessions`). Read-only.
 * Browser-safe: zod only.
 */

const sessionId = z.string().regex(/^[0-9a-f-]{8,64}$/i);
const agentId = z.string().regex(/^[\w-]{1,64}$/);
const seq = z.number().int().min(0);
const Page = z.object({ before: seq.optional(), after: seq.optional(), limit: z.number().int().min(1).max(200).optional() }).strict();

export const CLAUDE_CODE_API = {
  // A session's steps (or one of its agents'): the newest, or before/after a step → { steps, more, missing? }.
  'claudeCode.steps': { args: z.tuple([sessionId, agentId.optional(), Page.optional()]) },
} as const;
