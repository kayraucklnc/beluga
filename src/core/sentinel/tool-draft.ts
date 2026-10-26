import { z } from 'zod';
import { ACCESS, NOTIFY_WHERE } from './model.js';
import { ScheduleTriggerSchema } from './schema.js';

/**
 * What Claude's sentinel_create takes (agent/sentinel-tools.ts): a sentinel in the shapes this
 * Beluga runs (a schedule or by hand; Ask Claude, Run a script, Notify me), its project by name.
 * Browser-safe: zod only.
 */

export const TOOL_DRAFT_SHAPE = {
  name: z.string().trim().min(1).max(80).describe('A short name, like "Morning brief"'),
  project: z.string().max(200).optional().describe('The project’s name; leave out for Your Mac'),
  trigger: z
    .discriminatedUnion('kind', [ScheduleTriggerSchema.describe('every: hours (with hours: 1|2|3|6|12), day, other-day, week (with days: 0 Sunday…6 Saturday), month (with day: 1…28); at: "HH:MM" local time'), z.object({ kind: z.literal('manual') })])
    .describe('When it runs'),
  steps: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('claude'), name: z.string().max(80), prompt: z.string().min(1).max(20_000).describe('What Claude does each run; may use {{date}}, {{project}}, {{tasks}}, {{previous}}'), where: z.enum(['project', 'worktree', 'mac']).describe('project: reads only (briefs, triage); worktree: changes code; mac: about the Mac itself') }),
        z.object({ kind: z.literal('script'), name: z.string().max(80), command: z.string().min(1).max(4000), cwd: z.enum(['project', 'home']).optional(), timeoutSec: z.number().int().min(1).max(3600).optional() }),
        z.object({ kind: z.literal('notify'), name: z.string().max(80), title: z.string().max(200).optional(), body: z.string().max(4000).optional(), phone: z.boolean().optional() }),
      ]),
    )
    .min(1)
    .max(8),
  access: z.enum(ACCESS).optional().describe('look (default): read and report; work: change code in a worktree'),
  notify: z.enum(NOTIFY_WHERE).optional().describe('Where the run’s end is told (mac by default)'),
};

export const ToolDraftSchema = z.object(TOOL_DRAFT_SHAPE);
export type ToolDraft = z.infer<typeof ToolDraftSchema>;
