import { z } from 'zod';

/**
 * What your phone and your Mac say over the companion link (docs/companion.md). The Mac's side
 * (src/companion/host.ts) and the phone app (packages/companion) both import this file, so the two
 * can't disagree within one commit. Runs anywhere: zod only, no Node, no React Native.
 *
 * Versions: within a major only additive changes (new topics, fields, needs-you kinds); the phone
 * ignores what it doesn't know. A breaking change bumps the major, and the Mac keeps answering the
 * previous major for a release.
 */
export const COMPANION_PROTO = { major: 1, minor: 9 } as const;

/**
 * What came in which minor, for a phone talking to an older Mac: it subscribes to a topic (and
 * makes a call) only when the Mac's minor has it, since an older Mac drops a `sub` frame naming a
 * topic it doesn't know. 1.3: the relay (any network). 1.4: the tasks topics, `companion.openOnMac`, `companion.icon`, merging
 * from the phone (`companion.mergeCheck` / `merge` / `resolve`), describing a task
 * (`companion.draftTask` / `addTask`) and starting one (`board.start`). 1.5: "Your Mac" (the
 * `conv:mac:assistant` topic, Home's `assistant`), and asking in a project as a new worktree
 * (`workspaces.startWorktree`, with plan mode) or a plan (`plans.create`), besides a question;
 * a plan's dependencies, criteria and autonomy (`PlanView`, `plans.setAutonomy`). 1.6: a
 * worktree's branch state in its conversation (`ConvView.branch`). 1.7 (BLG-42): a worktree's
 * files, read-only (`companion.files.list` / `find` / `read`), and its terminals, shared with the
 * Mac (`companion.terminals` / `termOpen` / `termClose`, the `term_*` frames). 1.8: a branch's every
 * step from the phone, as the Mac's toolbar has them (`BranchView.steps`, `companion.branchStep`).
 * 1.9 (BLG-87): more of Claude's blocks drawn (`tree`, `json`, `terminal`, `math` blocks, mermaid as
 * a graph or view) and its math typeset (`ProseView.math`).
 */
export const SINCE = { tasks: 4, openOnMac: 4, icon: 4, merge: 4, draftTask: 4, viewFetch: 4, assistant: 5, askModes: 5, files: 7, terminal: 7, branchSteps: 8 } as const;

/** One frame's biggest payload, and a file piece. */
export const MAX_COMPANION_FRAME = 1024 * 1024;
export const COMPANION_PIECE = 192 * 1024;
/** How often the phone's link pings while open, and how long it stays after the app goes to the background. */
export const KEEPALIVE_MS = 20_000;
export const BACKGROUND_GRACE_MS = 15_000;
/** Views of one topic are sent at most this often. */
export const VIEW_COALESCE_MS = 500;
/** Turns a conversation view carries (older ones: companion.older). */
export const VIEW_TURNS = 40;
/** Phones one identity may pair. */
export const MAX_DEVICES = 4;
/** What the phone may send the Mac (photos, files): this big a file, this many in one message. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOADS = 10;
/** A worktree's file is read in pages of this many bytes (companion.files.read). */
export const FILE_PAGE = 512 * 1024;
/** A terminal's output is sent to the phone at most this often (about 30 frames a second), and in pieces of at most this many characters. */
export const TERM_COALESCE_MS = 33;
export const TERM_PIECE = 128 * 1024;

const id = z.string().min(1).max(200);
const text = z.string().max(64_000);
const ts = z.number().int().min(0);

// ---- topics

/** What a screen shows; the phone subscribes to the ones on screen. */
export const Topic = z.union([
  z.literal('home'),
  z.literal('work'),
  z.literal('plans'),
  z.literal('chats'),
  z.literal('people'),
  /** The board's tasks, by project and status (1.3). */
  z.literal('tasks'),
  z.string().regex(/^conv:[\w:.-]{1,200}$/),
  z.string().regex(/^plan:[\w.-]{1,200}$/),
  z.string().regex(/^chat:[\w:.-]{1,200}$/),
  /** One task's page (1.3). */
  z.string().regex(/^task:[\w.-]{1,200}$/),
]);
export type Topic = z.infer<typeof Topic>;

// ---- what views are made of

/** A file the phone sent the Mac (`put`): named by this ref in `companion.ask` / `companion.post`. */
export const UploadRef = z.string().regex(/^up:[\w-]{8,64}$/);

/** A file the Mac handed out: fetched by `ref` (resolved and checked on the Mac). */
export const OutputView = z.object({
  ref: z.string().regex(/^out:[\w-]{8,64}$/),
  name: z.string().max(256),
  kind: z.enum(['image', 'pdf', 'video', 'json', 'markdown', 'text', 'file']),
  size: z.number().int().min(0).optional(),
  ts: ts.optional(),
  /** Who made it: a sub-agent's id, else the conversation's Claude. */
  by: z.string().max(200).optional(),
});
export type OutputView = z.infer<typeof OutputView>;

