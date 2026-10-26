# Tasks, Plans and Graphs (Mac app) — design

Three features that build on each other:

1. **Graphs.** Claude draws interactive diagrams (React Flow) in any conversation, document or recap.
2. **Tasks.** A Linear-quality board shared with friends. Every worktree is a task, every task knows its PR, and agents read and improve each task's brief while they work.
3. **Plans.** Milestones → phases → tasks, with blockers, parallel lanes and review gates. You plan with Claude using your own planning instructions. A head Claude then runs the plan: it starts worktrees in parallel and stops for you wherever you ask it to.

Graphs ship first because the other two use them: plans are drawn as graphs, and milestone recaps explain what happened with graphs and proof.

The core holds the state and the agent tools; the Mac app shows them (see [parity.md](parity.md) › "Beyond the shared actions").

---

## 1. Graphs (`beluga-graph`) — phase 1, shipped first

Claude writes a fenced block of JSON and the window draws it. No code runs, so a graph is only data:

````
```beluga-graph
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

The gateway already uses the word "tasks" in code, so this feature's code says **board** and **issue**. The window says **Tasks**. Everything lives in `~/.beluga/board.json` (only you can read it), written a moment after each change.

| Field | Notes |
|---|---|
| `key` | `BOB-12`: a per-project prefix (from the project's name, changeable with `board.setPrefix`) and a counter |
| `title`, `status` | Backlog · Ready · In Progress · In Review · Done · Canceled (the board's columns) |
| `priority`, `labels`, `estimate`, `due` | Linear's set (estimates 1, 2, 3, 5, 8) |
| `assignee` | you, a friend (peer id), **your Claude**, or **a friend's Claude** |
| `parent` | sub-tasks; a task can't sit under itself or its own sub-tasks |
| `blockedBy`, `related` | what must be done first (its other side is "blocks"; a loop is refused), and related tasks |
| `worktrees`, `branch`, `pr` | the worktrees doing it (the current one last), its branch, and its pull request as the workbench last saw it |
| `brief` | the living definition (below), with revisions |
| `proof` | screenshots, pages, files, graphs and results, attached by people or Claude |
| `activity` | an append-only feed: who changed what, comments, Claude's notes, pull request events (the last 200). One field changed again by the same person within two minutes is one line ("estimated this at 5 points", from where it started; back where it was, no line) |
| `plan` | the plan, milestone and plan task it came from |

**The brief** is what later agents rely on. It's Markdown in fixed sections: **Goal**, **Context**, **Acceptance criteria** (checkboxes you tick on the page; one that can't be true yet carries its reason on its line, `- [ ] … — deferred: why` or `— not done: why`, and shows as Deferred or Not done), **Decisions** (what was decided and why), **Open questions** and **Notes for the next agent**. Each edit is a revision with its author (a person or a Claude) and a one-line reason. A section's history shows every version; **Restore This** puts one back (as a new revision).

### Worktree ↔ task (automatic)

- **Tasks come from plans, not from every worktree.** A question or a quick ask is not a task.
  - **Plan First** (Claude Code's plan mode): before Claude asks you to approve its plan, it calls `task_define` with the task the plan is for — a title, the goal *in its own words* (never your message pasted in), context, acceptance criteria, decisions, open questions, an estimate and a priority. It goes on the board only when you approve the plan (`planTask` in `agent/runner.ts`); a plan Claude asks you to approve without one goes back to it once. Approved in a main folder's chat, the task waits and the worktree the conversation continues in does it.
  - **Plan with Tasks** (Plans, below): every task of an approved plan.
  - A fork stays on the same task, as does a worktree started *from* a task (Start).
  - Tasks › ⋯ › Open a Task for Every New Worktree brings back a task per worktree (off by default; saved as `worktreeTasks`). Its brief is Claude's to write.
- **The task follows the work:**

  | When | Status |
  |---|---|
  | The worktree is created | In Progress |
  | A pull request opens (not a draft) | In Review |
  | Changes are requested | back to In Progress, with a note |
  | The pull request merges, or the worktree merges into main here | Done |
  | Archived or deleted before it was done | a banner asks: Cancel Task, Back to Backlog, or Keep As Is |
  | Its parent reaches Done | Done (every open sub-task, all the way down; Canceled ones stay) |

- **Work carried by another worktree** (BLG-29). When Claude moves a task to In Progress or In Review from a worktree that isn't doing it (the sub-tasks of a list of asks, done in one worktree), that worktree *carries* it (`carriedBy`, and its branch). The carrying worktree's pull request and merge move the task like its own. Tasks whose worktree went before their PR merged aren't watched by the workbench any more: `BoardWork.sweepShipped` asks gh about their branch soon after start and every ten minutes, and a merged PR makes them Done.
- **The Archive** (BLG-27, BLG-28). Archive Done (the button on Done, in the list and on the board, or Tasks › ⋯) moves every Done task to the Archive (`archivedAt`); a finished task's ⋯ › Archive moves one, with its finished sub-tasks. Archived tasks leave the board and Claude's `task_list` but keep their brief and history: Tasks › Archive lists them, a task's banner restores it, and Empty Archive (or Delete for Good) deletes them. Archiving lets go of their proof files in `~/.beluga/proof`: a screenshot becomes a 480 px JPEG (`thumb`, a few KB), any other file goes (`gone`); both keep how big they were (`bytes`). Files outside `~/.beluga/proof` are never touched.

- **Claude knows its task.** Your own runs in a task's worktree get its brief, parent, blockers and sub-tasks in their instructions (`core/board/prompt.ts`), and the task tools (server `beluga_board`), built for each run from its conversation:
  - `task_get`, `task_list`, `task_create` (sub-tasks, follow-ups), `task_update`, `task_brief_edit` (a section, a reason, replace or append), `task_note`, `task_relate`, `task_attach_proof`.
  - Claude is told to record decisions as it makes them, tick acceptance criteria, split off work as sub-tasks, attach proof, and rewrite the notes for the next agent before ending a turn that changed things. It doesn't mark tasks Done itself unless you ask or say the work shipped: the pull request does.
  - Every run hears how the board works, and to open tasks unasked when one message asks for two or more separate things (one per thing, under a parent when they belong together), move them along as it works, and show them in its answer as `task:KEY` chips or a `beluga-tasks` block. Not for questions or a single quick ask, and what you ask for instead wins (BLG-25).
  - Runs elsewhere get the tools and a short note that the board is there. Friends' runs, guests and main folders (questions only) get neither. The tools only touch your own board, so they never ask; files holding secrets are refused as proof.

### Sync with Linear (BLG-74)

A project's board can be linked to one Linear team, and kept in step both ways (`src/core/board/sync/`).

- **Connecting:** Tasks › ⋯ › Sync with Linear…. Paste a personal API key (`lin_api_…`), Check Key lists the workspace's teams, pick one, and choose **Autosync** (on by default) and **Also send this project's open tasks** (off: only tasks made from now on go to Linear). The key is kept in `~/.beluga/task-sync.json` (0600) and never reaches a screen or the phone. Screens get `board.sync[projectId]`: the team, autosync, when it last synced, how many tasks are linked, and what went wrong.
- **What comes over:** on the first sync, the team's open issues and those closed in the last two weeks. After that, everything changed since the last look. Each becomes a task (`origin: 'sync'`, "Linear brought this task over") linked to its issue (`issue.link`: the id, `ENG-12` and its URL).
- **What goes out:** tasks made in the project since connecting (and its open ones from before, when asked), parents first. Drafts wait until Claude has written them, and archived tasks stay here.
- **Kept in step:** title, status, priority, labels, estimate, due date, parent, and the brief as the description. The description is the goal first, then each other section under its heading (`## Acceptance criteria`). Reading one back, text under a known heading goes to that section and everything else to the goal.
  - **Status:** Backlog/Triage ↔ Backlog, Unstarted ↔ Ready, Started ↔ In Progress (a started state named "…Review…" ↔ In Review; Merged into Plan goes as In Review), Completed ↔ Done, Canceled ↔ Canceled.
  - **Priority:** Linear's 0–4.
  - **Labels:** matched by name, any case; missing ones are made as team labels.
  - **Estimates:** only sent when the team uses them.
