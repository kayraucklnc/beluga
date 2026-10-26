import { z } from 'zod';

/**
 * Team boards in the API (see api.ts): friends on the same GitHub repository who said yes keep
 * one board (core/team). The Mac app's offers, team badge and menus, and the phone's cards.
 * Browser-safe: zod only.
 */

const peerId = z.string().regex(/^[\w-]{32}$/);
const projectId = z.string().min(1).max(200);

export const TEAM_API = {
  // An offer to team up on a project: Team Up (true) or Not Now (false). Nothing is shared until both say yes.
  'team.answer': { args: z.tuple([peerId, projectId, z.boolean()]) },
  // Leave a project's team (one teammate, or everyone): your tasks stay on your board, they stop staying in step.
  'team.leave': { args: z.tuple([projectId, peerId.optional()]) },
  // A task a teammate gave you: you've seen it (it leaves your inbox; it stays yours).
  'team.ackAssignment': { args: z.tuple([z.string().min(1).max(40)]) },
} as const;
