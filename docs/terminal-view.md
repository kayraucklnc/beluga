# The terminal view

A conversation in a worktree or a chat can show three ways, picked in its header (Chat · Terminal ·
Both, or ⇧⌘T): the chat as Beluga draws it, the agent's own terminal app on the same conversation,
or that terminal with the chat beside it. Settings › Terminal › Conversations picks how ones you
haven't switched open.

## One conversation, two ways in

The terminal runs Claude Code's own terminal app (the copy Beluga downloaded) in the worktree, on
the conversation the chat has: `--resume <session>`; a new conversation gets `--session-id` up
front; a fork `--fork-session`. A local model runs in the same Claude Code, pointed at its
endpoint, so its conversations get the same terminal. Codex's conversations stay in the chat (the
switch isn't offered there). The worktree is trusted in Claude Code first (as its own "Yes, I trust
this folder" does), so the terminal opens straight on the conversation, its prompt at the bottom.

Only one side drives at a time. While the terminal is open, a message in the chat (on the Mac or
the phone) waits: the chat says the terminal is driving, and **Take Over** closes the terminal and
gives the conversation back. The terminal won't open over a turn that's still running in the chat.

What's said in the terminal comes back to the chat as it's written: Beluga reads Claude Code's own
transcript (`~/.claude/projects/…/<session>.jsonl`) from where it was when the terminal opened, and
shows each turn as the chat's own, with its steps.

## Beluga in the terminal

The terminal gets what a run in the chat gets: Beluga's tools (served over the tool host, as
Codex's are), Beluga's instructions plus the terminal's, the task's brief, your user settings
(never a project's `.claude/`), and edits without asking in a worktree. Beluga's rules for each
tool call (no edits in the main folder or outside the worktree, a `.env` file asks you) run as a
PreToolUse hook, a small script that asks the daemon (`src/agent/terminal-hook.ts`); if it can't
reach the daemon, the call is refused. Claude Code's own permission prompts still ask you in the
terminal. Codex runs under the sandbox and approvals Beluga gives your own Codex runs.

## Visuals as links

A terminal can't draw a graph or a live table, so in the terminal the `show` tool keeps the
visual in the daemon (`~/.beluga/terminal/visuals/<workspace>.json`) and answers with a token,
`[[visual:7]]`, that Claude writes on a line of its own. The Mac draws a chip over the token (what
it is, Open), and a click (or ⌘↩ for the newest) opens the real visual in a panel beside the
terminal, one tab each. Task keys the board has are links too. In the chat, each token is the
visual itself.

## A terminal you'd use

- **Tabs**: the agent's tab first, then shells in the worktree (⌘T); ⌘1–9 and ⇧⌘[ ] move between
  them. Each keeps its programs and scrollback while hidden, so vim, a dev server or htop carry on.
- **Splits**: ⌘D right, ⇧⌘D down, ⌥⌘ arrows (or ⌘[ ⌘]) to move, ⇧⌘↩ to zoom one pane, ⌘W to close.
- **Find** ⌘F, **clear** ⌘K, **text size** ⌘+ ⌘− ⌘0, and the GPU renderer.
- **Your look**: colours, font, cursor and spacing from Ghostty, iTerm2, Terminal, Alacritty,
  kitty, WezTerm or Warp, or a preset (Dracula, Catppuccin, Tokyo Night, Nord, Gruvbox, Rosé Pine,
  Solarized).
- **Your keys**: Ghostty's `keybind` lines and iTerm2's key mappings and menu shortcuts come over
  with the look (`src/terminal/import/keys.ts`): tabs, splits, moving between panes, text size, keys
  that type something. Settings › Terminal lists every key and where it came from.
- **The terminal's keys come first**: while you type in the terminal, its keys win over Beluga's
  shortcuts (the menu bar lets go of them, Close Window's ⌘W too). Settings › Terminal can keep
  Beluga's instead.

## The phone

The phone sees when the terminal drives a conversation (`ConvView.terminal`, companion 1.36): it
says so in place of the message box, with Take Over.

## Where it lives

- Daemon: `src/core/agent-term.ts` (open, drive, take over, visuals), `src/core/agent-term-sync.ts`
  (transcripts into the chat), `src/agent/runtime/claude/terminal.ts` (the launch),
  `src/ipc/agent-term-api.ts`.
- Mac: `packages/mac/src/agent-term/` (the view, panes, links, visuals panel, banner),
  `lib/term-keys.ts`, `lib/term-panes.ts`, `lib/convo-mode.ts`, `lib/terminal-themes.ts`.
