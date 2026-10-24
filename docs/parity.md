# Every way in, and where the Mac app shows it

The Mac app drives Beluga's core through `src/ipc/api.ts`. This page lists every way in and where you find it in the app. `tests/parity.test.ts` fails when a command, a UI action, a menu or an API method exists without a row here.

Columns: **Core** is the API method or intent it uses; **Mac** is where you find it.

## Slash commands

| Command | Core | Mac |
|---|---|---|
| `/invite` | `session.submit` → `runCommand` | typed in the composer · Sidebar footer Invite · File › Invite… · ⌘K |
| `/overview` | `session.submit` → `runCommand` | typed in the composer · Sidebar › Overview · Go › Overview (⌥2) |
| `/room` | `session.submit` → `runCommand` | typed in the composer · Sidebar › Chat (⌥1) |
| `/new` | `session.submit` → `runCommand` | typed in the composer · Sidebar project ⌥ button · File › New Worktree… (⌘⇧N) · ⌘K · empty Overview / chat › New Worktree |
| `/chat` | `session.submit` → `runCommand` | typed in the composer · Sidebar + · File › New Chat (⌘N) |
| `/review` | `session.submit` → `runCommand` | typed in the composer · the right panel's Changes tab (⌥⌘1; a diff opens in full with ⌘↩) |
| `/pr` | `session.submit` → `runCommand` | typed in the composer · Toolbar PR · ⌘K |
| `/run` | `session.submit` → `runCommand` | typed in the composer · Toolbar Run (shows the terminal, keeps the keyboard in the message box) · the panel's Terminal tab ▶ · person sheet “Run a command…” |
| `/terminal` | `session.submit` → `runCommand` | typed in the composer · the right panel's Terminal tab (⌥⌘3) or the drawer under the chat (⌘J, Settings › Terminal picks which) · Go › Terminal (⌥6) |
| `/setup` | `session.submit` → `runCommand` | typed in the composer · the panel terminal's Commands… |
| `/handoff` | `session.submit` → `runCommand` | typed in the composer · Toolbar ⋯ › Hand off |
| `/model` | `session.submit` → `runCommand` | typed in the composer · Composer model picker |
| `/search` | `session.submit` → `runCommand` | typed in the composer · Sidebar › Search · ⌘⇧F |
| `/usage` | `session.submit` → `runCommand` | typed in the composer · Sidebar › Usage (⌥5) |
| `/inbox` | `session.submit` → `runCommand` | typed in the composer · toolbar bell (notification centre) · the right panel's Info › Notifications · Go › Inbox · ⌘K › Notifications |
| `/template` | `session.submit` → `runCommand` | typed in the composer · Palette › Start from a template… |
| `/shell` | `session.submit` → `runCommand` (`/shell fish`, `default`, `login on\|off`, `args …`) | typed in the composer · Settings › Terminal › Shell |
| `/env` | `session.submit` → `runCommand` (`/env KEY=value`, `KEY=` removes, `project KEY=value`) | typed in the composer · Settings › Environment |
| `/compact` | `session.submit` → `runCommand` | typed in the composer · Toolbar ⋯ › Compact |
| `/visualize` | `session.submit` → `runCommand` (`/graph` too): your words in the chat, Claude asked for a `beluga-graph` | typed in the composer · ⌘K › Draw This as a Graph; the graph is drawn (docs/graphs.md) |
| `/merge` | `session.submit` → `runCommand` | typed in the composer · Toolbar Merge (the main button when ready) · Workspace › Merge (⇧⌘M) |
| `/commit` | `session.submit` → `runCommand` | typed in the composer · Toolbar Commit · Workspace › Commit (⇧⌘C) |
| `/fork` | `session.submit` → `runCommand` | typed in the composer · Toolbar ⋯ › Fork |
| `/finder` | `session.submit` → `runCommand` | typed in the composer · Toolbar ⋯ › Finder · the panel's Info › Finder · Files › Show in Finder |
| `/archive` | `session.submit` → `runCommand` | typed in the composer · Toolbar ⋯ › Archive · Usage row Archive |
| `/restore` | `session.submit` → `runCommand` | typed in the composer · Archived row › Restore |
| `/delete` | `session.submit` → `runCommand` | typed in the composer · Archived row › Delete |
| `/project` | `session.submit` → `runCommand` | typed in the composer · Sidebar Projects + · File › Add Project… |
| `/copy` | `session.submit` → `runCommand` | typed in the composer · Hover on an answer › Copy · ⌘K |
| `/follow` | `session.submit` → `runCommand` | typed in the composer · Person sheet › Follow |
| `/unfollow` | `session.submit` → `runCommand` | typed in the composer · Person sheet › Stop following |
| `/open` | `session.submit` → `runCommand` | typed in the composer · Shared files · links in chat |
| `/get` | `session.submit` → `runCommand` | typed in the composer · Viewer › Download |
| `/close` | `session.submit` → `runCommand` | typed in the composer · Viewer › Close |
| `/stop` | `session.submit` → `runCommand` | typed in the composer · ⌘K › Stop your Claude everywhere (stopping in one conversation: `host.stopRun`, Mac only) |
| `/policy` | `session.submit` → `runCommand` | typed in the composer · Settings › General |
| `/trust` | `session.submit` → `runCommand` | typed in the composer · Trust card · person sheet · Settings › People |
| `/untrust` | `session.submit` → `runCommand` | typed in the composer · Person sheet |
| `/people` | `session.submit` → `runCommand` | typed in the composer · Sidebar › People |
| `/share` | `session.submit` → `runCommand` | typed in the composer · File › Share a Folder… |
| `/unshare` | `session.submit` → `runCommand` | typed in the composer · Share a Folder… › Stop sharing |
| `/settings` | `session.submit` → `runCommand` | typed in the composer · Beluga › Settings… (⌘,) |
| `/name` | `session.submit` → `runCommand` | typed in the composer · Settings › General › Your name |
| `/theme` | `session.submit` → `runCommand` | typed in the composer · Settings › Appearance |
| `/zoom` | `session.submit` → `runCommand` | typed in the composer · ⌘+ / ⌘− / ⌘0 · View menu |
| `/clear` | `session.submit` → `runCommand` | typed in the composer · /clear in the composer (sheet) |
| `/plan` | `session.submit` → `runCommand` | typed in the composer · Composer Act/Plan chip (⇧Tab) |
| `/remove` | `session.submit` → `runCommand` | typed in the composer · Person sheet › Remove |
| `/newlink` | `session.submit` → `runCommand` | typed in the composer · Settings › People › New link |
| `/lock` | `session.submit` → `runCommand` | typed in the composer · Settings › People › Take new people |
| `/help` | `session.submit` → `runCommand` | typed in the composer · Help › Keys and Commands · ⌘K |
| `/quit` | `session.submit` → `runCommand` | typed in the composer · Beluga › Quit (⌘Q) · tray |