export const UsageWindowView = z.object({ label: z.string().max(40), pct: z.number().min(0).max(100), resetsAt: ts.optional() });
/** One agent provider's allowance (Claude Code today; others later). */
export const UsageView = z.object({ provider: z.string().max(40), plan: z.string().max(40).optional(), windows: z.array(UsageWindowView).max(4), updatedAt: ts });
export type UsageView = z.infer<typeof UsageView>;

export const Choice = z.object({ label: z.string().max(200), description: z.string().max(1000).optional() });

/**
 * Something waiting for you. `kind` tells the phone which buttons to draw; one it doesn't know is
 * drawn as a plain card with "Open on your Mac". `actions` are API calls the phone makes as they are.
 */
export const NeedsYou = z.object({
  id,
  kind: z.union([z.enum(['approval', 'question', 'request', 'decision', 'confirm']), z.string().max(40)]),
  title: z.string().max(500),
  detail: text.optional(),
  /** Who is asking ("your Claude", "mia's Claude"). */
  from: z.string().max(100).optional(),
  /** The conversation it holds up, to open. */
  topic: Topic.optional(),
  askedAt: ts.optional(),
  timeoutMs: z.number().int().min(0).optional(),
  /** A question's options (pick one, or several). */
  choices: z.array(Choice).max(12).optional(),
  multi: z.boolean().optional(),
  /** Free words are taken too. */
  freeText: z.boolean().optional(),
  /** Buttons: what they say and the call they make. `tone` main is the swipe-right one, danger the swipe-left. */
  actions: z
    .array(z.object({ label: z.string().max(40), tone: z.enum(['main', 'danger', 'plain']), method: z.string().max(80), args: z.array(z.unknown()).max(8) }))
    .max(4),
  /**
   * How to send an answer of your own (picked options, or words): call `method` with `args`, after
   * putting the answer at `slot` (a path into args: [1, 'answers', 'Which store?'] is
   * args[1].answers['Which store?']). Several picks go in as one string joined by `join`
   * (Claude's questions), or as a list when `list` is set. `text` says whether words are taken,
   * `picks` whether options are (one, or several with `multi`). No `answer`: only the buttons.
   */
  answer: z
    .object({
      method: z.string().max(80),
      args: z.array(z.unknown()).max(8),
      slot: z.array(z.union([z.number().int().min(0), z.string().max(1000)])).min(1).max(6),
      join: z.string().max(10).optional(),
      list: z.boolean().optional(),
      text: z.boolean(),
      picks: z.boolean(),
      /** What the send button says ("Send", "Send back"). */
      label: z.string().max(40).optional(),
    })
    .optional(),
});
export type NeedsYou = z.infer<typeof NeedsYou>;

/**
 * What kind of tool a step used, for its icon (1.3): reading, editing, writing a file, searching,
 * running a command, the tests, the web, a sub-agent, its plan, another tool. A phone draws a kind
 * it doesn't know as `tool`.
 */
export const ToolKind = z.union([z.enum(['read', 'edit', 'write', 'search', 'run', 'test', 'web', 'agent', 'plan', 'tool']), z.string().max(20)]);
export type ToolKind = z.infer<typeof ToolKind>;

/** One step in words, with its tool's kind ("Edited store.ts", edit). Never the code or the command line. */
export const StepView = z.object({ tool: ToolKind, text: z.string().max(300) });
export type StepView = z.infer<typeof StepView>;

/**
 * What a run is doing right now (1.3): thinking, writing its answer, on a step (its words, tool and
 * how far it has got), starting, waiting for your approval, or waiting its turn. `since`: when that
 * began (the phone counts the seconds itself; nothing streams per second).
 */
export const LiveView = z.object({
  phase: z.union([z.enum(['thinking', 'writing', 'step', 'starting', 'approval', 'queued']), z.string().max(20)]),
  since: ts.optional(),
  /** The step it's on, present tense ("Running the tests"), with its tool and its count ("137/215"). */
  words: z.string().max(300).optional(),
  tool: ToolKind.optional(),
  progress: z.string().max(40).optional(),
  /** Sub-agents of this run at work now. */
  agents: z.number().int().min(0).optional(),
});
export type LiveView = z.infer<typeof LiveView>;

export const SubAgentView = z.object({
  id,
  title: z.string().max(300),
  status: z.enum(['running', 'done', 'failed']),
  /** Its steps in words, newest last (at most 30). */
  steps: z.array(z.string().max(300)).max(30),
  outputs: z.array(OutputView).max(50),
  /** 1.3: the same steps with their tools' kinds (for icons), what it's doing now, its kind ("general-purpose"), when it started and ended. */
  trail: z.array(StepView).max(30).optional(),
  step: z.string().max(300).optional(),
  tool: ToolKind.optional(),
  type: z.string().max(60).optional(),
  startedAt: ts.optional(),
  endTs: ts.optional(),
  /** Steps it has taken in all (the trail keeps the last 30). */
  count: z.number().int().min(0).optional(),
});
export type SubAgentView = z.infer<typeof SubAgentView>;