- **Who wins:** each link keeps a fingerprint of every field on both sides as they last agreed (`link.local`, `link.remote`). A field only one side changed goes to the other. When both sides changed it, the newer change wins. A side whose value can't say what the other's does (Merged into Plan) doesn't bounce back. Changes from Linear show in the activity as by **Linear**, and brief edits keep their revisions, so Restore This brings back what Linear overwrote.
- **Autosync:** Linear can't call a Mac back, so Beluga asks every minute (`AUTO_MS`), soon after starting, and a few seconds after a change here to a linked or sendable task (`SOON_MS`). A key Linear turns down stops autosync until you connect a new one (the bar's Linear pill says so). Sync Now is in ⋯ and the sheet.
- **Disconnecting** forgets the key and unlinks the tasks. Nothing in Linear changes. Connecting another team unlinks the old team's tasks first.
- **Other trackers:** `sync/provider.ts` is the seam: teams, changed-since, create, update, in the board's terms. GitHub Issues is BLG-75.
- Claude sees a task's Linear key and URL in its brief (`prompt.ts`). `BELUGA_LINEAR_API` points the daemon at a fake Linear for testing.

### GitHub issues (BLG-163)

A project's GitHub issues, read in Beluga and handed to Claude (`src/core/issues/`, the Mac's `src/issues/`). This isn't sync (that's BLG-75): nothing in GitHub changes unless you post a comment. Every way of working on an issue goes through **a task**, so the work shows on the board, its worktree and conversation are the usual ones, and its pull request moves it along.

