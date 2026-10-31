import { z } from 'zod';
import { AgentRef } from '../protocol.js';

/**
 * Dialogues in the API (see api.ts): your agents talking, chaired by Beluga (core/dialogues). The
 * Mac starts one (or the composer does: "@my:claude @my:codex talk about X"), confirms its caps,
 * answers Continue?, stops it and speaks into it; the phone stops it. Browser-safe: zod only.
 */

const id = z.string().min(1).max(64);
const caps = z.object({ turnCap: z.number().int().min(1).max(200).optional(), budget: z.number().int().min(1).max(100_000_000).nullable().optional() });

export const DIALOGUES_API = {
  // A new dialogue in a conversation, proposed (its card asks you to confirm its caps) unless `confirmed`.
  'dialogues.start': {
    args: z.tuple([
      z.object({
        channel: z.string().min(1).max(200),
        // A friend's agent names its owner and their peer id (each of its turns is a request to them).
        agents: z.array(AgentRef.extend({ owner: z.string().min(1).max(80).optional(), peer: z.string().min(1).max(200).optional() })).min(2).max(4),
        topic: z.string().min(1).max(8000),
        mode: z.enum(['talk', 'cross-reference', 'work']).optional(),
        turnCap: z.number().int().min(1).max(200).optional(),
        budget: z.number().int().min(1).max(100_000_000).optional(),
        confirmed: z.boolean().optional(),
      }),
    ]),
  },
  // A proposal's Start, with its caps as shown or changed.
  'dialogues.confirm': { args: z.tuple([id, caps.optional()]) },
  // Continue? → yes, for another stretch (its cap, or `more` turns).
  'dialogues.continue': { args: z.tuple([id, z.number().int().min(1).max(200).optional()]) },
  // Stop (or cancel a proposal): over at once.
  'dialogues.stop': { args: z.tuple([id]) },
  // Say something into it: the next agent's turn reads it.
  'dialogues.interject': { args: z.tuple([id, z.string().min(1).max(16_000)]) },
} as const;