/** Claude's text, with code blocks taken out: each is a `[[code:n]]` marker and one entry in `code`. */
export const ProseView = z.object({
  text,
  code: z
    .array(
      z.object({
        lang: z.string().max(40).optional(),
        lines: z.number().int().min(0),
        /**
         * 1.3: what Claude drew for the screen rather than code (BLG-68): a `beluga-view` (table,
         * chart, stats, code, colors), a `beluga-graph` or `beluga-tasks`, its JSON as written. The
         * phone reads it with the Mac's own parsers (src/shared) and draws it; its source's rows
         * come through the Mac (companion.viewFetch). A phone before 1.3 shows the chip. A table
         * Claude wrote as text is a `view` (a table) too; 1.5: one that only looks like a table
         * is `text`, shown monospaced and never wrapped. 1.9 (BLG-87): a file tree (`tree`), JSON
         * (`json`) or terminal output (`terminal`) as written, display math as its TeX (`math`), and
         * a mermaid diagram as the `graph` or `view` it reads as (src/shared/render/rich-fence.ts).
         */
        block: z.object({ kind: z.union([z.enum(['view', 'graph', 'tasks', 'text', 'tree', 'json', 'terminal', 'math']), z.string().max(20)]), text: z.string().max(200_000) }).optional(),
      }),
    )
    .max(200),
  /**
   * 1.9: the math in it typeset on the Mac (MathJax, src/companion/math-svg.ts), by `I<tex>` (inline,
   * `$…$` in the text) or `D<tex>` (a `math` block): an SVG drawn in the text's color
   * (`currentColor`), its size and baseline in ex. Math the Mac couldn't typeset isn't here: the
   * phone shows its TeX.
   */
  math: z.record(z.string().max(4001), z.object({ svg: z.string().max(200_000), w: z.number(), h: z.number(), v: z.number() })).optional(),
});
export type ProseView = z.infer<typeof ProseView>;

export const TurnView = z.object({
  id,
  who: z.enum(['you', 'claude', 'friend', 'system']),
  name: z.string().max(100),
  prose: ProseView,
  ts,
  status: z.enum(['queued', 'working', 'done', 'failed', 'stopped']).optional(),
  /** What it's doing now, in words ("Running the tests · 137/215"). */
  step: z.string().max(300).optional(),
  steps: z.number().int().min(0).optional(),
  subagents: z.array(SubAgentView).max(40).optional(),
  outputs: z.array(OutputView).max(50).optional(),
  endTs: ts.optional(),
  /** 1.3: what it's doing now (a running turn), and its steps in words with their tools, newest last. */
  live: LiveView.optional(),
  trail: z.array(StepView).max(40).optional(),
  /**
   * Your message, steered into Claude's running turn, that Claude hasn't read yet (1.3): it waits
   * for Claude's next step (Send now: host.steerNow with `request`), or for its step to stop.
   */
  steer: z.object({ request: id, waiting: z.enum(['next_step', 'stopping']) }).optional(),
});
export type TurnView = z.infer<typeof TurnView>;

export const ConvSummary = z.object({
  topic: Topic,
  title: z.string().max(300),
  project: z.string().max(200).optional(),
  status: z.enum(['working', 'waiting', 'idle', 'failed']),
  last: z.string().max(300).optional(),
  lastAt: ts.optional(),
  unread: z.number().int().min(0).optional(),
  needsYou: z.boolean().optional(),
  /** Running sub-agents, for the dots. */
  agents: z.number().int().min(0).optional(),
  /** 1.3: its project's id and icon (a checksum: companion.icon), and outputs made since you last wrote in it. */
  projectId: z.string().max(200).optional(),
  icon: z.string().regex(/^[0-9a-f]{16,64}$/).optional(),
  fresh: z.number().int().min(0).optional(),
});
export type ConvSummary = z.infer<typeof ConvSummary>;

// ---- views, one per topic

export const HomeView = z.object({
  mac: z.object({ name: z.string().max(100), version: z.string().max(40) }),
  me: z.object({ name: z.string().max(64), peerId: id }),
  usage: z.array(UsageView).max(8),
  needsYou: z.array(NeedsYou).max(50),
  running: z.array(ConvSummary).max(20),
  /**
   * Every conversation's newest outputs in one list, until 1.2. Since 1.3 it's empty: outputs live
   * with their conversation (ConvView `outputs`), Home only hints at new ones (ConvSummary `fresh`).
   * Kept, empty, so older phones still read Home.
   */
  outputs: z.array(OutputView.extend({ topic: Topic.optional() })).max(30),
  unread: z.object({ work: z.number().int().min(0), chats: z.number().int().min(0) }),
  /** 1.5: "Your Mac" (`conv:mac:assistant`): its last line and whether it works, for Home's "Ask your Mac". */
  assistant: ConvSummary.optional(),
  /** 1.3: tasks waiting for your review (Home links to them). */
  review: z.object({ count: z.number().int().min(0), first: z.object({ topic: Topic, key: z.string().max(40), title: z.string().max(300) }).optional() }).optional(),
});
export type HomeView = z.infer<typeof HomeView>;

export const WorkView = z.object({
  projects: z.array(z.object({ id, name: z.string().max(200), conversations: z.array(ConvSummary).max(200), /** 1.3: its icon's checksum (companion.icon). */ icon: z.string().regex(/^[0-9a-f]{16,64}$/).optional() })).max(200),
});
export type WorkView = z.infer<typeof WorkView>;

