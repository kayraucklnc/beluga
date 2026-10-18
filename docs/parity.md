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
| `/review` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Workspace › Diff tab |
| `/pr` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar PR · ⌘K |
| `/run` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar Run · Terminal tab Run · person sheet “Run a command…” |
| `/terminal` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Workspace › Terminal tab · ⌘J dock · Go › Terminal (⌥6) |
| `/setup` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Terminal tab Setup |
| `/handoff` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar ⋯ › Hand off |
| `/model` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Composer model picker |
| `/search` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar › Search · ⌘⇧F |
| `/usage` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar › Usage (⌥5) |
| `/inbox` | `session.submit` → `runCommand` | typed in the composer · top bar “● N new” | typed in the composer · toolbar bell (notification centre) · Inspector › Notifications · Go › Inbox · ⌘K › Notifications |
| `/template` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Palette › Start from a template… |
| `/shell` | `session.submit` → `runCommand` (`/shell fish`, `default`, `login on\|off`, `args …`) | typed in the composer · Settings › Workspaces › Terminal | typed in the composer · Settings › Terminal › Shell |
| `/env` | `session.submit` → `runCommand` (`/env KEY=value`, `KEY=` removes, `project KEY=value`) | typed in the composer · Settings › Workspaces › Environment variables | typed in the composer · Settings › Environment |
| `/compact` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar ⋯ › Compact |
| `/merge` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar Merge (the main button when ready) · Workspace › Merge (⇧⌘M) |
| `/commit` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar Commit · Workspace › Commit (⇧⌘C) |
| `/fork` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar ⋯ › Fork |
| `/finder` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar ⋯ › Finder · Inspector Finder |
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
| `workspaces.open` | ✓ | ✓ |
| `workspaces.refresh` | ✓ | ✓ |
| `workspaces.newWorktree` | ✓ | ✓ |
| `workspaces.newChat` | ✓ | ✓ |
| `workspaces.startChat` | ✓ | ✓ |
| `workspaces.startWorktree` | ✓ | ✓ |
| `workspaces.branches` | — (Mac only: worktrees start from the default branch) | New worktree › Based on popup |
| `workspaces.fork` | ✓ | ✓ |
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
| `workspaces.ungroup` | – | ✓ (group row › Ungroup) |
| `workspaces.hideProject` | ✓ | ✓ |
| `workspaces.cleanAgentWorktrees` | ✓ | ✓ |
| `workspaces.addProject` | ✓ | ✓ |
| `workspaces.addFolder` | ✓ | ✓ |
| `workspaces.selectFile` | ✓ | ✓ |
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
| Window vibrancy, menu bar, menu-bar icon, `klaud://` links, Settings window, ⌘K palette, docked terminal (⌘J), drag-and-drop images | Mac | native window features; the actions they run are the shared ones above |
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
| “Connect GitHub” with copyable commands and Check Again (`workbench.refreshPrs(id, true)` looks for gh again) | Mac (PR sheet) | the terminal says to install gh in its PR menu |
| Stop your Claude in one conversation (`host.stopRun`): your queued messages there come back into the box, other people's requests keep their places and run next, other conversations carry on | Mac (■ Stop beside the send control, ⌘., Conversation › Stop Claude, Stop on a running answer) | the terminal keeps `/stop` (everywhere); `host.stopRun` is in the core for any screen |
| Workspace and Conversation menus in the menu bar (Commit ⇧⌘C, Pull Request… ⇧⌘P, Merge ⇧⌘M, Run ⌘R, Ask Claude to Review ⇧⌘R, Archive… ⌃⌘A, Stop ⌘., Plan First ⌥⌘P, Find ⌘F / ⌘G / ⇧⌘G, Clear ⇧⌘K, Previous/Next Workspace ⌥⌘↑/↓), greyed out when they can't run (`lib/commands.ts`, `set_menu_state`) | Mac | the same workspace actions as the toolbar (`workspaceButtons`); the terminal has its top bar and /commands |
| The places in the sidebar's order (Chat, Overview, Shared files, Search, Usage, Terminal) for ⌥1…6, ⌃Tab, the Go menu and the palette (`lib/go.ts`) | Mac | the terminal keeps its tab order (`topTabs`) |
| The toolbar's main button chosen from the workspace's state (Commit / Merge / PR #n / Fix Checks / Solve Conflict / Restore / Run), the rest as icons and a ⋯ menu with shortcuts (`layout/toolbar-actions.ts`) | Mac | the same `workspaceButtons`; the terminal's top bar shows them as words |
| Find in a conversation (⌘F) | Mac (`chat/FindBar.tsx`) | the terminal has Search (all conversations) |
| Right-click menus: messages (Copy, Copy as Markdown, Quote in Reply, Ask Claude About This, Open Image), code blocks, files (Open, Show in Finder, Copy Path, Mention in Chat, Save a Copy…), changed files and commits in Diff, search results, Usage rows, notifications | Mac | native context menus; what they run is shared (`files.open`, `files.download`, `inbox.*`…) |
| Save a shared file where you choose (`files.download` with `to`, the Save panel) | Mac | the terminal saves to ~/Downloads/klaud |
| A new worktree's form: Based on (`workspaces.branches`), Name, Create Worktree (`workspaces.startWorktree` with `base` / `name`) | Mac | the terminal names it from the task and starts from the default branch |
| Empty states with one-click starters (New Worktree, New Chat, Add Projects…, first tasks for Claude) | Mac | the terminal's empty views say what to type |
| The palette's commands as named actions (“Create Pull Request…”, “Fork This Workspace…”), never `/cmd <arg>` | Mac (`dialogs/palette-commands.ts`) | the terminal has the commands themselves |

## Adding a feature

1. The API: an entry in `src/ipc/api.ts` and its handler in `src/ipc/handlers.ts`.
2. The behavior in the core, with a contract test in `tests/contract/` (runs over both clients).
3. Shared model or action code in `src/ui/*-models.ts` / `*-actions.ts` / `menus.ts` if both screens show it (keep it browser-safe: `tests/browser-safe.test.ts`).
4. The terminal UI's pixels.
5. The Mac app's pixels (`packages/mac/src`).
6. A row on this page.
7. Command, palette, menu bar and help entries.
