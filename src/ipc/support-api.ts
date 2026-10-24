import { z } from 'zod';

/**
 * Supporting Beluga (see core/support-store.ts): answering the ask that came with a merge, the
 * star after the first and the coffee after the fifth. The count and which ask is due are in the
 * shared state's `support`. Only the Mac app shows them. Browser-safe: zod only.
 */

export const SUPPORT_API = {
  // You answered an ask: yes (starred, or opened a payment page), later (Maybe Later / Not Now), never (Don't Ask Again).
  'support.answer': { args: z.tuple([z.enum(['star', 'coffee']), z.enum(['yes', 'later', 'never'])]) },
} as const;