/** A worktree's merge as the phone follows it (1.3). Files by name only, never their contents. */
export const MergeView = z.object({
  phase: z.union([z.enum(['merging', 'conflicts', 'resolving', 'resolved', 'merged', 'blocked']), z.string().max(20)]),
  at: ts,
  conflicts: z.array(z.string().max(300)).max(100).optional(),
  why: z.string().max(500).optional(),
});
export type MergeView = z.infer<typeof MergeView>;

/**
 * 1.8: the branch steps the phone can ask the Mac for (companion.branchStep): all of the Mac's
 * (core/branch-state.ts) but Merge into the main folder (its own sheet, companion.merge) and Open
 * PR (the phone's browser).
 */
export const PHONE_BRANCH_STEPS = ['merge_pr', 'merge_auto', 'merge_admin', 'update_branch', 'mark_ready', 'resolve_pr', 'fix_checks', 'merge_claude', 'review_claude', 'commit', 'pr', 'continue_after_merge', 'archive', 'delete'] as const;
export type PhoneBranchStep = (typeof PHONE_BRANCH_STEPS)[number];

/** 1.8: one of a branch's steps (core/branch-state.ts BranchStep). */
export const BranchStepView = z.object({
  id: z.string().max(40),
  label: z.string().max(80),
  hint: z.string().max(300),
  /** Claude does it, in the worktree's conversation. */
  claude: z.boolean().optional(),
  /** Can't be undone (Delete Worktree, merging past the checks): the phone asks first. */
  danger: z.boolean().optional(),
});
export type BranchStepView = z.infer<typeof BranchStepView>;

/** 1.6: where a worktree's branch stands, as the Mac's toolbar shows it (core/branch-state.ts), and its next step in words. */
export const BranchView = z.object({
  kind: z.string().max(40),
  /** "Merged", "Ready to merge", "Conflicts". */
  label: z.string().max(80),
  tone: z.union([z.enum(['merged', 'ok', 'error', 'warn', 'wait', 'info', 'muted']), z.string().max(10)]),
  detail: z.string().max(300),
  branch: z.string().max(250),
  into: z.string().max(250),
  /** 1.8: `url`, its page on GitHub (Open PR opens it on the phone). */
  pr: z.object({ number: z.number().int().min(0), state: z.string().max(10), url: z.string().max(500).optional() }).optional(),
  /** The Mac's next step: "Squash and Merge", and whether Claude does it. */
  next: z.object({ id: z.string().max(40), label: z.string().max(80), claude: z.boolean().optional() }).optional(),
  /** 1.8: every step, the main one first (the Mac's toolbar button, then its menu); the phone does them with companion.branchStep. */
  steps: z.array(BranchStepView).max(20).optional(),
});
export type BranchView = z.infer<typeof BranchView>;

/** What a merge would do and what stands in the way (companion.mergeCheck): the Mac's own checks, in words. */
export const MergeCheckView = z.object({
  from: z.string().max(200),
  into: z.string().max(200),
  commits: z.number().int().min(0),
  files: z.number().int().min(0),
  /** The newest commits' subjects (words, at most 5). */
  subjects: z.array(z.string().max(300)).max(5),
  checks: z.array(z.object({ id: z.string().max(40), tone: z.union([z.enum(['ok', 'info', 'block']), z.string().max(10)]), text: z.string().max(500), fix: z.union([z.enum(['commit', 'claude']), z.string().max(20)]).optional() })).max(12),
  canMerge: z.boolean(),
  /** The button: "Merge 3 Commits". */
  confirm: z.string().max(60),
  conflicts: z.array(z.string().max(300)).max(100).optional(),
});
export type MergeCheckView = z.infer<typeof MergeCheckView>;

export const ConvView = z.object({
  topic: Topic,
  title: z.string().max(300),
  project: z.string().max(200).optional(),
  turns: z.array(TurnView).max(200),
  /** Older turns exist (companion.older). */
  more: z.boolean(),
  needsYou: z.array(NeedsYou).max(20),
  /** You may write here (it's yours, or shared with you to work in). */
  canSend: z.boolean(),
  working: z.boolean(),
  /** 1.3: its project's id and icon, everything its worktree made (scratch files, reports, its Claude's and sub-agents' outputs, newest first), and what of yours waits its turn. */
  projectId: z.string().max(200).optional(),
  icon: z.string().regex(/^[0-9a-f]{16,64}$/).optional(),
  outputs: z.array(OutputView).max(100).optional(),
  /** Your messages waiting for Claude here, in run order: Steer one (host.promote) or remove it (host.cancelQueued) by `id`. */
  queue: z.array(z.object({ id, text: z.string().max(300) })).max(20).optional(),
  /** 1.3: a worktree of yours: it can be merged from the phone (companion.mergeCheck, companion.merge). */
  mergeable: z.boolean().optional(),
  /** 1.3: where its merge stands: merging, conflicts (files by name), Claude resolving them, Claude done (check again), merged, or blocked (why). */
  merge: MergeView.optional(),
  /** 1.6: a worktree's branch: merged, ready to merge, conflicts, checks… (BranchView). */
  branch: BranchView.optional(),
});
export type ConvView = z.infer<typeof ConvView>;

