import { z } from 'zod';
import { PlanOpSchema } from './plans-api.js';

/**
 * Team boards in the API (see api.ts): friends on the same GitHub repository who said yes keep
 * one board (core/team). The Mac app's offers, team badge and menus, and the phone's cards.
 * Browser-safe: zod only.
 */

const peerId = z.string().regex(/^[\w-]{32}$/);
const projectId = z.string().min(1).max(200);
const planId = z.string().min(1).max(60);
const reviewId = z.string().regex(/^[\w-]{8,40}$/);
const knockId = z.string().regex(/^[\w-]{8,40}$/);

export const TEAM_API = {
  // An offer to team up on a project: Team Up (true) or Not Now (false). Nothing is shared until both say yes.
  'team.answer': { args: z.tuple([peerId, projectId, z.boolean()]) },
  // Leave a project's team (one teammate, or everyone): your tasks stay on your board, they stop staying in step.
  'team.leave': { args: z.tuple([projectId, peerId.optional()]) },
  // A task a teammate gave you: you've seen it (it leaves your inbox; it stays yours).
  'team.ackAssignment': { args: z.tuple([z.string().min(1).max(40)]) },
  // Share Plan with Team (true) or Stop Sharing (false): teammates see its draft read-only, with live changes.
  'team.sharePlan': { args: z.tuple([planId, z.boolean()]) },
  // Your word on a plan a teammate shared with you: a comment, an approval, or changes you suggest (the plan's edit ops).
  'team.reviewPlan': { args: z.tuple([peerId, planId, z.object({ kind: z.enum(['comment', 'approve', 'suggest']), text: z.string().max(8000).optional(), ops: z.array(PlanOpSchema).min(1).max(40).optional() })]) },
  // A teammate's suggested changes to your plan: in (as your edit), or set aside.
  'team.applySuggestion': { args: z.tuple([planId, reviewId]) },
  'team.dismissSuggestion': { args: z.tuple([planId, reviewId]) },
  // Knock on the worktree a teammate is doing a task in (BLG-416): they let you in as a viewer or an editor. Optional: which teammate, a few words.
  'team.knock': { args: z.tuple([z.string().min(1).max(40), peerId.optional(), z.string().max(500).optional()]) },
  // Take a knock of yours back (or clear one they answered).
  'team.cancelKnock': { args: z.tuple([knockId]) },
  // A teammate knocking on your worktree: let them in as a viewer ('view') or an editor ('contribute'), or not now ('decline').
  'team.answerKnock': { args: z.tuple([knockId, z.enum(['view', 'contribute', 'decline'])]) },
} as const;