- **Reading:** through gh, signed in as you (`src/core/issues/gh.ts`): GraphQL for a project's open or closed issues, newest activity first (REST's list counts pull requests against the page), GitHub's search when you search (`is:issue`), REST for one issue and its comments. gh is only asked about github.com and hosts it's signed in to. Not on GitHub, gh missing or signed out, and GitHub saying no each come back as their own state (`IssuesList`), in Beluga's words (`ghWords`). Lists are kept a minute (Refresh asks again).
- **Where:** **Issues** in the sidebar under Tasks (one project at a time, the one you're in; Open · Closed; search; ⌘K › Go to Issues), the latest four on a project's home, and an issue's page (`gh_issue`): the report and its comments, and what to do next.
- **What to do next**, until Claude is on it, is a composer like a project's home (`IssueComposer`): Investigate · Fix It · Make a Task, a box for anything Claude should know (it goes after Claude's instructions in your words, and shows in the conversation), one line saying what happens, and one button (↩):
  - **Investigate:** a task for the issue (`origin: 'github'`, `issue.github`: the repo, number and URL), a worktree for it (quietly: you stay on the issue), and your Claude told to find out what happens and why, reproduce it (a failing test if it can), write what it found into the task's brief (context and criteria) and stop before fixing (`investigatePrompt`). The page shows Claude at work, then its report (what happens, why, how to reproduce, how to fix, a verdict) with **Fix It**.
  - **Fix It:** after an investigation, in the same worktree and conversation (`fixAfterInvestigationPrompt`); otherwise in a new one (`fixPrompt`). Claude opens the pull request with your PR instructions (`buildPrPrompt`, beluga.json's `prPrompt` too) and "Fixes #n", so merging it closes the issue on GitHub and makes the task Done. Fix It is also on the task's page and the strip above its conversation once Claude has investigated.
  - **Make a Task:** on the board as Ready, written by your Claude from the issue (the drafter), or, with **Look at the code first** ticked, after a quick look: the drafter reads the main folder first with Read, Grep and Glob only (a PreToolUse hook refuses anything else, outside the folder, or a secret: `lookVerdict`), and adds context (where the code is, the likely cause). The task shows "Claude is writing…" meanwhile.
- **One task per issue:** asking again works on the one there is (a done or canceled one is reopened first, on its page). `taskForGitHub` finds it.
- **What it's at** (`issueStage`, from the task): new, on the board, investigating, investigated, fixing (or stopped before a pull request, with what Claude said), its pull request open, done. Rows in Issues and on the project's home show it as a pill.
- **The conversation shows a short line** ("Investigate #48 …: find out why it happens and reproduce it, without fixing it yet"): Claude gets the issue quoted as material (`<github_issue>`, never instructions, GitHub names never "@name": in Beluga that's a friend), with the steps (`askOwnClaude`'s `echo` as a string).
- **A task from an issue** links back to it: a GitHub row on its page, `◉ #48` on its rows and its strip, and Claude's start prompt and `task_get` name the issue, how to read its comments (`gh issue view`), and that its pull request says "Fixes #n".
- **Posting what Claude found:** an issue's ⋯ › Post the Findings on GitHub… (asks first, shows what goes) comments as you.
- **The demo** has a pretend GitHub (acme/bob-api, acme/landing) and a demo Claude that investigates and fixes #48.

### Sharing with friends — phase 3: team boards (BLG-220, shipped)

Two friends who each have the same GitHub repository as a project on their own Mac work on it as a team, **without sharing the project**. Code: `src/core/team/` (the daemon runs it with the board, whenever the network is on), the Mac app's `src/team/`. Features: `team.board`, `team.plans` (a friend on an older Beluga is told "Ata's Beluga 1.2.0 can't open team boards yet. Ask Ata to update Beluga.").

- **Finding each other** (`fingerprint.ts`, `service.ts`). On every link to a friend, each Mac sends the fingerprints of its GitHub projects: HMAC-SHA-256 of `host/owner/repo` (lowercased, from the origin remote), keyed by SHA-256 of both peer ids, cut to 128 bits. A friend who has the repository computes the same fingerprint. One who doesn't sees a string they can't turn back into a name (they could only check a name they guess). A match is an offer on both Macs, "Ata also works on acme/api": a strip on the project's home and atop its Tasks (Team Up; ••• › Not Now), a notification, and a card on the phone. Team Up sends an invite. The team forms only when the other side says yes too (two yeses crossing settle on the smaller link id). Not Now and Leave Team hide the offer until either asks again.
- **A team** is the set of pairwise links for one project (`~/.beluga/teams.json`): the team badge (teammates' avatars) on the project's row, and ••• › Leave Team. Three friends on one repository are three links. A change reaches everyone even if two of them aren't friends, because each Mac passes on what the others haven't seen.
- **How changes travel.** Over friends' links in a `team` frame, through friend-share's acked courier (`Courier<M>`, its own `team-outbox.json`: resent every 20 s while linked, at once on link-up, for 7 days). This is not option B's hidden group. The courier was already tested and needs no new group plumbing, nothing shows up in channel lists, and team membership is the links themselves.
- **How copies agree** (`crdt.ts`, `board-sync.ts`). Each task field is last-writer-wins by (Lamport time, author peer id), with the brief as one field per section. Activity and comments only get added, by id; a line its author folded into the next is dropped for everyone. A delete is a field too. Every change to a teamed project's task is caught as it reaches the shared state (you, Claude's task tools, a plan, a pull request), so nothing needs to call sync. What arrives is written to the board quietly, and brief sections keep their revisions ("from a teammate"), so Restore This works. Changes made while the network was off go out when it starts again. On every link-up both sides swap a digest of the field clocks, and a different one is answered with a snapshot in batches. Kept in `~/.beluga/team-board.json`.
- **Keys never clash.** A task has one id on every Mac. Each Mac gives it a key from its own project ("API-40" there may be "BLG-12" here). Teaming up shares the board as it is (archived tasks stay yours).
- **What never travels:** worktrees, branches, pull requests, proof files, ranks, the Archive, run details, and activity about worktrees, plans or proof. Teammates see "Ata is working on this" (`working.<peerId>`, true while one of Ata's worktrees does the task), on the task's page, its row and the phone.
- **Assigning** (`assign.ts`). Give a task to a teammate and it's in their My Tasks, with a notification and an inbox entry ("Ata gave you this task", Got It; a card on the phone) until they've seen it. Give it to **a teammate's Claude** and the Mac where you assigned it sends a request to their Claude (the gateway's `ask`, as you, in their project) with the task's brief. Their trust, rules and approval card apply. The result lands on the task as proof (the summary, the files) and a note from their Claude, and the note reaches the whole team. A teammate whose Beluga isn't taking requests gets a note on the task saying so.
- **Issues.** Which GitHub issue became which team task travels with the board (`github`: the issue and the step), so an issue's row says "Ata is investigating #48" with Ata's avatar. Investigate or Fix It on an issue a teammate is on asks first (Start Anyway; the API's `anyway`).
- **Plans** (`plan-share.ts`). A plan stays yours until its ••• › Share Plan with Team. Teammates then see its draft (or what was approved) read-only, in Plans under "Shared by your team": milestones, criteria and tasks. There they Approve (the main action), comment, or Suggest a Change… on a task (the plan's own edit ops). You're notified. Team Reviews on the plan's page lists what they said, with Apply (one click, as your edit; Set Aside under •••). Every change to the plan reaches them as it happens, and Stop Sharing takes it back. On the phone: approving a shared draft (or commenting) and applying or setting aside a suggestion are cards.
- **Chats stay private.** Teaming up never shares a conversation or a worktree. A team project's conversation has ••• › Share with Team ▸ (a teammate, or Everyone on the Team), which shares that one worktree live (`sharing.shareWithFriend`), and Stop Sharing. Its header shows who can see it (their avatars), or a lock when only you can.
- **Limits:** a teammate can claim any author in what it sends (teammates are trusted friends). Proof files don't travel. The fingerprint can't stop a friend from confirming a guessed repository name.

### The window (`packages/mac/src/tasks/`)

- **One project at a time.** Tasks from different projects never share a screen. Tasks opens on the project you're in (the worktree, project home or task you came from; else the last one; else the busiest), and a switcher at its top (the project's icon and name) changes it. Claude's `task_list` stays in its run's project too, unless it names another.
- **Tasks** in the sidebar, and ⌘K › New Task… / Go to Tasks.
- **The bar:** the project switcher, Active · Backlog · All · Archive (each with its count), **whose tasks** (Everyone, You, Your Claude, each person and their Claude, No one yet), a filter (⌘F), List · Board · What Waits on What, ⋯, and **New Task** (⌘N, or C).
- **Alone, no assignees.** On a project where you work alone (nobody else in the room, no friends, nothing assigned to anyone else), who a task is for isn't shown anywhere: not in rows, cards, a task's page or the New Task sheet. Every task is yours and your Claude's; Start is how it gets worked on.
- **List:** grouped by status (groups fold; + adds a task there). A row's priority, status and assignee are menus of their own (1–9 pick); the rest of the row opens the task. ↑↓ and Return; right-click for Open, Start (or Start Worktree Only; Open Worktree when a worktree does or carries it), Status ▸, Priority ▸, Add Sub-task…, Copy Key, Delete Task….
- **Board:** a column per status; drag a card to another column or up and down (a line shows where it lands).
- **What Waits on What:** the tasks tied to others as a graph (the graph engine): a task with sub-tasks is a box around them, blockers point at what they hold up, in the problem color until they're done. Double-click, or Open Task in its details, opens it.
- **A task's page:** the title (renamed in place), the next step (**Start**: a new worktree named after the task, In Progress, your Claude on it, told it's working on its key with the goal, criteria, context and decisions, and you taken to its chat; or Open Worktree with its pull request when a worktree already does or carries it), the brief, sub-tasks (add inline), Blocked by / Blocks / Related, proof (pictures open full size, graphs are drawn, links and files open), and the activity with a comment box (⌘↩). Its properties are down the right, each a menu.
- **New Task:** describe it (Claude writes the title, goal and criteria, and picks labels: the board's own first, up to two new ones when none fit), an optional priority, and the assignee when you work with others; or write the title and goal yourself. **Start with Claude** makes the worktree and puts Claude on it at once.
- **Above a worktree's chat:** the task it's doing (status, key, title, criteria ticked), one click from its page.

---

## 3. Plans and the head Claude — phase 4 and 5, shipped

### The model (`src/core/plans/`, browser-safe slice `plans`)

- **A plan** is a goal cut into **milestones**, which run side by side unless one builds on another: a milestone's `depends_on` (earlier milestone ids) says what it waits on, and when it's left out it's inferred from its tasks' blockers in other milestones (none: it runs from the start). Each milestone has a goal, **pass criteria** (checkable statements) and **tasks**. A task has a stable id Claude picks (`auth-api`), a goal, context, acceptance criteria, an estimate, `touches` (the files it changes, so parallel tasks keep apart), **blockers** (tasks of the same or an earlier milestone whose code it builds on — never a later one, never a loop) and sub-tasks. A task is Claude's unless it's marked as yours (accounts, secrets, decisions).
- **Draft and approved.** A plan keeps a `draft` (Claude's and your working copy) and a `body` (what was approved). The draft lives with the plan in `~/.beluga/plans.json`, *never on the board*. **Approve** puts it there (`apply.ts`): new tasks are made with their sub-tasks and blockers wired up, changed ones rewritten (ticked criteria stay ticked), and tasks taken out are canceled. The milestone being worked on is Ready (status `todo`); later ones wait in the Backlog. Discarding a never-approved draft deletes the plan; the board never knew.
- **Changing an approved plan** makes a new draft: the page shows "Claude proposes changes: 2 new · 1 changed · 1 taken out" with Apply / Discard. Your own edits apply at once (you're the approver). On **Autopilot**, the head Claude's changes apply at once too.
- **Your planning style** (`~/.beluga/planning.md`, Plans › ⋯ › Planning Style…) is added to Claude's planning instructions every time.

### Planning with Claude

- **New Plan** (Plans, ⌘K): “Plan in {project}”, a big goal box that grows as you write (⌘↩ starts), and how it runs as three cards (names and sentences from `AUTONOMY_INFO`). Opened from a project it asks no project; `goal` prefills the box. It opens a conversation of its own in the project's main folder (Claude only reads there) and the plan's page. Claude reads the code and writes the plan with its tools (`beluga_plan`: `plan_get`, `plan_write`, `plan_update`); the graph fills in as it writes, and you talk it through in the conversation beside it.
- **Plan with Tasks** in any conversation in a project (the composer's mode menu, or ⇧⇥: Act → Plan First → Plan with Tasks): that conversation becomes the plan's home. A strip above it shows the plan and its next step.
- A plan task can adopt a task already on the board (`issue: "BOB-12"`).

### Running it (`pilot.ts`, `progress.ts`)

`planView` works out, from the plan, the board and what each worktree's Claude is doing right now, every task's state (later · waiting · ready · Claude working · needs you · in progress · in review · done), each milestone's (up next · in progress · Claude is checking · ready to pass · check failed · passed) and **the one thing the plan waits for** (the page's main button). Every milestone whose dependencies have passed is open at once, each with its own check and pass; *Run at Once* counts milestones at work across the whole plan (each is one Claude), and autonomy applies per milestone. The pilot acts on it a moment after anything changes:

| Autonomy | What happens |
|---|---|
| **Step by Step** (you start each task) | ready tasks line up with a Start button; nothing starts by itself. Start gives that one task to the milestone's Claude (started for it the first time), which does only that and stops |
| **Check-ins** (`gated`, the default: runs, then waits for you at each milestone) | a milestone with work ready gets its Claude by itself (up to *Run at Once*, 3 by default); each milestone waits for you to pass it |
| **Autopilot** (runs to the end, stops only if something fails) | milestone to milestone: a passing check moves on by itself; a failed one stops there, and the head Claude adds fix tasks (applied at once) |

- **One Claude per milestone** (BLG-7). A worktree per task spent most of each task finding its way around the code again, so an open milestone with work ready gets **one worktree and one Claude** that does its tasks one after another, keeping its context. The pilot (`stepAgents`, `launch`) makes the worktree quietly from the plan's branch (or what its first ready task builds on), links every task of the milestone that's Claude's to it (`Board.linkWorktree(…, { shared })`; the first goes In Progress; the milestone's `runs[id].agent` records the worktree and the tasks handed to it), and sends one lean brief (`milestonePrompt`): the plan's goal, the milestone's goal and pass criteria, its tasks in the order they build on each other (`taskOrder`: blockers first, else the plan's order) each with its goal, context, files (`touches`) and checklist, what runs beside it, and how to go fast — read only what a task touches, no surveying the codebase, one task at a time: `task_update` In Progress, make it work, tick its criteria, typecheck and its own tests, **one commit per task**, `task_attach_proof`, a short handoff, `task_update` In Review, then the next without stopping; no pull requests. So the board still moves task by task, and the plan's view shows the next ones as *Next for this milestone's Claude* (`TaskView.queued`). Each run in that worktree gets the milestone's note (`milestoneNote`, via `BoardWork.setRunBrief`) instead of one task's brief, and its task tools point at the task it's on. Its turn ending with tasks ready and none begun, it's sent on once (`milestoneNextPrompt`); stopping again with the same ones left, the plan says so and it's yours (open its chat, or Start one). A task of it that started and stopped is woken by the watchdog as before, once per worktree, and told to go on with the next. Tasks added later (a failed check's fix tasks) go to the same Claude. Its worktree gone (archived), the next ready task gets a new one. Passing merges its one branch once and archives its one worktree. `workers: 'task'` (PlansWork/PlanPilot deps) keeps the older way, a worktree per task, described next.
- **Tasks for you** (assignee *me*) are never a Claude's: the milestone's Claude is told to skip them (what builds on one comes after you've done it), the plan's activity says “KEY waits for you”, and the pilot's `forYou` hook hears of each one once it's ready (`waitingOnYou`), for the plan's chat to ask you.
- **Starting** a task (a worktree per task, `workers: 'task'`) makes its worktree quietly (it doesn't take you there) with Claude on it. A task that builds on one still in review starts from that one's branch. One that builds on several starts from them combined: `beluga/<key>-base`, the first one's branch with the others merged in (`--no-ff`), made in a hidden worktree (`~/.beluga/workspaces/.bases/`, never listed) and removed once it's made. A branch already in another one, or already in main, isn't merged again. Meanwhile the task shows *Combining KLD-9 and KLD-27 …*. A conflict goes to the head Claude, which may edit only that hidden worktree while the conflict is open. Once no markers are left, Beluga commits the merge, finishes combining and starts the task. If two fix-ups don't do it, the task waits for you and says where the conflict is. Beluga looks again every 30 seconds (or when you press Start), and the task starts once the conflict is fixed. A task already being worked on in a worktree is never started again (`BoardWork.start` refuses).
- **Finished** means In Review or Done. The task's Claude is told to commit, rewrite the handoff and move its task to In Review when every acceptance criterion holds. A task can't go to In Review (by `task_update` or its pull request opening) while a criterion is neither ticked nor explained: its Claude is told which, and the board shows **Needs its checks** until they are (then an open pull request moves it by itself). On Autopilot, a task whose Claude stopped without finishing is nudged once.
- **The plan's branch.** Approving a plan makes `plan/<slug>` from main (its title up to a colon; a `plan/<name>` its text names, or one that already exists, is adopted, never made twice), stored on the plan. Every task starts from it as it is right then, so a later milestone sees the earlier ones' work. Passing a milestone (you, or Claude on Autopilot) merges each of its task branches `--no-ff` into it, in a hidden worktree (or where the branch is already checked out, if that checkout is clean). Branches already in it are skipped. The milestone counts as passed only once the merge is done. Then its tasks go **Merged into Plan** (status `in_plan`), a board column between In Review and Done, and their worktrees are archived (the conversations are kept) and their branches deleted. No PR is opened per task or per milestone. A conflict goes to the head Claude as a fix-up in that worktree; meanwhile the plan says *Fixing a merge conflict in KEY* and the milestone stays open. When the last milestone passes, the plan offers **Open PR** (`plan/<slug>` → main, then Merge on GitHub) or **Merge into Main Locally**. When that PR merges, every Merged into Plan task goes to Done with *merged into main via #N*. A PR closed without merging leaves them Merged into Plan and says so on the plan. The pilot looks at the PR every 2 minutes (`PlanGit`, `plan-git.ts`). Plans that ran before this catch up once: each passed milestone whose tasks are still In Review is merged into the branch, and tasks already in main go to Done.
- **Pass Anyway is instant** (BLG-16). Passing is said at once (the page shows it merging) and nothing slow sits on the request: the merge into the plan's branch starts right away in the background, and archiving the merged worktrees runs after it, so another milestone's merge never waits for it. A check the head Claude still runs when you pass is stopped (`AgentHost.cancelRun`; or taken out of the queue), so what the plan asks next (a fix-up, the next check, the recap) doesn't wait behind a test run nobody needs, and a verdict that comes late is ignored.
- **Gates:** when a milestone's tasks are finished, the head Claude is asked to check its pass criteria for real (briefs, handoffs, proof, diffs) and records `plan_gate` pass or fail with notes per criterion. The check lists each task's acceptance criteria with ticks and reasons: an unexplained one fails the milestone, a deferred one waits for the last milestone's check, which must settle every deferred item against the full suite run (tick it, or fail with a fix task). A milestone with no pass criteria of its own is still checked when one of its tasks has an open criterion. While it checks, on every mode, the plan waits on Claude (`checking`), never on you; it's yours to pass only once the check is back (or there's nothing to check). Pass Milestone / Not Yet… are yours (Not Yet sends what's missing to the head Claude, which adds the tasks). When the last milestone passes, the head Claude writes a recap.
- **Parallel Claudes know about each other.** Every run doing a task gets what else in the project is being worked on right now (which task, which worktree, whether its Claude is working); `task_get` says where a task is being worked on. A plan task's worktree also gets its plan, milestone, pass criteria and the tasks running beside it (with their `touches`). The head Claude is warned when tasks running side by side touch the same files, and can message a task's Claude (`plan_message_task`).
- Pause stops starts; the scheduler, not Claude, enforces limits, blockers and gates.
- **Tests, sized to the task.** A task writes the tests it needs and runs only typecheck and the test files it touched. The e2e and full suites run once per milestone, at its check, on the milestone's combined work. With *When to Run Tests ▸ Only at the End* (⋯, or the New Plan sheet), milestone checks skip the suites and the final step runs everything. A failure that looks like load counts only if it fails again when re-run once, alone.
- **One Mac e2e at a time.** `npm run e2e` (packages/mac) runs through `scripts/e2e-lock.mjs`: a machine-wide lock (`~/.beluga/e2e/lock.json`), so a second run from any worktree waits ("waiting for KLD-12's e2e"). Each worktree gets its own port and demo home. Every process the run starts is stopped however it ends, and a run that failed while the Mac was overloaded re-runs its failed tests once, alone. When a worktree's Claude stops, Beluga stops the test runs it left (its runs carry `BELUGA_WORKTREE`). Archiving or deleting a worktree stops every test runner in it (`src/workspaces/test-procs.ts`).
- **What happened:** the pilot writes what it did to the plan's activity: tasks `started` and `finished` (coming back for review), Claude `checked` a milestone (or it `failed`), milestones `merged` and `passed`, the mode changed (`autonomy`).

### In the window (`packages/mac/src/plans/`)

- **Plans** in the sidebar (under Tasks): one project's plans with a milestone progress bar, their status and what they wait for.
- **A plan is one row under its project** (`layout/plan-row.tsx`): a flag, its name, a small ring of how far it got (breathing while its tasks run), a dot when it waits for you, and a count of what's new in its conversation and its tasks. Its conversation and its task worktrees (`core/plans/owner.ts`: any worktree of a task of a running plan, adopted tasks included) stay off the tree; the row opens the plan with its conversation, and stays marked while you're in one of its tasks. Project Home lists plans the same way and leaves their worktrees out; the Worktrees page still lists them, labelled with their plan.
- **A running plan is a black box at the top level.** One rule (`planOf` / `isPlanOwned` in `core/plans/owner.ts`) says which conversations fold into a plan, and every top-level place follows it: Unread shows the plan once ("Card checkout for launch · 3 updates") and only while something in it is new; a task's question or approval makes that row need you, saying which ("KLD-12 asks a question"), and opens the plan at that task, where Answer is one click. The bell folds a plan's quiet task news under one entry (milestones stand alone), and Overview and project tallies count the plan as one item. Inside the plan each task's card and row keep their own unread mark. For the detail, the plan's ⋯ › Show Task Chats in the Sidebar lists them under its row (per plan, off by default).
- **A plan task's worktree has no local Merge**: its next step is **Open Plan** (and **Open Task** under ⋯); **Merge Anyway…** (and ⇧⌘M) first says Beluga merges it into the plan itself. No PR of its own either: the plan opens one at the end.
- **A plan's page:** the name (renamed in place), one progress bar (milestones that run side by side share a column, as stacked tracks), and one sentence with whose turn it is (`headline`: “You: pass “API” — Claude checked all 4 criteria”, “Claude is checking “API””, “3 tasks running in 2 milestones”, “Fixing a merge conflict in KLD-9”); clicking it opens **What Happened**, the plan's feed (newest first, repeats folded: “Beluga started 3 tasks: …”). Beside it: **Runs on Check-ins**, a button that opens the three mode cards; picking another says in plain words what changes from now on (and what happens at once) before you switch. Then ⋯ (Pause, Run at Once ▸, When to Run Tests ▸, Copy as Markdown, Planning Style…, Discard, Delete), and one main button for what it waits for (Approve Plan, Apply Changes, Start, Pass Milestone, Not Yet…). A task's worktree shows the same sentence from the task's side (“Done. Claude is checking “API”; Beluga merges this into the plan”).
  - **Graph:** milestones that run side by side sit side by side in a row; a row waits on the rows above, and a line runs from each milestone down to those that wait on it. Tasks inside left to right by what waits on what (what can start at once lines up on the left); a gate at the end of each lane that opens the next. Tasks Claude is working on have a copper light going round them and say what Claude is doing; finished ones tick; a gate waiting for you is the one thing in the accent. The layout depends only on the plan's shape, so work moving on never moves anything; a re-cut plan glides to its new shape. Blockers from an earlier milestone show for the task you pick.
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
| 1 ✓ | Graph engine: `beluga-graph` in chat and docs, `/visualize`, prompt, demo | — |
| 2 ✓ | Tasks: slice, saving, `board.*` API, Tasks view (list, board, graph, task page), a task per worktree, status from pull requests, Claude's task tools, brief revisions | 1 (the dependency graph) |
| 3 ✓ | Team boards: friends on the same repository keep one board (over friends' links), assign to teammates and their Claudes, who's on which issue, shared plan drafts | 2 |
| 4 ✓ | Plans: planning style, Claude's plan tools, drafts off the board, plan graph and outline, approve → tasks | 1, 2 |
| 5 ✓ (recaps in words) | Head Claude: scheduler, orchestrator tools, autonomy, gates checked by Claude, live plan view, a recap when it's done | 4 |

Each phase is its own PR with tests (core contract tests, Mac model tests, an e2e spec and screenshots in light and dark).
