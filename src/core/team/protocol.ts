import { z } from 'zod';
import { ISSUE_STATUSES } from '../board/model.js';

/**
 * What teammates' Macs say inside the mesh's `team` frame (a Noise link between two friends; see
 * docs/tasks-and-plans.md, "Sharing with friends — phase 3"). Each message rides in a frame
 * `{f, m}` the other side acknowledges (`{ack}`), through the same courier as sharing's.
 *
 * Finding each other:
 * - `repos`: fingerprints of your GitHub projects, keyed for this one friend (fingerprint.ts), so
 *   a friend who doesn't have a repository learns nothing about it.
 * - `invite`: you said yes to teaming up on the repository with that fingerprint (`link`: the id
 *   the two of you will use for it; `project`: your project's name, for their Claude's requests).
 * - `accept`: you said yes to their invite: the team is formed. `decline`: not now. `leave`: you left.
 *
 * The board (board-sync.ts, BLG-222):
 * - `ops`: tasks as the team has them, or only what changed: each field with who set it and when
 *   (`l` Lamport time, `a` author peer id; the later one wins, by l then a), activity to add
 *   (append-only; `drop`: lines its author took back when it folded two quick changes into one),
 *   and how it was born (the first time). A snapshot is the same message with everything.
 * - `digest`: a hash of every field's clock, sent when a link comes up; a different one gets a snapshot.
 */

export const hex32 = z.string().regex(/^[0-9a-f]{32}$/);
export const linkId = z.string().regex(/^[\w-]{8,40}$/);
const name = z.string().max(200);

export const peerId = z.string().regex(/^[\w-]{32}$/);
const words = (max: number) => z.string().max(max);
export const ActorSchema = z.union([
  z.object({ kind: z.literal('person'), id: peerId, name: words(80) }),
  z.object({ kind: z.literal('claude'), owner: peerId, ownerName: words(80) }),
  z.object({ kind: z.literal('beluga') }),
]);
export const AssigneeSchema = z.union([z.object({ kind: z.literal('person'), id: peerId, name: words(80) }), z.object({ kind: z.literal('claude'), owner: peerId, ownerName: words(80) })]);
const ACT_KINDS = ['created', 'title', 'status', 'priority', 'assignee', 'labels', 'estimate', 'due', 'parent', 'relation', 'brief', 'comment', 'note', 'worktree', 'pr', 'proof', 'project', 'plan', 'link'] as const;
export const ActivitySchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  at: z.number().int().min(0),
  by: ActorSchema,
  kind: z.enum(ACT_KINDS),
  text: words(2000),
  body: words(8000).optional(),
  assignee: AssigneeSchema.nullable().optional(),
  was: words(400).optional(),
  now: words(400).optional(),
});
export const taskId = z.string().regex(/^[\w-]{1,40}$/);
export const FieldSchema = z.object({ v: z.unknown(), l: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), a: peerId });
export const TaskDelta = z.object({
  id: taskId,
  fields: z.record(z.string().regex(/^[\w.-]{1,60}$/), FieldSchema),
  acts: z.array(ActivitySchema).max(200),
  drop: z.array(z.string().max(40)).max(200).optional(),
  born: z.object({ at: z.number().int().min(0), by: ActorSchema, origin: z.enum(['manual', 'worktree', 'claude', 'plan', 'sync', 'github']) }).optional(),
});
export type TaskDelta = z.infer<typeof TaskDelta>;

/** What each synced field may hold (anything else is ignored). `null` is "none". */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ids = z.array(taskId).max(100);
export const FIELD_VALUES: Readonly<Record<string, z.ZodType>> = {
  title: z.string().min(1).max(200),
  status: z.enum(ISSUE_STATUSES),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']),
  labels: z.array(z.string().max(32)).max(12),
  estimate: z.number().int().min(1).max(100).nullable(),
  due: day.nullable(),
  assignee: AssigneeSchema.nullable(),
  parent: taskId.nullable(),
  blockedBy: ids,
  related: ids,
  github: z.object({ repo: z.string().max(200), host: z.string().max(200).optional(), number: z.number().int().positive(), url: z.string().max(500), step: z.enum(['investigate', 'fix']).optional(), investigated: z.boolean().optional() }).nullable(),
  deleted: z.boolean(),
};
/** A field's value checker: the fixed ones, a brief section, or someone working on it. */
export function fieldValue(name: string): z.ZodType | undefined {
  if (FIELD_VALUES[name]) return FIELD_VALUES[name];
  if (/^brief\.(goal|context|acceptance|decisions|questions|handoff)$/.test(name)) return z.string().max(20_000);
  if (/^working\.[\w-]{32}$/.test(name)) return z.literal(true).nullable();
  return undefined;
}

export const TeamMsg = z.discriminatedUnion('k', [
  z.object({ k: z.literal('repos'), prints: z.array(hex32).max(500) }),
  z.object({ k: z.literal('invite'), print: hex32, link: linkId, project: name }),
  z.object({ k: z.literal('accept'), print: hex32, link: linkId, project: name }),
  z.object({ k: z.literal('decline'), print: hex32 }),
  z.object({ k: z.literal('leave'), link: linkId }),
  z.object({ k: z.literal('ops'), link: linkId, tasks: z.array(TaskDelta).max(50) }),
  z.object({ k: z.literal('digest'), link: linkId, hash: z.string().regex(/^[0-9a-f]{64}$/) }),
]);
export type TeamMsg = z.infer<typeof TeamMsg>;

const frameId = z.string().regex(/^[\w-]{8,40}$/);
export const TeamFrame = z.union([z.object({ f: frameId, m: TeamMsg }), z.object({ ack: frameId })]);
export type TeamFrame = z.infer<typeof TeamFrame>;

export function parseTeamFrame(raw: unknown): TeamFrame | undefined {
  const parsed = TeamFrame.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