export const PlanTaskView = z.object({
  id,
  title: z.string().max(300),
  state: z.string().max(40),
  mine: z.boolean().optional(),
  topic: Topic.optional(),
  /** 1.5: what it's for, done means (its acceptance), the plan's tasks it waits on (ids), and why it can't start yet. */
  goal: z.string().max(1000).optional(),
  acceptance: z.array(z.string().max(400)).max(20).optional(),
  blockedBy: z.array(id).max(20).optional(),
  why: z.string().max(300).optional(),
});
/** How a plan runs (1.5): Step by Step (you start each task), Check-ins (waits at each milestone), Autopilot. */
export const PlanAutonomy = z.union([z.enum(['step', 'gated', 'autopilot']), z.string().max(20)]);
export const PlanView = z.object({
  id,
  title: z.string().max(300),
  goal: z.string().max(4000).optional(),
  state: z.string().max(40),
  topic: Topic.optional(),
  milestones: z
    .array(
      z.object({
        id,
        title: z.string().max(300),
        state: z.string().max(40),
        criteria: z.array(z.string().max(1000)).max(40),
        tasks: z.array(PlanTaskView).max(100),
        /** 1.5: the milestones it waits on (ids; none: it runs alongside from the start), and its own autonomy when it differs from the plan's. */
        dependsOn: z.array(id).max(20).optional(),
        autonomy: PlanAutonomy.optional(),
      }),
    )
    .max(50),
  needsYou: z.array(NeedsYou).max(20),
  /** 1.5: how it runs (plans.setAutonomy), paused, how many tasks may run at once, and how many run now. */
  autonomy: PlanAutonomy.optional(),
  paused: z.boolean().optional(),
  parallel: z.number().int().min(0).optional(),
  running: z.number().int().min(0).optional(),
});
export type PlanView = z.infer<typeof PlanView>;
export const PlansView = z.object({ plans: z.array(PlanView.pick({ id: true, title: true, state: true, topic: true }).extend({ done: z.number().int(), total: z.number().int() })).max(100) });
export type PlansView = z.infer<typeof PlansView>;

/** The board's statuses and priorities (src/core/board/model.ts), as the phone shows them. */
export const TaskStatus = z.union([z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'in_plan', 'done', 'canceled']), z.string().max(20)]);
export const TaskPriority = z.union([z.enum(['urgent', 'high', 'medium', 'low', 'none']), z.string().max(20)]);

/** A task in a list (1.3): its key, title, status, priority, who has it ("you", "your Claude", "Mia"). */
export const TaskSummary = z.object({
  id,
  topic: Topic,
  key: z.string().max(40),
  title: z.string().max(300),
  status: TaskStatus,
  priority: TaskPriority,
  assignee: z.string().max(80).optional(),
  /** Acceptance criteria ticked, of all. */
  checks: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }).optional(),
  /** The conversation of the worktree doing it. */
  conv: Topic.optional(),
  pr: z.object({ number: z.number().int().min(0), state: z.string().max(20) }).optional(),
  updatedAt: ts,
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TasksView = z.object({
  projects: z
    .array(
      z.object({
        id,
        name: z.string().max(200),
        icon: z.string().regex(/^[0-9a-f]{16,64}$/).optional(),
        /** By status, in the board's order (in progress, in review, ready, backlog, then the latest done). */
        groups: z.array(z.object({ status: TaskStatus, label: z.string().max(40), tasks: z.array(TaskSummary).max(100), more: z.number().int().min(0).optional() })).max(10),
      }),
    )
    .max(100),
});
export type TasksView = z.infer<typeof TasksView>;

/** One task's page (1.3): its brief's goal (code folded), acceptance with ticks, activity, worktree and pull request. */
export const TaskPageView = TaskSummary.extend({
  project: z.string().max(200),
  projectId: z.string().max(200),
  icon: z.string().regex(/^[0-9a-f]{16,64}$/).optional(),
  goal: ProseView.optional(),
  acceptance: z.array(z.object({ text: z.string().max(1000), state: z.union([z.enum(['done', 'deferred', 'not_done', 'open']), z.string().max(20)]), reason: z.string().max(1000).optional() })).max(60),
  /** Newest last. */
  activity: z.array(z.object({ id, at: ts, who: z.string().max(80), text: z.string().max(500), body: z.string().max(8000).optional(), comment: z.boolean().optional() })).max(60),
  worktree: z.string().max(200).optional(),
  pr: z.object({ number: z.number().int().min(0), state: z.string().max(20), title: z.string().max(300), checks: z.string().max(20).optional() }).optional(),
  /** Where it may be moved from the phone (board.move), with their labels. */
  moves: z.array(z.object({ status: TaskStatus, label: z.string().max(40) })).max(10),
});
export type TaskPageView = z.infer<typeof TaskPageView>;

