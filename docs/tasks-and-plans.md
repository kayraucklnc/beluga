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

## 2. Tasks — phase 2

### The model (`src/core/board/`, browser-safe slice `board`)

The gateway already uses the word "tasks" in code, so this feature's code says **board** and **issue**. The window says **Tasks**.

| Field | Notes |
|---|---|
| `key` | `KLD-42`: a per-project prefix (settable) and a counter |
| `title`, `status` | Backlog · Todo · In Progress · In Review · Done · Canceled (the board's columns) |
| `priority`, `labels`, `estimate`, `due` | Linear's set |
| `assignee` | you, a friend (peer id), **your Claude**, or **a friend's Claude** |
| `parent`, `children` | sub-tasks |
| `relations` | `blocks` / `blockedBy` / `relatedTo` / `duplicateOf` |
| `links` | worktree id, branch, PR (number, url, checks, review), conversations, files |
| `brief` | the living definition (below), with revisions |
| `proof` | screenshots, URLs, graphs, test output, attached by people or agents |
| `activity` | an append-only feed: status changes, comments, agent notes, PR events |

**The brief** is what later agents rely on. It's Markdown with fixed sections: **Goal**, **Context**, **Acceptance criteria** (checkboxes), **Decisions** (dated: what was decided and why), **Open questions** and **Notes for the next agent**. Each edit is a revision with its author (a person or a Claude) and a one-line reason. You can see the diff between revisions and restore an old one.

### Worktree ↔ task (automatic)

- **A worktree opens a task.** The `onWorktreeCreated` hook (`core/session-parts.ts`) creates a task for every new worktree. The first message becomes the brief's Goal, and the small model's name becomes the title. A worktree started *from* a task links to that task instead. `WorkspaceRecord.taskId` holds the link.
- **The task follows the work:**

  | When | Status |
  |---|---|
  | The worktree is created | In Progress |
  | A PR opens (`refreshPrs`) | In Review |
  | Changes are requested | back to In Progress, with a note |
  | The PR merges or the worktree merges into main | Done |
  | Archived without a merge | you're asked: Canceled, or back to Backlog |

- **Claude knows its task.** Each run in a linked worktree gets a system-prompt append with the task's brief, its blockers, its parent and its milestone. The task tools are built for each run (a closure over the channel, like `continueInWorktree`), never from the global `currentChannel`.
  - Reading is always allowed (`ALWAYS_OK`): `task_get`, `task_list`, `task_search`.
  - Writing your own tasks: `task_update`, `task_brief_edit` (a section and a reason), `task_note`, `task_create` (a sub-task or a follow-up), `task_attach_proof`.
  - Claude is told to keep the brief true: record decisions as they're made, and leave Notes for the next agent before ending its turn.

### Sharing with friends

- **A board belongs to a project.** It's shared with whoever can see that project (project invites), or with a Channel (a network group).
- **How changes travel:** board ops ride inside encrypted group messages as a new `extras.board` field. That's option B in the network map: ordering, E2E encryption, offline catch-up and membership come for free, and older Macs show the short text note that goes with each op.
- **How copies agree:** every field is last-writer-wins, ordered by Lamport time and then the author's id. Activity and comments only ever get added to, so every Mac ends up with the same board.
- **Assigning:**
  - Give a task to a friend and it appears in their *My Tasks* with a notification.
  - Give it to *a friend's Claude* and klaud sends an `ask_person` with the task's brief. Their usual approval pop-up and trust rules apply, and the result comes back as proof and a note on the task.
- **What friends see:** shared tasks, briefs and proof. Proof files travel Mac to Mac like chat files, and secrets are never attached.

### The window

- **Tasks** in the sidebar, with *My Tasks*, *Active*, *Backlog* and one entry per project.
- **List** (grouped by status, ⌘-click to select many) and **Board** (columns, drag between them). **Graph** draws the dependency graph with the graph engine.
- **The task page:** title and properties along the top (popovers, never typed commands), the brief with its sections, sub-tasks, relations, linked PR (checks and review), proof (a gallery), and activity. **Start Worktree** / **Open Worktree** is the main button.
- **Shortcuts:** ⌘K palette entries, C new task, ⌘↩ to save. Everything is also clickable.

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
| 1 | Graph engine: `klaud-graph` in chat and docs, `/visualize`, prompt, demo | — |
| 2 | Tasks core: slice, saving, `board.*` API, Tasks view (list, board, task page), task per worktree, PR-driven status, agent task tools, brief revisions | 1 (dependency graph) |
| 3 | Sharing: board ops over groups, assign to friends and friends' Claudes, My Tasks | 2 |
| 4 | Plans: planning styles, planner, `klaud-plan`, editable plan graph, approve → tasks | 1, 2 |
| 5 | Head Claude: scheduler, orchestrator tools, autonomy, review gates, live plan view, milestone recaps with proof | 4 |

Each phase is its own PR with tests (core contract tests, Mac model tests, an e2e spec and screenshots in light and dark).
