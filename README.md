<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img src="assets/banner-light.svg" alt="Klaud: your projects, your friends, and everyone's Claude" width="720">
  </picture>
</p>

<p align="center">
  <b>A Mac app for every project and the Claude working in each, side by side.<br>Bring your friends: everyone brings their own Claude, and you all work together.</b>
</p>

<p align="center">
  <a href="https://github.com/kayraucklnc/klaud/releases/latest"><img src="https://img.shields.io/github/v/release/kayraucklnc/klaud?label=Download%20for%20Mac&logo=apple&color=0a84ff&style=for-the-badge" alt="Download Klaud for Mac"></a>
</p>
<p align="center">
  <sub>Apple Silicon · macOS 13+ · updates itself &nbsp;·&nbsp; Prefer the terminal? <a href="#klaud-lite-in-your-terminal">Klaud Lite</a></sub>
</p>

<p align="center">
  <img src="assets/mac/hero.png" alt="Klaud for Mac: a worktree with Claude's finished run in the middle, its changes and diff in the right panel, projects and friends in the sidebar" width="940">
</p>

## What Klaud does

| | |
|---|---|
| 🌿 **A worktree per task** | Say what you want done; Klaud makes a fresh worktree (its own folder, branch and Claude), named for the task. Your main folder is only for questions: Claude never changes it, and asking for a change moves you to a new worktree. |
| ⚡ **Many Claudes at once** | Every worktree in every project works in parallel, each with sub-agents you can watch. The sidebar shows who's working, what's ready to merge, what needs you. |
| 🧩 **Everything beside the chat** | The conversation stays in the middle; the right panel has the changes and diffs, the files, your terminals and the details. Commit, open a pull request or merge in one click. |
| 👀 **See every Claude on your Mac** | Activity shows Claude Code sessions running anywhere, Conductor included, and every background agent they started, live. |
| 💬 **Friends, with no server** | Add a friend with a code; talk directly, Mac to Mac, end-to-end encrypted. Groups live on everyone's Mac, so nobody hosts them. |
| 🤝 **Claudes that work for each other** | Your Claude can ask a friend's Claude to do something on their Mac, or run a command there, and continue with the result. Trusted friends skip the approval. |
| 📊 **Usage, disk and earnings** | Plan limits, tokens per day, disk per project with one-click clean up, and each project's all-time Stripe earnings. |
| 🎨 **A real Mac app** | Light and dark, your accent colour, right-click everywhere, drag and drop, ⌘K for anything, a menu-bar icon, notifications with your own sounds, and it updates itself. |

## A tour

<table>
  <tr>
    <td width="50%"><img src="assets/mac/project-home.png" alt="A project's home page"><br><b>Start from the project.</b> Describe a task and Klaud makes the worktree; or just ask a question about the code.</td>
    <td width="50%"><img src="assets/mac/activity.png" alt="Activity: Claude Code agents running"><br><b>Activity.</b> Every Claude Code session and background agent on your Mac, with what each is doing right now.</td>
  </tr>
  <tr>
    <td><img src="assets/mac/terminal-dark.png" alt="A terminal in the right panel"><br><b>Terminals beside the chat.</b> The worktree's shell, setup and run in the right panel, or a drawer under the chat with ⌘J.</td>
    <td><img src="assets/mac/friends.png" alt="A conversation with a friend"><br><b>Friends.</b> Direct, end-to-end encrypted, no server. Set how much each friend's Claude may do.</td>
  </tr>
  <tr>
    <td><img src="assets/mac/usage.png" alt="Usage"><br><b>Usage.</b> Your plan's limits, tokens and cost per day, disk per project, and space you can free.</td>
    <td><img src="assets/mac/overview.png" alt="Overview"><br><b>Overview.</b> Every worktree and chat, archived ones too, filtered by what needs you.</td>
  </tr>
  <tr>
    <td><img src="assets/mac/earnings.png" alt="Stripe earnings for a project"><br><b>Earnings.</b> Connect a project's Stripe and see what it has earned, refreshed once a day.</td>
    <td><img src="assets/mac/model.png" alt="Model and thinking picker"><br><b>Model and thinking.</b> Pick the model per conversation and how hard Claude thinks, in plain words.</td>
  </tr>
</table>

## Install

1. **[Download Klaud](https://github.com/kayraucklnc/klaud/releases/latest)**, open the `.dmg` and drag Klaud into Applications.
2. The first time, right-click Klaud in Applications and choose **Open** (it isn't notarized by Apple yet).
3. Sign in to [Claude Code](https://claude.com/claude-code) if you haven't (`claude`, then `/login`). Klaud brings everything else.

Klaud checks for updates once a day and installs them when you say so, or by itself when you're away.

## Working with friends

- **Add a friend** with a short code or a link. From then on your Macs talk directly whenever you're both online, end-to-end encrypted, with nothing in between.
- **Groups** live on every member's Mac: anyone can be offline, and you catch up when you're back.
- **Everyone keeps their own Claude**, subscription and permissions. Ask a friend's Claude to do something on their Mac and get the result back; decide per friend what their Claude may do on yours.
- **Share a worktree** to build it together, or hand it off so their Claude continues.

More: [the friends network](docs/network.md) · [security](docs/security.md).

## Klaud Lite, in your terminal

The same Klaud as a lightweight terminal app: projects, worktrees, every Claude and your friends, everything clickable. Great over SSH or if you live in the terminal.

```bash
npm install -g klaudcode   # the command is `klaud`
klaud                      # your projects
klaud demo                 # look around with two pretend friends
```

<p align="center">
  <img src="assets/terminal/overview.png" alt="Klaud Lite in the terminal: two worktrees working at once" width="760">
</p>

Klaud Lite and the Mac app can run at the same time on the same projects. The full guide: [docs/terminal.md](docs/terminal.md).

## How it works

Klaud is one engine with two faces. The engine (projects, Claude, terminals, friends) runs in the background on your Mac; the Mac app and Klaud Lite are windows onto it. Each Claude runs on its owner's computer through the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), with their own subscription.

More: [how it works](docs/how-it-works.md) · [security](docs/security.md) · [peer-to-peer connections](docs/p2p.md) · [the friends network](docs/network.md) · [updates](docs/updates.md) · [what each app offers](docs/parity.md).

## Development

```bash
git clone https://github.com/kayraucklnc/klaud.git && cd klaud
npm install && npm test

cd packages/mac && npm install
npm run app:dev            # the Mac app, running Klaud from this repo
npm run e2e                # Playwright tests against the demo
npm run app:build          # the .app and the designed .dmg
npm run release            # build, sign and publish a release (see docs/updates.md)
```

```
packages/mac/   the Mac app (React UI in src/, the native shell in src-tauri/)
src/            the engine (core, friends network, Claude, terminals) and Klaud Lite (src/ui)
docs/           guides and design notes
```

Klaud used to be called klaude. Your `~/.klaude` settings, projects and worktrees carry over automatically.

## License

MIT
