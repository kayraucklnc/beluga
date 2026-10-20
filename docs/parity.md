# Parity: the terminal app and the Mac app

Both clients drive the same core through `src/ipc/api.ts`. This page lists every way in and where each client shows it. `tests/parity.test.ts` fails when a command, a UI action, a menu or an API method exists without a row here.

Columns: **Core** is the API method or intent it uses; **Terminal** and **Mac** are where you find it.

## Slash commands

| Command | Core | Terminal | Mac |
|---|---|---|---|
| `/invite` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar footer Invite · File › Invite… · ⌘K |
| `/overview` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar › Overview · Go › Overview (⌥2) |
| `/room` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar › Chat (⌥1) |
| `/new` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar project ⌥ button · File › New Worktree… (⌘⇧N) · ⌘K · empty Overview / chat › New Worktree |
| `/chat` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar + · File › New Chat (⌘N) |
| `/review` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · the right panel's Changes tab (⌥⌘1; a diff opens in full with ⌘↩) |
| `/pr` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar PR · ⌘K |
| `/run` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar Run (shows the terminal, keeps the keyboard in the message box) · the panel's Terminal tab ▶ · person sheet “Run a command…” |
| `/terminal` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · the right panel's Terminal tab (⌥⌘3) or the drawer under the chat (⌘J, Settings › Terminal picks which) · Go › Terminal (⌥6) |
| `/setup` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · the panel terminal's Commands… |
| `/handoff` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar ⋯ › Hand off |
| `/model` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Composer model picker |
| `/search` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar › Search · ⌘⇧F |
| `/usage` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar › Usage (⌥5) |
| `/inbox` | `session.submit` → `runCommand` | typed in the composer · top bar “● N new” | typed in the composer · toolbar bell (notification centre) · the right panel's Info › Notifications · Go › Inbox · ⌘K › Notifications |
| `/template` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Palette › Start from a template… |
| `/shell` | `session.submit` → `runCommand` (`/shell fish`, `default`, `login on\|off`, `args …`) | typed in the composer · Settings › Workspaces › Terminal | typed in the composer · Settings › Terminal › Shell |
| `/env` | `session.submit` → `runCommand` (`/env KEY=value`, `KEY=` removes, `project KEY=value`) | typed in the composer · Settings › Workspaces › Environment variables | typed in the composer · Settings › Environment |
| `/compact` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar ⋯ › Compact |
| `/visualize` | `session.submit` → `runCommand` (`/graph` too): your words in the chat, Claude asked for a `klaud-graph` | typed in the composer; the answer's graph shows as its JSON | typed in the composer · ⌘K › Draw This as a Graph; the graph is drawn (docs/graphs.md) |
| `/merge` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar Merge (the main button when ready) · Workspace › Merge (⇧⌘M) |
| `/commit` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar Commit · Workspace › Commit (⇧⌘C) |
| `/fork` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar ⋯ › Fork |
| `/finder` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar ⋯ › Finder · the panel's Info › Finder · Files › Show in Finder |
| `/archive` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar ⋯ › Archive · Usage row Archive |
| `/restore` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Archived row › Restore |
| `/delete` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Archived row › Delete |
| `/project` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar Projects + · File › Add Project… |
| `/copy` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Hover on an answer › Copy · ⌘K |
| `/follow` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Person sheet › Follow |
| `/unfollow` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Person sheet › Stop following |
| `/open` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Shared files · links in chat |
| `/get` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Viewer › Download |
| `/close` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Viewer › Close |
| `/stop` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · ⌘K › Stop your Claude everywhere (stopping in one conversation: `host.stopRun`, Mac only) |
| `/policy` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Settings › General |
| `/trust` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Trust card · person sheet · Settings › People |
| `/untrust` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Person sheet |
| `/people` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar › People |
| `/share` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · File › Share a Folder… |
| `/unshare` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Share a Folder… › Stop sharing |
| `/settings` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · klaud › Settings… (⌘,) |
| `/name` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Settings › General › Your name |
| `/theme` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Settings › Appearance |
| `/zoom` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · ⌘+ / ⌘− / ⌘0 · View menu |
| `/clear` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · /clear in the composer (sheet) |
| `/plan` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Composer Act/Plan chip (⇧Tab) |
| `/remove` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Person sheet › Remove |
| `/newlink` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Settings › People › New link |
| `/lock` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Settings › People › Take new people |
| `/help` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Help › Keys and Commands · ⌘K |
| `/quit` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · klaud › Quit (⌘Q) · tray |

## UI actions (`UiAction`, shared by both clients)

| Action | Terminal | Mac |
|---|---|---|
| `open_ws` | click / keys | click (`runUiActionWith`) |
| `toggle_project` | click / keys | click (`runUiActionWith`) |
| `toggle_fold` | click / keys | click (`runUiActionWith`) |
| `agents_menu` | click / keys | click (`runUiActionWith`) |
| `toggle_group` | click / keys | click (`runUiActionWith`) |
| `toggle_archive` | click / keys | click (`runUiActionWith`) |
| `project_menu` | click / keys | click (`runUiActionWith`) |
| `archived_menu` | click / keys | click (`runUiActionWith`) |
| `new_worktree` | click / keys | click (`runUiActionWith`) |
| `new_chat` | click / keys | click (`runUiActionWith`) |
| `add_project` | click / keys | click (`runUiActionWith`) |
| `view` | click / keys | click (`runUiActionWith`) |
| `close_tab` | click / keys | click (`runUiActionWith`) |
| `ws` | click / keys | click (`runUiActionWith`) |
| `review_file` | click / keys | click (`runUiActionWith`) |
| `plan_toggle` | click / keys | click (`runUiActionWith`) |
| `plan_full` | click / keys | click (`runUiActionWith`) |
| `open_shared` | click / keys | click (`runUiActionWith`) |
| `knock` | click / keys | click (`runUiActionWith`) |
| `shell_open` | click / keys | click (`runUiActionWith`) |
| `shell_run` | click / keys | click (`runUiActionWith`) |
| `shared_menu` | click / keys | click (`runUiActionWith`) |
| `answer` | click / keys | click (`runUiActionWith`) |
| `inbox` | click / keys | click (`runUiActionWith`) |
| `model_menu` | click / keys | click (`runUiActionWith`) |
| `template` | click / keys | click (`runUiActionWith`) |
| `templates_menu` | click / keys | click (`runUiActionWith`) |
| `trust` | click / keys | click (`runUiActionWith`) |
| `trust_later` | click / keys | click (`runUiActionWith`) |
| `search_hit` | click / keys | click (`runUiActionWith`) |
| `term_tab` | click / keys | click (`runUiActionWith`) |
| `term_new` | click / keys | click (`runUiActionWith`) |
| `ws_more` | click / keys | click (`runUiActionWith`) |
| `open_link` | click / keys | click (`runUiActionWith`) |
| `paste_image` | click / keys | click (`runUiActionWith`) |
| `none` | click / keys | click (`runUiActionWith`) |

