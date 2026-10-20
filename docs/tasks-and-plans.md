# Tasks, Plans and Graphs (Mac app) — design

Three features that build on each other:

1. **Graphs.** Claude draws interactive diagrams (React Flow) in any conversation, document or recap.
2. **Tasks.** A Linear-quality board shared with friends. Every worktree is a task, every task knows its PR, and agents read and improve each task's brief while they work.
3. **Plans.** Milestones → phases → tasks, with blockers, parallel lanes and review gates. You plan with Claude using your own planning instructions. A head Claude then runs the plan: it starts worktrees in parallel and stops for you wherever you ask it to.

Graphs ship first because the other two use them: plans are drawn as graphs, and milestone recaps explain what happened with graphs and proof.

Mac-only, like the network and the gateway (see [parity.md](parity.md) › "Only in one client"). The terminal app stays as it is. The core holds the state and the agent tools, so a terminal screen could show it later.

---

## 1. Graphs (`klaud-graph`) — phase 1, shipped first

Claude writes a fenced block of JSON and the window draws it. No code runs, so a graph is only data:

````
```klaud-graph
{ "title": "How a login works", "direction": "right",
  "nodes": [ { "id": "app", "type": "client", "label": "Mac app" }, … ],
  "edges": [ { "from": "app", "to": "api", "label": "POST /login", "kind": "call" } ],
  "steps": [ { "title": "1. The app asks", "focus": ["app", "api"], "text": "…" } ] }
```
````

- **Where graphs show up:** chat answers, Markdown files in the reader, reports, task briefs and milestone recaps.
- **How it starts:** `/visualize <what>` asks Claude for a graph. Claude can also decide on its own: the system prompt says when a graph helps and what the format is.
- **Node kinds:** `client`, `service`, `database` (with fields), `queue`, `storage`, `external`, `actor`/`person`, `function`, `file`, `decision`, `note`, `task` (with status), `milestone`, `image` (a screenshot as proof), `metric`, and `group` (a labelled box around other nodes).
- **Edge kinds:** `flow`, `call`, `data`, `async` (moving dashes), `depends` and `blocks`, each with an optional label.
- **Layout:** automatic, with ELK's layered algorithm and groups as compound nodes. Claude never writes coordinates.
- **Working with a graph:**
  - pan, zoom and fit
  - hover a node to light up its neighbours
  - click a node for its details: Markdown, links to files, tasks and URLs
  - **Walkthrough** (`steps`): one step at a time, each focusing a few nodes and edges with a caption
  - open full window, with a minimap
  - change the direction
  - Copy as JSON
- **Look:** the window's own tokens, neutral greys with color only for meaning (status, Claude's copper), light and dark, reduced motion respected.
- **Safety:** zod validates every block. A block that doesn't validate shows a readable error with its JSON. Markdown in details goes through the chat's sanitizing renderer, and image nodes follow the chat's image rules (local pictures only in your own and your Claude's messages).

Spec and examples: [graphs.md](graphs.md). Code: `src/shared/graph-spec.ts` (browser-safe schema), `packages/mac/src/components/graph/*`.

---

## 2. Tasks — phase 2, shipped

### The model (`src/core/board/`, browser-safe slice `board`)

The gateway already uses the word "tasks" in code, so this feature's code says **board** and **issue**. The window says **Tasks**. Everything lives in `~/.klaud/board.json` (only you can read it), written a moment after each change.

