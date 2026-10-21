import { z } from 'zod';
import { AUTONOMIES, MAX_PARALLEL } from '../core/plans/model.js';
import { PRIORITIES } from '../core/board/model.js';

/**
 * Plans in the API (see api.ts): the Mac app's Plans view and plan pages. You act as yourself;
 * Claude writes plans through its own tools in the plan's conversation. Browser-safe: zod only.
 */

const id = z.string().min(1).max(60);
const ref = z.string().min(1).max(40);
const lines = z.union([z.array(z.string().max(400)).max(20), z.string().max(8000)]);
const task = z.object({
  id: ref.optional(),
  title: z.string().min(1).max(200),
  goal: z.string().max(4000).optional(),
  context: z.string().max(8000).optional(),
  acceptance: lines.optional(),
  blockedBy: z.array(ref).max(20).optional(),
  parent: ref.nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  estimate: z.number().int().min(1).max(8).nullable().optional(),
  labels: z.array(z.string().max(32)).max(8).optional(),
  touches: z.array(z.string().max(200)).max(20).optional(),
  assignee: z.enum(['claude', 'me']).optional(),
});
const autonomy = z.enum(AUTONOMIES);

/** Your changes to a plan (the same ops Claude has). */
export const PlanOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('retitle'), title: z.string().max(200).optional(), goal: z.string().max(4000).optional() }),
  z.object({ op: z.literal('add_milestone'), milestone: z.object({ id: ref.optional(), title: z.string().min(1).max(200), goal: z.string().max(4000).optional(), criteria: lines.optional(), tasks: z.array(task).max(40).optional(), dependsOn: z.array(ref).max(12).optional() }), after: ref.optional() }),
  z.object({ op: z.literal('update_milestone'), id: ref, title: z.string().max(200).optional(), goal: z.string().max(4000).optional(), criteria: lines.optional(), autonomy: autonomy.nullable().optional(), dependsOn: z.array(ref).max(12).nullable().optional() }),
  z.object({ op: z.literal('remove_milestone'), id: ref }),
  z.object({ op: z.literal('add_task'), milestone: ref, task, after: ref.optional() }),
  z.object({ op: z.literal('update_task'), id: ref, patch: task.partial() }),
  z.object({ op: z.literal('remove_task'), id: ref }),
  z.object({ op: z.literal('move_task'), id: ref, milestone: ref, before: ref.optional() }),
  z.object({ op: z.literal('block'), id: ref, by: ref, on: z.boolean() }),
]);

export const PLANS_API = {
  // A new plan with Claude: its own conversation (in the project's main folder) and its page → the plan.
  'plans.create': { args: z.tuple([z.object({ projectId: z.string().min(1).max(200), goal: z.string().min(1).max(8000), autonomy: autonomy.optional() })]) },
  // Plan in this conversation (the composer's Plan with Tasks) → the plan.
  'plans.here': { args: z.tuple([z.string().min(1).max(200), autonomy.optional()]) },
  // The draft goes on the board (a new plan, or changes to one).
  'plans.approve': { args: z.tuple([id]) },
  // Throw the draft away (a plan never approved goes with it).
  'plans.discard': { args: z.tuple([id]) },
  'plans.edit': { args: z.tuple([id, z.array(PlanOpSchema).min(1).max(40)]) },
  // The plan's autonomy, or one milestone's.
  'plans.setAutonomy': { args: z.tuple([id, autonomy, ref.optional()]) },
  'plans.setPaused': { args: z.tuple([id, z.boolean()]) },
  'plans.setParallel': { args: z.tuple([id, z.number().int().min(1).max(MAX_PARALLEL)]) },
  // Pass a milestone (the next one opens), or send it back to the head Claude with what's missing.
  'plans.pass': { args: z.tuple([id, ref]) },
  // Ask the plan's Claude to check a milestone again.
  'plans.recheck': { args: z.tuple([id, ref]) },
  'plans.sendBack': { args: z.tuple([id, ref, z.string().min(1).max(4000)]) },
  // Start a ready task now → what happened.
  'plans.startTask': { args: z.tuple([id, ref]) },
  'plans.remove': { args: z.tuple([id]) },
  // Your planning style (how you like plans cut), added to Claude's planning instructions.
  'plans.setStyle': { args: z.tuple([z.string().max(8000)]) },
} as const;