## Menus and dialogs (`MenuKind`, from `menuSpec`)

| Menu | Terminal | Mac |
|---|---|---|
| `welcome` | menu overlay | sheet |
| `settings` | menu overlay | Settings window |
| `model` | menu overlay | model picker / sheet |
| `inbox` | menu overlay: notices (Today, then Earlier), Showing: All / Unread / Needs you / Mentions, Mark all as read, Clear one by one…, Clear all | notification centre under the toolbar bell: the same filters and groups, click to go there, hover for read/unread and ×, Mark all read, Clear all |
| `person` | menu overlay | a card beside the person's row (centred from the palette): trust as a segmented control, Message / Ask Claude / Run / Follow / Files buttons, Remove with an alert; your own row is your account card (name, who may use your Claude). Right-click: Trust submenu and the same actions |
| `confirm` | menu overlay | sheet |
| `project` | menu overlay | sheet and right-click menu |
| `archived` | menu overlay | sheet and right-click menu |
| `agents` | menu overlay | sheet |
| `ws_share` | menu overlay | Share sheet: everyone in the room with an access popup (Can work here / Can follow / No access), Invite by Link… |
| `shared` | menu overlay | sheet (Chat / Files / Changes, who's in it, Leave… with an alert; the people button on its toolbar) and right-click menu |
| `clear` | menu overlay | sheet |
| `invite_person` | menu overlay | sheet: workspaces with Invite buttons, Work here / Follow |
| `share_folder` | menu overlay | Share a Folder sheet: the Open panel (or a path), your projects, who sees it (everyone or only some people), Claude may edit, what you share now with Stop Sharing |
| `share_who` | menu overlay | the Share a Folder sheet with the folder filled in |
| `pr` | menu overlay | sheet |
| `scripts` | menu overlay | sheet |
| `templates` | menu overlay | sheet |
| `handoff` | menu overlay | sheet |
| `remote_ws` | menu overlay | sheet |
| `ws_more` | menu overlay | sheet |
| `invite_link` | menu overlay | Invite People sheet: Invite to popup, They can (Watch / Prompt / Edit), link checkboxes, Copy Invite Link (Return, says Copied), how they join, people waiting, active links with Copy and Revoke |
| `guest_add` | menu overlay | the guest's card: Add ▾ beside the projects they're in |

## API methods

| Method | Terminal | Mac |
|---|---|---|
| `session.submit` | ✓ | ✓ |
| `session.copyInvite` | ✓ | ✓ |
| `session.copyLastAnswer` | ✓ | ✓ |
| `session.copyText` | ✓ | ✓ |
| `session.setPrefs` | ✓ | ✓ |
| `session.setPlanMode` | ✓ | ✓ |
| `session.compact` | ✓ (/compact, ⋯ › Compact) | ✓ (context meter › Compact now) |
| `session.setClaudeSharing` | ✓ | ✓ |
| `session.rename` | ✓ | ✓ |
| `session.zoom` | ✓ | ✓ |
| `session.shareFolder` | ✓ | ✓ |
| `session.unshareFolder` | ✓ | ✓ |
| `session.follow` | ✓ | ✓ |
| `session.clearChat` | ✓ | ✓ |
| `session.removePerson` | ✓ | ✓ |
| `session.newInviteLink` | ✓ | ✓ |
| `session.setRoomOpen` | ✓ | ✓ |
| `session.setFriendWorktrees` | ✓ | ✓ |
| `session.setAccess` | ✓ | ✓ |
| `session.runOnPeerByHand` | ✓ | ✓ |
| `session.stopAgent` | ✓ | ✓ |
| `session.quit` | ✓ | ✓ |
| `session.serveFolder` | ✓ | ✓ |
| `session.localLocation` | ✓ | ✓ |
| `session.testNotification` | ✓ | ✓ |
| `host.answerApproval` | ✓ | ✓ |
| `host.promote` | ✓ | ✓ |
| `host.stopRun` | — (Mac only, see below; the terminal has `/stop`) | ■ Stop beside Queue/Send now · ⌘. · Conversation › Stop Claude · Stop on a running answer |
| `host.cancelQueued` | ✓ | ✓ |
| `host.reorderQueued` | — (no reordering; see below) | ✓ queue tray ↑ ↓ |
| `inbox.read` | ✓ | ✓ |
| `inbox.unread` | – (see below) | ✓ |
| `inbox.clear` | ✓ (all, or one by one) | ✓ (all, or × on one) |
| `questions.answer` | ✓ | ✓ |
| `questions.pick` | ✓ | ✓ |
| `people.setTrust` | ✓ | ✓ |
| `people.dismissPrompt` | ✓ | ✓ |
| `people.forget` | ✓ | ✓ |
| `sharing.invite` | ✓ | ✓ |
| `sharing.remove` | ✓ | ✓ |
| `sharing.leave` | ✓ | ✓ |
| `invites.create` | ✓ | ✓ |
| `invites.revoke` | ✓ | ✓ |
| `invites.copyLink` | ✓ | ✓ |
| `invites.letIn` | ✓ | ✓ |
| `invites.decline` | ✓ | ✓ |
| `invites.change` | ✓ | ✓ |
| `invites.remove` | ✓ | ✓ |
| `remote.requestWorktree` | ✓ | ✓ |
| `remote.handoff` | ✓ | ✓ |
| `diff.load` | ✓ | ✓ |
| `diff.select` | ✓ | ✓ |
| `shell.run` | ✓ the read-only shell in a shared workspace's Terminal tab | ✓ the search field over a shared workspace's Files (find + grep) |
| `shell.openEntry` | ✓ (click a name in a shared workspace's Terminal tab) | – (the Files tab opens files directly) |
| `files.browseTo` | ✓ | ✓ |
| `files.enter` | ✓ | ✓ |
| `files.up` | ✓ | ✓ |
| `files.loadDir` | ✓ | ✓ |
| `files.open` | ✓ | ✓ |
| `files.openSpec` | ✓ | ✓ |
| `files.download` | ✓ (to ~/Downloads/klaud) | ✓ · `to`: Save… dialog |
| `files.downloadSpec` | ✓ | ✓ |
| `files.closeViewer` | ✓ | ✓ |
| `files.readImage` | ✓ | ✓ |
| `files.readImageFile` | – (the terminal shows Markdown as text) | ✓ images in the Markdown reader (`![](diagram.png)` next to the file); PDFs drawn page by page in Files, Changes and the reader |
| `workspaces.scratch` | – | ✓ the panel's Scratch tab: the workspace's `.klaud/scratch/` folder, newest first, live |
| `files.read` | – | ✓ a changed file as itself in Changes (Markdown formatted), without moving the Files tab's open file |
| `workspaces.open` | ✓ | ✓ |
| `workspaces.load` | — (opening a workspace loads it) | Overview › Archived › Read Conversation (read-only, stays in the Overview) |
| `workspaces.refresh` | ✓ | ✓ |
| `workspaces.newWorktree` | ✓ | ✓ |
| `workspaces.newChat` | ✓ | ✓ |
| `workspaces.startChat` | ✓ | ✓ |
| `workspaces.startWorktree` | ✓ | ✓ |
| `workspaces.branches` | — (Mac only: worktrees start from the default branch) | New worktree › Based on popup |
| `workspaces.fork` | ✓ | ✓ |
| `workspaces.continueInWorktree` | — (asking Claude for a change in a main-folder chat moves it; the core runs the same `continueInWorktree`) | Continue in New Worktree… (toolbar and the ask banner) › sheet: Task, Based on, Name |
| `workspaces.archive` | ✓ | ✓ |
| `workspaces.restore` | ✓ | ✓ |
| `workspaces.remove` | ✓ | ✓ |
| `workspaces.commit` | ✓ | ✓ |
| `workspaces.merge` | ✓ | ✓ |
| `workspaces.prepareRemoval` | ✓ | ✓ |
| `workspaces.applyEnvBack` | ✓ | ✓ |
| `workspaces.askClaudeToReview` | ✓ | ✓ |
| `workspaces.askClaudeToMerge` | ✓ | ✓ |
| `workspaces.compact` | ✓ | ✓ |
| `workspaces.openInFinder` | ✓ | ✓ |
| `workspaces.setGroup` | ✓ | ✓ |
| `workspaces.renameGroup` | – | ✓ (group row › Rename) |
| `workspaces.ungroup` | – | ✓ (group row › Ungroup / Delete Group) |
| `workspaces.arrange` | — (Mac only, see below; the terminal lists projects in the order you arranged them) | drag projects and groups in the sidebar, Move Up / Move Down (⌃⌘↑/↓), Move to Group ▸ |
| `workspaces.newGroup` | — (Mac only, see below) | Projects + › New Group, right-click › New Group, Move to Group ▸ New Group… |
| `workspaces.showProject` | — (Mac only, see below; the terminal adds it back with /project add) | Hidden Projects in the sidebar, Settings › Workspaces, the Add Projects sheet's Show |
| `workspaces.hideProject` | ✓ | ✓ |
| `workspaces.cleanAgentWorktrees` | ✓ | ✓ |
| `workspaces.otherOrigins` | — (Mac only) | who made each worktree made outside Klaud (picks the right conversation; never shown as a tool's name) |
| `workspaces.otherActivity` | — (Mac only) | worktrees made outside Klaud listed after a project's own, most recently active first (5, then Show N more) |
| `workspaces.worktreeInfo` | — (Mac only) | the page a worktree from another tool shows when it has no conversation (or About This Worktree) |
| `workspaces.showConversation` | — (Mac only) | that page › Earlier conversations › Show |
| `workspaces.removeOther` | — (Mac only) | that page › Remove Worktree… (asks first; keeps the branch) |
| `workspaces.staleOthers` | — (Mac only) | a project's Clean Up Worktrees… (its right-click menu and its home) |
| `workspaces.cleanUpOthers` | — (Mac only) | Clean Up Worktrees… › Remove (only what you ticked; branches kept) |
| `workspaces.addProject` | ✓ | ✓ |
| `workspaces.addFolder` | ✓ | ✓ |
| `workspaces.selectFile` | ✓ | ✓ |
| `workspaces.review` | — (Mac only: the terminal loads it by opening the Diff tab) | the right panel's Changes tab (loads and refreshes the changes while you stay in the chat) |
| `workbench.run` | ✓ | ✓ |
| `workbench.stopRun` | ✓ | ✓ |
| `workbench.runSetup` | ✓ | ✓ |
| `workbench.setScript` | ✓ | ✓ |
| `workbench.shareScripts` | ✓ | ✓ |
| `workbench.setModel` | ✓ | ✓ |
| `workbench.createPr` | ✓ | ✓ |
| `workbench.fixChecks` | ✓ | ✓ |
| `workbench.openPr` | ✓ | ✓ |
| `workbench.refreshPrs` | ✓ | ✓ |
| `workbench.editPrPrompt` | ✓ | ✓ |
| `workbench.resetPrPrompt` | ✓ | ✓ |
| `workbench.measureDisk` | ✓ | ✓ |
| `workbench.search` | ✓ | ✓ |
| `workbench.openHit` | ✓ | ✓ |
| `workbench.saveTemplate` | ✓ | ✓ |
| `workbench.removeTemplate` | ✓ | ✓ |
| `terminals.shell` | ✓ | ✓ |
| `terminals.global` | ✓ | ✓ |
| `terminals.close` | ✓ | ✓ |
| `terminals.rename` | shows the names in the terminal tabs (renaming is Mac-only for now) | ✓ double-click a shell tab, or right-click › Rename… (Return saves, Escape cancels, empty resets) |
| `env.get` | — (`/env` lists the names from `envKeys`) | ✓ Settings › Environment (values only go to the screen that asks) |
| `env.set` | via `/env` | ✓ Settings › Environment |
| `attachments.add` | ✓ | ✓ |
| `attachments.expand` | ✓ | ✓ |
| `attachments.read` | — (images open in the viewer, drawn as text) | ✓ images shown in messages |
| `attachments.open` | — | ✓ image full size › Open (in Preview) |
| `daemon.stop` | ✓ | ✓ |
| `local.listDirs` | ✓ | ✓ |
| `local.openFolder` | ✓ | ✓ |
| `projects.add` | `/project add <path>` (adds a folder of projects too) | ✓ Add projects sheet, Choose Folders…, drop folders on the sidebar |
| `projects.addFolder` | `/project folder <path>` | ✓ (a dropped folder of projects is watched) |
| `projects.suggest` | — | ✓ "On this Mac" in the Add projects sheet |
| `projects.icon` | — (a terminal can't draw images) | ✓ project icons in the sidebar |
| `projects.iconAt` | — | ✓ icons of suggested folders |
| `projects.setIcon` | — | ✓ right-click a project › Change Icon… |
| `network.setEnabled` | — (Mac only, see below) | ✓ the Friends card’s Turn On, Settings › People & access › Talk with friends directly (starts and stops live) |
| `network.status` | — (Mac only, see below) | ✓ the network is on (the Friends card, Settings › People & access) |
| `network.friends.list` | — (Mac only, see below) | ✓ sidebar Friends (presence dots, notes, unread, relayed link) |
| `network.friends.invite` | — (Mac only, see below) | ✓ Add a Friend sheet › Create Invitation (code, link, QR, expiry) |
| `network.friends.accept` | — (Mac only, see below) | ✓ Add a Friend sheet › Have a code or link? (pasted from the clipboard; `klaud://add…` links open it) |
| `network.friends.cancelInvite` | — (Mac only, see below) | ✓ Add a Friend sheet › Cancel Invitation; replacing a group link |
| `network.friends.remove` | — (Mac only, see below) | ✓ right-click a friend › Remove… (alert); the conversation’s ⋯ |
| `network.dm.send` | — (Mac only, see below) | ✓ the conversation’s message box; Send Again on an undelivered one |
| `network.dm.history` | — (Mac only, see below) | ✓ Show Earlier Messages |
| `network.groups.list` | — (Mac only, see below) | ✓ sidebar Groups (unread, join requests) |
| `network.groups.create` | — (Mac only, see below) | ✓ New Group sheet (name, friends with checkboxes) |
| `network.groups.send` | — (Mac only, see below) | ✓ the group’s message box |
| `network.groups.history` | — (Mac only, see below) | ✓ Show Earlier Messages |
| `network.groups.addMember` | — (Mac only, see below) | ✓ Add People… sheet; right-click a friend › Add to Group ▸ |
| `network.groups.removeMember` | — (Mac only, see below) | ✓ group info › a member’s menu › Remove… (alert) |
| `network.groups.setAdmin` | — (Mac only, see below) | ✓ group info › a member’s menu › Make Admin / Remove as Admin |
| `network.groups.leave` | — (Mac only, see below) | ✓ Leave Group… (alert) from the sidebar, the header ⋯ or the group info |
| `network.groups.rename` | — (Mac only, see below) | ✓ rename in place in the group info, or the sidebar (double-click, Rename…) |
| `network.groups.invite` | — (Mac only, see below) | ✓ group info › Invite with a Link (Approve Each Request / Anyone with the Link), Copy Invite Link |
| `network.groups.join` | — (Mac only, see below) | ✓ Join a Group sheet (`klaud://join#…` links) |
| `network.groups.approve` | — (Mac only, see below) | ✓ group info › Asking to Join › Approve |
| `network.groups.decline` | — (Mac only, see below) | ✓ group info › Asking to Join › Decline |
| `network.presence.set` | — (Mac only, see below) | ✓ your status (sidebar footer, menu bar, palette), Away when idle |
| `network.presence.get` | — (Mac only, see below) | ✓ the shared state’s `network.self` (no call needed) |
| `network.read` | — (Mac only, see below) | ✓ opening a conversation reads it (the `conversation` view is shown); Mark as Read on a group |
| `network.post` | — (Mac only, see below) | ✓ a conversation's message box: words, files waiting in the box, and the Ask Claude menu (yours, everyone's, one person's); Send Again on an undelivered one |
| `network.files.add` | — (Mac only, see below) | ✓ the paper clip (Open panel), files dropped anywhere on a conversation |
| `network.files.addData` | — (Mac only, see below) | ✓ files and pictures pasted into the message box (and picked in a browser) |
| `network.files.download` | — (Mac only, see below) | ✓ a file card's Download (files up to 50 MB come by themselves); Try Again on one that didn't come |
| `network.files.cancel` | — (Mac only, see below) | ✓ a file card's × while it comes; right-click › Stop Downloading |
| `network.files.open` | — (Mac only, see below) | ✓ click a file card or a picture; right-click › Open |
| `network.files.reveal` | — (Mac only, see below) | ✓ a file card's folder button; right-click › Show in Finder |
| `network.files.saveTo` | — (Mac only, see below) | ✓ right-click a file › Save As… (the Save panel) |
| `network.files.preview` | — (Mac only, see below) | ✓ pictures shown in the chat |
| `network.channels.main` | — (Mac only, see below) | ✓ All Friends (the first chat tab, the top of sidebar Channels): made the first time it's opened |
| `stripe.connect` | — (Mac only, see below) | ✓ Connect Stripe… (a project's right-click and ⋯ menus, the Inspector's Earnings row, the Overview's hint and Earnings card): the Connect Stripe sheet checks the key with Stripe and shows the account |
| `stripe.disconnect` | — (Mac only, see below) | ✓ the Connect Stripe sheet › Disconnect |
| `stripe.refresh` | — (Mac only, see below) | ✓ Refresh in the Inspector's Earnings row, the sheet and the Overview's Earnings card (the daemon also refreshes once a day by itself) |
| `gateway.list` | — (Mac only, see below) | ✓ the shared state's `gateway` (task cards in conversations, Requests) |
| `gateway.confirm` | — (Mac only, see below) | ✓ the “Ask bob's Claude?” card in a conversation: Ask / Not now |
| `gateway.cancel` | — (Mac only, see below) | ✓ Cancel on a task card and in Requests (sent), Stop in Requests (received) |
| `gateway.ask` | — (Mac only, see below) | ✓ Requests › Ask someone's Claude… |
| `gateway.setNote` | — (Mac only, see below) | ✓ Requests › your “Ask me for…” note |
| `gateway.decide` | — (Mac only, see below) | ✓ the request sheet (Approve once / Always, with its scope and expiry / Decline with a reason), the notification's and the menu bar's Approve / Always / Decline |
| `gateway.answer` | — (Mac only, see below) | ✓ a sent task's card when their Claude asks something: pick an answer or write one, or Let them decide |
| `gateway.saveRule` | — (Mac only, see below) | ✓ Settings › People & access › Rules, and a friend's card: change a rule's answer or expiry |
| `gateway.removeRule` | — (Mac only, see below) | ✓ Settings › People & access › Rules, and a friend's card: Delete |
| `gateway.setCapabilities` | — (Mac only, see below) | ✓ Settings › People & access › What your friends’ Claudes can do here (per capability and trust level, the folders) |
| `gateway.image` | — (Mac only, see below) | ✓ screenshots on a task card's result |
| `board.create` | — (Mac only, see below) | ✓ New Task (⌘N in Tasks, C, the + in a status group, ⌘K › New Task…), sub-tasks on a task page |
| `board.update` | — (Mac only, see below) | ✓ a task's properties (status, priority, assignee, labels, estimate, due date, parent), its title in place, row and card menus |
| `board.move` | — (Mac only, see below) | ✓ dragging a card between columns on the board, or within one |
| `board.editBrief` | — (Mac only, see below) | ✓ a section of the brief on a task page (click to edit, ⌘↩ saves) |
| `board.restoreRevision` | — (Mac only, see below) | ✓ History › Restore on a brief section |
| `board.comment` | — (Mac only, see below) | ✓ the comment box under a task's activity |
| `board.relate` | — (Mac only, see below) | ✓ Blocked by / Blocks / Related on a task page |
| `board.addProof` | — (Mac only, see below) | ✓ Add Proof (a picture, a page, a file) on a task page; Claude's task_attach_proof |
| `board.removeProof` | — (Mac only, see below) | ✓ a proof item's ✕ |
| `board.remove` | — (Mac only, see below) | ✓ Delete Task… (an alert, with Cancel) |
| `board.start` | — (Mac only, see below) | ✓ Start Worktree / Start with Claude on a task |
| `board.settleGone` | — (Mac only, see below) | ✓ the banner on a task whose worktree was archived or deleted (Cancel Task / Back to Backlog / Keep) |
| `board.setAutoTasks` | — (Mac only, see below) | ✓ Tasks › ⋯ › Open a Task for Every New Worktree |
| `board.setPrefix` | — (Mac only, see below) | ✓ Tasks › ⋯ › Task Keys… |
| `claudeCode.steps` | — (Mac only, see below) | ✓ a Claude Code session's or agent's live, read-only transcript (Activity, the strip above a workspace's chat, the Inspector's Claude Code panel) |
| `claudeCode.step` | — (Mac only, see below) | ✓ opening a tool call or thinking line in that transcript: the command and its output, the file, the diff, the thinking |
| `claudeCode.findAgent` | — (Mac only, see below) | ✓ opening a sub-agent's own worktree whose agent finished a while ago: it's found again and followed live |
| `claudeCode.outputs` | — (Mac only, see below) | ✓ a sub-agent's Outputs tab: the screenshots, test output, logs and JSON it made or looked at (from its transcript, wherever it put them, plus its own `.klaud/scratch/agents/<name>/`), still on disk, newest first |
| `claudeCode.output` | — (Mac only, see below) | ✓ looking at one of them: pictures inline, text with secrets redacted (only files that agent made or looked at) |
| `claudeCode.taskOutput` | — (Mac only, see below) | ✓ following a background command or watch Claude or a sub-agent started (the panel's Background tab, a sub-agent's Background): the end of its output, live, cleaned of terminal codes and secrets; its own log when it writes to one |
| `agent.steps` | — (the terminal keeps its one-line steps) | ✓ a Claude card's steps as disclosure rows (an icon per tool, ✓/✗, how long it took), thinking as “Thought for 12s”, sub-agents' steps |
| `agent.step` | — (the terminal keeps its one-line steps) | ✓ opening a step on a Claude card: Bash's command and output (colours kept), the file read, an edit's diff, a search's matches, a page fetched, an MCP tool's input and output as JSON, the thinking |
| `git.fetch` | — (Mac only, see below) | ✓ Fetch on a project's home (“fetched 3 min ago”, or why it couldn't: sign-in needed, offline) |
| `git.fetchIfStale` | — (Mac only, see below) | ✓ opening a project's home fetches quietly when the last fetch is a few minutes old (the daemon also fetches every project every ~15 min) |
| `git.updateMain` | — (Mac only, see below) | ✓ Update main on a project's home: fetch and fast-forward the default branch; what can't fast-forward asks (changes in the way, or Let Claude Handle It) |
| `git.stashAndUpdate` | — (Mac only, see below) | ✓ the “changes in the way” alert › Stash and Update (and put them back) |
| `git.moveAndUpdate` | — (Mac only, see below) | ✓ the “changes in the way” alert › Move to Worktree |
| `git.switchToDefault` | — (Mac only, see below) | ✓ “The main folder is on feat/…” › Switch to main (clean; or Move to Worktree / Bring Them Along) |
| `git.askClaude` | — (Mac only, see below) | ✓ Let Claude Handle It: a conversation in the project's Questions whose run may only sync git (banner “Claude is updating main”) |
| `git.github` | — (Mac only, see below) | ✓ the GitHub row on a project's home: GitHub ↗, Private/Public, people, open PRs, stars (through gh, cached an hour; Connect GitHub when gh isn't set up) |
| `git.githubRepo` | — (Mac only, see below) | ✓ Open on GitHub in a project's right-click and ⋯ menus |
| `git.log` | — (Mac only, see below) | ✓ History: a project home's latest commits, the History page (Show All) and the panel's History tab (⌥⌘5), as a graph |
| `git.commit` | — (Mac only, see below) | ✓ a commit in History: message, author, date, parents, files with +/− and their diffs |
| `git.mergePreview` | — (Mac only, see below) | ✓ the toolbar's Merge into main: where it goes, the commits and files, and checks (conflicts, uncommitted work, the main folder's branch) before you confirm |
| `git.filters` | — (Mac only, see below) | ✓ History's Branch and Author pop-ups |
| `git.worktreeAt` | — (Mac only, see below) | ✓ a commit in History › Start a Worktree Here |
## Sending while Claude works, and images

| What | Core | Terminal | Mac |
|---|---|---|---|
| Queue a message (the default while your Claude works) | `session.submit` | Return | Return · the split button's **Queue** |
| Send now: stop the current task, run this next | `session.submit` with `urgent` | Option+Return | Option+Return · the split button's **Send now** |
| What waits, in run order (text, who asked) | `queueIn` (`src/ui/compose.ts`), the prompt comes with the `queued` event | the queued cards in the chat | the queue above the box |
| Run a waiting message now | `host.promote` | action bar › Run queued now | queue › Send now |
| Drop a waiting message | `host.cancelQueued` | action bar › Cancel queued | queue › ✕ |
| Edit a waiting message (back into the box) | `host.cancelQueued`, then the box | — | queue › ✎ |
| Change the order | `host.reorderQueued` (yours only; friends' keep their places) | — | queue › ↑ ↓ |
| Paste or drop an image | `attachments.add` (Mac) · the clipboard (terminal) | ⌘V / drag a file: an `[image N]` chip | ⌘V / drop: a chip plus its picture above the text |
| An image in a message | `attachments.read` (yours from disk, a friend's through their share) | a link that opens it in the viewer | the picture (several in a grid); click for full size, ⌘C copies, Open shows it in Preview |

## Only in one client, on purpose

| What | Where | Why |
|---|---|---|
| Mouse escape codes, OSC 52 copy, terminal zoom, focus reports | Terminal | they are the terminal's own features (`src/ui/tty`) |
| Window vibrancy, menu bar, menu-bar icon, `klaud://` links, Settings window, ⌘K palette, drag-and-drop images | Mac | native window features; the actions they run are the shared ones above |
| A workspace's screen: the conversation always in the center; a right panel (⌥⌘0, resizable, its tab remembered per workspace; narrow, only the tab you're on shows its name) with Changes (files with +/−, the diff inline or the file as itself — Markdown formatted, pictures and PDFs always as themselves — Show in Files, Commit / PR / Review), Files (a tree you filter by name, a preview with PDFs drawn page by page, Show Changes on a changed file), Terminal (the workspace's shells, setup and run) and Info (the inspector); ⌘J's terminal in that panel or a drawer under the chat; a diff, file or the terminal in full for a while (⌘↩, Esc back) | Mac (`layout/RightPanel.tsx`, `layout/panel/*`, `lib/panel.ts`) | the terminal app switches the whole screen between Chat, Files, Diff and Terminal tabs (the same shared actions: `workspaces.open`, `workspaces.selectFile`, `files.*`, `terminals.*`) |
| Dock badge, clicking a desktop notification to go where it's about | Mac | the app shell's (`set_tray_status`, the notification plugin's taps); the count is the shared `badgeCount` |
| Marking one notification unread again | Mac (hover a notification) | the terminal's inbox is a menu: opening a notice reads it, and it has Mark all as read |
| Desktop notifications through the terminal (OSC 9/99, terminal-notifier, notify-send) | Terminal | `src/ui/tty/desktop-notify.ts`; which events notify, Do Not Disturb and “only when klaud isn’t in front” are shared settings the core applies for both |
| Local UI preferences (appearance, accent, text size, density, widths) | Mac (`lib/prefs.ts`) | per window; klaud's own settings (model, notifications, trust…) are shared through `session.setPrefs` |
| Terminal look (font, size, line height, cursor style and blink, scrollback) | Mac (`lib/prefs.ts`, Settings › Terminal) | the terminal app draws in your terminal emulator, which has its own font and cursor settings. The shell itself (which one, login, arguments) is shared: `session.setPrefs` |
| Environment variable editor (masked values, paste KEY=value lines, per-project scope, load the project's .env) | Mac (Settings › Environment) | the terminal app sets them one at a time with `/env`; both use the same core (`src/core/env-vars.ts`), and values never enter the shared state or anything sent to the room |
| Confirmations as alerts (archive/delete with “Commit & Archive” and an env-changes table, clear, agent worktrees, hide project, leave a shared workspace), each with Cancel | Mac (`dialogs/native/*Alert.tsx`, `components/Alert.tsx`) | the terminal asks with a numbered menu; the alerts pick the same menu options (`actions.pick`), so what happens is identical |
| Inviting, people and sharing as sheets and cards: the Invite People sheet (Invite to popup, Watch / Prompt / Edit, Copy Invite Link with “Copied”, people waiting, active links with Copy and Revoke), a person's card beside their row (trust as a segmented control, Message / Ask Claude / Run / Follow / Files, usage meters, Remove with an alert), your account card (rename in place, who may use your Claude), a right-click Trust ▸ submenu, the Share sheet for a workspace (an access popup per person), Share a Folder (Open panel, your projects, only some people, Claude may edit, Stop Sharing), the room's card from the sidebar's status | Mac (`dialogs/native/InviteSheet.tsx`, `PersonPopover.tsx`, `PersonCards.tsx`, `PersonMenu.tsx`, `WorkspaceShare.tsx`, `ShareFolderSheet.tsx`, `SharedSheet.tsx`, `RoomPopover.tsx`) | the terminal asks with numbered menus; underneath it's the same API calls and the same menu options (`actions.pick`) |
| Addressing a message with a chip (“To bob”, “To bob's Claude”, “To your Claude”) | Mac (`MacUi.to`, the composer) | the terminal types `@bob ` / `@claude:bob ` into its input; the chip adds the same words when the message is sent |
| Run a command on a friend's computer from a sheet with a command field | Mac (`dialogs/native/PeerSheets.tsx`) | the terminal asks for the command in its input; both call `session.runOnPeerByHand` |
| Search over a workspace shared with you (names and contents) above its Files, instead of a read-only shell tab | Mac (`views/SharedSearch.tsx`) | the terminal keeps its Terminal tab (`ls`, `cd`, `find`, `grep`…); the search runs the same `find` and `grep` through `shell.run` |
| A shared workspace's earlier conversation drawn as people's messages | Mac (`lib/said.ts`, from each line's `said`) | the terminal shows those lines as they are (“bob: …”) |
| Clicking an invite link (`klaud://<key>…#secret`) opens the Join sheet | Mac (`lib/native.ts` `inviteOf`) | the terminal joins with `klaud join <link>` |
| Forms instead of typing in the message box: fork name, project Setup/Run (with where each comes from, and “Save to klaud.json”: `workbench.setScript(…, team)`), PR with extra instructions, new template with Plan first (`workbench.saveTemplate(…, plan)`), hand off, a worktree or a command on a friend's computer, the model, the welcome choice | Mac (`dialogs/native/`, `lib/native-routes.ts`) | the terminal types a /command or asks in its box; the Mac's message box is only for messages (`tests/mac-no-typing.test.ts` lists every place the shared runners type) |
| Groups in the sidebar: Move to Group ▸ submenu, a new group named in place, rename, ungroup (`workspaces.renameGroup`, `workspaces.ungroup`), drag a project onto a group or out of it | Mac (`layout/ProjectGroups.tsx`) | the terminal moves projects with its project menu and a typed name |
| Arranging the sidebar Finder-style: drag projects to reorder them (an insertion line, the list scrolls near its edges, Esc puts it back), drop one on a group (the folder lights up; a folded one springs open) or between a group's projects, pull it out to the top level, drag groups among the projects; Move Up / Move Down (⌃⌘↑/↓) in a row's menu; empty groups you make stay until you delete them (`workspaces.arrange`, `workspaces.newGroup`; the order lives in projects.json's `order` and each group's list, see `src/workspaces/arrange.ts`). Project rows don't fold (their worktrees and chats always show, never the main checkout; clicking one opens the project); groups fold, with a count | Mac (`layout/ProjectTree.tsx`, `layout/arrange-drag.ts`, `layout/project-layout.ts`) | the terminal keeps its project list and folding as they are; it shows projects and groups in the order you arranged them (`projects` / `projectGroups` come ordered), with no new UI |
| Hiding a project with Undo (“Hidden klaude — Undo”, ⌘Z) instead of an alert; Hidden Projects folded at the bottom of the sidebar, in Settings › Workspaces and in the Add Projects sheet, each with Show (`workspaces.showProject`; it comes back in its place and group) | Mac (`layout/ProjectTree.tsx`, `lib/undo-toast.tsx`) | the terminal hides from its project menu (with its own confirmation) and adds a project back with /project add |
| “Connect GitHub” with copyable commands and Check Again (`workbench.refreshPrs(id, true)` looks for gh again) | Mac (PR sheet) | the terminal says to install gh in its PR menu |
| Stop your Claude in one conversation (`host.stopRun`): your queued messages there come back into the box, other people's requests keep their places and run next, other conversations carry on | Mac (■ Stop beside the send control, ⌘., Conversation › Stop Claude, Stop on a running answer) | the terminal keeps `/stop` (everywhere); `host.stopRun` is in the core for any screen |
| Workspace and Conversation menus in the menu bar (Commit… ⇧⌘C, Pull Request… ⇧⌘P, Merge… ⇧⌘M, Run ⌘R, Ask Claude to Review… ⇧⌘R, Archive… ⌃⌘A, Stop ⌘., Plan First ⌥⌘P, Find ⌘F / ⌘G / ⇧⌘G, Clear ⇧⌘K, Previous/Next Workspace ⌥⌘↑/↓), greyed out when they can't run (`lib/commands.ts`, `set_menu_state`); what starts Claude or changes git (Review, Commit, Merge, Solve Conflict, Compact, Fix Checks) says what it will do and waits for Start, from every way in (a popover under its toolbar button, else an alert; `lib/work-confirm.ts`) | Mac | the same workspace actions as the toolbar (`workspaceButtons`); the terminal has its top bar and /commands |
| A calm sidebar: Overview, Tasks and Group chat at the top, always; Activity and Requests only while there's something in them; Shared files under Shared with me; Search in the toolbar (⇧⌘F); Usage as an icon above the sidebar (amber when most of the week is used); the terminal in the right panel (⌘J). The places in order (Overview, Tasks, Chat, Search, Usage, Terminal, Shared files) for ⌥1…7, ⌃Tab, the Go menu and the palette (`lib/go.ts`) | Mac | the terminal keeps its tab order (`topTabs`) |
| The toolbar's main button chosen from the workspace's state (Commit / Merge / PR #n / Fix Checks / Solve Conflict / Restore / Run), the rest as icons and a ⋯ menu with shortcuts (`layout/toolbar-actions.ts`) | Mac | the same `workspaceButtons`; the terminal's top bar shows them as words |
| Find in a conversation (⌘F) | Mac (`chat/FindBar.tsx`) | the terminal has Search (all conversations) |
| Right-click menus: messages (Copy, Copy as Markdown, Quote in Reply, Ask Claude About This, Open Image), code blocks, files (Open, Show in Finder, Copy Path, Mention in Chat, Save a Copy…), changed files and commits in Diff, search results, Usage rows, notifications | Mac | native context menus; what they run is shared (`files.open`, `files.download`, `inbox.*`…) |
| Save a shared file where you choose (`files.download` with `to`, the Save panel) | Mac | the terminal saves to ~/Downloads/klaud |
| A new worktree's form: Based on (`workspaces.branches`), Name, Create Worktree (`workspaces.startWorktree` with `base` / `name`) | Mac | the terminal names it from the task and starts from the default branch |
| Never change main: every Claude run in a project's main folder (the main checkout, or a chat there) is questions only. Edits, writes and shell commands that aren't clearly read-only are denied (`agent/policy.ts` `askOnly`, `agent/read-only.ts`), Claude is told so, and a change request makes it call `continue_in_worktree`: a new worktree from the latest origin, named after the task, with the conversation carried over (history copied, Claude's session forked), and the work goes on there (your own requests move right away; someone else's ask you first) | both (core) | the terminal shows the same notes in the chat and goes to the new worktree; no new terminal UI |
| A project's home (`project` view): icon, name, main's branch and how it compares with origin, counts (active / ready to merge / archived, earnings), “What do you want to do in …?” with New Worktree (Based on, Name) or Just Ask, then its worktrees, questions and recently archived (Show All in Overview). Clicking a project opens it | Mac (`views/ProjectHome.tsx`, `lib/project-home.ts`) | the terminal keeps its project rows; it never gets this view |
| Keeping main current and seeing history: the project home is about the default branch (main or master, “3 behind origin/main”, and “The main folder is on feat/…” with Switch to main), Update main and Fetch with when it last fetched, a quiet fetch of every project every ~15 min (never a password prompt: GIT_TERMINAL_PROMPT=0), uncommitted changes in the way (stash and put back, or move to a worktree), anything else to Claude in a run whose only permission beyond reading is syncing git (`agent/sync-main.ts`; never push, never discard), the GitHub row, and History (a commit graph with lanes and merges, authors as initials, refs as pills, filters, a commit's diffs; `views/history/*`) | Mac (`views/project/MainSyncBar.tsx`, `views/project/GitHubRow.tsx`, `views/history/*`, `layout/panel/HistoryTab.tsx`; core: `core/main-sync.ts`, `workspaces/sync.ts`, `workspaces/history.ts`, `workspaces/github.ts`) | the terminal app is unchanged; its main folder runs stay questions only |
| A questions-only chat: “Questions only — Claude won’t change anything in main.” above the box, Continue in New Worktree… as the toolbar's main button, “Ask about <project>…” in the box | Mac (`chat/AskBanner.tsx`, `dialogs/native/ContinueSheet.tsx`) | the terminal's runs there are read-only too |
| Sub-agents: under the conversation that started them in the sidebar (a robot, running first, “N more”), their own worktrees as the agent (never as your worktrees; leftovers in one folded Sub-agents row), the sub-agent page (who started it, type, model, effort, time, steps, context; its live transcript with thinking and tools; its worktree's Changes, Files and Scratch beside it; Send to Main Claude to steer it through its lead), Watch on a sub-agent in the chat | Mac (`src/layout/SubAgents.tsx`, `src/claude-code/AgentMonitor.tsx`) | on purpose: the terminal app keeps its own sub-agent lines |
| Chats with friends: tabs above the conversation (All Friends first; open, close, + for a new channel), files shared Mac to Mac (cards, pictures, progress, Open / Show in Finder / Save As), Claudes called in with the Ask Claude menu (answers marked “bob’s Claude”, “… is answering”), Settings › People & access › Who can ask your Claude in chats | Mac (`src/network/ChatTabs.tsx`, `ChatFiles.tsx`, `NetComposer.tsx`) | on purpose (docs/network.md › Chats): the terminal app keeps `@claude` in its rooms |
| Friends, direct messages, groups and your status (the klaud network): sidebar Friends and Groups with presence and unread, the Add a Friend sheet (code, link, QR; `klaud://add` / `klaud://join` links), conversations (`conversation` view), New Group / Add People sheets, group info (members, admins, invite link, join requests, rename, leave), the status menu in the sidebar and the menu bar, Away when idle, Settings › People & access switch | Mac (`src/network/*`) | on purpose (docs/network.md): the terminal app keeps its rooms and stays as it is; notifications for messages come from the shared Notifier (`mentions`) |
| Empty states with one-click starters (New Worktree, New Chat, Add Projects…, first tasks for Claude) | Mac | the terminal's empty views say what to type |
| The palette's commands as named actions (“Create Pull Request…”, “Fork This Workspace…”), never `/cmd <arg>` | Mac (`dialogs/palette-commands.ts`) | the terminal has the commands themselves |
| The klaud network: friends added once by a one-time link or a short code, direct messages that wait for offline friends, groups that live on their members' Macs (no host, end-to-end encrypted, admins add and remove people, join by link), and your status (online, away, do not disturb, appear offline) — the `network.*` API and the shared state's `network` | Mac (the daemon runs it when `network: true` is in settings or `KLAUD_NETWORK=1`; `src/net/mesh/`, `src/core/network.ts`) | a home for people and conversations beyond one room is the Mac app's job; the terminal app keeps its rooms (`klaud host` / `klaud join`), which work as before |
| Earnings from Stripe per project: a key per project (kept in ~/.klaud/stripe.json, 0600; screens only get `earnings`: connected, the account's name, all-time totals per currency, when they were counted, what went wrong), counted in the background once a day (incrementally, with a full recount weekly), shown as a pill beside each project in the sidebar, in the Inspector, and as a card in the Overview and the Usage view, every total in one currency (`prefs.earningsCurrency`, "Show earnings in" in Settings › General and the Stripe sheet; unset: the one most was earned in), other currencies converted at the ECB's daily rates (`src/core/fx-rates.ts`, `fx` in the shared state, fetched alongside the daily Stripe count) — the `stripe.*` API and the shared state's `earnings` | Mac (`src/core/stripe-earnings.ts`, the daemon runs it; `components/EarningsPill.tsx`, `dialogs/StripeSheet.tsx`, `lib/earnings.ts`) | a glance at what each app earns belongs beside the projects in the Mac app's sidebar; the terminal app stays about the work, and the core refuses `stripe.*` where no daemon runs it |
| Claude Code running outside klaud, live and read-only: sessions you run through Conductor or a terminal, and their sub-agents (description, type, running / finished / failed / stopped / idle, the current step, steps, context), found by watching the transcripts Claude Code writes in ~/.claude/projects (never written to; tailed from the end, at most the last 200 steps per agent kept), in Activity (every live session by project, “6 agents running”), a strip above a workspace's chat and the Inspector's Claude Code panel (the session's folder is the workspace's, Conductor worktrees included), and a read-only transcript per session or agent; a background agent finishing notifies (`background`) — the `claudeCode.steps` API and the shared state's `claudeCode` (screens on this computer only, never sent to the room) | Mac (`src/core/claude-code/`, the daemon runs it; `src/claude-code/*` in the app) | the terminal app is where you'd run Claude Code itself; watching several sessions and their agents side by side is the Mac app's job |
| Tasks between Claudes (the gateway): your Claude finds who can help (`who_can`), asks their Claude (`ask_person`) or runs one command on their Mac (`run_on`), waits (`wait_for`) or ends its turn and continues when the answer comes back; you're asked first for people you don't trust (a card in the conversation), their side approves with today's approval cards unless they trust you; results go only to the requester, as data. Task cards in conversations, the Requests view (Sent / Received) — the `gateway.*` API and the shared state's `gateway` | Mac (`src/core/gateway/`, the daemon runs it; `src/gateway/*` in the app) | on purpose: the terminal app stays as it is; the tools exist for every Claude but say the klaud app is needed where no daemon runs the gateway |
| Tasks (the board): a Tasks place in the sidebar with My Tasks, Active, Backlog and All, by project; a list grouped by status, a board you drag cards across, and a graph of what waits on what (the graph engine); a task's page (its title, properties, a brief in sections that Claude and you keep true with every version kept, sub-tasks, blockers, its worktree and pull request, proof, activity and comments); a task opens with every new worktree and follows its pull request (In Review when it opens, Done when it merges); Start Worktree / Start with Claude on a task; your Claude's runs in a task's worktree get its brief and the task tools (`mcp__klaud_board__*`) — the `board.*` API and the shared state's `board` | Mac (`src/core/board/`, the daemon runs it; `src/tasks/*` in the app) | on purpose (docs/tasks-and-plans.md): the terminal app keeps its worktrees as they are; tasks, their pages and dragging cards are the Mac app's job |
| Graphs Claude draws (`klaud-graph` blocks: interactive diagrams laid out by ELK and drawn with React Flow, in answers, reports and Markdown files; hover, details, walkthrough, full window) | Mac (`components/graph/*`; the format is `src/shared/graph-spec.ts`, Claude learns it from `agent/graph-prompt.ts`) | the terminal app shows the block's JSON as code; drawing diagrams is the Mac app's job (docs/graphs.md) |

## Adding a feature

1. The API: an entry in `src/ipc/api.ts` and its handler in `src/ipc/handlers.ts`.
2. The behavior in the core, with a contract test in `tests/contract/` (runs over both clients).
3. Shared model or action code in `src/ui/*-models.ts` / `*-actions.ts` / `menus.ts` if both screens show it (keep it browser-safe: `tests/browser-safe.test.ts`).
4. The terminal UI's pixels.
5. The Mac app's pixels (`packages/mac/src`).
6. A row on this page.
7. Command, palette, menu bar and help entries.
