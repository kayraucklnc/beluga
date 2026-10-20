import { z } from 'zod';
import { BRIEF_SECTIONS, ISSUE_STATUSES, PRIORITIES } from '../core/board/model.js';

/**
 * Tasks (the board) in the API (see api.ts): the Mac app's Tasks view and task pages. You act
 * as yourself; Claude's changes come through its own tools. Browser-safe: zod only.
 */

const ref = z.string().min(1).max(40);
const projectId = z.string().min(1).max(200);
const status = z.enum(ISSUE_STATUSES);
const priority = z.enum(PRIORITIES);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const peer = z.string().min(1).max(80);
const assignee = z.union([z.object({ kind: z.literal('person'), id: peer, name: z.string().min(1).max(64) }), z.object({ kind: z.literal('claude'), owner: peer, ownerName: z.string().min(1).max(64) })]);
const labels = z.array(z.string().min(1).max(32)).max(12);

export const BOARD_API = {
  // A new task (a sub-task with parent) → the task.
  'board.create': {
    args: z.tuple([
      z.object({
        projectId,
        title: z.string().min(1).max(200),
        status: status.optional(),
        priority: priority.optional(),
        assignee: assignee.optional(),
        labels: labels.optional(),
        estimate: z.number().int().min(1).max(100).optional(),
        due: day.optional(),
        parent: ref.optional(),
        blockedBy: z.array(ref).max(20).optional(),
        goal: z.string().max(20_000).optional(),
      }),
    ]),
  },
  // Change a task's title, status, priority, assignee (null: no one), labels, estimate, due date or parent (null: none).
  'board.update': {
    args: z.tuple([
      ref,
      z.object({
        title: z.string().min(1).max(200).optional(),
        status: status.optional(),
        priority: priority.optional(),
        assignee: assignee.nullable().optional(),
        labels: labels.optional(),
        estimate: z.number().int().min(1).max(100).nullable().optional(),
        due: day.nullable().optional(),
        parent: ref.nullable().optional(),
      }),
    ]),
  },
  // Drop a task in a status, between two others (their keys or ids).
  'board.move': { args: z.tuple([ref, status, z.object({ before: ref.optional(), after: ref.optional() }).optional()]) },
  // Write one section of a task's brief (the old text is kept as a revision).
  'board.editBrief': { args: z.tuple([ref, z.enum(BRIEF_SECTIONS), z.string().max(20_000), z.string().max(200).optional()]) },
  'board.restoreRevision': { args: z.tuple([ref, z.string().min(1).max(40)]) },
  'board.comment': { args: z.tuple([ref, z.string().min(1).max(8000)]) },
  // What waits on what: blocked_by, blocks, related; false takes it back.
  'board.relate': { args: z.tuple([ref, z.enum(['blocked_by', 'blocks', 'related']), ref, z.boolean()]) },
  'board.addProof': { args: z.tuple([ref, z.object({ kind: z.enum(['image', 'url', 'file', 'graph', 'text']), title: z.string().min(1).max(120), path: z.string().min(1).max(4096).optional(), url: z.string().url().max(2000).optional(), body: z.string().max(60_000).optional() })]) },
  'board.removeProof': { args: z.tuple([ref, z.string().min(1).max(40)]) },
  'board.remove': { args: z.tuple([ref]) },
  // Start a worktree for a task (and open it); with claude, your Claude starts on it there → the workspace id.
  'board.start': { args: z.tuple([ref, z.object({ claude: z.boolean().optional(), base: z.string().min(1).max(200).optional() }).optional()]) },
  // Its worktree went away before it was done: Canceled, back to the Backlog, or keep it as it is.
  'board.settleGone': { args: z.tuple([ref, z.enum(['canceled', 'backlog', 'keep'])]) },
  // Open a task for every new worktree (on by default).
  'board.setAutoTasks': { args: z.tuple([z.boolean()]) },
  // What a project's task keys start with from now on ("BOB").
  'board.setPrefix': { args: z.tuple([projectId, z.string().min(2).max(6)]) },
} as const;
