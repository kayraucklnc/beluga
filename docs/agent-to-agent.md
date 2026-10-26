# Agent-to-agent: one model

Where Beluga is going with people, sharing and Claudes talking to Claudes. Decided 2026-10-26.

## Why it feels confusing today

Beluga grew **two people systems** side by side:

| | Rooms (`src/net/hub.ts`) | Network (`src/net/mesh/`) |
|---|---|---|
| Who | "In this room": whoever joined the host's link | Friends, DMs, channels |
| Needs | the host's Mac online, one room at a time | nothing; messages wait while someone is offline |
| Has | trust cards, project and worktree sharing, Shared with me, shared folders | chat, chat files, Ask Claude (no tools), gateway tasks |
| Versions | room protocol 3, exact match, you're told | `PROTO` 1; a mismatch just looks offline |

So every feature lives somewhere else:

- **Project invites.** A project invite becomes one "Shared with me" row per worktree (`project-invites.ts` `syncWorkspaces`). The rows disappear when the host goes offline, and messages sent meanwhile are dropped.
- **Trust.** Trust can be set in five places.
- **Approvals.** A friend's request is approved in Requests, the pop-up or the menu bar, never in the DM it came from (`ConversationView` has no approvals).
- **Results.** Only the asker sees a result. Nothing is posted to the DM the two people share.
- **Asking from chats.** Asking your own Claude in a DM or channel can't do anything, because it has no tools (`chat-answer.ts`).
- **Secrets.** Secrets are refused by three separate layers, even after the owner said yes (`serve.ts`, `result.ts`, `agent/prompt.ts`).
- **`/invite`.** It copies a room link.
- **Older Macs.** An older Mac drops frames it can't parse, so a task to it waits seven days and then reads "didn't come online in time".

## The model

**People = friends.** There is one list. Trust is a property of a friend, set in one place: their card.
Rooms fold into this: an old room link opens as a friend request.

**You add friends to three kinds of thing:**

1. **A conversation**: a DM or a channel (a group of friends). A "room" is just a channel now.
2. **A project**: it shows in *their* Projects list like their own, with *your* avatar on it, and
   its worktrees are nested beneath it. There's one row per project, never one per worktree.
3. **A folder** (shared files): this is a separate thing that lives under Files, never mixed with
   projects.

**@ata is Ata; @claude:ata is Ata's Claude.** Mentioning a friend tells them; naming their Claude asks it.
Your Claude may still decide to ask a friend's Claude when the work needs it (with the usual check).

**Every conversation can act.** In a DM, a channel or a worktree, your Claude has its full tools
when *you* ask it. A request's approval card appears in that conversation, on both sides. Its
result is posted there too, so everyone involved sees it.

**A worktree is shared live.** Everyone added to it can talk to its agent. Each person shows as
online, away or offline. A message to someone offline waits and says so, instead of vanishing.

**Versions are visible.** Every link says which Beluga version it runs and what it can do
(`features`).

- A request someone's Beluga can't take fails at once: "Ata's Beluga 1.1 can't take file requests
  yet. Ask Ata to update".
- Anything both Macs support still works.
- Only the person who hit an error is told about it.

**Secrets.** Trust, rules and *Always* never cover a secret.

- The owner gets a separate approval each time, marked as a secret ("This is a private key").
- If they allow it, the file is sent, and both Claudes are told it was approved, so neither refuses
  afterwards.

## Plan, in order

1. **Versions and fast errors.** Links carry the app version and features. Requests to someone who
   can't take them fail at once, with an update nudge.
2. **One people list.** "In this room" goes away, and the friend card holds the only trust control.
   Room links become friend requests.
3. **A `/invite` that does it.** `/invite` adds a friend. `/invite @ata` adds Ata to the chat,
   project or worktree you're in.
4. **Projects over friends' links.** You share a project with a friend over the mesh, with nobody
   hosting. It shows in their Projects with your avatar.
5. **Files ≠ projects.** Shared folders move to Files, and "Shared with me" goes away.
6. **Live worktrees.** Everyone added can talk to the agent. Presence shows on each person, and
   there's a clear offline state.
7. **Act from any chat.** Your Claude has its tools in DMs and channels, and approvals appear
   inline on both sides.
8. **Results for everyone.** A task's request, approval and result are posted into the
   conversation it came from.
9. **Secrets with a separate approval.** Each one is approved on its own, and the Claudes are told
   the truth about it.
10. **Redesign the multi-person chat.** It shows who's who, whose Claude is working, and what's
    waiting on whom.
