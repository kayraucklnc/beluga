# klaude

**A multiplayer terminal for you, your friends, and everyone's Claude.**

klaude is a full-screen, vim-flavoured TUI where a few people share a live group chat with
each other *and* with each person's own Claude Code agent. Ask your Claude, ask your friend's
Claude (it runs on **their** machine with **their** subscription), or ask all of them at
once. Agents can talk to each other, browse each other's shared folders, and write reports that
everyone watches update live. Follow a friend (or their agent) like in Google Docs and your
viewer jumps to whatever they open.

```
 klaude kay's room ● connected │ ★kay◆ ●bob◆ │ following bob
╭──────────────────────╮╭──────────────────────────────────────────╮╭─────────────────────────────╮
│ shared folders       ││ 15:57 bob: hello from bob!               ││ bob:api/NOTES.md ◉ bob ● live│
│›▸ kay:proj           ││ 15:57 kay (you): @claude:bob summarize   ││1 # Bob API                  │
│ ▸ bob:api (ro)       ││   NOTES.md into a report                 ││2                            │
│                      ││ 15:57 ✓ bob's claude ← kay · done        ││3 TODO: add auth             │
│                      ││     ↳ write_report Notes Review          ││                             │
│                      ││     ↳ send_chat                          ││                             │
│                      ││ 15:57 ◆ bob's claude: report is up       ││                             │
╰──────────────────────╯╰──────────────────────────────────────────╯╰─────────────────────────────╯
 NORMAL  chat  policy:ask · i chat · : cmd · @ ask claude · Tab pane · j/k move · q quit
```

## Quick start