export const ChatMessageView = z.object({
  id,
  from: z.string().max(100),
  mine: z.boolean(),
  claude: z.boolean().optional(),
  text,
  ts,
  files: z.array(OutputView).max(20).optional(),
});
export type ChatMessageView = z.infer<typeof ChatMessageView>;
export const ChatsView = z.object({
  chats: z.array(z.object({ topic: Topic, name: z.string().max(100), kind: z.enum(['dm', 'group']), last: z.string().max(300).optional(), lastAt: ts.optional(), unread: z.number().int().min(0) })).max(600),
});
export type ChatsView = z.infer<typeof ChatsView>;
/** Someone in a chat (you too, `me`): whose Claude a message can ask (companion.post `ask`). Since 1.2. */
export const ChatMemberView = z.object({ peerId: id, name: z.string().max(64), me: z.boolean().optional() });
export type ChatMemberView = z.infer<typeof ChatMemberView>;
export const ChatView = z.object({
  topic: Topic,
  name: z.string().max(100),
  kind: z.enum(['dm', 'group']),
  messages: z.array(ChatMessageView).max(200),
  more: z.boolean(),
  live: z.array(z.string().max(100)).max(20),
  /** Who's in it, you first (1.2; older Macs leave it out). */
  members: z.array(ChatMemberView).max(200).optional(),
});
export type ChatView = z.infer<typeof ChatView>;

export const PeopleView = z.object({
  people: z
    .array(
      z.object({
        peerId: id,
        name: z.string().max(64),
        presence: z.enum(['online', 'away', 'dnd', 'offline']),
        note: z.string().max(200).optional(),
        usage: UsageView.optional(),
        /** What their Beluga lets your Claude do (their card): "screen", "commands"… */
        offers: z.array(z.string().max(40)).max(20),
        chat: Topic.optional(),
      }),
    )
    .max(600),
});
export type PeopleView = z.infer<typeof PeopleView>;

// ---- a worktree's files and terminals (1.7, BLG-42)

/**
 * One entry of a worktree's folder (companion.files.list). `ref`: a picture, openable in the
 * image viewer as an output. Secrets (`isSecretPath`), `.git` and links that lead out of the
 * worktree are never listed.
 */
export const FileEntryView = z.object({
  name: z.string().max(256),
  dir: z.boolean(),
  size: z.number().int().min(0).optional(),
  ref: OutputView.shape.ref.optional(),
});
export type FileEntryView = z.infer<typeof FileEntryView>;
/** A folder of a worktree: its path inside it ('' is the top), folders first. */
export const FolderView = z.object({ path: z.string().max(4096), entries: z.array(FileEntryView).max(5000), more: z.boolean().optional() });
export type FolderView = z.infer<typeof FolderView>;
/** Files and folders whose names match (companion.files.find), by their paths inside the worktree. */
export const FoundView = z.object({ hits: z.array(z.object({ path: z.string().max(4096), dir: z.boolean() })).max(200), more: z.boolean().optional() });
export type FoundView = z.infer<typeof FoundView>;
/**
 * A page of a worktree's file, read-only (companion.files.read): `text` from byte `off` (secrets a
 * file holds are redacted), the file's `size`, `eof`, and its language for colours (`lang`, from
 * its name). `binary`: not text; nothing is sent.
 */
export const FilePageView = z.object({
  path: z.string().max(4096),
  text: z.string().max(FILE_PAGE * 2),
  off: z.number().int().min(0),
  next: z.number().int().min(0),
  size: z.number().int().min(0),
  eof: z.boolean(),
  lang: z.string().max(20).optional(),
  binary: z.boolean().optional(),
});
export type FilePageView = z.infer<typeof FilePageView>;
/** A terminal session of a worktree (companion.terminals): the same session the Mac's terminal dock shows. */
export const TerminalView = z.object({
  key: z.string().min(1).max(200),
  label: z.string().max(80),
  running: z.boolean(),
  exit: z.number().int().nullable().optional(),
  /** The session's size: the Mac's. The phone draws that grid rather than resizing it. */
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500),
});
export type TerminalView = z.infer<typeof TerminalView>;
export const TerminalsView = z.object({ terminals: z.array(TerminalView).max(40) });
export type TerminalsView = z.infer<typeof TerminalsView>;

const termKey = z.string().min(1).max(200);

// ---- paths (docs/companion.md, "Any network")

/**
 * How a link reached the Mac: `lan` (directly, on the same network), `direct` (directly over the
 * internet: hyperdht's hole-punch), or `relay` (through the Mac's Cloudflare tunnel, with the same
 * Noise handshake inside, so the relay sees only ciphertext).
 */
export const LinkPath = z.enum(['lan', 'direct', 'relay']);
export type LinkPath = z.infer<typeof LinkPath>;

/** One way the phone tried (`p2p`: hyperdht, LAN first then hole-punching; `relay`: the tunnel). */
export const DialAttempt = z.object({
  way: z.enum(['p2p', 'relay']),
  outcome: z.enum(['ok', 'timeout', 'refused', 'unreachable', 'not-found', 'failed', 'skipped', 'lost']),
  /** `lost`: still trying when another way connected (it was dropped). `code`: hyperdht's error code (HOLEPUNCH_ABORTED, PEER_NOT_FOUND…), or the relay's close code. */
  code: z.string().max(60).optional(),
  ms: z.number().int().min(0).optional(),
});
export type DialAttempt = z.infer<typeof DialAttempt>;

