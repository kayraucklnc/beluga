import { z } from 'zod';
import { AgentRef } from '../protocol.js';
import { LABEL_COLORS, LABEL_ICONS } from '../core/board/labels.js';
import { BRIEF_SECTIONS, ISSUE_STATUSES, MAX_PROJECT_CONTEXT, PRIORITIES, SYNC_PROVIDERS, personOf } from '../core/board/model.js';

/**
 * Tasks (the board) in the API (see api.ts): the Mac app's Tasks view and task pages. You act
 * as yourself; Claude's changes come through its own tools. Browser-safe: zod only.
 */

const ref = z.string().min(1).max(40);
const projectId = z.string().min(1).max(200);
// A board: a repo's own (its project id) or one of its own (board_…).
const boardId = z.string().min(1).max(200);
const repos = z.array(projectId).min(1).max(20);
const status = z.enum(ISSUE_STATUSES);
const priority = z.enum(PRIORITIES);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const peer = z.string().min(1).max(80);
// A task is for a person (BLG-278); someone's Claude (an older screen) means them.
const assignee = z.union([z.object({ kind: z.literal('person'), id: peer, name: z.string().min(1).max(64) }), z.object({ kind: z.literal('claude'), owner: peer, ownerName: z.string().min(1).max(64) })]).transform(personOf);
const labels = z.array(z.string().min(1).max(32)).max(12);
const provider = z.enum(SYNC_PROVIDERS);
// The core checks the key's exact shape and says what's wrong.
const trackerKey = z.string().trim().min(1).max(400);

