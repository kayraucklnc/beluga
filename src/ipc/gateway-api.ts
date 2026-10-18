import { z } from 'zod';

/**
 * Tasks between Claudes (the gateway) in the API (see api.ts): the Mac app's task cards and
 * Requests view. Browser-safe: zod only.
 */

const taskId = z.string().regex(/^t_[\w-]{10,40}$/);
const needs = z.array(z.enum(['project', 'shell', 'files', 'screen', 'device'])).max(5);

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
} as const;
