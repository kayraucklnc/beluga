import { z } from 'zod';

/**
 * Earnings from Stripe, per project (see api.ts): connect a key, forget it, count again now.
 * Only the Mac app shows them; the key goes in once and never comes back out. Browser-safe: zod only.
 */

const projectId = z.string().min(1).max(200);
// Stripe keys are long; the core checks the exact shape and says what's wrong.
const key = z.string().trim().min(1).max(400);

export const STRIPE_API = {
  // Check the key with Stripe and keep it (on this computer only): → { ok: true, account?, mode, secretKey } or { ok: false, error }.
  'stripe.connect': { args: z.tuple([projectId, key]) },
  'stripe.disconnect': { args: z.tuple([projectId]) },
  // Count again now: one project, or every connected one.
  'stripe.refresh': { args: z.tuple([projectId.optional()]) },
} as const;