## UI actions (`UiAction`, in `src/ui/workspace-models.ts`)

| Action | Mac |
|---|---|
| `open_ws` | click (`runUiActionWith`) |
| `toggle_project` | click (`runUiActionWith`) |
| `toggle_fold` | click (`runUiActionWith`) |
| `agents_menu` | click (`runUiActionWith`) |
| `toggle_group` | click (`runUiActionWith`) |
| `toggle_archive` | click (`runUiActionWith`) |
| `project_menu` | click (`runUiActionWith`) |
| `archived_menu` | click (`runUiActionWith`) |
| `new_worktree` | click (`runUiActionWith`) |
| `new_chat` | click (`runUiActionWith`) |
| `add_project` | click (`runUiActionWith`) |
| `view` | click (`runUiActionWith`) |
| `close_tab` | click (`runUiActionWith`) |
| `ws` | click (`runUiActionWith`) |
| `review_file` | click (`runUiActionWith`) |
| `plan_toggle` | click (`runUiActionWith`) |
| `plan_full` | click (`runUiActionWith`) |
| `open_shared` | click (`runUiActionWith`) |
| `knock` | click (`runUiActionWith`) |
| `shell_open` | click (`runUiActionWith`) |
| `shell_run` | click (`runUiActionWith`) |
| `shared_menu` | click (`runUiActionWith`) |
| `answer` | click (`runUiActionWith`) |
| `inbox` | click (`runUiActionWith`) |
| `model_menu` | click (`runUiActionWith`) |
| `template` | click (`runUiActionWith`) |
| `templates_menu` | click (`runUiActionWith`) |
| `trust` | click (`runUiActionWith`) |
| `trust_later` | click (`runUiActionWith`) |
| `search_hit` | click (`runUiActionWith`) |
| `term_tab` | click (`runUiActionWith`) |
| `term_new` | click (`runUiActionWith`) |
| `ws_more` | click (`runUiActionWith`) |
| `open_link` | click (`runUiActionWith`) |
| `paste_image` | click (`runUiActionWith`) |
| `none` | click (`runUiActionWith`) |

## Menus and dialogs (`MenuKind`, from `menuSpec`)

