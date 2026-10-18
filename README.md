<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img src="assets/banner-light.svg" alt="klaud: you, your friends, and everyone's Claude" width="720">
  </picture>
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="#what-you-can-do"><b>Features</b></a> ·
  <a href="#a-quick-tour"><b>Tour</b></a> ·
  <a href="#how-it-works"><b>How it works</b></a> ·
  <a href="#security"><b>Security</b></a>
</p>

<p align="center">
  <img src="assets/demo.gif" alt="klaud demo: two worktrees in two projects, each with its own Claude and sub-agents, running at the same time; the overview; a group chat with two friends" width="900">
  <br><sub>Recorded with <code>klaud demo</code> (the friends and every Claude reply are simulated)</sub>
</p>

**klaud is one terminal for all your projects and the Claude working in each of them.**

Give every task its own worktree: a separate folder and branch with its own Claude conversation. Claudes in different worktrees and projects work **at the same time without touching each other**, each with its own sub-agents that you can watch live. When you want company, invite friends into the same room. Everyone brings their own Claude, and you can all talk at once.

## What you can do

| | |
|---|---|
| 🌿 **A worktree per task, in every project** | Click **+⌥**, describe the task, and Haiku names a fresh worktree from the latest `origin`. Your `.env` files come along. klaud finds all your git projects, and worktrees from Conductor or Claude Code show up too, with their earlier conversations. |
| ⚡ **Parallel, and isolated** | Each worktree has its own folder, branch and Claude conversation, so `add-auth` in one project and `new-hero` in another run side by side and never step on each other. |
| 🧩 **Sub-agents you can watch** | When a Claude fans out to sub-agents (reviewers, explorers, test runners) or background tasks, they nest under its card with live progress. |
| 🔭 **Everything at a glance** | The Overview shows every workspace in plain words: *Claude working · 2 sub-agents running*, *ready to merge*, *merge conflict*. |
| 💬 **Many people, many Claudes** | Invite friends into one room and talk all at once. `@claude:mia` runs on **mia's** computer with **mia's** subscription. Bring someone into a single worktree to work on it with you. |
| ✅ **Review, plan, merge** | **Review** runs a thorough check (bugs, security, tests, quality). **Shift+Tab** turns on plan mode, so Claude proposes a plan before changing anything. Its questions come with clickable answers. **Merge** explains itself, and conflicts get a *Solve conflict* button. |
| 🖥️ **A real terminal inside** | Every workspace has a **Terminal** tab: a full shell (vim, htop, colors). **Run** starts your dev server there. |
| 🔔 **Notifications that matter** | Claude finished, has a question, wants a plan approved, hit a conflict, a PR's checks failed: a desktop notification and the **Inbox**, never for what you're already looking at. |
| 🚀 **Pull requests by Claude** | Click **PR**: Claude commits, pushes and writes a short description (what, why, how to test). Your own PR instructions, per project too. Status and checks show on the cards. |
| 🧠 **Pick the model per chat** | Click the model in the box to switch between Opus, Sonnet, Haiku… for one conversation, or set the default. |
| 🔎 **Search everything** | One search across every conversation, including archived ones. |
| 📊 **Space and usage at a glance** | **Usage** shows each worktree's disk space and Claude tokens as bars, with an Archive button to free space. |
| 🤝 **Work on each other's computers** | Start a worktree **on a friend's computer**, **hand off** a workspace so their Claude continues it, or let your Claude fetch a file from their desktop. |
| 🛡️ **Trust, in one click** | When someone joins, pick how much you trust them: *Can't use my Claude*, *Ask me each time*, *Trusted*, or *Full trust*. klaud remembers it. |
| 🔗 **Direct and encrypted** | Friends connect straight to you, peer to peer, with Cloudflare only as a fallback. Every message is end-to-end encrypted and signed. |
| 🖼️ **Images in the terminal** | Open PNG, JPEG, GIF and SVG files, drawn in truecolor half-blocks or as text art. |
| 🔒 **Private by default** | klaud runs solo until you click Invite. Everything is end-to-end encrypted, and you decide who may use your Claude and where. |

## Quick start

```bash
npm install -g klaudcode
klaud
```

