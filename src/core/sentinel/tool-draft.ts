import { z } from 'zod';
import { ACCESS, NOTIFY_WHERE } from './model.js';
import { LimitsSchema, ScheduleTriggerSchema } from './schema.js';

/**
 * What Claude's sentinel_create and sentinel_update take (agent/sentinel-tools.ts): a sentinel in
 * the shapes this Beluga runs (a schedule, by hand, or after another sentinel; every step kind),
 * its project by name. Browser-safe: zod only.
 */

const stepId = z.string().max(40).optional().describe('Keep a step’s id (from sentinel_get) when you keep or edit that step');
const stepName = z.string().max(80);

const TOOL_TRIGGER = z
  .discriminatedUnion('kind', [
    ScheduleTriggerSchema.describe('every: hours (with hours: 1|2|3|6|12), day, other-day, week (with days: 0 Sunday…6 Saturday), month (with day: 1…28); at: "HH:MM" local time'),
    z.object({ kind: z.literal('manual') }),
    z.object({ kind: z.literal('after'), sentinelId: z.string().min(1).max(80).describe('The other sentinel’s id (sentinel_list)'), on: z.enum(['success', 'failure', 'always']) }),
  ])
  .describe('When it runs');

const TOOL_STEP = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claude'), id: stepId, name: stepName, prompt: z.string().min(1).max(20_000).describe('What Claude does each run; may use {{date}}, {{project}}, {{tasks}}, {{previous}}'), where: z.enum(['project', 'worktree', 'mac']).describe('project: reads only (briefs, triage); worktree: changes code; mac: about the Mac itself') }),
  z.object({ kind: z.literal('script'), id: stepId, name: stepName, command: z.string().min(1).max(4000), cwd: z.enum(['project', 'home']).optional(), timeoutSec: z.number().int().min(1).max(3600).optional() }),
  z.object({ kind: z.literal('notify'), id: stepId, name: stepName, title: z.string().max(200).optional(), body: z.string().max(4000).optional(), phone: z.boolean().optional() }),
  z.object({
    kind: z.literal('http'),
    id: stepId,
    name: stepName,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    url: z.string().max(2000).describe('May be $VAR (Settings › Environment), like $SLACK_WEBHOOK_URL'),
    headers: z.record(z.string().max(200), z.string().max(4000)).optional().describe('Secrets only as $VAR: "Bearer $GROQBOT_KEY"'),
    body: z.string().max(60_000).optional(),
    timeoutSec: z.number().int().min(1).max(600).optional(),
    preset: z.enum(['groqbot', 'slack', 'discord', 'url']).optional(),
  }),
  z.object({ kind: z.literal('pr'), id: stepId, name: stepName, draft: z.boolean().optional() }).describe('Opens a pull request from the worktree an earlier Claude step (where: worktree) made; needs work access'),
  z.object({ kind: z.literal('merge'), id: stepId, name: stepName, require: z.object({ checks: z.literal(true), approval: z.boolean() }).optional(), method: z.enum(['squash', 'merge']).optional() }).describe('Merges that pull request once the checks pass, a review says ship and the user approves; needs ship access'),
  z.object({ kind: z.literal('message'), id: stepId, name: stepName, to: z.string().regex(/^(dm|group):[\w-]{1,80}$/).describe('dm:<peerId> or group:<id>'), text: z.string().min(1).max(8000) }),
  z.object({ kind: z.literal('friend'), id: stepId, name: stepName, peerId: z.string().min(1).max(80), prompt: z.string().min(1).max(20_000), project: z.string().max(200).optional() }),
  z.object({ kind: z.literal('trigger'), id: stepId, name: stepName, sentinelId: z.string().min(1).max(80) }),
]);

export const TOOL_DRAFT_SHAPE = {
  name: z.string().trim().min(1).max(80).describe('A short name, like "Morning brief"'),
  project: z.string().max(200).optional().describe('The project’s name; leave out for Your Mac'),
  trigger: TOOL_TRIGGER,
  steps: z.array(TOOL_STEP).min(1).max(12),
  access: z.enum(ACCESS).optional().describe('look (default): read and report; work: change code in a worktree and open pull requests; ship: also merge after checks and approval'),
  notify: z.enum(NOTIFY_WHERE).optional().describe('Where the run’s end is told (mac by default)'),
};

export const ToolDraftSchema = z.object(TOOL_DRAFT_SHAPE);
export type ToolDraft = z.infer<typeof ToolDraftSchema>;
export type ToolStep = z.infer<typeof TOOL_STEP>;

/** sentinel_update: only what changes. Steps are the whole new list, in order. */
export const TOOL_PATCH_SHAPE = {
  name: TOOL_DRAFT_SHAPE.name.optional(),
  project: z.string().max(200).nullable().optional().describe('The project’s name; null for Your Mac'),
  trigger: TOOL_TRIGGER.optional(),
  steps: z.array(TOOL_STEP).max(12).optional().describe('The whole list of steps, in order (keep the ids of the ones you keep)'),
  access: TOOL_DRAFT_SHAPE.access,
  limits: LimitsSchema.partial().optional().describe('minutes per run, perDay (0: no limit), pauseAfter failures in a row (0: never)'),
  notify: TOOL_DRAFT_SHAPE.notify,
};

export const ToolPatchSchema = z.object(TOOL_PATCH_SHAPE);
export type ToolPatch = z.infer<typeof ToolPatchSchema>;