/** A relay URL: wss:// (the tunnel), or ws:// (a local relay in tests). */
export const RelayUrl = z.string().max(300).regex(/^wss?:\/\/[\w.:-]+(\/[\w./-]*)?$/);
/** Where a key's relay is: the URL path ends with the key it reaches (hex). */
export const relayUrlFor = (base: string, keyHex: string): string => `${base.replace(/\/+$/, '')}/${keyHex}`;

/**
 * What the Mac publishes on the DHT under its companion key (and each open pairing's key), signed
 * with that key (hyperdht mutablePut): its current relay. The DHT lookup works on networks where
 * peer connections don't, so a phone finds the relay there.
 */
export const RelayRecord = z.object({ v: z.literal(1), relay: RelayUrl.optional(), at: ts });
export type RelayRecord = z.infer<typeof RelayRecord>;

// ---- frames

export const PhoneFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    v: z.object({ major: z.number().int(), minor: z.number().int() }),
    app: z.string().max(40),
    platform: z.enum(['android', 'ios']),
    topics: z.array(Topic).max(16),
    /** How this link got here, and what was tried first (the Mac's Settings › Phone says it in words). */
    via: z.object({ path: LinkPath, tried: z.array(DialAttempt).max(8) }).optional(),
  }),
  z.object({ t: z.literal('sub'), topics: z.array(Topic).max(16) }),
  z.object({ t: z.literal('call'), id: z.number().int().min(0), method: z.string().max(80), args: z.array(z.unknown()).max(16) }),
  z.object({ t: z.literal('get'), id: z.number().int().min(0), ref: OutputView.shape.ref, variant: z.enum(['thumb', 'full', 'text']), off: z.number().int().min(0) }),
  /**
   * A piece of a file for the Mac (a photo to attach): pieces of at most COMPANION_PIECE bytes, in
   * order from 0, the last with `eof`. Each is answered with `result {id}`; the last one's value is
   * `{ ref }` (an `up:` ref for companion.ask / companion.post). At most MAX_UPLOAD_BYTES a file.
   */
  z.object({ t: z.literal('put'), id: z.number().int().min(0), name: z.string().min(1).max(200), mime: z.string().max(100), size: z.number().int().min(0).max(MAX_UPLOAD_BYTES), off: z.number().int().min(0), b64: z.string().max(Math.ceil(COMPANION_PIECE / 3) * 4 + 4), eof: z.boolean() }),
  z.object({ t: z.literal('push'), platform: z.enum(['fcm', 'apns']), token: z.string().max(4096), relayKey: z.string().max(200) }),
  /** The app went to the background (the link closes after the grace) or came back. */
  z.object({ t: z.literal('focus'), on: z.boolean() }),
  /**
   * 1.7: a terminal on the phone's screen (a key companion.terminals or termOpen gave). The Mac
   * sends what it wrote lately, then its output as it comes (coalesced, TERM_COALESCE_MS), until
   * `term_detach` or the link closes. `term_input`: keys typed on the phone, written to the very
   * session the Mac shows.
   */
  z.object({ t: z.literal('term_attach'), term: termKey }),
  z.object({ t: z.literal('term_detach'), term: termKey }),
  z.object({ t: z.literal('term_input'), term: termKey, data: z.string().min(1).max(64_000) }),
  z.object({ t: z.literal('bye') }),
]);
export type PhoneFrame = z.infer<typeof PhoneFrame>;

export const MacFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('welcome'),
    v: z.object({ major: z.number().int(), minor: z.number().int() }),
    /** The oldest phone protocol this Mac still answers. */
    min: z.object({ major: z.number().int(), minor: z.number().int() }),
    mac: z.object({ name: z.string().max(100), version: z.string().max(40) }),
    me: z.object({ name: z.string().max(64), peerId: id }),
    /** The Mac's relay now (the phone keeps it for next time). */
    relay: RelayUrl.optional(),
  }),
  z.object({ t: z.literal('view'), topic: Topic, rev: z.number().int().min(0), data: z.unknown() }),
  z.object({ t: z.literal('result'), id: z.number().int().min(0), ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(2000).optional() }),
  z.object({ t: z.literal('chunk'), id: z.number().int().min(0), off: z.number().int().min(0), b64: z.string().max(Math.ceil(COMPANION_PIECE / 3) * 4 + 4), eof: z.boolean(), size: z.number().int().min(0), mime: z.string().max(100) }),
  z.object({ t: z.literal('nudge'), kind: z.enum(['needsYou', 'done', 'mentions']), title: z.string().max(200), body: z.string().max(1000), topic: Topic.optional() }),
  /** 1.7: a terminal's output (raw, as the program wrote it). `reset`: what follows is the whole screen again (clear first). */
  z.object({ t: z.literal('term_data'), term: termKey, data: z.string().max(TERM_PIECE), reset: z.boolean().optional() }),
  /** 1.7: whether it runs, how it ended, and its size (the Mac's: when the Mac resizes it, this comes again). */
  z.object({ t: z.literal('term_status'), term: termKey, running: z.boolean(), exit: z.number().int().nullable().optional(), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500), gone: z.boolean().optional() }),
  z.object({ t: z.literal('bye'), reason: z.string().max(200) }),
]);
export type MacFrame = z.infer<typeof MacFrame>;