You need Node 20+ and [Claude Code](https://claude.com/claude-code) signed in (`claude`, then `/login`).

- **`klaud`** opens your projects. Nothing is shared and no tunnel is opened until you click **Invite**.
- **`klaud demo`** lets you look around, with two pretend friends and simulated replies (`npx klaudcode demo` works without installing).
- **`klaud update`** gets the latest version (or `klaud update --check` to just look).

To bring friends in, click **Invite** (or run `klaud --invite`) and send them the link. They run `klaud join`.

## A quick tour

<table>
  <tr>
    <td width="50%"><img src="assets/screenshot-overview.png" alt="Two worktrees working at once"><br><b>Side by side.</b> Two worktrees in two projects, each Claude with its own sub-agents.</td>
    <td width="50%"><img src="assets/screenshot-subagents.png" alt="A Claude and its sub-agents"><br><b>Sub-agents.</b> Explore and Plan agents working for the Claude in <code>new-hero</code>.</td>
  </tr>
  <tr>
    <td><img src="assets/screenshot-group.png" alt="Group chat with two friends"><br><b>Talk with everyone.</b> You, bob and mia in one room, each with their own Claude.</td>
    <td><img src="assets/screenshot-workspace.png" alt="A finished review in a workspace"><br><b>Workspaces.</b> Chat, Files and Diff, plus Review, Merge, Fork, Finder, Archive and Share.</td>
  </tr>
  <tr>
    <td><img src="assets/screenshot-plan.png" alt="Claude proposes a plan"><br><b>Plan first.</b> Claude looks around, then asks you to approve its plan.</td>
    <td><img src="assets/screenshot-question.png" alt="Claude asks a question"><br><b>Claude asks, you click.</b> Pick an option, press its number, or type your own answer.</td>
  </tr>
  <tr>
    <td><img src="assets/screenshot-share.png" alt="Sharing a workspace"><br><b>Work together.</b> Invite someone into one worktree, switch them to follow-only, or remove them.</td>
    <td><img src="assets/screenshot-projects.png" alt="Projects and worktrees"><br><b>Projects.</b> Each project lists its worktrees and chats; other tools' worktrees fold away.</td>
  </tr>
  <tr>
    <td><img src="assets/screenshot-terminal.png" alt="A real terminal in a workspace"><br><b>Terminal.</b> A real shell in every workspace, next to its setup and run commands.</td>
    <td><img src="assets/screenshot-inbox.png" alt="The inbox"><br><b>Notifications.</b> What finished or needs you while you were elsewhere, on the desktop and in the Inbox.</td>
  </tr>
  <tr>
    <td><img src="assets/screenshot-usage.png" alt="Disk space and Claude usage per workspace"><br><b>Usage.</b> Disk space and Claude tokens per workspace, with Archive to free space.</td>
    <td><img src="assets/screenshot-search.png" alt="Searching every conversation"><br><b>Search.</b> Every conversation, archived ones too.</td>
  </tr>
  <tr>
    <td><img src="assets/screenshot-pr.png" alt="The pull request menu"><br><b>Pull requests.</b> Claude pushes and writes a short description, with your own instructions.</td>
    <td><img src="assets/screenshot-trust.png" alt="Choosing how much to trust someone"><br><b>Trust, in one click.</b> Someone joins: pick what they may do with your Claude.</td>
  </tr>
</table>

Everything is clickable, and the bar at the bottom always says what you can do next. There are no shortcuts to memorize.

---

## Using klaud

### Projects and workspaces

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

### Terminal, setup and run

- **Terminal** is a real shell in the workspace's folder: colors, `vim`, `htop`, `git`, anything. Click it to type; **Ctrl+]** or a click anywhere else gives the keyboard back.
- **Setup** runs in every new worktree (and forks and handoffs), in the Terminal tab where you can watch it: `npm install`, `uv sync`, whatever the project needs. klaud guesses it from the lockfile; set your own in the project's **⋯ → Setup and run commands**, or commit a `klaud.json` so the whole team gets it (`conductor.json` works too):

  ```json
  { "scripts": { "setup": "npm install", "run": "npm run dev" }, "prPrompt": "Link the Linear issue." }
  ```

  Scripts get `KLAUDE_WORKSPACE_PATH`, `KLAUDE_ROOT_PATH` (the main checkout, e.g. to copy files from) and `KLAUDE_WORKSPACE_NAME`.
- **Run** starts the run command in the Terminal tab; **Stop** and **Restart** are right above it.

### Pull requests

Click **PR** (or type `/pr`) and Claude commits what belongs to the work, pushes the branch and opens a pull request with `gh`, with a short description: *what*, *why*, *how to test*. Make it yours:

- **Settings → Claude → Pull request instructions** opens the instructions in your editor (`~/.klaud/prompts/pull-request.md`). `{{branch}}`, `{{base}}` and `{{project}}` are filled in.
- A project's `klaud.json` can add `"prPrompt"` guidelines for everyone on it.
- `/pr mention the migration` adds a note for one pull request.

The PR's number, checks and review state show on the workspace and in the Overview. If checks fail, **PR → Fix the failing checks** hands the CI logs to Claude. You need the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`).

### Notifications and the inbox

klaud tells you when something needs you: Claude finished, asks a question or proposes a plan, wants an approval, hit a merge conflict, setup failed, a PR opened or its checks finished, someone joined or handed you work. It never interrupts you about the conversation you're looking at.

- On the desktop: iTerm2, Ghostty, WezTerm and kitty show their own notifications (clicking one brings the terminal back); elsewhere macOS Notification Center or `notify-send`.
- In klaud: **Inbox** (top right) lists everything, and clicking an item takes you there.
- **Settings → Notifications** turns each kind, the desktop and the sound on or off.

### Models, search, usage and templates

- **Model**: click **◆ Default ▾** in the box to pick the model for this conversation (Opus, Sonnet, Haiku, or whatever your Claude Code offers). Settings → Claude sets the default and the thinking effort.
- **Search** (tab, or `/search words`): every conversation, archived ones too. All words must match; ↑↓ and Enter open one.
- **Usage** (tab): disk space and Claude tokens per workspace, side by side, with an estimated cost. Archive a worktree to free its space; the branch and conversation stay.
- **Templates**: a new worktree or chat lists ready-made starts (fix failing CI, add tests, fix a bug, build a feature with a plan first…). Save your own with `/template save Name: what Claude should do`.

### On your own

klaud starts solo. The **Chat** tab is you and your Claude, so just type, no `@claude` needed. Start a message with `@add-auth` (Tab completes) to send it to the Claude working in that worktree or project.

Worktrees made by other tools (Conductor, Claude Code) show their latest Claude Code conversation when you open them, and Claude continues it. The People panel appears once someone joins.

### Working with people

- **Invite** opens a secure link and copies it. Your friend runs `klaud join`.
- **Someone joins**: a card asks *how much do you trust them?* Pick one, and klaud remembers it next time (by their own key, which nobody else can use):
  - **Can't use my Claude**: they can chat, but their requests are declined.
  - **Ask me each time** (the default): you approve each request. Their requests only reach your shared folders; reading anything else asks you.
  - **Trusted**: requests run without asking. Commands, edits, and files outside your shared folders still ask.
  - **Full trust**: like you, on your own computer, without any prompts. Secrets (`.env`, keys, `.ssh`) stay blocked even then.
- **Click a person** to:
  - change how much you trust them (the four levels above);
  - ask their Claude;
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
- **Share a folder** from **Shared files** (or the person menu). Pick this folder, a project or any path, then choose everyone or one person, and read-only or editable. Secrets are never shared.
- **Clear** a conversation: just for you, for everyone (the host, in the group chat), or with a fresh Claude conversation (in a workspace).

### Claude asks you

When Claude needs a decision, a card appears above the box you type in:
- **A question**: click an option, press its number, or type your own answer and press Enter. **Skip** lets Claude decide.
- **A plan**: press **Shift+Tab** in a conversation to turn on plan mode (shown on the right of the input box). Claude then investigates read-only and proposes a plan: **Approve plan** lets it start, or type what to change. **⛶ Full screen** (or **Ctrl+F**) opens the whole plan, scrollable.

Questions go to whoever asked Claude, even when it's a friend's Claude on their computer. Unanswered questions time out after 5 minutes, so nothing waits forever.

### Talking

| Type | What happens |
|---|---|
| `fix the failing test` (in a workspace) | your Claude, working in that workspace |
| `hey all` (in the group chat) | message everyone |
| `@claude fix the failing test` | your Claude, on your computer |
| `@claude:bob how does auth work?` | bob's Claude, on bob's computer, after bob approves |
| `@claudes review this plan` | every Claude in the room at once |

- **Enter** sends. If Claude is busy, the message waits in line.
- **Option+Enter** (or **Ctrl+Enter**) interrupts and sends right away.
- Type `@` or `/` to get suggestions, and scroll through all of them with ↑ ↓.

### Commands

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
| `/settings` · `/theme` · `/zoom in` · `/name` | settings and quick changes |
| `/policy ask\|auto\|deny` · `/trust bob` | who can use your Claude |
| `/share ~/notes` · `/unshare notes` | share a folder (or use **+ Share a folder**) |
| `/remove bob` · `/newlink` · `/lock on\|off` | host: remove someone, replace the invite link, close the room |
| `/stop` · `/copy` · `/people` · `/clear` · `/help` · `/quit` | |

### Keys (all optional, since everything is also clickable)

| Key | |
|---|---|
| `Enter` · `Option+Enter` | send (queued while Claude works) · interrupt and send now |
| `Tab` | jump between areas: chat, the top bar, projects, people (and files, the diff or the terminal when shown) |
| `Ctrl+]` | leave the built-in terminal (all other keys go to its shell) |
| `Enter` / `Esc` (on an area) | go inside it (then `Tab` or arrows move between its items) / come back out |
| `Shift+Tab` (in the chat) | switch plan mode: Claude plans first and asks you to approve |
| `1`–`4` | pick an option on Claude's question card |
| `@` | `Option+Q` (Turkish), `Option+L` (German) and `Option+2` (Spanish) work even when your terminal sends Option as Meta |
| `Esc` | back to typing, or cancel a new chat |
| `↑ ↓` · `PgUp PgDn` | history or suggestions · scroll |
| `Option+↑` / `Option+↓` | bigger or smaller text (works on every keyboard layout) |
| `f` · `r` · `d` (in the viewer) | fullscreen · source/formatted (or color/text art) · download |
| `Ctrl+Y` · `Ctrl+N` · `Ctrl+T` | allow · deny · always allow this person |
| `Ctrl+C` twice | quit |

### Settings

Your choices are saved in `~/.klaud/settings.json`, so plain `klaud` always starts the way you like it. Open **Settings** from the bottom bar or with `/settings`:

- **Name** and **color theme** (Calm, Light terminal, High contrast, Monochrome)
- **People & permissions**: what new people start at, each person's trust level, people you trusted before, and how friends connect (direct with a Cloudflare backup, direct only, Cloudflare, ngrok, or local network)
- **Notifications**: desktop on/off, sound, and each kind (finished, needs you, problems, people, pull requests), plus a test
- **Claude**: default model, thinking effort, whether your own Claude asks before commands, your pull request instructions, templates
- **Workspaces**: setup in new worktrees, whether friends may start work on your computer, the terminal's shell, which top-bar buttons show
- **Display**: mouse, context meter, how much sub-agent detail the chat shows, text size

### Command line

```
klaud                           your projects, with your saved settings (solo)
klaud --invite                  also open remote access and copy an invite
klaud join [invite]             join a friend (reads the invite from your clipboard)
klaud demo                      try everything with a pretend friend
klaud view <image> [--ascii]    show a PNG, JPEG, GIF or SVG in the terminal
klaud update [--check]          get the latest klaud, or just check

  -n, --name <name>        display name (remembered)
  -s, --share <spec>       share a folder: [name=]path[:rw], repeatable
      --no-agent           don't offer your Claude
      --policy <p>         ask | auto | deny
      --tunnel <kind>      auto | p2p | cloudflared | ngrok | none
      --no-mouse           keyboard only
      --model <id>         model for your Claude
```

## How it works

```
 your computer                                       bob's computer
┌──────────────────────────────┐                   ┌──────────────────────────────┐
│ klaud                        │   encrypted       │ klaud                        │
│  projects · chat · files      │◄─── frames ──────►│  projects · chat · files      │
│  your Claude (your login)     │ direct (P2P) or   │  bob's Claude (bob's login)   │
│                               │ via Cloudflare    │                               │
│  room hub (relay)             │                   │                               │
└──────────────────────────────┘                   └──────────────────────────────┘
```

- **Each Claude runs at home.** The [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) drives each person's own Claude Code, with their own subscription and permissions. Workspace conversations stay on your computer.
- **Room hub.** When you invite people, the host runs a small relay. Friends connect straight to it, peer to peer (Hyperswarm DHT with UDP hole-punching and Noise encryption). If their network blocks that, they fall back to a free Cloudflare quick tunnel that the invite also names. See [docs/p2p.md](docs/p2p.md). The topology is a star through the host, not a mesh. The relay checks the invite secret, forwards messages, and keeps a short history for latecomers.
- **End-to-end encryption.** Every frame is sealed with AES-256-GCM, using keys derived from the invite secret with HKDF. Neither the tunnel nor the relay can read or forge messages. Direct connections are also encrypted underneath with Noise (forward secret), pinned to the host's key from the invite.
- **Limits.**
  - Up to 16 people per room and 120 messages per second per connection.
  - Messages up to 1 MB. Files are sent in 256 KB encrypted chunks, up to 200 MB.
  - Cloudflare quick tunnels have no uptime guarantee. Use ngrok or your own network if you need one.
- **Images** are decoded in a background thread and shrunk before they're drawn, so big photos never freeze the screen.

## Security

Inviting someone exposes your Claude, with your permissions, to other people. klaud is built around that:

- **Solo by default.** Nothing is reachable until you click Invite.
- **The invite is the key.** Anyone with the link can join, so share it privately. The host can **remove** someone, **replace the link** (the old one stops working; people already in stay), or **close the room** to newcomers.
- **Nobody can speak for someone else.** Everyone has their own signing key (kept in `~/.klaud/identity.json`), their id comes from it, and **every message is signed**. Not even the host relaying the room can forge a message from you, so a trust level you gave someone can't be borrowed. Requests that act on your computer must be fresh: an old one replayed later is dropped.
- **You decide how much each person may do**: can't use your Claude, ask each time, trusted, or full trust (see *Working with people*). Unanswered approvals are declined after 5 minutes.
- **Reaching outside your shared folders asks you.** Friends' requests use your shared folders; reading anything else, shell commands, web requests and edits outside a `:rw` folder ask you first, even ones Claude Code would normally auto-approve. Only **full trust** skips these.
- **Secrets stay put.** `.env` files, keys, `.ssh`, `.aws` and similar are never shared, sent or readable by friends' requests, whatever the trust level.
- **Files are sent one at a time.** When you approve sending a file, only a copy of that file is shared, with only that person, for 15 minutes.
- **Work from friends is yours to approve.** Starting a worktree on your computer or taking over someone's work asks you first (unless you fully trust them); turn it off in Settings → Workspaces.
- **Direct connections are pinned.** A direct (peer-to-peer) connection is encrypted with Noise, has forward secrecy, and only completes with the host whose key is in the invite. The relay and the DHT see IP addresses, never content. See [docs/p2p.md](docs/p2p.md).
- **Untrusted files are handled carefully.** Images from friends are size-checked before decoding, and SVGs can't load files from your disk.
- **Be aware:** a friend's message can try to talk your Claude into things (prompt injection). Keep approvals on for people you don't fully trust.

## Development

```bash
git clone https://github.com/kayraucklnc/klaud.git && cd klaud
npm install
npm run dev -- demo        # run from source
npm test                   # 670+ unit and multi-peer integration tests
npm run typecheck
npm run build && npm link  # use your local build as `klaud` (klaud update then follows git)
```

klaud used to be called klaude. Your `~/.klaude` settings, projects and worktrees carry over automatically.

## Roadmap

- Show a shared workspace's diff to the people in it
- Per-friend invite links and knock-to-join

## License

MIT
