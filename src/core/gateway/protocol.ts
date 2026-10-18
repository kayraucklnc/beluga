import { z } from 'zod';

/**
 * The gateway's wire protocol: tasks between Claudes. A task is a request from one person's
 * Claude (or the person) to another's: "ask" (their Claude does the work its own way) or "run"
 * (one command, run directly on their Mac). Results go only to the requester, never to a room.
 *
 * Messages travel the same over a friend's mesh link (`gw` frames, see net/mesh/wire.ts) and
 * over today's rooms (a `gateway` body sent to one person). Every message rides in a frame with
 * its own id; the receiver acknowledges it, and what matters (requests, results, cancels) waits
 * in the sender's outbox until it does. Browser-safe: zod only.
 */

/** What a task may need on the other Mac (screen and device arrive in phase 4). */
export const NEEDS = ['project', 'shell', 'files', 'screen', 'device'] as const;
export type Need = (typeof NEEDS)[number];

/** What the other side's klaud offers in phase 2. */
export const OFFERED: readonly Need[] = ['project', 'shell', 'files'];

/** States a task passes through on the other Mac before its result. */
export const LIVE_STATES = ['queued', 'awaiting_approval', 'working'] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export const RESULT_STATUSES = ['done', 'declined', 'failed', 'cancelled'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const TRUST = ['blocked', 'ask', 'trusted', 'full'] as const;

/** Limits: what one task may carry. */
export const MAX_ASK = 16_000;
export const MAX_SUMMARY = 60_000;
export const MAX_DATA_CHARS = 256 * 1024;
export const MAX_FILES = 8;
/** Bytes of files one result may carry (inline, base64); bigger files are listed, not sent. */
export const MAX_FILE_TOTAL = 512 * 1024;
export const MAX_SCHEMA_CHARS = 8_000;

export const TaskId = z.string().regex(/^t_[\w-]{10,40}$/);
const PeerId = z.string().regex(/^[\w-]{8,64}$/);
const json = (max: number) =>
  z.unknown().refine((v) => {
    try {
      return (JSON.stringify(v) ?? '').length <= max;
    } catch {
      return false;
    }
  }, `Too large (over ${max} characters as JSON)`);

/** What the requester wants back: data matching a JSON schema, or files. */
export const Expects = z.union([z.literal('files'), z.record(z.string(), z.unknown()).and(json(MAX_SCHEMA_CHARS))]);
export type Expects = z.infer<typeof Expects>;

export const TaskRequest = z.object({
  t: z.literal('task_request'),
  id: TaskId,
  from: PeerId,
  to: PeerId,
  /** ask: their Claude does it; run: one command, directly on their Mac. */
  kind: z.enum(['ask', 'run']).default('ask'),
  ask: z.string().min(1).max(MAX_ASK),
  needs: z.array(z.enum(NEEDS)).max(NEEDS.length).default([]),
  /** One of their projects (by name) to work or run in. */
  project: z.string().min(1).max(80).optional(),
  expects: Expects.optional(),
  /** Epoch ms after which it shouldn't start any more. */
  deadline: z.number().int().positive().optional(),
  /** run: the command, where, and for how long at most. */
  command: z.string().min(1).max(8000).optional(),
  cwd: z.string().max(4096).optional(),
  timeoutSec: z.number().int().min(1).max(600).optional(),
  /** Who asked: the person's Claude, or the person from their screen. */
  by: z.enum(['agent', 'person']).default('agent'),
  ts: z.number().int().min(0),
});
export type TaskRequest = z.infer<typeof TaskRequest>;

export const TaskUpdate = z.object({
  t: z.literal('task_update'),
  id: TaskId,
  state: z.enum(LIVE_STATES),
  step: z.string().max(300).optional(),
  ts: z.number().int().min(0),
});
export type TaskUpdate = z.infer<typeof TaskUpdate>;

export const ResultFile = z.object({
  name: z.string().min(1).max(200),
  size: z.number().int().min(0),
  /** The bytes, base64 (missing: too big to send this way). */
  b64: z.string().max(Math.ceil((MAX_FILE_TOTAL * 4) / 3) + 8).optional(),
});
export type ResultFile = z.infer<typeof ResultFile>;

export const TaskResult = z.object({
  t: z.literal('task_result'),
  id: TaskId,
  status: z.enum(RESULT_STATUSES),
  summary: z.string().max(MAX_SUMMARY),
  data: json(MAX_DATA_CHARS).optional(),
  files: z.array(ResultFile).max(MAX_FILES).default([]),
  /** The steps it took (short lines). */
  log: z.array(z.string().max(300)).max(60).default([]),
  ts: z.number().int().min(0),
});
export type TaskResult = z.infer<typeof TaskResult>;

export const TaskCancel = z.object({ t: z.literal('task_cancel'), id: TaskId, ts: z.number().int().min(0) });
export type TaskCancel = z.infer<typeof TaskCancel>;

/** What my klaud offers you, told to you so your Claude knows whom to ask for what. */
export const PeerCardMsg = z.object({
  t: z.literal('card'),
  /** "Ask me for…": a short note other Claudes see. */
  note: z.string().max(280).optional(),
  /** How much I trust you (what your requests may do here). */
  trust: z.enum(TRUST),
  offers: z.array(z.enum(NEEDS)).max(NEEDS.length),
  /** My projects you may name. */
  projects: z.array(z.string().min(1).max(80)).max(60).default([]),
  /** My Claude is on. */
  claude: z.boolean().default(true),
});
export type PeerCardMsg = z.infer<typeof PeerCardMsg>;

export const GatewayMsg = z.discriminatedUnion('t', [TaskRequest, TaskUpdate, TaskResult, TaskCancel, PeerCardMsg]);
export type GatewayMsg = z.infer<typeof GatewayMsg>;
export type GatewayMsgInput = z.input<typeof GatewayMsg>;

const FrameId = z.string().regex(/^[\w-]{8,40}$/);

/** One message and its frame id, or the acknowledgement of one. */
export const Frame = z.union([z.object({ f: FrameId, m: GatewayMsg }), z.object({ ack: FrameId })]);
export type Frame = z.infer<typeof Frame>;

/** Parse what came in; undefined for anything malformed. */
export function parseFrame(raw: unknown): Frame | undefined {
  const parsed = Frame.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
