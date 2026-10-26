import { z } from 'zod';

/**
 * A project's GitHub Actions in the API (see api.ts): its runs on Project Home and in Actions, a
 * run's page (jobs, steps, the workflow as a graph), and its workflows. Through gh (core/ci).
 * Browser-safe: zod only.
 */

const projectId = z.string().min(1).max(200);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const force = z.object({ force: z.boolean().optional() }).strict().optional();

export const CI_API = {
  /** A project's latest workflow runs (one workflow's by its file's path, one branch's), `force` to ask GitHub again. */
  'ci.runs': { args: z.tuple([projectId, z.object({ workflow: z.string().max(300).optional(), branch: z.string().max(300).optional(), force: z.boolean().optional() }).strict().optional()]) },
  /** One run with its jobs and their steps, and the workflow file it ran. */
  'ci.run': { args: z.tuple([projectId, id, force]) },
  /** The project's workflows, each with its file (from its folder when it's there). */
  'ci.workflows': { args: z.tuple([projectId, force]) },
  /** The end of a job's log, where it failed. */
  'ci.log': { args: z.tuple([projectId, id]) },
  /** Run it again: only the failed jobs (`failed`), or all of it. */
  'ci.rerun': { args: z.tuple([projectId, id, z.object({ failed: z.boolean().optional() }).strict().optional()]) },
  /** Stop a run that's going. */
  'ci.cancel': { args: z.tuple([projectId, id]) },
} as const;
