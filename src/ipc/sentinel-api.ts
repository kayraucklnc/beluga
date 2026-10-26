import { z } from 'zod';
import { MAX_RUN_AT_ONCE } from '../core/sentinel/model.js';
import { SentinelDraftSchema, SentinelPatchSchema } from '../core/sentinel/schema.js';

/**
 * Sentinel in the API (see api.ts; docs/sentinel.md §4): the Mac app's Sentinel section, and the
 * phone's runs. You act as yourself; your Claude has its own tools. Browser-safe: zod only.
 */

const id = z.string().min(1).max(80);

export const SENTINEL_API = {
  // A new sentinel (paused until you turn it on) → the sentinel.
  'sentinel.create': { args: z.tuple([SentinelDraftSchema]) },
  // Change its name, icon, project (null: Your Mac), trigger, steps, access, limits or where it notifies → the sentinel.
  'sentinel.update': { args: z.tuple([id, SentinelPatchSchema]) },
  // Delete it (its run stops; its runs' folders go with the next prune).
  'sentinel.remove': { args: z.tuple([id]) },
  'sentinel.duplicate': { args: z.tuple([id]) },
  // Run Now → the run (queued when one is going).
  'sentinel.run': { args: z.tuple([id]) },
  // Stop a run → whether one was going.
  'sentinel.stop': { args: z.tuple([id]) },
  // Pause it, or turn it on (Turn On, Resume).
  'sentinel.pause': { args: z.tuple([id, z.boolean()]) },
  // Its whole index (the last 200 runs), newest first, without outputs.
  'sentinel.runs': { args: z.tuple([id]) },
  // One run: its steps' outputs (the first 16 KB each) and its report's text → RunDetail.
  'sentinel.runGet': { args: z.tuple([id]) },
  // Your Claude changes it from your words (the page's box; Describe it is create, then this) → { channel }.
  'sentinel.ask': { args: z.tuple([id, z.string().trim().min(1).max(8000)]) },
  'sentinel.recipes': { args: z.tuple([]) },
  // A run waiting for you (a merge): Merge (once GitHub merged it) or Not Now → the run.
  'sentinel.decide': { args: z.tuple([id, z.enum(['merge', 'skip'])]) },
  // Claude steps running together across all sentinels.
  'sentinel.setRunAtOnce': { args: z.tuple([z.number().int().min(1).max(MAX_RUN_AT_ONCE)]) },
  // A webhook sentinel's secret, new; its URL (phase 3).
  'sentinel.rotateSecret': { args: z.tuple([id]) },
  'sentinel.webhookUrl': { args: z.tuple([id]) },
} as const;
