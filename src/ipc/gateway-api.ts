import { z } from 'zod';
import { CAP_LEVELS, Decision, RULE_DECISIONS, RULE_KINDS } from '../core/gateway/access.js';

/**
 * Tasks between Claudes (the gateway) in the API (see api.ts): the Mac app's task cards and
 * Requests view. Browser-safe: zod only.
 */

const taskId = z.string().regex(/^t_[\w-]{10,40}$/);
const needs = z.array(z.enum(['project', 'shell', 'files', 'screen', 'device'])).max(5);
const capRow = z.object({ ask: z.enum(CAP_LEVELS), trusted: z.enum(CAP_LEVELS), full: z.enum(CAP_LEVELS) });
const ruleInput = z.object({
  id: z.string().regex(/^r_[\w-]{6,40}$/).optional(),
  peerId: z.string().regex(/^[\w-]{8,64}$/),
  peerName: z.string().max(64),
  kind: z.enum(RULE_KINDS),
  needs: needs.default([]),
  command: z.string().min(1).max(8000).optional(),
  project: z.string().min(1).max(80).optional(),
  folder: z.string().min(1).max(4096).optional(),
  expiresAt: z.number().int().positive().optional(),
  decision: z.enum(RULE_DECISIONS),
});

export const GATEWAY_API = {
  // Your tasks (sent and received) and what people's klauds offer you.
  'gateway.list': { args: z.tuple([]) },
  // Your answer on an "Ask Alice's Claude?" card: send it (maybe reworded), or not now.
  'gateway.confirm': { args: z.tuple([taskId, z.boolean(), z.string().max(16_000).optional()]) },
  // Cancel a task you sent, or stop one someone sent you.
  'gateway.cancel': { args: z.tuple([taskId]) },
  // Ask someone's Claude yourself (from their card): → the task.
  'gateway.ask': { args: z.tuple([z.string().min(1).max(80), z.string().min(1).max(16_000), z.object({ needs: needs.optional(), project: z.string().min(1).max(80).optional() }).optional()]) },
  // Your "Ask me for…" note (what friends' Claudes see on your card).
  'gateway.setNote': { args: z.tuple([z.string().max(280)]) },
  // Your answer to a friend's request waiting on you: once, always (the rule's scope and expiry), or no (a reason).
  'gateway.decide': { args: z.tuple([taskId, Decision]) },
  // Answer the question a friend's Claude asked about a task you sent (one answer per question), or skip.
  'gateway.answer': { args: z.tuple([taskId, z.union([z.array(z.string().max(4000)).min(1).max(4), z.literal('skip')])]) },
  // Your rules for people's requests: add or change one (with an id), remove one.
  'gateway.saveRule': { args: z.tuple([ruleInput]) },
  'gateway.removeRule': { args: z.tuple([z.string().regex(/^r_[\w-]{6,40}$/)]) },
  // What friends' Claudes may do here, by trust level, and the folders they may use.
  'gateway.setCapabilities': { args: z.tuple([z.object({ levels: z.object({ project: capRow, shell: capRow, files: capRow, screen: capRow, device: capRow }).partial().optional(), folders: z.array(z.string().min(1).max(4096)).max(20).optional() })]) },
  // A picture a result brought (a screenshot), to show: → a data: URL.
  'gateway.image': { args: z.tuple([taskId, z.string().min(1).max(200)]) },
} as const;
