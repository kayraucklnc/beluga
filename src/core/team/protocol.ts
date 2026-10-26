import { z } from 'zod';

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
 */

export const hex32 = z.string().regex(/^[0-9a-f]{32}$/);
export const linkId = z.string().regex(/^[\w-]{8,40}$/);
const name = z.string().max(200);

export const TeamMsg = z.discriminatedUnion('k', [
  z.object({ k: z.literal('repos'), prints: z.array(hex32).max(500) }),
  z.object({ k: z.literal('invite'), print: hex32, link: linkId, project: name }),
  z.object({ k: z.literal('accept'), print: hex32, link: linkId, project: name }),
  z.object({ k: z.literal('decline'), print: hex32 }),
  z.object({ k: z.literal('leave'), link: linkId }),
]);
export type TeamMsg = z.infer<typeof TeamMsg>;

const frameId = z.string().regex(/^[\w-]{8,40}$/);
export const TeamFrame = z.union([z.object({ f: frameId, m: TeamMsg }), z.object({ ack: frameId })]);
export type TeamFrame = z.infer<typeof TeamFrame>;

export function parseTeamFrame(raw: unknown): TeamFrame | undefined {
  const parsed = TeamFrame.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
