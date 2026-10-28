import { z } from 'zod';
import { MAX_RUN_AT_ONCE } from '../core/sentinel/model.js';
import { SentinelDraftSchema, SentinelPatchSchema } from '../core/sentinel/schema.js';

/**
 * Sentinel in the API (see api.ts; docs/sentinel.md §4): the Mac app's Sentinel section, and the
 * phone's runs. You act as yourself; your Claude has its own tools. Browser-safe: zod only.
 */

const id = z.string().min(1).max(80);
const chat = z.string().regex(/^[a-z0-9]{1,24}$/);

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
  // Test its sources once, paused or not, without turning it on (BLG-302): each Keep the numbers step
  // that reads a source runs and keeps what it finds; nothing else runs → SentinelTest (core/sentinel/preview.ts).
  'sentinel.test': { args: z.tuple([id]) },
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
  // A webhook sentinel's secret, new (the old URL stops at once); its URL with the secret, or why there's none now → { url?, why? }.
  'sentinel.rotateSecret': { args: z.tuple([id]) },
  'sentinel.webhookUrl': { args: z.tuple([id]) },
  // A sentinel's number over time (two years at most; since a time) → { metric, lines }, oldest first.
  'sentinel.metricRead': { args: z.tuple([id, z.string().min(1).max(80), z.number().optional()]) },
  // A typed column's document (BLG-345), by sentinel, metric, column and its cell (the file's name; only one
  // its latest rows hold) → { name, mime, size, text | base64, runId, at }. The phone reads it through the Mac.
  'sentinel.document': { args: z.tuple([id, z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(200)]) },
  // The same document opened in its own app on the Mac.
  'sentinel.documentOpen': { args: z.tuple([id, z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(200)]) },
  // A storage cell's link, signed now for about a minute with the project's Supabase variables → { url, expiresIn }. Never kept.
  'sentinel.signStorage': { args: z.tuple([id, z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(1200)]) },
  // The Sentinel chat (docs/sentinel.md §12): a new conversation beside the others, open now → { id, channel }.
  'sentinel.chatNew': { args: z.tuple([]) },
  // Open one (the phone's Chat is the open one).
  'sentinel.chatOpen': { args: z.tuple([chat]) },
  // Clear: its messages go and its Claude starts afresh; the chat stays.
  'sentinel.chatClear': { args: z.tuple([chat]) },
  // Delete it for good (its Claude stops first): the one beside it opens, or a fresh first one.
  'sentinel.chatDelete': { args: z.tuple([chat]) },
} as const;