/** Which view type a topic carries. */
export function viewSchema(topic: Topic): z.ZodType {
  if (topic === 'home') return HomeView;
  if (topic === 'work') return WorkView;
  if (topic === 'plans') return PlansView;
  if (topic === 'chats') return ChatsView;
  if (topic === 'people') return PeopleView;
  if (topic.startsWith('conv:')) return ConvView;
  if (topic.startsWith('plan:')) return PlanView;
  if (topic === 'tasks') return TasksView;
  if (topic.startsWith('task:')) return TaskPageView;
  return ChatView;
}

/** Can this side talk to that one: same major, or the other side still answers ours. */
export const compatible = (mine: { major: number }, theirs: { major: number }, theirMin: { major: number }): boolean => mine.major === theirs.major || (mine.major < theirs.major && mine.major >= theirMin.major);

const parse = <T>(schema: z.ZodType<T>, raw: string): T | undefined => {
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
};
export const parsePhoneFrame = (raw: string): PhoneFrame | undefined => parse(PhoneFrame, raw);
export const parseMacFrame = (raw: string): MacFrame | undefined => parse(MacFrame, raw);

// ---- pairing (docs/companion.md, "Signing in")

/** What the pairing QR holds: `beluga://device#<22 chars>`; a code is typed as for friends. */
/** `?r=` (additive): the Mac's relay, URL-encoded, so pairing works where the DHT doesn't. */
export const DEVICE_LINK = /^(?:beluga|klaud):\/\/device#([\w-]{22})(?:\?r=([\w%.-]+))?$/;

export const DeviceCert = z.object({
  v: z.literal(1),
  /** Your peer id and identity key (base64 SPKI). */
  owner: id,
  ownerKey: z.string().max(200),
  /** The phone's own Ed25519 key (hex), its Noise link key (hex) and box key (hex X25519). */
  device: z.string().regex(/^[0-9a-f]{64}$/),
  link: z.string().regex(/^[0-9a-f]{64}$/),
  box: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1).max(64),
  platform: z.enum(['android', 'ios']),
  issuedAt: ts,
  /** Your identity's signature over the canonical JSON of the rest ('beluga-device-v1'). */
  sig: z.string().max(200),
});
export type DeviceCert = z.infer<typeof DeviceCert>;

/**
 * The pairing's messages. `mac` on dev_hello and dev_ok is the sender's proof that it holds the
 * pairing's secret: keyed BLAKE2b over its role, the Noise handshake hash and the canonical JSON
 * of the message without `mac` (src/companion/device-crypto.ts `devProof`).
 */
export const DevicePair = z.discriminatedUnion('t', [
  z.object({ t: z.literal('dev_hello'), proto: z.number().int(), mac: z.string().max(100), device: z.string().regex(/^[0-9a-f]{64}$/), box: z.string().regex(/^[0-9a-f]{64}$/), name: z.string().min(1).max(64), platform: z.enum(['android', 'ios']), app: z.string().max(40) }),
  /** The Mac is showing "Pair this phone?" with the fingerprint; waits for your click. */
  z.object({ t: z.literal('dev_wait'), fingerprint: z.string().max(40) }),
  z.object({ t: z.literal('dev_ok'), mac: z.string().max(100), cert: DeviceCert, address: z.string().regex(/^[0-9a-f]{64}$/), macName: z.string().max(100), relay: RelayUrl.optional() }),
  /** `why` (additive) says it for the phone's explanation (diagnose.ts); `reason` is the Mac's words. */
  z.object({ t: z.literal('dev_refused'), reason: z.string().max(200), why: z.enum(['expired', 'used', 'cancelled', 'unverified', 'tries', 'busy', 'full', 'version-mac', 'version-app']).optional() }),
]);
export type DevicePair = z.infer<typeof DevicePair>;
export const parseDevicePair = (raw: string): DevicePair | undefined => parse(DevicePair, raw);

/** The paired phones, as the Mac's screens see them (never keys). */
export interface DeviceView {
  readonly id: string;
  readonly name: string;
  readonly platform: 'android' | 'ios';
  readonly app?: string;
  readonly pairedAt: number;
  readonly lastSeen?: number;
  /** Linked right now. */
  readonly linked: boolean;
  /** It can be told things while closed (Beluga Push is set up for it). */
  readonly push: boolean;
  /** How its last link came: on the same network, directly over the internet, or through the relay. */
  readonly path?: LinkPath;
  /** That in words, when it's worth saying ("couldn't connect directly on its network; it used the relay"). */
  readonly note?: string;
}

export interface CompanionSlice {
  readonly companion: { readonly devices: readonly DeviceView[]; readonly pairing?: { readonly link: string; readonly code: string; readonly expiresAt: number; readonly waiting?: { readonly name: string; readonly fingerprint: string } } };
}