| Menu | Mac |
|---|---|
| `welcome` | sheet |
| `settings` | Settings window |
| `model` | model picker / sheet |
| `inbox` | notification centre under the toolbar bell: the same filters and groups, click to go there, hover for read/unread and ×, Mark all read, Clear all |
| `person` | a card beside the person's row (centred from the palette): trust as a segmented control, Message / Ask Claude / Run / Follow / Files buttons, Remove with an alert; your own row is your account card (name, who may use your Claude). Right-click: Trust submenu and the same actions |
| `confirm` | sheet |
| `project` | sheet and right-click menu |
| `archived` | sheet and right-click menu |
| `agents` | sheet |
| `ws_share` | Share sheet: everyone in the room with an access popup (Can work here / Can follow / No access), Invite by Link… |
| `shared` | sheet (Chat / Files / Changes, who's in it, Leave… with an alert; the people button on its toolbar) and right-click menu |
| `clear` | sheet |
| `invite_person` | sheet: workspaces with Invite buttons, Work here / Follow |
| `share_folder` | Share a Folder sheet: the Open panel (or a path), your projects, who sees it (everyone or only some people), Claude may edit, what you share now with Stop Sharing |
| `share_who` | the Share a Folder sheet with the folder filled in |
| `pr` | sheet |
| `scripts` | sheet |
| `templates` | sheet |
| `handoff` | sheet |
| `remote_ws` | sheet |
| `ws_more` | sheet |
| `invite_link` | Invite People sheet: Invite to popup, They can (Watch / Prompt / Edit), link checkboxes, Copy Invite Link (Return, says Copied), how they join, people waiting, active links with Copy and Revoke |
| `guest_add` | the guest's card: Add ▾ beside the projects they're in |

## API methods

| Method | Mac |
|---|---|
| `session.submit` | ✓ |
| `session.copyInvite` | ✓ |
| `session.copyLastAnswer` | ✓ |
| `session.copyText` | ✓ |
| `session.setPrefs` | ✓ |
| `session.setPlanMode` | ✓ |
| `session.compact` | ✓ (context meter › Compact now) |
| `session.setClaudeSharing` | ✓ |
| `session.rename` | ✓ |
| `session.zoom` | ✓ |
| `session.shareFolder` | ✓ |
| `session.unshareFolder` | ✓ |
| `session.follow` | ✓ |
| `session.clearChat` | ✓ |
| `session.removePerson` | ✓ |
| `session.newInviteLink` | ✓ |
| `session.setRoomOpen` | ✓ |
| `session.setFriendWorktrees` | ✓ |
| `session.setAccess` | ✓ |
| `session.runOnPeerByHand` | ✓ |
| `session.stopAgent` | ✓ |
| `session.quit` | ✓ |
| `session.serveFolder` | ✓ |
| `session.localLocation` | ✓ |
| `session.testNotification` | ✓ |
| `session.retryConnection` | ✓ Retry now in the connection status |
| `host.answerApproval` | ✓ |
| `host.promote` | ✓ |
| `host.sendNext` | ✓ Send Now on a queued message (runs it next, never interrupting) |
| `host.steerNow` | ✓ Send now on a steered message Claude hasn't read yet · ⇧⌥↩ (stops its step, your message is next) |
| `host.stopRun` | ■ Stop beside Queue/Steer · ⌘. · Conversation › Stop Claude · Stop on a running answer |
| `host.cancelQueued` | ✓ |
| `host.reorderQueued` | ✓ queue tray ↑ ↓ |
| `inbox.read` | ✓ |
| `inbox.unread` | ✓ |
| `inbox.clear` | ✓ (all, or × on one) |
| `questions.answer` | ✓ |
| `questions.pick` | ✓ |
| `people.setTrust` | ✓ |
| `people.dismissPrompt` | ✓ |
| `people.forget` | ✓ |
| `sharing.invite` | ✓ |
| `sharing.remove` | ✓ |
| `sharing.leave` | ✓ |
| `invites.create` | ✓ |
| `invites.revoke` | ✓ |
| `invites.copyLink` | ✓ |
| `invites.letIn` | ✓ |
| `invites.decline` | ✓ |
| `invites.change` | ✓ |
| `invites.remove` | ✓ |
| `remote.requestWorktree` | ✓ |
| `remote.handoff` | ✓ |
| `diff.load` | ✓ |
| `diff.select` | ✓ |
| `shell.run` | ✓ the search field over a shared workspace's Files (find + grep) |
| `shell.openEntry` | – (the Files tab opens files directly) |
| `files.browseTo` | ✓ |
| `files.enter` | ✓ |
| `files.up` | ✓ |
| `files.loadDir` | ✓ |
| `files.open` | ✓ |
| `files.openSpec` | ✓ |
| `files.download` | ✓ · `to`: Save… dialog |
| `files.downloadSpec` | ✓ |
| `files.closeViewer` | ✓ |
| `files.readImage` | ✓ |
| `files.readImageFile` | ✓ images in the Markdown reader (`![](diagram.png)` next to the file); PDFs drawn page by page in Files, Changes and the reader |
| `workspaces.scratch` | ✓ the panel's Scratch tab: the workspace's `.beluga/scratch/` and `.context/` folders, newest first, live; drawn in outline (moving while Claude works) until something lands |
| `files.read` | ✓ a changed file as itself in Changes (Markdown formatted), without moving the Files tab's open file |
| `files.searchContent` | ✓ the Files tab's search box on Contents: lines by file (ripgrep, else Node), Match Case / Whole Word / Regular Expression; a line opens the file there |
| `files.save` | ✓ Edit in a file's header (files open read-only), then Save or ⌘S; asks before overwriting a change made since |
| `files.formatter` | ✓ whether a file's Format button is on (the project's Prettier), and why not in its tooltip |
| `files.format` | ✓ Format (the wand) in a file's header: the project's Prettier lays out the text you're editing (Save writes it) |
| `companion.pair.start` | ✓ the sidebar footer's phone mark › Pair a Phone…: a one-time pairing (QR and code, 10 minutes, one phone) |
| `companion.pair.approve` | ✓ the Phone popover's “Pair Kayra's Pixel 9?” with the four-picture fingerprint › Pair |
| `companion.pair.cancel` | ✓ the Phone popover's Cancel while a pairing is open (a waiting phone hears no) |
| `companion.devices.remove` | ✓ the Phone popover › a phone › Remove (its link drops at once, its key is refused from then on) |
| `companion.older` | – the phone only: older turns of a conversation (or messages of a chat) as you scroll up (docs/companion.md) |
| `companion.ask` | – the phone only: Ask your Mac (a new chat in a project, as New Chat does, or a message in a conversation), with photos and files the phone sent (`put`) |
| `companion.post` | – the phone only: a message in a friends' chat with files from the phone |
| `companion.askPerson` | – the phone only: ask a friend's Claude yourself, as from their card in Requests (their approval and trust rules apply) |
| `companion.signOut` | – the phone only: Sign Out removes that phone's own certificate (the Mac's Remove is `companion.devices.remove`) |
| `workspaces.open` | ✓ |
| `workspaces.load` | Overview › Archived › Read Conversation (read-only, stays in the Overview) |
| `workspaces.refresh` | ✓ |
| `workspaces.newWorktree` | ✓ |
| `workspaces.newChat` | ✓ |
| `workspaces.startChat` | ✓ |
| `workspaces.startWorktree` | ✓ |
| `workspaces.branches` | New worktree › Based on popup |
| `workspaces.fork` | ✓ |
| `workspaces.continueInWorktree` | Continue in New Worktree… (toolbar and the ask banner) › sheet: Task, Based on, Name |
| `workspaces.archive` | ✓ |
| `workspaces.restore` | ✓ |
| `workspaces.archivePlan` | ✓ the Archive dialog says how much space it frees |
| `workspaces.freeSpace` | ✓ Free Up Space on a worktree: clears its dependencies, builds and caches |
| `workspaces.remove` | ✓ |
| `workspaces.commit` | ✓ |
| `workspaces.merge` | ✓ |
| `workspaces.prepareRemoval` | ✓ |
| `workspaces.applyEnvBack` | ✓ |
| `workspaces.askClaudeToReview` | ✓ |
| `workspaces.askClaudeToMerge` | ✓ |
| `workspaces.compact` | ✓ |
| `workspaces.openInFinder` | ✓ |
| `workspaces.setGroup` | ✓ |
| `workspaces.renameGroup` | ✓ (group row › Rename) |
| `workspaces.ungroup` | ✓ (group row › Ungroup / Delete Group) |
| `workspaces.arrange` | drag projects and groups in the sidebar, Move Up / Move Down (⌃⌘↑/↓), Move to Group ▸ |
| `workspaces.newGroup` | Projects + › New Group, right-click › New Group, Move to Group ▸ New Group… |
| `workspaces.showProject` | Hidden Projects in the sidebar, Settings › Workspaces, the Add Projects sheet's Show |
| `workspaces.hideProject` | ✓ |
| `workspaces.cleanAgentWorktrees` | ✓ |
| `workspaces.otherOrigins` | who made each worktree made outside Beluga (picks the right conversation; never shown as a tool's name) |
| `workspaces.otherActivity` | worktrees made outside Beluga listed after a project's own, most recently active first (5, then Show N more) |
| `workspaces.worktreeInfo` | the page a worktree from another tool shows when it has no conversation (or About This Worktree) |
| `workspaces.showConversation` | that page › Earlier conversations › Show |
| `workspaces.removeOther` | that page › Remove Worktree… (asks first; keeps the branch) |
| `workspaces.staleOthers` | a project's Clean Up Worktrees… (its right-click menu and its home) |
| `workspaces.cleanUpOthers` | Clean Up Worktrees… › Remove (only what you ticked; branches kept) |
| `workspaces.addProject` | ✓ |
| `workspaces.removeProject` | a project's ⋯ / right-click menu › Delete Project… (out of Beluga; its folder goes to the Trash only if ticked) |
| `workspaces.addFolder` | ✓ |
| `workspaces.selectFile` | ✓ |
| `workspaces.review` | the right panel's Changes tab (loads and refreshes the changes while you stay in the chat) |
| `workbench.run` | ✓ |
| `workbench.stopRun` | ✓ |
| `workbench.runSetup` | ✓ |
| `workbench.setScript` | ✓ |
| `workbench.shareScripts` | ✓ |
| `workbench.setModel` | ✓ |
| `workbench.createPr` | ✓ |
| `workbench.fixChecks` | ✓ |
| `workbench.resolvePrConflicts` | ✓ Resolve Merge Conflicts… (toolbar, PR sheet, the PR strip above the chat) when GitHub says the PR conflicts |
| `workbench.continueAfterMerge` | ✓ Continue After Merge… (⋯, PR sheet, the PR strip) once the PR merged |
| `workbench.openPr` | ✓ |
| `workbench.refreshPrs` | ✓ |
| `workbench.mergePr` | ✓ the PR sheet › Merge on GitHub (squash, merge or rebase; Merge When Checks Pass; Merge Now, Skipping Checks), also in the PR strip above the chat |
| `workbench.editPrPrompt` | ✓ |
| `workbench.resetPrPrompt` | ✓ |
| `workbench.measureDisk` | ✓ |
| `workbench.search` | ✓ |
| `workbench.openHit` | ✓ |
| `workbench.saveTemplate` | ✓ |
| `workbench.removeTemplate` | ✓ |
| `terminals.shell` | ✓ |
| `terminals.global` | ✓ |
| `terminals.close` | ✓ |
| `terminals.restart` | ✓ the terminal's "started before your variables changed · Restart" |
| `terminals.rename` | ✓ double-click a shell tab, or right-click › Rename… (Return saves, Escape cancels, empty resets) |
| `env.get` | ✓ Settings › Environment (values only go to the screen that asks) |
| `env.set` | ✓ Settings › Environment |
| `env.testDatabase` | ✓ Settings › Environment › Database (Test Connection) |
| `env.claudeDotenv` | ✓ Settings › Environment › Your Claude (and a .env approval's Always) |
| `attachments.add` | ✓ |
| `attachments.addFile` | ✓ a pasted path of an image becomes a waiting thumbnail |
| `attachments.reattach` | ✓ a queued message pulled back to edit gets its images back as thumbnails |
| `attachments.expand` | ✓ |
| `attachments.read` | ✓ images shown in messages |
| `attachments.open` | ✓ image full size › Open (in Preview) |
| `daemon.stop` | ✓ |
| `local.listDirs` | ✓ |
| `local.openFolder` | ✓ |
| `local.statFiles` | ✓ ⌘V of file paths attaches the files (⌘⇧V keeps the words) |
| `projects.add` | ✓ Add projects sheet, Choose Folders…, drop folders on the sidebar |
| `projects.addFolder` | ✓ (a dropped folder of projects is watched) |
| `projects.suggest` | ✓ "On this Mac" in the Add projects sheet |
| `projects.icon` | ✓ project icons in the sidebar |
| `projects.iconAt` | ✓ icons of suggested folders |
| `projects.setIcon` | ✓ right-click a project › Change Icon… |
| `network.setEnabled` | ✓ the Friends card’s Turn On, Settings › People & access › Talk with friends directly (starts and stops live) |
| `network.status` | ✓ the network is on (the Friends card, Settings › People & access) |
| `network.friends.list` | ✓ sidebar Friends (presence dots, notes, unread, relayed link) |
| `network.friends.invite` | ✓ Add a Friend sheet › Create Invitation (code, link, QR, expiry) |
| `network.friends.accept` | ✓ Add a Friend sheet › Have a code or link? (pasted from the clipboard; `beluga://add…` links open it) |
| `network.friends.cancelInvite` | ✓ Add a Friend sheet › Cancel Invitation; replacing a group link |
| `network.friends.remove` | ✓ right-click a friend › Remove… (alert); the conversation’s ⋯ |
| `network.dm.send` | ✓ the conversation’s message box; Send Again on an undelivered one |
| `network.dm.history` | ✓ Show Earlier Messages |
| `network.groups.list` | ✓ sidebar Groups (unread, join requests) |
| `network.groups.create` | ✓ New Group sheet (name, friends with checkboxes) |
| `network.groups.send` | ✓ the group’s message box |
| `network.groups.history` | ✓ Show Earlier Messages |
| `network.groups.addMember` | ✓ Add People… sheet; right-click a friend › Add to Group ▸ |
| `network.groups.removeMember` | ✓ group info › a member’s menu › Remove… (alert) |
| `network.groups.setAdmin` | ✓ group info › a member’s menu › Make Admin / Remove as Admin |
| `network.groups.leave` | ✓ Leave Group… (alert) from the sidebar, the header ⋯ or the group info |
| `network.groups.delete` | ✓ Delete Channel… (alert) for a channel you've left: the ⋯ menus, the group info, the read-only banner, or ticked in the Leave alert |
| `network.groups.rename` | ✓ rename in place in the group info, or the sidebar (double-click, Rename…) |
| `network.groups.invite` | ✓ group info › Invite with a Link (Approve Each Request / Anyone with the Link), Copy Invite Link |
| `network.groups.join` | ✓ Join a Group sheet (`beluga://join#…` links) |
| `network.groups.approve` | ✓ group info › Asking to Join › Approve |
| `network.groups.decline` | ✓ group info › Asking to Join › Decline |
| `network.presence.set` | ✓ your status (sidebar footer, menu bar, palette), Away when idle |
| `network.presence.get` | ✓ the shared state’s `network.self` (no call needed) |
| `network.read` | ✓ opening a conversation reads it (the `conversation` view is shown); Mark as Read on a group |
| `network.post` | ✓ a conversation's message box: words, files waiting in the box, and the Ask Claude menu (yours, everyone's, one person's); Send Again on an undelivered one |
| `network.files.add` | ✓ the paper clip (Open panel), files dropped anywhere on a conversation |
| `network.files.addData` | ✓ files and pictures pasted into the message box (and picked in a browser) |
| `network.files.download` | ✓ a file card's Download (files up to 50 MB come by themselves); Try Again on one that didn't come |
| `network.files.cancel` | ✓ a file card's × while it comes; right-click › Stop Downloading |
| `network.files.open` | ✓ click a file card or a picture; right-click › Open |
| `network.files.reveal` | ✓ a file card's folder button; right-click › Show in Finder |
| `network.files.saveTo` | ✓ right-click a file › Save As… (the Save panel) |
| `network.files.preview` | ✓ pictures shown in the chat |
| `network.channels.main` | ✓ All Friends (the first chat tab, the top of sidebar Channels): made the first time it's opened |
| `stripe.connect` | ✓ Connect Stripe… (a project's right-click and ⋯ menus, the Inspector's Earnings row, the Overview's hint and Earnings card): the Connect Stripe sheet checks the key with Stripe and shows the account |
| `stripe.disconnect` | ✓ the Connect Stripe sheet › Disconnect |
| `stripe.refresh` | ✓ Refresh in the Inspector's Earnings row, the sheet and the Overview's Earnings card (the daemon also refreshes once a day by itself) |
| `gateway.list` | ✓ the shared state's `gateway` (task cards in conversations, Requests) |
| `gateway.confirm` | ✓ the “Ask bob's Claude?” card in a conversation: Ask / Not now |
| `gateway.cancel` | ✓ Cancel on a task card and in Requests (sent), Stop in Requests (received) |
| `gateway.ask` | ✓ Requests › Ask someone's Claude… |
| `gateway.setNote` | ✓ Requests › your “Ask me for…” note |
| `gateway.decide` | ✓ the request sheet (Approve once / Always, with its scope and expiry / Decline with a reason), the notification's and the menu bar's Approve / Always / Decline |
| `gateway.answer` | ✓ a sent task's card when their Claude asks something: pick an answer or write one, or Let them decide |
| `gateway.saveRule` | ✓ Settings › People & access › Rules, and a friend's card: change a rule's answer or expiry |
| `gateway.removeRule` | ✓ Settings › People & access › Rules, and a friend's card: Delete |
| `gateway.setCapabilities` | ✓ Settings › People & access › What your friends’ Claudes can do here (per capability and trust level, the folders) |
| `gateway.image` | ✓ screenshots on a task card's result |
| `board.create` | ✓ New Task (⌘N in Tasks, C, the + in a status group, ⌘K › New Task…), sub-tasks on a task page |
| `board.update` | ✓ a task's properties (status, priority, assignee, labels, estimate, due date, parent), its title in place, row and card menus |
| `board.move` | ✓ dragging a card between columns on the board, or within one |
| `board.editBrief` | ✓ a section of the brief on a task page (click to edit, ⌘↩ saves) |
| `board.restoreRevision` | ✓ History › Restore on a brief section |
| `board.comment` | ✓ the comment box under a task's activity |
| `board.relate` | ✓ Blocked by / Blocks / Related on a task page |
| `board.addProof` | ✓ Add Proof (a picture, a page, a file) on a task page; Claude's task_attach_proof |
| `board.removeProof` | ✓ a proof item's ✕ |
| `board.remove` | ✓ Delete Task… (an alert, with Cancel) |
| `board.start` | ✓ Start Worktree / Start with Claude on a task |
| `board.settleGone` | ✓ the banner on a task whose worktree was archived or deleted (Cancel Task / Back to Backlog / Keep) |
| `board.archive` | ✓ a finished task's ⋯ › Archive |
| `board.archiveDone` | ✓ the archive button on Done (list group, board column), Tasks ⋯ › Archive Done Tasks |
| `board.unarchive` | ✓ an archived task's banner (Restore), ⋯ › Restore from Archive |
| `board.emptyArchive` | ✓ Tasks › Archive › Empty Archive |
| `board.setAutoTasks` | ✓ Tasks › ⋯ › Open a Task for Every New Worktree |
| `board.setPrefix` | ✓ Tasks › ⋯ › Task Keys… |
| `plans.create` | ✓ Plans › New Plan (a goal; Claude plans in a conversation of its own in the project's main folder) |
| `plans.here` | ✓ the composer's mode menu › Plan with Tasks (Claude plans in the conversation you're in) |
| `plans.approve` | ✓ Approve Plan / Apply Changes on a plan's page and its strip above the conversation |
| `plans.discard` | ✓ Discard Draft / Discard Changes on a plan's page |
| `plans.edit` | ✓ editing a plan's outline (rename, criteria, move, remove, what waits on what) |
| `plans.setAutonomy` | ✓ Step by Step · Check-ins · Autopilot on a plan's page (a milestone's own from its menu) |
| `plans.setPaused` | ✓ Pause / Resume on a plan's page |
| `plans.setParallel` | ✓ a plan's ⋯ › Run at Once ▸ |
| `plans.setTestsAt` | ✓ a plan's ⋯ › When to Run Tests ▸ (each milestone, or once at the end) |
| `plans.pass` | ✓ Pass Milestone on a plan's page |
| `plans.recheck` | ✓ Check Again on a milestone Claude is checking or that failed its check |
| `plans.openPr` | ✓ Open PR on a plan whose every milestone passed (plan/<slug> → main) |
| `plans.mergePr` | ✓ Merge on GitHub once the plan's pull request is open |
| `plans.mergeLocal` | ✓ ⋯ › Merge into Main Locally on a plan ready to ship |
| `plans.sendBack` | ✓ Not Yet… on a milestone waiting for you |
| `plans.startTask` | ✓ Start on a ready task (step by step, or a task for you) |
| `plans.resumeTask` | ✓ Resume on a task that stopped (Claude ran out of usage or crashed) |
| `plans.remove` | ✓ a plan's ⋯ › Delete Plan… (its tasks stay on the board) |
| `plans.tidyUp` | ✓ Tidy Up / No on a plan's leftover task worktrees (merged into its branch, then archived) |
| `plans.setStyle` | ✓ Plans › ⋯ › Planning Style… |
| `claudeCode.steps` | ✓ a Claude Code session's or agent's live, read-only transcript (Activity, the strip above a workspace's chat, the Inspector's Claude Code panel) |
| `claudeCode.step` | ✓ opening a tool call or thinking line in that transcript: the command and its output, the file, the diff, the thinking |
| `claudeCode.findAgent` | ✓ opening a sub-agent's own worktree whose agent finished a while ago: it's found again and followed live |
| `claudeCode.outputs` | ✓ a sub-agent's Outputs tab: the screenshots, test output, logs and JSON it made or looked at (from its transcript, wherever it put them, plus its own `.beluga/scratch/agents/<name>/`), still on disk, newest first |
| `claudeCode.output` | ✓ looking at one of them: pictures inline, text with secrets redacted (only files that agent made or looked at) |
| `claudeCode.taskOutput` | ✓ following a background command or watch Claude or a sub-agent started (the panel's Background tab, below the terminal; a sub-agent's Background): the end of its output, live, cleaned of terminal codes and secrets; its own log when it writes to one |
| `agent.steps` | ✓ a Claude card's steps as disclosure rows (an icon per tool, ✓/✗, how long it took), thinking as “Thought for 12s”, sub-agents' steps |
| `agent.step` | ✓ opening a step on a Claude card: Bash's command and output (colours kept), the file read, an edit's diff, a search's matches, a page fetched, an MCP tool's input and output as JSON, the thinking |
| `view.fetch` | ✓ a live table, chart, stats or code view in a conversation fetching its next page, sorted or searched, or refreshing it (docs/views.md) |
| `git.fetch` | ✓ Fetch on a project's home (“fetched 3 min ago”, or why it couldn't: sign-in needed, offline) |
| `git.fetchIfStale` | ✓ opening a project's home fetches quietly when the last fetch is a few minutes old (the daemon also fetches every project every ~15 min) |
| `git.updateMain` | ✓ Update main on a project's home: fetch and fast-forward the default branch; what can't fast-forward asks (changes in the way, or Let Claude Handle It) |
| `git.stashAndUpdate` | ✓ the “changes in the way” alert › Stash and Update (and put them back) |
| `git.moveAndUpdate` | ✓ the “changes in the way” alert › Move to Worktree |
| `git.switchToDefault` | ✓ “The main folder is on feat/…” › Switch to main (clean; or Move to Worktree / Bring Them Along) |
| `git.askClaude` | ✓ Let Claude Handle It: a conversation in the project's Questions whose run may only sync git (banner “Claude is updating main”) |
| `git.github` | ✓ the GitHub row on a project's home: GitHub ↗, Private/Public, people, open PRs, stars (through gh, cached an hour; Connect GitHub when gh isn't set up) |
| `git.githubRepo` | ✓ Open on GitHub in a project's right-click and ⋯ menus |
| `git.log` | ✓ History: a project home's latest commits, the History page (Show All) and the panel's History tab (⌥⌘5), as a graph |
| `git.commit` | ✓ a commit in History: message, author, date, parents, files with +/− and their diffs |
| `git.mergePreview` | ✓ the toolbar's Merge into main: where it goes, the commits and files, and checks (conflicts, uncommitted work, the main folder's branch) before you confirm |
| `git.filters` | ✓ History's Branch and Author pop-ups |
| `git.worktreeAt` | ✓ a commit in History › Start a Worktree Here |
## Sending while Claude works, and images

