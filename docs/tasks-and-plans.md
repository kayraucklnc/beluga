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
| `activity` | an append-only feed: who changed what, comments, Claude's notes, pull request events (the last 200). One field changed again by the same person within two minutes is one line ("estimated this at 5 points", from where it started; back where it was, no line) |
| `plan` | the plan, milestone and plan task it came from |

**The brief** is what later agents rely on. It's Markdown in fixed sections: **Goal**, **Context**, **Acceptance criteria** (checkboxes you tick on the page), **Decisions** (what was decided and why), **Open questions** and **Notes for the next agent**. Each edit is a revision with its author (a person or a Claude) and a one-line reason. A section's history shows every version; **Restore This** puts one back (as a new revision).

### Worktree ↔ task (automatic)

- **Tasks come from plans, not from every worktree.** A question or a quick ask is not a task.
  - **Plan First** (Claude Code's plan mode): before Claude asks you to approve its plan, it calls `task_define` with the task the plan is for — a title, the goal *in its own words* (never your message pasted in), context, acceptance criteria, decisions, open questions, an estimate and a priority. It goes on the board only when you approve the plan (`planTask` in `agent/runner.ts`); a plan Claude asks you to approve without one goes back to it once. Approved in a main folder's chat, the task waits and the worktree the conversation continues in does it.
  - **Plan with Tasks** (Plans, below): every task of an approved plan.
  - A fork stays on the same task, as does a worktree started *from* a task (Start Worktree).
  - Tasks › ⋯ › Open a Task for Every New Worktree brings back a task per worktree (off by default; saved as `worktreeTasks`). Its brief is Claude's to write.
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

- **One project at a time.** Tasks from different projects never share a screen. Tasks opens on the project you're in (the worktree, project home or task you came from; else the last one; else the busiest), and a switcher at its top (the project's icon and name) changes it. Claude's `task_list` stays in its run's project too, unless it names another.
- **Tasks** in the sidebar, and ⌘K › New Task… / Go to Tasks.
- **The bar:** the project switcher, Active · Backlog · All (each with its count), **whose tasks** (Everyone, You, Your Claude, each person and their Claude, No one yet), a filter (⌘F), List · Board · What Waits on What, ⋯, and **New Task** (⌘N, or C).
- **Alone, no assignees.** On a project where you work alone (nobody else in the room, no friends, nothing assigned to anyone else), who a task is for isn't shown anywhere: not in rows, cards, a task's page or the New Task sheet. Every task is yours and your Claude's; Start with Claude is how it gets worked on.
- **List:** grouped by status (groups fold; + adds a task there). A row's priority, status and assignee are menus of their own (1–9 pick); the rest of the row opens the task. ↑↓ and Return; right-click for Open, Start with Claude, Status ▸, Priority ▸, Add Sub-task…, Copy Key, Delete Task….
- **Board:** a column per status; drag a card to another column or up and down (a line shows where it lands).
- **What Waits on What:** the tasks tied to others as a graph (the graph engine): a task with sub-tasks is a box around them, blockers point at what they hold up, in the problem color until they're done. Double-click, or Open Task in its details, opens it.
- **A task's page:** the title (renamed in place), the next step (Start with Claude / Start Worktree, or Open Worktree with its pull request), the brief, sub-tasks (add inline), Blocked by / Blocks / Related, proof (pictures open full size, graphs are drawn, links and files open), and the activity with a comment box (⌘↩). Its properties are down the right, each a menu.
- **New Task:** title, goal, project, status, priority, assignee, labels; **Start with Claude** makes the worktree and puts Claude on it at once.
- **Above a worktree's chat:** the task it's doing (status, key, title, criteria ticked), one click from its page.

---

## 3. Plans and the head Claude — phase 4 and 5, shipped

### The model (`src/core/plans/`, browser-safe slice `plans`)

