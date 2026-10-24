import { z } from 'zod';
import { MAX_UPLOADS, UploadRef } from '../companion/protocol.js';
import { NEEDS } from '../core/gateway/protocol.js';

/**
 * Your phone (the companion, docs/companion.md) in the API (see api.ts): pairing one from the Mac,
 * removing one, and what the phone itself asks for beyond the shared methods (older turns of a
 * conversation). Which of these a phone may call is in src/companion/coverage.ts. Browser-safe: zod only.
 */

const topic = z.string().regex(/^(conv|chat):[\w:.-]{1,200}$/);
const files = z.array(UploadRef).max(MAX_UPLOADS);
/** A worktree's conversation. */
const wsTopic = z.string().regex(/^conv:ws:[\w.-]{1,200}$/);
const conversation = z.string().regex(/^(dm:[\w-]{32}|group:[0-9a-f]{32})$/);

export const COMPANION_API = {
  // Open a one-time pairing (10 minutes, one phone): → { link, code, expiresAt }. Starting another replaces it.
  'companion.pair.start': { args: z.tuple([]) },
  // Pair the phone that's waiting (its name and fingerprint are in companion.pairing.waiting).
  'companion.pair.approve': { args: z.tuple([]) },
  // Close the pairing (a waiting phone is told no).
  'companion.pair.cancel': { args: z.tuple([]) },
  // Remove a phone: its certificate goes, its link drops at once and its key is refused from then on.
  'companion.devices.remove': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/)]) },
  // A conversation's (or chat's) turns before one the phone has: → { turns | messages, more }.
  'companion.older': { args: z.tuple([topic, z.object({ before: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).optional() }).strict()]) },
  // Ask your Mac from the phone: a new chat in a project, or a message in a conversation; files the phone `put` go along → { topic }.
  'companion.ask': {
    args: z.tuple([
      z
        .object({
          target: z.union([z.object({ project: z.string().min(1).max(200) }).strict(), z.object({ topic: z.string().regex(/^conv:[\w:.-]{1,200}$/) }).strict()]),
          text: z.string().max(64_000),
          files: files.optional(),
        })
        .strict()
        .refine((a) => a.text.trim() || a.files?.length, 'Say something, or attach a file'),
    ]),
  },
  // Write in a friends' chat from the phone, with files it `put` → the message.
  'companion.post': {
    args: z.tuple([
      z
        .object({ conversation, text: z.string().max(8_000), files: files.optional(), ask: z.union([z.literal('all'), z.array(z.string().regex(/^[\w-]{32}$/)).min(1).max(100)]).optional() })
        .strict()
        .refine((a) => a.text.trim() || a.files?.length, 'Say something, or attach a file'),
    ]),
  },
  // Ask a friend's Claude yourself (as ask_person does, with their approval and trust rules) → { topic, task }.
  'companion.askPerson': { args: z.tuple([z.object({ peerId: z.string().regex(/^[\w-]{8,64}$/), text: z.string().min(1).max(16_000), needs: z.array(z.enum(NEEDS)).max(5).optional(), project: z.string().min(1).max(80).optional() }).strict()]) },
  // The phone signs out: its own certificate goes (only the calling phone's), and the link closes.
  'companion.signOut': { args: z.tuple([]) },
  // Open on your Mac: the Mac app's window comes to the front showing what the phone has open (a
  // topic, or a needs-you item without one) → { opened, why? } (why not: the Mac app isn't open).
  'companion.openOnMac': {
    args: z.tuple([
      z
        .object({ topic: z.string().regex(/^(home|work|plans|tasks|chats|people|(conv|plan|chat|task):[\w:.-]{1,200})$/).optional(), need: z.string().min(1).max(300).optional() })
        .strict()
        .refine((a) => a.topic || a.need, 'Say what to open'),
    ]),
  },
  // A project's small icon by the checksum a view handed out → { sum, mime, b64 } (PNG, at most 128 px; or a small SVG).
  'companion.icon': { args: z.tuple([z.string().regex(/^[0-9a-f]{16,64}$/)]) },
  // Merging a worktree of yours (its conversation's topic), the Mac's own way: look first (the
  // Merge sheet's checks) → MergeCheckView; merge → where it stands (merged, conflicts by file name,
  // blocked and why); Claude resolves the conflicts in that worktree → resolving.
  'companion.mergeCheck': { args: z.tuple([wsTopic]) },
  'companion.merge': { args: z.tuple([wsTopic]) },
  'companion.resolve': { args: z.tuple([wsTopic]) },
  // A task described in words: your Claude's draft of it (title, goal, criteria, labels), not added yet → the draft.
  'companion.draftTask': { args: z.tuple([z.object({ projectId: z.string().min(1).max(200), text: z.string().min(1).max(8000) }).strict()]) },
  // Add a draft (maybe changed on the phone) as a task in a project → the task ({ id, key }).
  'companion.addTask': {
    args: z.tuple([
      z
        .object({
          projectId: z.string().min(1).max(200),
          title: z.string().trim().min(1).max(200),
          goal: z.string().max(20_000),
          acceptance: z.array(z.string().trim().min(1).max(300)).max(12),
          labels: z.array(z.string().min(1).max(32)).max(12),
          priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
        })
        .strict(),
    ]),
  },
} as const;