| What | Core | Mac |
|---|---|---|
| Queue a message (the default while your Claude works) | `session.submit` | Return · the split button's **Queue** |
| Steer: Claude reads it at its next step without stopping (a run that can't take it: stop it, run this next) | `session.submit` with `urgent` | Option+Return · the split button's **Steer** |
| What waits, in run order (text, who asked) | `queueIn` (`src/ui/compose.ts`), the prompt comes with the `queued` event | the queue above the box |
| Run a waiting message now (steering, as above) | `host.promote` | queue › Steer |
| A steered message Claude hasn't read yet: sent, not read (its card is a note till Claude reads it: `READS_AFTER_STEP`, `STOPPING_FOR`, then `STEERED_IN` or its own turn) | `steerWaiting` (`src/shared/claude-notices.ts`), the message's `request` | your message dimmed, a clock and “Sent · waiting for Claude to read it” |
| Send it now: Claude's step stops (its interrupt, as Stop does) and the conversation goes on from your message | `host.steerNow` | **Send now** on that message · ⇧⌥↩ |
| Drop a waiting message | `host.cancelQueued` | queue › ✕ |
| Edit a waiting message (back into the box) | `host.cancelQueued`, then the box | queue › ✎ |
| Change the order | `host.reorderQueued` (yours only; friends' keep their places) | queue › ↑ ↓ |
| Paste or drop an image | `attachments.add` | ⌘V / drop: a chip plus its picture above the text |
| An image in a message | `attachments.read` (yours from disk, a friend's through their share) | the picture (several in a grid); click for full size, ⌘C copies, Open shows it in Preview |

## Beyond the shared actions

| What | Where |
|---|---|
| Window vibrancy, menu bar, menu-bar icon, `beluga://` links, Settings window, ⌘K palette, drag-and-drop images | Mac |
| A workspace's screen: the conversation always in the center; a right panel (⌥⌘0, resizable, its tab remembered per workspace; in two panes split where you drag it: what Claude made on top (Changes, Files, Scratch, Info) and what runs below (Terminal, Background; it folds to its tabs); drag a tab to the other pane or right-click › Move to Bottom / Top, Reset Panel Layout; tabs always named; History is Changes' second view; a dot on Scratch when Claude saves something new) with Changes (files with +/−, the diff inline or the file as itself — Markdown formatted, pictures and PDFs always as themselves — Show in Files, Commit / PR / Review), Files (a tree you filter by name, a preview with PDFs drawn page by page, Show Changes on a changed file), Terminal (the workspace's shells, setup and run) and Info (the inspector); a calm toolbar (what the workspace needs next, Run, ⋯ in sections: git steps, the conversation, the folder, putting it away; then Search, the bell, the panel); ⌘J types in the terminal, and puts it away when you're already typing there; Claude's steps fold away once it answers (Show Steps on the answer, Settings › Chat to keep them); ⌘J's terminal in that panel or a drawer under the chat; a diff, file or the terminal in full for a while (⌘↩, Esc back) | Mac (`layout/RightPanel.tsx`, `layout/panel/*`, `lib/panel.ts`) |
| Dock badge, clicking a desktop notification to go where it's about | Mac |
| Marking one notification unread again | Mac (hover a notification) |
| First-run welcome: a five-part animated tour (parallel worktrees, live agents, friends, earnings, archive), then the look and a few shared settings; once per Mac, never after an update; Help › Welcome to Beluga shows it again | Mac (`onboarding/*`) |
| Local UI preferences (appearance, accent, text size, density, widths) | Mac (`lib/prefs.ts`) |
| Terminal look (font, size, line height, cursor style and blink, scrollback) | Mac (`lib/prefs.ts`, Settings › Terminal) |
| Environment variable editor (masked values, paste KEY=value lines, per-project scope, load the project's .env) | Mac (Settings › Environment) |
| Confirmations as alerts (archive/delete with “Commit & Archive” and an env-changes table, clear, agent worktrees, hide project, leave a shared workspace), each with Cancel | Mac (`dialogs/native/*Alert.tsx`, `components/Alert.tsx`) |
| Inviting, people and sharing as sheets and cards: the Invite People sheet (Invite to popup, Watch / Prompt / Edit, Copy Invite Link with “Copied”, people waiting, active links with Copy and Revoke), a person's card beside their row (trust as a segmented control, Message / Ask Claude / Run / Follow / Files, usage meters, Remove with an alert), your account card (rename in place, who may use your Claude), a right-click Trust ▸ submenu, the Share sheet for a workspace (an access popup per person), Share a Folder (Open panel, your projects, only some people, Claude may edit, Stop Sharing), the room's card from the sidebar's status | Mac (`dialogs/native/InviteSheet.tsx`, `PersonPopover.tsx`, `PersonCards.tsx`, `PersonMenu.tsx`, `WorkspaceShare.tsx`, `ShareFolderSheet.tsx`, `SharedSheet.tsx`, `RoomPopover.tsx`) |
| Addressing a message with a chip (“To bob”, “To bob's Claude”, “To your Claude”) | Mac (`MacUi.to`, the composer) |
| Run a command on a friend's computer from a sheet with a command field | Mac (`dialogs/native/PeerSheets.tsx`) |
| Search over a workspace shared with you (names and contents) above its Files, instead of a read-only shell tab | Mac (`views/SharedSearch.tsx`) |
| A shared workspace's earlier conversation drawn as people's messages | Mac (`lib/said.ts`, from each line's `said`) |
| Clicking an invite link (`beluga://<key>…#secret`) opens the Join sheet | Mac (`lib/native.ts` `inviteOf`) |
| Forms instead of typing in the message box: fork name, project Setup/Run (with where each comes from, and “Save to beluga.json”: `workbench.setScript(…, team)`), PR with extra instructions, new template with Plan first (`workbench.saveTemplate(…, plan)`), hand off, a worktree or a command on a friend's computer, the model, the welcome choice | Mac (`dialogs/native/`, `lib/native-routes.ts`) |
| Groups in the sidebar: Move to Group ▸ submenu, a new group named in place, rename, ungroup (`workspaces.renameGroup`, `workspaces.ungroup`), drag a project onto a group or out of it | Mac (`layout/ProjectGroups.tsx`) |
| Arranging the sidebar Finder-style: drag projects to reorder them (an insertion line, the list scrolls near its edges, Esc puts it back), drop one on a group (the folder lights up; a folded one springs open) or between a group's projects, pull it out to the top level, drag groups among the projects; Move Up / Move Down (⌃⌘↑/↓) in a row's menu; empty groups you make stay until you delete them (`workspaces.arrange`, `workspaces.newGroup`; the order lives in projects.json's `order` and each group's list, see `src/workspaces/arrange.ts`). Project rows don't fold (their worktrees and chats always show, never the main checkout; clicking one opens the project); groups fold, with a count | Mac (`layout/ProjectTree.tsx`, `layout/arrange-drag.ts`, `layout/project-layout.ts`) |
| Hiding a project with Undo (“Hidden api — Undo”, ⌘Z) instead of an alert; Hidden Projects folded at the bottom of the sidebar, in Settings › Workspaces and in the Add Projects sheet, each with Show (`workspaces.showProject`; it comes back in its place and group) | Mac (`layout/ProjectTree.tsx`, `lib/undo-toast.tsx`) |
| “Connect GitHub” with copyable commands and Check Again (`workbench.refreshPrs(id, true)` looks for gh again) | Mac (PR sheet) |
| Stop your Claude in one conversation (`host.stopRun`): your queued messages there come back into the box, other people's requests keep their places and run next, other conversations carry on | Mac (■ Stop beside the send control, ⌘., Conversation › Stop Claude, Stop on a running answer) |
| Workspace and Conversation menus in the menu bar (Commit… ⇧⌘C, Pull Request… ⇧⌘P, Merge… ⇧⌘M, Run ⌘R, Ask Claude to Review… ⇧⌘R, Archive… ⌃⌘A, Stop ⌘., Plan First ⌥⌘P, Find ⌘F / ⌘G / ⇧⌘G, Clear ⇧⌘K, Previous/Next Workspace ⌥⌘↑/↓), greyed out when they can't run (`lib/commands.ts`, `set_menu_state`); what starts Claude or changes git (Review, Commit, Merge, Solve Conflict, Compact, Fix Checks) says what it will do and waits for Start, from every way in (a popover under its toolbar button, else an alert; `lib/work-confirm.ts`) | Mac |
| A calm sidebar: Overview, Tasks and Group chat at the top, always; Activity and Requests only while there's something in them; Shared files under Shared with me; Search in the toolbar (⇧⌘F); Usage as an icon above the sidebar (amber when most of the week is used); the terminal in the right panel (⌘J). The places in order (Overview, Tasks, Chat, Search, Usage, Terminal, Shared files) for ⌥1…7, ⌃Tab, the Go menu and the palette (`lib/go.ts`) | Mac |
| The toolbar's main button chosen from the workspace's state (Commit / Merge / PR #n / Fix Checks / Solve Conflict / Restore / Run), the rest as icons and a ⋯ menu with shortcuts (`layout/toolbar-actions.ts`) | Mac |
| Find in a conversation (⌘F) | Mac (`chat/FindBar.tsx`) |
| Right-click menus: messages (Copy, Copy as Markdown, Quote in Reply, Ask Claude About This, Open Image), code blocks, files (Open, Show in Finder, Copy Path, Mention in Chat, Save a Copy…), changed files and commits in Diff, search results, Usage rows, notifications | Mac |
| Save a shared file where you choose (`files.download` with `to`, the Save panel) | Mac |
| A new worktree's form: Based on (`workspaces.branches`), Name, Create Worktree (`workspaces.startWorktree` with `base` / `name`) | Mac |
| Never change main: every Claude run in a project's main folder (the main checkout, or a chat there) is questions only. Edits, writes and shell commands that aren't clearly read-only are denied (`agent/policy.ts` `askOnly`, `agent/read-only.ts`), Claude is told so, and a change request makes it call `continue_in_worktree`: a new worktree from the latest origin, named after the task, with the conversation carried over (history copied, Claude's session forked), and the work goes on there (your own requests move right away; someone else's ask you first) | both (core) |
| A project's home (`project` view): icon, name, main's branch and how it compares with origin, counts (active / ready to merge / archived, earnings), “What do you want to do in …?” with New Worktree (Based on, Name) or Just Ask, then its worktrees, questions and recently archived (Show All in Overview). Clicking a project opens it | Mac (`views/ProjectHome.tsx`, `lib/project-home.ts`) |
| Keeping main current and seeing history: the project home is about the default branch (main or master, “3 behind origin/main”, and “The main folder is on feat/…” with Switch to main), Update main and Fetch with when it last fetched, a quiet fetch of every project every ~15 min (never a password prompt: GIT_TERMINAL_PROMPT=0), uncommitted changes in the way (stash and put back, or move to a worktree), anything else to Claude in a run whose only permission beyond reading is syncing git (`agent/sync-main.ts`; never push, never discard), the GitHub row, and History (a commit graph with lanes and merges, authors as initials, refs as pills, filters, a commit's diffs; `views/history/*`) | Mac (`views/project/MainSyncBar.tsx`, `views/project/GitHubRow.tsx`, `views/history/*`, `layout/panel/HistoryTab.tsx`; core: `core/main-sync.ts`, `workspaces/sync.ts`, `workspaces/history.ts`, `workspaces/github.ts`) |
| A questions-only chat: “Questions only — Claude won’t change anything in main.” above the box, Continue in New Worktree… as the toolbar's main button, “Ask about <project>…” in the box | Mac (`chat/AskBanner.tsx`, `dialogs/native/ContinueSheet.tsx`) |
| Sub-agents: under the conversation that started them in the sidebar (a robot, running first, “N more”), their own worktrees as the agent (never as your worktrees; old ones no conversation here started aren’t listed, Clean Up Worktrees… has them), the sub-agent page (who started it, type, model, effort, time, steps, context; its live transcript with thinking and tools; its worktree's Changes, Files and Scratch beside it; Send to Main Claude to steer it through its lead), Watch on a sub-agent in the chat | Mac (`src/layout/SubAgents.tsx`, `src/claude-code/AgentMonitor.tsx`) |
| Chats with friends: tabs above the conversation (All Friends first; open, close, + for a new channel), files shared Mac to Mac (cards, pictures, progress, Open / Show in Finder / Save As), Claudes called in with the Ask Claude menu (answers marked “bob’s Claude”, “… is answering”), Settings › People & access › Who can ask your Claude in chats | Mac (`src/network/ChatTabs.tsx`, `ChatFiles.tsx`, `NetComposer.tsx`) |
| Friends, direct messages, groups and your status (the Beluga network): sidebar Friends and Groups with presence and unread, the Add a Friend sheet (code, link, QR; `beluga://add` / `beluga://join` links), conversations (`conversation` view), New Group / Add People sheets, group info (members, admins, invite link, join requests, rename, leave), the status menu in the sidebar and the menu bar, Away when idle, Settings › People & access switch | Mac (`src/network/*`) |
| Empty states with one-click starters (New Worktree, New Chat, Add Projects…, first tasks for Claude) | Mac |
| The palette's commands as named actions (“Create Pull Request…”, “Fork This Workspace…”), never `/cmd <arg>` | Mac (`dialogs/palette-commands.ts`) |
| The Beluga network: friends added once by a one-time link or a short code, direct messages that wait for offline friends, groups that live on their members' Macs (no host, end-to-end encrypted, admins add and remove people, join by link), and your status (online, away, do not disturb, appear offline) — the `network.*` API and the shared state's `network` | Mac (the daemon runs it when `network: true` is in settings or `BELUGA_NETWORK=1`; `src/net/mesh/`, `src/core/network.ts`) |
| Earnings from Stripe per project: a key per project (kept in ~/.beluga/stripe.json, 0600; screens only get `earnings`: connected, the account's name, all-time totals per currency, when they were counted, what went wrong), counted in the background once a day (incrementally, with a full recount weekly), shown as a pill beside each project in the sidebar, in the Inspector, and as a card in the Overview and the Usage view, every total in one currency (`prefs.earningsCurrency`, "Show earnings in" in Settings › General and the Stripe sheet; unset: the one most was earned in), other currencies converted at the ECB's daily rates (`src/core/fx-rates.ts`, `fx` in the shared state, fetched alongside the daily Stripe count) — the `stripe.*` API and the shared state's `earnings` | Mac (`src/core/stripe-earnings.ts`, the daemon runs it; `components/EarningsPill.tsx`, `dialogs/StripeSheet.tsx`, `lib/earnings.ts`) |
| Claude Code running outside Beluga, live and read-only: sessions you run through Conductor or a terminal, and their sub-agents (description, type, running / finished / failed / stopped / idle, the current step, steps, context), found by watching the transcripts Claude Code writes in ~/.claude/projects (never written to; tailed from the end, at most the last 200 steps per agent kept), in Activity (every live session by project, “6 agents running”), a strip above a workspace's chat and the Inspector's Claude Code panel (the session's folder is the workspace's, Conductor worktrees included), and a read-only transcript per session or agent; a background agent finishing notifies (`background`) — the `claudeCode.steps` API and the shared state's `claudeCode` (screens on this computer only, never sent to the room) | Mac (`src/core/claude-code/`, the daemon runs it; `src/claude-code/*` in the app) |
| The Worktrees page: every worktree in your projects (Beluga's, sub-agents', made outside Beluga) with who made it (a sub-agent's conversation, or that it's gone), whether its work is done, its size and what can be cleared; tick some, then Free Up Space (they stay) or Archive (everything of yours kept); the sidebar's Worktrees row, a project's Manage Worktrees… | Mac (`src/views/worktrees/`) |
| Tasks between Claudes (the gateway): your Claude finds who can help (`who_can`), asks their Claude (`ask_person`) or runs one command on their Mac (`run_on`), waits (`wait_for`) or ends its turn and continues when the answer comes back; you're asked first for people you don't trust (a card in the conversation), their side approves with today's approval cards unless they trust you; results go only to the requester, as data. Task cards in conversations, the Requests view (Sent / Received) — the `gateway.*` API and the shared state's `gateway` | Mac (`src/core/gateway/`, the daemon runs it; `src/gateway/*` in the app) |
| Tasks (the board): a Tasks place in the sidebar with My Tasks, Active, Backlog and All, by project; a list grouped by status, a board you drag cards across, and a graph of what waits on what (the graph engine); a task's page (its title, properties, a brief in sections that Claude and you keep true with every version kept, sub-tasks, blockers, its worktree and pull request, proof, activity and comments); a task opens with every new worktree and follows its pull request (In Review when it opens, Done when it merges); Start Worktree / Start with Claude on a task; your Claude's runs in a task's worktree get its brief and the task tools (`mcp__beluga_board__*`) — the `board.*` API and the shared state's `board` | Mac (`src/core/board/`, the daemon runs it; `src/tasks/*` in the app) |
| Plans: milestones with pass criteria and parallel tasks, drafted by Claude in a conversation and kept off the board until approved; a live plan graph and outline; Step by Step · Check-ins · Autopilot run by a scheduler that starts worktrees and asks Claude to check each milestone; the composer's Plan with Tasks — the `plans.*` API, Claude's `mcp__beluga_plan__*` tools and the shared state's `plans` | Mac (`src/core/plans/`, the daemon runs it; `src/plans/*` in the app) |
| Graphs Claude draws (`beluga-graph` blocks: interactive diagrams laid out by ELK and drawn with React Flow, in answers, reports and Markdown files; hover, details, walkthrough, full window) | Mac (`components/graph/*`; the format is `src/shared/graph-spec.ts`, Claude learns it from `agent/graph-prompt.ts`) |
| Views Claude shows (`beluga-view` blocks and the `show` tool: tables, charts, stats, code, colors; live from a file, folder, SQLite, Postgres, a web address or a command, paged, sorted and searched without Claude) | Mac (`components/views/*`; the format is `src/shared/view-spec.ts`, sources run in `core/views/sources.ts`, Claude learns it from `agent/view-prompt.ts`) |

## Adding a feature

1. The API: an entry in `src/ipc/api.ts` and its handler in `src/ipc/handlers.ts`.
2. The behavior in the core, with a contract test in `tests/contract/` (runs in process and over the daemon's socket).
3. Model or action code in `src/ui/*-models.ts` / `*-actions.ts` / `menus.ts` (keep it browser-safe: `tests/browser-safe.test.ts`).
4. The Mac app's pixels (`packages/mac/src`).
5. A row on this page.
6. Command, palette, menu bar and help entries.
