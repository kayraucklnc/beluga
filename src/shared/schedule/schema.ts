import { z } from 'zod';
import { SCHEDULE_EVERY } from './trigger.js';

/** A schedule as zod checks. Browser-safe: zod only. */

export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time like 07:00');

export const ScheduleTriggerSchema = z.object({
  kind: z.literal('schedule'),
  every: z.enum(SCHEDULE_EVERY),
  at: HHMM.default('07:00'),
  hours: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(6), z.literal(12)]).optional(),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  day: z.number().int().min(1).max(28).optional(),
  missed: z.enum(['catch-up', 'skip']).default('catch-up'),
});
