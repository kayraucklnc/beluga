# Security


Inviting someone exposes your Claude, with your permissions, to other people. Beluga is built around that:

- **Solo by default.** Nothing is reachable until you click Invite.
- **The invite is the key.** Anyone with the link can join, so share it privately. The host can **remove** someone, **replace the link** (the old one stops working; people already in stay), or **close the room** to newcomers.
- **Nobody can speak for someone else.** Everyone has their own signing key (kept in `~/.beluga/identity.json`), their id comes from it, and **every message is signed**. Not even the host relaying the room can forge a message from you, so a trust level you gave someone can't be borrowed. Requests that act on your computer must be fresh: an old one replayed later is dropped.
- **You decide how much each person may do**: can't use your Claude, ask each time, trusted, or full trust (see *Working with people*). Unanswered approvals are declined after 5 minutes.
- **Reaching outside your shared folders asks you.** Friends' requests use your shared folders; reading anything else, shell commands, web requests and edits outside a `:rw` folder ask you first, even ones Claude Code would normally auto-approve. Only **full trust** skips these.
- **Commands from friends are yours to approve.** A friend (or their Claude) asking to run a command on your computer always shows you the exact command first, unless you fully trust them. It runs with no input, a time limit and capped output, and you get a notice afterwards.
- **Secrets stay put.** `.env` files, keys, `.ssh`, `.aws` and similar are never shared, sent or readable by friends' requests, whatever the trust level.
- **Files are sent one at a time.** When you approve sending a file, only a copy of that file is shared, with only that person, for 15 minutes.
- **Work from friends is yours to approve.** Starting a worktree on your computer or taking over someone's work asks you first (unless you fully trust them); turn it off in Settings → Workspaces.
- **Direct connections are pinned.** A direct (peer-to-peer) connection is encrypted with Noise, has forward secrecy, and only completes with the host whose key is in the invite. The relay and the DHT see IP addresses, never content. See [docs/p2p.md](p2p.md).
- **Untrusted files are handled carefully.** Images from friends are size-checked before decoding, and SVGs can't load files from your disk.
- **Be aware:** a friend's message can try to talk your Claude into things (prompt injection). Keep approvals on for people you don't fully trust.
