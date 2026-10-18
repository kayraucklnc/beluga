# Klaud in the terminal

The lightweight Klaud: everything in your terminal, clickable, no shortcuts to memorize. Install it with `npm install -g klaudcode` and run `klaud`.


## Projects and workspaces

- **CHATS** are conversations with Claude that aren't tied to a project. **+ new** opens an empty chat in the folder you started klaud in. Your first message creates it, and Esc cancels.
- **PROJECTS** are your git repos. Each project row has three buttons:
  - **+⌥** opens a new worktree: describe the task, and a small model (Haiku, on your own login) names it. It's created from the latest `origin` under `~/.klaud/workspaces/<project>/<name>`, and Claude starts right away.
  - **+◇** opens a new chat in the project folder.
  - **⋯** moves the project to a group, hides it, or opens it in Finder.
- **Inside a workspace**, the top bar has (Tab walks through every button, Enter presses it; whatever doesn't fit is under **⋯ More**, and Settings → Workspaces hides the ones you don't use):
  - **Chat**, **Files**, **Diff** and **Terminal** views.
  - **Run**: starts the project's run command (e.g. `npm run dev`) in the Terminal tab.
  - **Review**: a thorough check by sub-agents covering correctness, security, tests and quality, then a verdict.
  - **PR**: Claude opens a pull request (see below). Once there is one, the button shows its number and checks.
  - **Hand off**: someone else's Claude continues this work on their computer (see below).
  - **Commit** and **Merge**: merging into the main folder. A conflict shows a red banner and a **Solve conflict** button that asks Claude to fix it.
  - **Compact**: summarizes the conversation when the context meter fills up.
  - **Fork**: a new worktree that keeps the conversation.
  - **Finder**: opens the folder.
  - **Archive**: keeps the conversation, removes the worktree. Restore it any time from **Archived**.
  - **Share**: invite people from the room to work here or follow along, and remove them any time.
- **Worktrees from other tools** stay out of the way. The ones Claude Code sub-agents create (`.claude/worktrees/agent-*`) fold into **Claude Code agents**, where **⋯** removes the finished ones (branches are kept). Other tools' worktrees fold into **Other worktrees**.
- **Env files**: `.env*` files (and `.ssh` / `.aws` folders inside the project) are copied into new worktrees. When you archive or delete one, klaud shows which keys changed and offers to copy them back to main.

## Terminal, setup and run

- **Terminal** (the last tab at the top, next to Usage) is your own shell, always one click away: it starts in the project you're working in (or your home folder). Click it to type; **Ctrl+]** or a click anywhere else gives the keyboard back. **+** opens another shell.
- Each workspace also has its own **Terminal** view: a real shell in the workspace's folder: colors, `vim`, `htop`, `git`, anything.
- **Setup** runs in every new worktree (and forks and handoffs), in the Terminal tab where you can watch it: `npm install`, `uv sync`, whatever the project needs. klaud guesses it from the lockfile; set your own in the project's **⋯ → Setup and run commands**, or commit a `klaud.json` so the whole team gets it (`conductor.json` works too):

  ```json
  { "scripts": { "setup": "npm install", "run": "npm run dev" }, "prPrompt": "Link the Linear issue." }
  ```

  Scripts get `KLAUDE_WORKSPACE_PATH`, `KLAUDE_ROOT_PATH` (the main checkout, e.g. to copy files from) and `KLAUDE_WORKSPACE_NAME`.
- **Run** starts the run command in the Terminal tab; **Stop** and **Restart** are right above it.

## Pull requests

Click **PR** (or type `/pr`) and Claude commits what belongs to the work, pushes the branch and opens a pull request with `gh`, with a short description: *what*, *why*, *how to test*. Make it yours:

- **Settings → Claude → Pull request instructions** opens the instructions in your editor (`~/.klaud/prompts/pull-request.md`). `{{branch}}`, `{{base}}` and `{{project}}` are filled in.
- A project's `klaud.json` can add `"prPrompt"` guidelines for everyone on it.
- `/pr mention the migration` adds a note for one pull request.

The PR's number, checks and review state show on the workspace and in the Overview. If checks fail, **PR → Fix the failing checks** hands the CI logs to Claude. You need the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`).

## Notifications and the inbox

klaud tells you when something needs you: Claude finished, asks a question or proposes a plan, wants an approval, hit a merge conflict, setup failed, a PR opened or its checks finished, someone joined or handed you work. It never interrupts you about the conversation you're looking at.

