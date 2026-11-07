import { z } from 'zod';
import { ScheduleInputSchema, SchedulePatchSchema } from '../core/schedule/schema.js';

/**
 * Schedules in the API (see api.ts): recurring runs in one chat. Only the chat's owner acts on
 * them, and every method refuses while the setting chatSchedules is off. Browser-safe: zod only.
 */

const id = z.string().min(1).max(80);
const channel = z.string().min(1).max(200);

export const SCHEDULE_API = {
  // The schedules of a chat, or all of them → ScheduleView[].
  'schedule.list': { args: z.tuple([channel.optional()]) },
  // A new one in a chat → ScheduleView. It throws why not, in words the user can act on.
  'schedule.create': { args: z.tuple([channel, ScheduleInputSchema]) },
  // Change what the patch names → ScheduleView.
  'schedule.update': { args: z.tuple([id, SchedulePatchSchema]) },
  // Pause it, or resume it (refused while the chat can't have one) → ScheduleView.
  'schedule.setEnabled': { args: z.tuple([id, z.boolean()]) },
  // Run it now, on or paused (refused while a run is active) → ScheduleView.
  'schedule.runNow': { args: z.tuple([id]) },
  'schedule.remove': { args: z.tuple([id]) },
};
