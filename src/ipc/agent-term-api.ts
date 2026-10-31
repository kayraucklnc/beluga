import { z } from 'zod';

/**
 * The agent's own terminal on a conversation (BLG-534): Claude Code's or Codex's terminal app in
 * the middle of a worktree, on the same conversation as its chat; and the visuals it showed
 * (BLG-535), opened beside it. Browser-safe: zod only.
 */

const TermSize = z.object({ cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) });

export const AGENT_TERM_API = {
  // Open it (or the one open) → the terminal's key to attach to. Fails with why (a turn running in the chat).
  'agentTerm.open': { args: z.tuple([z.string().min(1).max(200), TermSize.optional()]) },
  // Give the conversation back to the chat: the terminal closes, what it said is in the chat.
  'agentTerm.takeOver': { args: z.tuple([z.string().min(1).max(200)]) },
  // A visual one of its links opens → its fenced block (beluga-graph or beluga-view), or undefined.
  'agentTerm.visual': { args: z.tuple([z.string().min(1).max(200), z.number().int().min(1).max(1_000_000)]) },
} as const;