| Field | Notes |
|---|---|
| `key` | `BOB-12`: a per-project prefix (from the project's name, changeable with `board.setPrefix`) and a counter |
| `title`, `status` | Backlog · Todo · In Progress · In Review · Done · Canceled (the board's columns) |
| `priority`, `labels`, `estimate`, `due` | Linear's set (estimates 1, 2, 3, 5, 8) |
| `assignee` | you, a friend (peer id), **your Claude**, or **a friend's Claude** |
| `parent` | sub-tasks; a task can't sit under itself or its own sub-tasks |
| `blockedBy`, `related` | what must be done first (its other side is "blocks"; a loop is refused), and related tasks |
| `worktrees`, `branch`, `pr` | the worktrees doing it (the current one last), its branch, and its pull request as the workbench last saw it |
| `brief` | the living definition (below), with revisions |
| `proof` | screenshots, pages, files, graphs and results, attached by people or Claude |
| `activity` | an append-only feed: who changed what, comments, Claude's notes, pull request events (the last 200) |

**The brief** is what later agents rely on. It's Markdown in fixed sections: **Goal**, **Context**, **Acceptance criteria** (checkboxes you tick on the page), **Decisions** (what was decided and why), **Open questions** and **Notes for the next agent**. Each edit is a revision with its author (a person or a Claude) and a one-line reason. A section's history shows every version; **Restore This** puts one back (as a new revision).

### Worktree ↔ task (automatic)

- **A worktree opens a task.** `WorkspaceController.onWorktree` reports worktrees opening, merging, being archived, deleted or restored; the board listens (`core/board/work.ts`).
  - A new worktree gets a task titled after it ("add-rate-limiting" → "Add rate limiting"), In Progress, for your Claude. The title follows the worktree's name until you rename the task. The first thing you say there becomes the Goal.
  - A conversation carried into a worktree from main brings what it was asked as the Goal.
  - A fork stays on the same task, as does a worktree started *from* a task (Start Worktree).
  - Turn it off in Tasks › ⋯ › Open a Task for Every New Worktree.
- **The task follows the work:**

  | When | Status |
  |---|---|
  | The worktree is created | In Progress |
  | A pull request opens (not a draft) | In Review |
  | Changes are requested | back to In Progress, with a note |
  | The pull request merges, or the worktree merges into main here | Done |
  | Archived or deleted before it was done | a banner asks: Cancel Task, Back to Backlog, or Keep As Is |

- **Claude knows its task.** Your own runs in a task's worktree get its brief, parent, blockers and sub-tasks in their instructions (`core/board/prompt.ts`), and the task tools (server `klaud_board`), built for each run from its conversation:
  - `task_get`, `task_list`, `task_create` (sub-tasks, follow-ups), `task_update`, `task_brief_edit` (a section, a reason, replace or append), `task_note`, `task_relate`, `task_attach_proof`.
  - Claude is told to record decisions as it makes them, tick acceptance criteria, split off work as sub-tasks, attach proof, and rewrite the notes for the next agent before ending a turn that changed things. It doesn't mark tasks Done itself: the pull request does.
  - Runs elsewhere get the tools and a short note that the board is there. Friends' runs, guests and main folders (questions only) get neither. The tools only touch your own board, so they never ask; files holding secrets are refused as proof.

### Sharing with friends — phase 3

- **A board belongs to a project.** It's shared with whoever can see that project (project invites), or with a Channel (a network group).
- **How changes travel:** board ops ride inside encrypted group messages as a new `extras.board` field. That's option B in the network map: ordering, E2E encryption, offline catch-up and membership come for free, and older Macs show the short text note that goes with each op.
- **How copies agree:** every field is last-writer-wins, ordered by Lamport time and then the author's id. Activity and comments only ever get added to, so every Mac ends up with the same board.
- **Assigning:** phase 2 already lets you give a task to a friend or their Claude (people from the room and your friends), but it stays on your Mac. In phase 3:
  - a friend's task appears in their *My Tasks* with a notification;
  - giving it to *a friend's Claude* sends an `ask_person` with the task's brief. Their usual approval pop-up and trust rules apply, and the result comes back as proof and a note on the task.
- **What friends see:** shared tasks, briefs and proof. Proof files travel Mac to Mac like chat files, and secrets are never attached.

### The window (`packages/mac/src/tasks/`)

- **Tasks** in the sidebar (how many are yours, or in review), and ⌘K › New Task… / Go to Tasks.
- **The bar:** My Tasks · Active · Backlog · All (each with its count), a project pop-up, a filter (⌘F), List · Board · What Waits on What, ⋯, and **New Task** (⌘N, or C).
- **List:** grouped by status (groups fold; + adds a task there). A row's priority, status and assignee are menus of their own (1–9 pick); the rest of the row opens the task. ↑↓ and Return; right-click for Open, Start with Claude, Status ▸, Priority ▸, Add Sub-task…, Copy Key, Delete Task….
- **Board:** a column per status; drag a card to another column or up and down (a line shows where it lands).
- **What Waits on What:** the tasks tied to others as a graph (the graph engine): a task with sub-tasks is a box around them, blockers point at what they hold up, in the problem color until they're done. Double-click, or Open Task in its details, opens it.
- **A task's page:** the title (renamed in place), the next step (Start with Claude / Start Worktree, or Open Worktree with its pull request), the brief, sub-tasks (add inline), Blocked by / Blocks / Related, proof (pictures open full size, graphs are drawn, links and files open), and the activity with a comment box (⌘↩). Its properties are down the right, each a menu.
- **New Task:** title, goal, project, status, priority, assignee, labels; **Start with Claude** makes the worktree and puts Claude on it at once.
- **Above a worktree's chat:** the task it's doing (status, key, title, criteria ticked), one click from its page.

---

## 3. Plans and the head Claude — phases 3–5

### Plans (`src/core/plans/`)

- **A plan** is a goal broken into milestones, each with phases, each with tasks.
- **Dependencies:** milestones depend on milestones and tasks block tasks.
- **Phases:**
  - A **build** phase's tasks run in parallel unless one blocks another.
  - A **review** phase is a gate. It passes when a person approves, a reviewer Claude passes it with its notes, CI is green, or all three.

**Planning with Claude:**
1. In the **New Plan** sheet you set the goal, the projects, how much autonomy, and a **planning style**.
2. A planning style is your own instructions for how plans should be cut: task size, when to add review gates, testing expectations. You keep them in `~/.klaud/prompts/planning/*.md`, and a project can add its own in `klaud.json` `planning`.
3. Claude plans in Plan mode, reading the code. It returns a `klaud-plan` block, which zod validates.
4. The plan opens as a graph you can edit: drag to add or remove blockers, split or merge tasks, move tasks between phases. An outline view sits beside it, and every task has its brief written.
5. **Approve** turns the plan into tasks, a milestone at a time or all at once.

**Autonomy**, set per milestone and changeable at any time:

| Level | What the head Claude does |
|---|---|
| **Step** | proposes each start; you click Start |
| **Gated** (default) | starts whatever is ready inside a phase by itself and waits for you at review gates and at the end of each milestone |
| **Autopilot** | runs through; stops only when something fails or a question needs you |

### The head Claude (orchestrator)

**Where it runs:** in the plan's own conversation (`plan:<id>`), with per-run tools:
- `plan_status`: the ready set, computed by a deterministic scheduler in the core from the graph, the gates and the autonomy setting
- `start_task`: starts a worktree with the task's brief, via `controller.startWorktree`
- `message_task` / `wait_tasks` / `check_task` / `stop_task`: non-blocking, modelled on the gateway's ask, wait and check
- `request_review`: a reviewer Claude in its own read-only run, or a person
- `pass_gate` / `fail_gate`: only at Autopilot, or with your approval
- `update_plan`: re-plan with a reason, shown as a diff of the graph

**Limits and safety:**
- The scheduler, not Claude, enforces concurrency (a setting; `MAX_PARALLEL_RUNS` becomes configurable) and gates. Claude can't start a blocked task.
- Every start, gate and re-plan goes into the plan's activity. You can pause the whole plan at any time.

**In the window:**
- The live plan graph: running tasks pulse, done ones tick, a gate waiting for you is the one thing in accent color.
- A lane per running worktree, showing its Claude's current step (from `SubAgentTracker` / `live-run`).
- An approvals tray.

### Milestone recaps (phase 5)

When a milestone ends, the head Claude writes a recap:
- what changed and why
- a **graph** of the architecture or flow that changed
- **proof**: screenshots of web pages (via Playwright, into the worktree's scratch folder), test results, PR links and diff stats
- what's next

The recap opens as a page, with a **walkthrough** that steps through the graph. Approving the recap passes the milestone's gate.

---

## Phases

| # | What | Depends on |
|---|---|---|
| 1 ✓ | Graph engine: `klaud-graph` in chat and docs, `/visualize`, prompt, demo | — |
| 2 ✓ | Tasks: slice, saving, `board.*` API, Tasks view (list, board, graph, task page), a task per worktree, status from pull requests, Claude's task tools, brief revisions | 1 (the dependency graph) |
| 3 | Sharing: board ops over groups, assign to friends and friends' Claudes, My Tasks | 2 |
| 4 | Plans: planning styles, planner, `klaud-plan`, editable plan graph, approve → tasks | 1, 2 |
| 5 | Head Claude: scheduler, orchestrator tools, autonomy, review gates, live plan view, milestone recaps with proof | 4 |

Each phase is its own PR with tests (core contract tests, Mac model tests, an e2e spec and screenshots in light and dark).