export const BOARD_API = {
  // A new task (a sub-task with parent) → the task. With describe instead of a title, your Claude
  // writes its title, goal and criteria (the first line stands in until it has); words asking for
  // several tasks (or an epic), each for someone on the team, make them all (BLG-319).
  'board.create': {
    args: z.tuple([
      z.object({
        // The repo it runs in; board: the board it goes on (left out: the one the repo's work goes on).
        projectId,
        board: boardId.optional(),
        title: z.string().min(1).max(200).optional(),
        describe: z.string().min(1).max(8000).optional(),
        status: status.optional(),
        priority: priority.optional(),
        assignee: assignee.optional(),
        labels: labels.optional(),
        estimate: z.number().int().min(1).max(100).optional(),
        due: day.optional(),
        parent: ref.optional(),
        blockedBy: z.array(ref).max(20).optional(),
        goal: z.string().max(20_000).optional(),
        // The agent (and model) that works it when it starts (BLG-497); none: your default.
        agent: AgentRef.optional(),
        // Only you see it (BLG-501). Left out: private when the description asks for it ("just for me").
        private: z.boolean().optional(),
      }).refine((t) => Boolean(t.title?.trim() || t.describe?.trim()), 'A task needs a title or a description'),
    ]),
  },
  // Change a task's title, status, priority, assignee (null: no one), labels, estimate, due date, parent (null: none) or the repo it runs in (it stays on its board).
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
        projectId: projectId.optional(),
      }),
    ]),
  },
  // Only you see it (true), or the team does again (false): its sub-tasks go with it (BLG-501).
  'board.setPrivate': { args: z.tuple([ref, z.boolean()]) },
  // Drop a task in a status, between two others (their keys or ids).
  'board.move': { args: z.tuple([ref, status, z.object({ before: ref.optional(), after: ref.optional() }).optional()]) },
  // Write one section of a task's brief (the old text is kept as a revision).
  'board.editBrief': { args: z.tuple([ref, z.enum(BRIEF_SECTIONS), z.string().max(20_000), z.string().max(200).optional()]) },
  'board.restoreRevision': { args: z.tuple([ref, z.string().min(1).max(40)]) },
  'board.comment': { args: z.tuple([ref, z.string().min(1).max(8000)]) },
  // What waits on what: blocked_by, blocks, related; false takes it back.
  'board.relate': { args: z.tuple([ref, z.enum(['blocked_by', 'blocks', 'related']), ref, z.boolean()]) },
  'board.addProof': { args: z.tuple([ref, z.object({ kind: z.enum(['image', 'url', 'file', 'graph', 'text']), title: z.string().min(1).max(120), path: z.string().min(1).max(4096).optional(), url: z.string().url().max(2000).optional(), body: z.string().max(60_000).optional(), context: z.boolean().optional() })]) },
  'board.removeProof': { args: z.tuple([ref, z.string().min(1).max(40)]) },
  'board.remove': { args: z.tuple([ref]) },
  // Who works a task (BLG-498): an agent (and model), or null for your default. It takes effect at the
  // task's next start; a worktree already working it keeps its agent → what happened, in words.
  'board.setAgent': { args: z.tuple([ref, AgentRef.nullish()]) },
  // Start a worktree for a task (and open it); with claude, your agent starts on it there → the workspace id.
  // `agent`: this start only, instead of the task's own agent (or your default).
  'board.start': { args: z.tuple([ref, z.object({ claude: z.boolean().optional(), base: z.string().min(1).max(200).optional(), agent: AgentRef.optional() }).optional()]) },
  // The Archive: one finished task (and its finished sub-tasks), or every Done one (in a project); back out; deleted for good.
  'board.archive': { args: z.tuple([ref]) },
  'board.archiveDone': { args: z.tuple([projectId.optional()]) },
  'board.unarchive': { args: z.tuple([ref]) },
  'board.emptyArchive': { args: z.tuple([projectId.optional()]) },
  // Its worktree went away before it was done: Canceled, back to the Backlog, or keep it as it is.
  'board.settleGone': { args: z.tuple([ref, z.enum(['canceled', 'backlog', 'keep'])]) },
  // Open a task for every new worktree (on by default).
  'board.setAutoTasks': { args: z.tuple([z.boolean()]) },
  // Boards and repos are many to many: a board of its own covering a few repos (→ its id), a board renamed or
  // given other repos (a repo's own board too), and a board of its own removed (its tasks go home to
  // their repos' boards, keys kept → how many moved).
  'board.createBoard': { args: z.tuple([z.object({ name: z.string().min(1).max(60), repos, prefix: z.string().min(2).max(6).optional() })]) },
  'board.editBoard': { args: z.tuple([boardId, z.object({ name: z.string().max(60).optional(), repos: z.array(projectId).max(20).optional() })]) },
  'board.removeBoard': { args: z.tuple([boardId]) },
  // What a board's task keys start with from now on ("BOB").
  'board.setPrefix': { args: z.tuple([projectId, z.string().min(2).max(6)]) },
  // A label added to a project's set (its name, icon and color) → the label; and one of its own taken out.
  'board.createLabel': { args: z.tuple([projectId, z.object({ name: z.string().min(1).max(32), icon: z.enum(LABEL_ICONS), color: z.enum(LABEL_COLORS), hint: z.string().max(80).optional() })]) },
  'board.removeLabel': { args: z.tuple([projectId, z.string().min(1).max(32)]) },
  // What the project is about, for Claude writing its tasks (empty: none); shared with its teammates (BLG-298).
  'board.setContext': { args: z.tuple([projectId, z.string().max(MAX_PROJECT_CONTEXT)]) },
  // Sync with another tracker (Linear), per project. Check a key → { ok: true, workspace?, teams } or { ok: false, error }.
  'board.syncTeams': { args: z.tuple([provider, trackerKey]) },
  // Link a project to a team (the key stays on this computer) and sync now → { ok: true, team } or { ok: false, error }.
  'board.syncConnect': { args: z.tuple([projectId, z.object({ provider, key: trackerKey, teamId: z.string().min(1).max(200), auto: z.boolean().optional(), pushExisting: z.boolean().optional() })]) },
  // Forget the key; tasks stay, unlinked (nothing in the tracker changes).
  'board.syncDisconnect': { args: z.tuple([projectId]) },
  // Sync one project now, or every connected one.
  'board.syncNow': { args: z.tuple([projectId.optional()]) },
  // Autosync: every minute, and shortly after a change here.
  'board.syncAuto': { args: z.tuple([projectId, z.boolean()]) },
} as const;