- On the desktop: iTerm2, Ghostty, WezTerm and kitty show their own notifications (clicking one brings the terminal back); elsewhere macOS Notification Center or `notify-send`.
- In klaud: **Inbox** (top right) lists everything, and clicking an item takes you there.
- **Settings → Notifications** turns each kind, the desktop and the sound on or off.

## Models, search, usage and templates

- **Model**: click **◆ Default ▾** in the box to pick the model for this conversation (Opus, Sonnet, Haiku, or whatever your Claude Code offers). Settings → Claude sets the default and the thinking effort.
- **Search** (tab, or `/search words`): every conversation, archived ones too. All words must match; ↑↓ and Enter open one.
- **Usage** (tab): disk space and Claude tokens per workspace, side by side, with an estimated cost. Archive a worktree to free its space; the branch and conversation stay.
- **Templates**: a new worktree or chat lists ready-made starts (fix failing CI, add tests, fix a bug, build a feature with a plan first…). Save your own with `/template save Name: what Claude should do`.

## On your own

klaud starts solo. The **Chat** tab is you and your Claude, so just type, no `@claude` needed. Start a message with `@add-auth` (Tab completes) to send it to the Claude working in that worktree or project.

Worktrees made by other tools (Conductor, Claude Code) show their Claude Code conversation when you open them (for Conductor's, the one Conductor has open; else the latest), and Claude continues it once you write there; until then they stay in their own fold. The People panel appears once someone joins.

## Working with people

- **Invite** (bottom bar, a project's ⋯ menu, or a workspace's **Share**) asks two things: **Invite to** *This project* (all its worktrees and chats) or *Everything* (the whole room), and **They can** *Watch* (chat history and files), *Prompt* (talk to your Claude there; edits and commands follow your approval rules) or *Edit* (your Claude edits and runs commands in that project's folder without asking; secrets stay blocked). **Copy invite link**, and your friend runs `klaud join <link>`.
  - Links **knock** by default: a card says *mia wants to join bob-api* with **Let in**, **Watch only** and **Decline**. They're for one person and expire after 24 hours, unless you untick those; turn any link off from the same menu. They work in rooms you host, while klaud runs.
  - Project guests see **only** what they were invited to: no group chat, no other projects or shared folders. Files stream as they open them (no full download), in **Files**, a read-only **Terminal** (`ls`, `cd`, `cat`, `tree`, `find`, `grep`; click any name to open it; Tab completes) and **Diff** (what changed). Nothing runs on your computer for that.
  - Their prompts run on your computer, with your Claude, in that project's folder, and show up as *mia (via kay's Claude)*.
  - **Click a guest** in People to change what they can do, add them to another project, invite them to everything, or remove them. No new link needed.
  - Prefer the old way? *Copy the room's open link* lets anyone with it into everything, without knocking.
- **Someone joins**: a card asks *how much do you trust them?* Pick one, and klaud remembers it next time (by their own key, which nobody else can use):
  - **Can't use my Claude**: they can chat, but their requests are declined.
  - **Ask me each time** (the default): you approve each request. Their requests only reach your shared folders; reading anything else asks you.
  - **Trusted**: requests run without asking. Commands, edits, and files outside your shared folders still ask.
  - **Full trust**: like you, on your own computer, without any prompts. Secrets (`.env`, keys, `.ssh`) stay blocked even then.
- **Click a person** to:
  - change how much you trust them (the four levels above);
  - ask their Claude;
  - run a command on their computer (shown once they let you at least *ask each time*; the menu says how much they trust you, e.g. "bob lets your Claude: ask each time");
  - start a worktree on their computer;
  - invite them into one of your workspaces;
  - share a folder with just them;
  - follow them;
- **The host** can also:
  - **remove someone** (they're disconnected, and the invite link changes so the old one stops working);
  - **make a new invite link**;
  - **close the room** to new people.
- **Shared workspaces** appear under **SHARED WITH ME**. If you can work there, your messages go to the owner's Claude, on their computer.
- **Start a worktree on a friend's computer**: click them → *Start a worktree on bob's computer…*, pick one of their projects and describe the task. Bob approves, his Claude does the work on his computer, and you're both in it.
- **Hand off**: in a worktree, click **Hand off** and pick someone. Your Claude writes a handoff note (done, left, decisions), uncommitted work is committed, and the branch goes over encrypted. They accept, get a worktree with the branch, the chat and the note, and their Claude continues. They need the same repository cloned. You can follow along under SHARED WITH ME.
- **Your Claude on their computer**: ask your Claude things like *"get bob's ~/Desktop/report.pdf onto my desktop"*. It asks bob's Claude, or fetches the file itself; bob approves each read unless he fully trusts you. When their Claude works for you, it can send results back to you as files.
- **Run a command on a friend's computer**: *Run a command on bob's computer…* in the person menu, `/run @bob npm test`, or ask your Claude (*"run the tests on bob's computer"*, also from inside a project chat). It runs through bob's klaud, in his shared folder (his home folder with full trust), with no input, stopping after 2 minutes (10 at most); the exit code and the end of the output (up to 64 KB) show in your chat. Bob gets a card with the exact command, the folder and who asked (**Yes**, **No**, or **Always** for you until klaud quits), unless he fully trusts you; blocked people are declined. Your card shows *waiting for bob*, then *running*, then the result, and bob sees a quiet line like "kay's Claude ran `npm test` in ~/api". Commands that touch secrets (`.env`, keys) are refused at every level.
- **Your Claude knows what it may ask**: it sees each friend's projects, the workspaces they shared with you and how much they trust you, and can ask their Claude to work in a specific project. If the friend isn't in the room, it tells you to **Invite** them (they run `klaud join <link>`).
- **Share a folder** from **Shared files** (or the person menu). Pick this folder, a project or any path, then choose everyone or one person, and read-only or editable. Secrets are never shared.
- **Clear** a conversation: just for you, for everyone (the host, in the group chat), or with a fresh Claude conversation (in a workspace).

## Claude asks you

When Claude needs a decision, a card appears above the box you type in:
- **A question**: click an option, press its number, or type your own answer and press Enter. **Skip** lets Claude decide.
- **A plan**: press **Shift+Tab** in a conversation to turn on plan mode (shown on the right of the input box). Claude then investigates read-only and proposes a plan: **Approve plan** lets it start, or type what to change. **⛶ Full screen** (or **Ctrl+F**) opens the whole plan, scrollable.

Questions go to whoever asked Claude, even when it's a friend's Claude on their computer. Unanswered questions time out after 5 minutes, so nothing waits forever.

## Talking

| Type | What happens |
|---|---|
| `fix the failing test` (in a workspace) | your Claude, working in that workspace |
| `hey all` (in the group chat) | message everyone |
| `@claude fix the failing test` | your Claude, on your computer |
| `@claude:bob how does auth work?` | bob's Claude, on bob's computer, after bob approves |
| `@claudes review this plan` | every Claude in the room at once |

- **Enter** sends. If Claude is busy, the message waits in line: the bar below the box shows **Queue ↵** and **Send now ⌥↵** while you type, and **Run queued now** / **Cancel queued** once something is waiting.
- **Option+Enter** (or **Ctrl+Enter**) interrupts and sends right away.
- Long messages wrap and the box grows (up to about half the screen, then scrolls). **Ctrl+J** or **Shift+Enter** starts a new line; pasted text keeps its lines.
- **Option+Backspace** deletes a word, and holding **Backspace** speeds up the longer you hold it.
- Type `@` or `/` to get suggestions, and scroll through all of them with ↑ ↓.
- **Images:** click **+ image** next to the model (or press **Ctrl+V**) to attach the image on your clipboard, such as a screenshot or an image file copied in Finder. You can also drag an image file into the terminal. It shows up as `[image 1]` while you type. Your Claude sees the image itself, and friends in the room can click it to view it.
- **Links:** files, folders and URLs mentioned in the chat, like `src/ui/App.tsx:42`, `src/` or `https://…`, are clickable when they exist. Click (or ⌥-click) one to open the file at that line, browse the folder, or open the page in your browser. Hovering shows where a link goes.

## Commands

| Command | |
|---|---|
| `/new name` · `/chat` · `/fork` · `/archive` | create, fork or archive workspaces |
| `/plan on\|off` | plan first in this conversation |
| `/review` · `/commit` · `/merge` · `/compact` · `/finder` | act on the current workspace |
| `/pr [note]` · `/run` · `/terminal` · `/setup` · `/handoff bob` | pull request, run, terminal, setup, hand off |
| `/model sonnet` · `/search words` · `/usage` · `/inbox` | model for this chat, search, space and usage, notifications |
| `/template save Name: prompt` · `/project setup npm ci` · `/shell /bin/bash` | templates, project commands, terminal shell |
| `/overview` · `/room` | the overview, or back to the group chat |
| `/invite` | open remote access and copy an invite link |
| `/open bob:api/README.md` · `/get bob:api/data.csv` | open or download a shared file (autocompletes) |
| `/follow bob` · `/unfollow` | follow bob and bob's Claude |
| `/run @bob npm test` | run a command on bob's computer (bob approves unless he fully trusts you) |
| `/settings` · `/theme` · `/zoom in` · `/name` | settings and quick changes |
| `/policy ask\|auto\|deny` · `/trust bob` | who can use your Claude |
| `/share ~/notes` · `/unshare notes` | share a folder (or use **+ Share a folder**) |
| `/remove bob` · `/newlink` · `/lock on\|off` | host: remove someone, replace the invite link, close the room |
| `/stop` · `/copy` · `/people` · `/clear` · `/help` · `/quit` | |

## Keys (all optional, since everything is also clickable)

| Key | |
|---|---|
| `Enter` · `Option+Enter` | send (queued while Claude works) · interrupt and send now |
| `Tab` | jump between areas: chat, the top bar, projects, people (and files, the diff or the terminal when shown) |
| `Ctrl+]` | leave the built-in terminal (all other keys go to its shell) |
| `Option+1`…`6` · `Ctrl+Tab` · `Option+[` `]` | jump to a top tab (Chat, Shared files, Overview, Search, Usage, Terminal) · next / previous tab |
| `Enter` / `Esc` (on an area) | go inside it (then `Tab` or arrows move between its items) / come back out |
| `Shift+Tab` (in the chat) | switch plan mode: Claude plans first and asks you to approve |
| `1`–`4` | pick an option on Claude's question card |
| `@` | `Option+Q` (Turkish), `Option+L` (German) and `Option+2` (Spanish, while you're typing) work even when your terminal sends Option as Meta |
| `Esc` | back to typing, or cancel a new chat |
| `↑ ↓` · `PgUp PgDn` | move between lines of a long message, history or suggestions · scroll |
| `Ctrl+J` / `Shift+Enter` | new line in the message |
| `Option+Backspace` · `Option+Delete` · `Ctrl+W` | delete the word before / after the cursor |
| `Option+← →` · `Cmd+← →` · `Cmd+Backspace` | move by word · to the start / end of the line · delete to the line start |
| `Option+↑` / `Option+↓` | bigger or smaller text (works on every keyboard layout) |
| `Ctrl+V` | attach the image on your clipboard |
| `f` · `r` · `d` (in the viewer) | fullscreen · source/formatted (or color/text art) · download |
| `Ctrl+Y` · `Ctrl+N` · `Ctrl+T` | allow · deny · always allow this person |
| `Ctrl+C` twice | quit |

## Settings

Your choices are saved in `~/.klaud/settings.json`, so plain `klaud` always starts the way you like it. Open **Settings** from the bottom bar or with `/settings`:

- **Name** and **color theme** (Calm, Light terminal, High contrast, Monochrome)
- **People & permissions**: what new people start at, each person's trust level, people you trusted before, and how friends connect (direct with a Cloudflare backup, direct only, Cloudflare, ngrok, or local network)
- **Notifications**: desktop on/off, sound, and each kind (finished, needs you, problems, people, pull requests), plus a test
- **Claude**: default model, thinking effort, whether your own Claude asks before commands, your pull request instructions, templates
- **Workspaces**: setup in new worktrees, whether friends may start work on your computer, the terminal's shell, which top-bar buttons show
- **Display**: mouse, context meter, how much sub-agent detail the chat shows, text size

## Command line

```
klaud                           your projects, with your saved settings (solo)
klaud --invite                  also open remote access and copy an invite
klaud join [invite]             join a friend (reads the invite from your clipboard)
klaud demo                      try everything with a pretend friend
klaud view <image> [--ascii]    show a PNG, JPEG, GIF or SVG in the terminal
klaud update [--check]          get the latest klaud, or just check
klaud daemon [--keep-alive]     run klaud in the background for other windows (the Mac app uses this)

  -n, --name <name>        display name (remembered)
  -s, --share <spec>       share a folder: [name=]path[:rw], repeatable
      --no-agent           don't offer your Claude
      --policy <p>         ask | auto | deny
      --tunnel <kind>      auto | p2p | cloudflared | ngrok | none
      --no-mouse           keyboard only
      --model <id>         model for your Claude
```