- **A plan** is a goal cut into **milestones**, which run side by side unless one builds on another: a milestone's `depends_on` (earlier milestone ids) says what it waits on, and when it's left out it's inferred from its tasks' blockers in other milestones (none: it runs from the start). Each milestone has a goal, **pass criteria** (checkable statements) and **tasks**. A task has a stable id Claude picks (`auth-api`), a goal, context, acceptance criteria, an estimate, `touches` (the files it changes, so parallel tasks keep apart), **blockers** (tasks of the same or an earlier milestone whose code it builds on — never a later one, never a loop) and sub-tasks. A task is Claude's unless it's marked as yours (accounts, secrets, decisions).
- **Draft and approved.** A plan keeps a `draft` (Claude's and your working copy) and a `body` (what was approved). The draft lives with the plan in `~/.klaud/plans.json`, *never on the board*. **Approve** puts it there (`apply.ts`): new tasks are made with their sub-tasks and blockers wired up, changed ones rewritten (ticked criteria stay ticked), and tasks taken out are canceled. The milestone being worked on is Todo; later ones wait in the Backlog. Discarding a never-approved draft deletes the plan; the board never knew.
- **Changing an approved plan** makes a new draft: the page shows "Claude proposes changes: 2 new · 1 changed · 1 taken out" with Apply / Discard. Your own edits apply at once (you're the approver). On **Autopilot**, the head Claude's changes apply at once too.
- **Your planning style** (`~/.klaud/planning.md`, Plans › ⋯ › Planning Style…) is added to Claude's planning instructions every time.

### Planning with Claude

- **New Plan** (Plans, ⌘K): a goal, the project, how it runs. It opens a conversation of its own in the project's main folder (Claude only reads there) and the plan's page. Claude reads the code and writes the plan with its tools (`klaud_plan`: `plan_get`, `plan_write`, `plan_update`); the graph fills in as it writes, and you talk it through in the conversation beside it.
- **Plan with Tasks** in any conversation in a project (the composer's mode menu, or ⇧⇥: Act → Plan First → Plan with Tasks): that conversation becomes the plan's home. A strip above it shows the plan and its next step.
- A plan task can adopt a task already on the board (`issue: "BOB-12"`).

### Running it (`pilot.ts`, `progress.ts`)

`planView` works out, from the plan, the board and what each worktree's Claude is doing right now, every task's state (later · waiting · ready · Claude working · needs you · in progress · in review · done), each milestone's (up next · in progress · Claude is checking · ready to pass · check failed · passed) and **the one thing the plan waits for** (the page's main button). Every milestone whose dependencies have passed is open at once, each with its own check and pass; *Run at Once* counts tasks across the whole plan, and autonomy applies per milestone. The pilot acts on it a moment after anything changes:

| Autonomy | What happens |
|---|---|
| **Step by Step** | ready tasks line up with a Start button; nothing starts by itself |
| **Gated** (default) | ready tasks start by themselves (up to *Run at Once*, 3 by default); each milestone waits for you to pass it |
| **Autopilot** | milestone to milestone: a passing check moves on by itself; a failed one stops there, and the head Claude adds fix tasks (applied at once) |

- **Starting** a task makes its worktree quietly (it doesn't take you there) with Claude on it. A task that builds on one still in review starts from that one's branch. One that builds on several starts from them combined: `klaud/<key>-base`, the first one's branch with the others merged in (`--no-ff`), made in a hidden worktree (`~/.klaud/workspaces/.bases/`, never listed) and removed once it's made. A branch already in another one, or already in main, isn't merged again. Meanwhile the task shows *Combining KLD-9 and KLD-27 …*. A conflict goes to the head Claude, which may edit only that hidden worktree while the conflict is open. Once no markers are left, klaud commits the merge, finishes combining and starts the task. If two fix-ups don't do it, the task waits for you and says where the conflict is. klaud looks again every 30 seconds (or when you press Start), and the task starts once the conflict is fixed. A task already being worked on in a worktree is never started again (`BoardWork.start` refuses).
- **Finished** means In Review or Done. The task's Claude is told to commit, rewrite the handoff and move its task to In Review when every acceptance criterion holds. On Autopilot, a task whose Claude stopped without finishing is nudged once.
- **Gates:** when a milestone's tasks are finished, the head Claude is asked to check its pass criteria for real (briefs, handoffs, proof, diffs) and records `plan_gate` pass or fail with notes per criterion. Pass Milestone / Not Yet… are yours (Not Yet sends what's missing to the head Claude, which adds the tasks). When the last milestone passes, the head Claude writes a recap.
- **Parallel Claudes know about each other.** Every run doing a task gets what else in the project is being worked on right now (which task, which worktree, whether its Claude is working); `task_get` says where a task is being worked on. A plan task's worktree also gets its plan, milestone, pass criteria and the tasks running beside it (with their `touches`). The head Claude is warned when tasks running side by side touch the same files, and can message a task's Claude (`plan_message_task`).
- Pause stops starts; the scheduler, not Claude, enforces limits, blockers and gates.

### In the window (`packages/mac/src/plans/`)

- **Plans** in the sidebar (under Tasks): one project's plans with a milestone progress bar, their status and what they wait for.
- **A plan's page:** the name (renamed in place), its status, Step by Step · Gated · Autopilot, ⋯ (Pause, Run at Once ▸, Copy as Markdown, Planning Style…, Discard, Delete), and one main button for what it waits for (Approve Plan, Apply Changes, Start, Pass Milestone, Not Yet…).
  - **Graph:** milestones as lanes, top to bottom; tasks inside left to right by what waits on what (what can start at once lines up on the left); a gate at the end of each lane that opens the next. Tasks Claude is working on have a copper light going round them and say what Claude is doing; finished ones tick; a gate waiting for you is the one thing in the accent. The layout depends only on the plan's shape, so work moving on never moves anything; a re-cut plan glides to its new shape. Blockers from an earlier milestone show for the task you pick.
  - **Outline:** the same, milestone by milestone, with names changed in place and a task's ⋯ (Start, Move to ▸, I'll Do It Myself, Take Out of the Plan).
  - Picking a task or gate opens its details (goal, done when, waits on, the files it changes, Claude's check).
  - **The conversation** with the plan's Claude docks on the right.

### Kanban drag

The board's cards are picked up with the pointer (`TaskBoard.tsx`, pure parts in `board-drag.ts`): the card lifts and leans with the way you move it, the cards where it would land slide apart (motion layout springs), and it settles into place on release. Esc puts it back; the board scrolls near its edges; ⌥←/→ and ⌥↑/↓ move a focused card.

### Milestone recaps (next)

Today the head Claude writes a recap in the plan's conversation when the plan is done. Next, a recap per milestone, as a page:
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
| 4 ✓ | Plans: planning style, Claude's plan tools, drafts off the board, plan graph and outline, approve → tasks | 1, 2 |
| 5 ✓ (recaps in words) | Head Claude: scheduler, orchestrator tools, autonomy, gates checked by Claude, live plan view, a recap when it's done | 4 |

Each phase is its own PR with tests (core contract tests, Mac model tests, an e2e spec and screenshots in light and dark).
