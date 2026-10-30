# Security


Inviting someone exposes your agent, with your permissions, to other people. Beluga is built around that:

- **Solo by default.** Nothing is reachable until you click Invite.
- **The invite is the key.** Anyone with the link can join, so share it privately. The host can **remove** someone, **replace the link** (the old one stops working; people already in stay), or **close the room** to newcomers.
- **Nobody can speak for someone else.** Everyone has their own signing key (kept in `~/.beluga/identity.json`), their id comes from it, and **every message is signed**. Not even the host relaying the room can forge a message from you, so a trust level you gave someone can't be borrowed. Requests that act on your computer must be fresh: an old one replayed later is dropped.
- **You decide how much each person may do**: can't use your agent, ask each time, trusted, or full trust (see *Working with people*). Unanswered approvals are declined after 5 minutes.
- **Reaching outside your shared folders asks you.** Friends' requests use your shared folders; reading anything else, shell commands, web requests and edits outside a `:rw` folder ask you first, even ones Claude Code would normally auto-approve. Only **full trust** skips these. Folders are checked where they really are: a link inside a shared folder can't reach a file outside it, and a harmlessly named link to a key is still refused as the key.
- **Editing files never quietly becomes running commands.** A friend's change to a file that makes code run later (git hooks and `.git/config`, `.claude/` and `.mcp.json`, `.vscode/`, `.husky/`, `.envrc`, `package.json`, `Makefile`, CI workflows, shell start-up files, login items, `.command` files) asks you every time, even in a `:rw` folder, with only **Allow once** and **Decline**. Only **full trust** skips it.
- **Commands from friends are yours to approve.** A friend (or their agent) asking to run a command on your computer always shows you the exact command first, unless you fully trust them. It runs with no input, a time limit and capped output, and you get a notice afterwards.
- **A friend's request can't run on and on.** It stops after 20 minutes or 50 turns, after asking you to approve 8 steps, or when you decline 2 in a row, and the friend is told why. It takes at most 4 screenshots, commands like `screencapture` included.
- **Secrets stay put unless you send one yourself.** `.env` files, keys, `.ssh`, `.aws` and similar are never shared or readable by friends' requests, and commands or asks to their agent that touch them are refused, whatever the trust level. A friend can only ask for one secret file at a time (`get_file`): you then get a separate approval that says what it is ("kay's agent wants your private SSH key id_ed25519"), every time, with only **Allow once** and **Decline**. Trust, rules and Always never cover it. If you allow it, Beluga sends that one file (no agent reads it), and their agent is told you approved it. Beluga's own private files in `~/.beluga` (your identity, settings, rules) and the keychains are never sent, whoever approves.
- **Your own `.env` files are yours.** You see and edit them in Files (friends never see even their names). Your own agent asks before it reads or changes one, even when it asks you nothing else: allow once, always for that project, or always. Take it back in Settings › Environment › Your agent. Keys, `.ssh`, `.aws` and Beluga's own files stay refused. Templates (`.env.example`, `.env.sample`…) hold no secrets and are ordinary files.
- **Files are sent one at a time.** When you approve sending a file, only a copy of that file is shared, with only that person, for 15 minutes.
- **Work from friends is yours to approve.** Starting a worktree on your computer or taking over someone's work asks you first (unless you fully trust them); turn it off in Settings → Workspaces.
- **Direct connections are pinned.** A direct (peer-to-peer) connection is encrypted with Noise, has forward secrecy, and only completes with the host whose key is in the invite. The relay and the DHT see IP addresses, never content. See [docs/p2p.md](p2p.md).
- **Untrusted files are handled carefully.** Images from friends are size-checked before decoding, and SVGs can't load files from your disk.
- **Be aware:** a friend's message can try to talk your agent into things (prompt injection). Keep approvals on for people you don't fully trust.

## Codex runs

Claude Code asks Beluga before every step it takes, so the rules above are checked one step at a time. Codex runs its own commands and edits without asking first, so on Codex the same rules are kept by **Codex's own sandbox** instead: a permissions profile Beluga sets for each run, enforced by macOS.

- Writes go only to the run's own folders. A project's main folder, and a plan while it's being made, are read only.
- `.env` files, keys and credential stores (`.ssh`, `.aws`, the GitHub CLI's token, the keychains, Beluga's own files in `~/.beluga`, Codex's and Claude's logins) can't be read at all, so no command reaches them however it's written. Templates like `.env.example` are hidden too: the sandbox can't tell them apart.
- A friend's task runs with the network off, without your own Codex MCP servers, plugins and hooks, and without your environment's tokens. It can never ask to go past the sandbox. Beluga's own tools (the room, the board) still check each call against the friend's limits.
- Your own run may ask to go past the sandbox (a command that needs more): you get the same approval prompt as for Claude.
- Guests can't use Codex.
- Quick side calls on Codex (answering in a chat, naming a worktree, drafting a task) run as tightly as a friend's task, whoever asked: read only, your home and `.env` files out of reach, none of your own Codex tools, and no network unless the call runs commands (a pull request's review). A call given no tools can't read the folder either.
- A talk or cross-reference between agents only looks: a Codex speaker's sandbox writes nowhere, whatever the worktree allows.

<!-- codex-trust-table -->
| Who asks | Trust | Files | Rest of your home | Network | `.env`, keys, credential stores | Going past the sandbox | Your Codex tools |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Your own run | — | write the run's folders | read | on | denied by the sandbox | asks you | on |
| A friend's task | Ask me each time, Trusted | write the run's folders | denied | off | denied by the sandbox | not possible | off |
| A friend's task | Full trust | write the run's folders | read | off | denied by the sandbox | not possible | off |
| A guest | invited into one project | refused | | | | | |
<!-- /codex-trust-table -->
