import { z } from 'zod';

/**
 * Your own workspace's files in the Mac app's Files tab (see api.ts): searching what's in them,
 * saving one you edited, and formatting one with the project's Prettier. Browser-safe: zod only.
 */

const id = z.string().min(1).max(200);
const rel = z.string().min(1).max(4096);
/** A file's text: Beluga reads up to 512 KB, a formatter may add a little. */
const text = z.string().max(2_000_000);

export const FILES_EDIT_API = {
  // Lines with the query in a workspace's files, by file → ContentResults. `slot`: a newer search in the same slot cancels this one.
  'files.searchContent': {
    args: z.tuple([
      id,
      z.string().min(1).max(1000),
      z.object({ regex: z.boolean().optional(), caseSensitive: z.boolean().optional(), wholeWord: z.boolean().optional(), slot: z.string().max(200).optional() }).strict().optional(),
    ]),
  },
  // Save a file you edited → { ok, hash } or { ok: false, conflict } (it changed since `expect`, the hash of the text you started from; `force` saves anyway).
  'files.save': { args: z.tuple([id, rel, text, z.object({ expect: z.string().regex(/^[0-9a-f]{64}$/).optional(), force: z.boolean().optional() }).strict().optional()]) },
  // Whether the project's Prettier can format this file → { available, reason?, version? }.
  'files.formatter': { args: z.tuple([id, rel]) },
  // The text as Prettier lays it out (nothing is saved) → the formatted text.
  'files.format': { args: z.tuple([id, rel, text]) },
} as const;
