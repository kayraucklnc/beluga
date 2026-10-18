# Parity: the terminal app and the Mac app

Both clients drive the same core through `src/ipc/api.ts`. This page lists every way in and where each client shows it. `tests/parity.test.ts` fails when a command, a UI action, a menu or an API method exists without a row here.

Columns: **Core** is the API method or intent it uses; **Terminal** and **Mac** are where you find it.

## Slash commands

| Command | Core | Terminal | Mac |
|---|---|---|---|
| `/invite` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar footer Invite · File › Invite… · ⌘K |
| `/overview` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar › Overview · Go › Overview (⌥3) |
| `/room` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar › Chat (⌥1) |
| `/new` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Sidebar project ⌥ button · File › New Worktree… (⌘⇧N) · ⌘K |
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
| `/inbox` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Inspector › Inbox · Go › Inbox |
| `/template` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Palette › Start from a template… |
| `/shell` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Settings › Workspaces › Terminal shell |
| `/compact` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar ⋯ › Compact |
| `/merge` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar Merge |
| `/commit` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · Toolbar Commit |
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
| `/stop` | `session.submit` → `runCommand` | typed in the composer | typed in the composer · ⌘K › Stop your Claude |
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
| `inbox` | menu overlay | sheet |
| `person` | menu overlay | sheet and right-click menu |
| `confirm` | menu overlay | sheet |
| `project` | menu overlay | sheet and right-click menu |
| `archived` | menu overlay | sheet and right-click menu |
| `agents` | menu overlay | sheet |
| `ws_share` | menu overlay | sheet |
| `shared` | menu overlay | sheet and right-click menu |
| `clear` | menu overlay | sheet |
| `invite_person` | menu overlay | sheet |
| `share_folder` | menu overlay | sheet |
| `share_who` | menu overlay | sheet |
| `pr` | menu overlay | sheet |
| `scripts` | menu overlay | sheet |
| `templates` | menu overlay | sheet |
| `handoff` | menu overlay | sheet |
| `remote_ws` | menu overlay | sheet |
| `ws_more` | menu overlay | sheet |
| `invite_link` | menu overlay | sheet |
| `guest_add` | menu overlay | sheet |

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
| `host.cancelQueued` | ✓ | ✓ |
| `inbox.read` | ✓ | ✓ |
| `inbox.clear` | ✓ | ✓ |
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
| `shell.run` | ✓ | ✓ |
| `shell.openEntry` | ✓ | ✓ |
| `files.browseTo` | ✓ | ✓ |
| `files.enter` | ✓ | ✓ |
| `files.up` | ✓ | ✓ |
| `files.loadDir` | ✓ | ✓ |
| `files.open` | ✓ | ✓ |
| `files.openSpec` | ✓ | ✓ |
| `files.download` | ✓ | ✓ |
| `files.downloadSpec` | ✓ | ✓ |
| `files.closeViewer` | ✓ | ✓ |
| `files.readImage` | ✓ | ✓ |
| `workspaces.open` | ✓ | ✓ |
| `workspaces.refresh` | ✓ | ✓ |
| `workspaces.newWorktree` | ✓ | ✓ |
| `workspaces.newChat` | ✓ | ✓ |
| `workspaces.startChat` | ✓ | ✓ |
| `workspaces.startWorktree` | ✓ | ✓ |
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
| `attachments.add` | ✓ | ✓ |
| `attachments.expand` | ✓ | ✓ |
| `daemon.stop` | ✓ | ✓ |
| `local.listDirs` | ✓ | ✓ |
| `local.openFolder` | ✓ | ✓ |
## Only in one client, on purpose

| What | Where | Why |
|---|---|---|
| Mouse escape codes, OSC 52 copy, terminal zoom, focus reports | Terminal | they are the terminal's own features (`src/ui/tty`) |
| Window vibrancy, menu bar, menu-bar icon, `klaud://` links, Settings window, ⌘K palette, docked terminal (⌘J), drag-and-drop images | Mac | native window features; the actions they run are the shared ones above |
| Local UI preferences (appearance, accent, text size, density, widths) | Mac (`lib/prefs.ts`) | per window; klaud's own settings (model, notifications, trust…) are shared through `session.setPrefs` |

## Adding a feature

1. The API: an entry in `src/ipc/api.ts` and its handler in `src/ipc/handlers.ts`.
2. The behavior in the core, with a contract test in `tests/contract/` (runs over both clients).
3. Shared model or action code in `src/ui/*-models.ts` / `*-actions.ts` / `menus.ts` if both screens show it (keep it browser-safe: `tests/browser-safe.test.ts`).
4. The terminal UI's pixels.
5. The Mac app's pixels (`packages/mac/src`).
6. A row on this page.
7. Command, palette, menu bar and help entries.