Requirements: Node 20+, and [Claude Code](https://claude.com/claude-code) installed and logged in
(`claude` → `/login`) on every machine that offers an agent.

```bash
git clone <this repo> && cd klaude
npm install && npm run build && npm link     # puts `klaude` on your PATH

# You: start a room (shares the current folder read-only by default)
klaude host --name kay

# Friend: paste the invite you sent them
klaude join klaude:eyJ1cmwiOi... --name bob
```

`klaude host` exposes the room through **ngrok** if installed, otherwise a free
**cloudflared** quick tunnel (no account needed). The invite is printed in the chat and copied
to your clipboard. On the same Wi-Fi you can skip tunnels with `--lan --tunnel none`.

## Talking to agents

| You type | What happens |
| --- | --- |
| `hey all` | group chat |
| `@claude refactor the parser` | **your** Claude runs on your machine |
| `@claude:bob why is the API slow?` | **bob's** Claude runs on bob's machine, on bob's subscription, after bob approves |
| `@claudes review this plan` | every Claude in the room answers in parallel |

Everyone sees each agent's progress stream live (tool calls, text, final answer).

Agents get room tools (an in-process MCP server), so they can:

- `send_chat`: post to the group chat
- `list_peers`: see who's here, their shares, and whose agent is online
- `ask_agent`: delegate to another person's Claude and get the answer back (agent to agent)
- `list_peer_files` / `read_peer_file`: browse a friend's shared folders (read-only)
- `write_report`: write `.klaude/reports/<date>-<title>.md`, announce it, and make every
  follower's viewer jump to it live

## Keys and commands

klaude starts in INSERT mode so you can just type. `Esc` gives NORMAL mode, `:` gives COMMAND mode.

| NORMAL key | Action |
| --- | --- |
| `i` / `Enter` | type in chat |
| `@` | start an agent mention |
| `Tab` / `Shift-Tab` | cycle panes: files, chat, viewer |
| `j` `k` / `Ctrl-d` `Ctrl-u` / `g` `G` | move or scroll |
| `l` / `Enter`, `h` / `-` | open, or go up a folder (files pane) |
| `x` | close viewer |
| `Ctrl-Y` / `Ctrl-N` | allow / deny a pending approval (any mode) |
| `y` / `n` / `a` | allow / deny / always-allow (for that person + tool) in NORMAL mode |
| `q` / `Ctrl-c` | quit |

| Command | |
| --- | --- |
| `:open bob:api/src/app.ts` | view a friend's file (live-reloads when it changes) |
| `:follow bob` / `:unfollow` | follow bob and bob's Claude |
| `:peers`, `:invite`, `:help`, `:clear`, `:q` | |
| `:policy ask\|auto\|deny` | how requests from friends for your Claude are handled |
| `:trust bob` / `:untrust bob` | auto-approve one friend |
| `:stop` | abort your Claude's current run |

## CLI

```
klaude host [options]            start a room and print an invite code
klaude join <invite> [options]   join a friend's room

  -n, --name <name>        display name
  -s, --share <spec>       [name=]path[:rw], repeatable. :rw lets your Claude edit there without asking
      --no-share           share nothing (default: current folder, read-only)
      --no-agent           don't offer your Claude to the room
      --policy <p>         ask | auto | deny (default ask)
      --model <id>         model for your Claude
      --tunnel <kind>      auto | ngrok | cloudflared | none (host)
      --lan                listen on all interfaces (host)
  -p, --port <port>        hub port
```

Set `KLAUDE_CLAUDE_PATH` to point at a specific `claude` executable.

## How it works

```
 kay's machine                                        bob's machine
┌─────────────────────────────┐                     ┌─────────────────────────────┐
│ klaude TUI (Ink)            │                     │ klaude TUI (Ink)            │
│  Session ─ Store ─ Shares   │                     │  Session ─ Store ─ Shares   │
│  Claude Agent SDK (kay's    │   AES-GCM frames    │  Claude Agent SDK (bob's    │
│  login) + room MCP tools    │◄──── wss ──────────►│  login) + room MCP tools    │
│  Hub (relay, auth, history) │   ngrok/cloudflared │                             │
└─────────────────────────────┘                     └─────────────────────────────┘
```

- **Hub** (`src/net/hub.ts`): a tiny relay on the host. It does HMAC challenge-response auth,
  routes broadcast/direct frames, stamps `from` so peers can't spoof each other, rate-limits,
  and keeps a short history for late joiners.
- **End-to-end encryption** (`src/net/crypto.ts`): every payload is AES-256-GCM sealed with a
  key HKDF-derived from the invite secret, so the tunnel provider only sees ciphertext.
- **Session** (`src/core/session.ts`): routes chat, agent requests and approvals, file
  requests, focus/follow, and the agent bridge.
- **Agent** (`src/agent/`): the Claude Agent SDK drives each person's local Claude Code install,
  so every agent uses its owner's own subscription. One session is kept per room so the agent
  remembers context.
- **Shares** (`src/core/shares.ts`): read-only file serving with traversal and symlink-escape
  protection. `.env*`, keys, `.ssh`, `.git` and `node_modules` are never served.

## Security model

- The **invite is the key**. Anyone holding it can join and read the room. Only send it to
  people you trust, and start a new room (new secret) to revoke access.
- Friends **cannot** run your agent unless you approve (`policy: ask`, the default), trust
  them for the session, or set `policy: auto`. Trust ends when they disconnect.
- Your agent only auto-runs read-only tools **inside your shares**. Bash, web access, reads
  outside your shares, edits outside `:rw` shares, and `ask_agent` all prompt **you**, whoever
  asked for the work. "Always" is scoped to one person + one tool.
- Credential files (`.env*`, keys, `.ssh`, `.aws`, …) are never served to peers and are blocked
  for your agent by a `PreToolUse` hook. Claude Code settings files are not loaded for room
  sessions, so a friend with `:rw` access can't plant permission rules.
- Each message's sender id is sealed inside the encrypted box, so a tunnel can't re-attribute
  messages. Replayed agent requests are dropped.
- Chat context given to agents is built from **your own** log and marked as untrusted. Still,
  prompt injection is a real risk: keep `policy: ask` with people you don't fully trust.

**Fair use:** each person runs their own Claude with their own account. klaude never shares
credentials between machines; requests for bob's Claude run on bob's computer.

## Development

```bash
npm install
npm run dev -- host --tunnel none   # run from source
npm test                            # unit + multi-peer integration tests
npm run test:coverage               # ≥80% enforced
npm run typecheck
```

## Roadmap

- CRDT co-editing (Yjs) of shared files, beyond live viewing
- Serverless P2P via hyperswarm/holepunching (no tunnel needed)
- Threaded agent-to-agent conversations visible as their own panes
- Per-peer share ACLs and write access for humans
- Syntax highlighting and diff view for agent edits

## License

MIT
