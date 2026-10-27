import type { Method } from '../ipc/api.js';

/**
 * What your phone may ask your Mac to do: every API method (src/ipc/api.ts) is `phone` or `mac`.
 * The type is `Record<Method, …>`, so a new method doesn't compile until someone decides, and
 * tests/companion-coverage.test.ts fails for one the list doesn't name.
 *
 * `phone` only for what fits the phone (docs/companion.md, "What it is for"): reading, answering
 * (approvals, Claude's questions, friends' requests, plan decisions), asking your Mac (a message in
 * a conversation, a new chat in a project, a friend's Claude), stopping a run, and chatting with
 * friends. Since BLG-42 also a worktree's files, read-only (`companion.files.*`, through the
 * companion's file gate: inside that worktree, never a secret), and its terminals, interactive and
 * shared with the Mac (`companion.terminals` / `termOpen` / `termClose`). Never editing, diffs, git
 * beyond Merge, files on the Mac by path, settings, projects, invitations or hosting; the Mac's own
 * `terminals.*` and `files.*` stay the Mac's. The host refuses a `mac` method before its arguments
 * are even parsed.
 */
export type Side = 'phone' | 'mac';

export const PHONE: Record<Method, Side> = {
  // ---- the room, chat and your preferences
  'session.submit': 'phone',
  'session.copyInvite': 'mac',
  'session.copyLastAnswer': 'mac',
  'session.copyText': 'mac',
  'session.setPrefs': 'mac',
  'session.setPlanMode': 'mac',
  'session.setClaudeSharing': 'mac',
  'session.rename': 'mac',
  'session.zoom': 'mac',
  'session.shareFolder': 'mac',
  'session.unshareFolder': 'mac',
  'session.follow': 'mac',
  'session.clearChat': 'mac',
  'session.removePerson': 'mac',
  'session.newInviteLink': 'mac',
  'session.setRoomOpen': 'mac',
  'session.retryConnection': 'mac',
  'session.setFriendWorktrees': 'mac',
  'session.setAccess': 'mac',
  'session.runOnPeerByHand': 'mac',
  'session.stopAgent': 'mac',
  'session.compact': 'mac',
  'session.quit': 'mac',
  'session.serveFolder': 'mac',
  'session.localLocation': 'mac',
  'session.testNotification': 'mac',

  // ---- your Claude's queue and approvals
  'host.answerApproval': 'phone',
  'host.promote': 'phone',
  'host.sendNext': 'phone',
  // Your steered message Claude hasn't read yet, answered now: like Stop, phone-sized.
  'host.steerNow': 'phone',
  'host.stopRun': 'phone',
  'host.cancelQueued': 'phone',
  'host.reorderQueued': 'mac',

  // ---- the inbox
  'inbox.read': 'phone',
  'inbox.unread': 'phone',
  'inbox.clear': 'mac',

  // ---- Claude's questions
  'questions.answer': 'phone',
  'questions.pick': 'phone',

  // ---- people, sharing, invitations, a friend's computer: the Mac's (but answering a knock)
  'people.setTrust': 'mac',
  'people.dismissPrompt': 'mac',
  'people.forget': 'mac',
  'sharing.invite': 'mac',
  'sharing.remove': 'mac',
  'sharing.leave': 'mac',
  'sharing.shareWithFriend': 'mac',
  'sharing.unshareFriend': 'mac',
  'sharing.leaveProject': 'mac',
  'sharing.copyProject': 'mac',
  'invites.create': 'mac',
  'invites.revoke': 'mac',
  'invites.copyLink': 'mac',
  // Someone at the door with a link you made: let them in (as the link offers) or turn them away, like an approval.
  'invites.letIn': 'phone',
  'invites.decline': 'phone',
  'invites.change': 'mac',
  'invites.remove': 'mac',
  'remote.requestWorktree': 'mac',
  'remote.handoff': 'mac',

  // ---- diffs, shells, files by path: code, never on the phone
  'diff.load': 'mac',
  'diff.select': 'mac',
  'shell.run': 'mac',
  'shell.openEntry': 'mac',
  'files.browseTo': 'mac',
  'files.enter': 'mac',
  'files.up': 'mac',
  'files.loadDir': 'mac',
  'files.open': 'mac',
  'files.openSpec': 'mac',
  'files.download': 'mac',
  'files.downloadSpec': 'mac',
  'files.closeViewer': 'mac',
  'files.readImage': 'mac',
  'files.readImageFile': 'mac',
  'files.read': 'mac',

  // ---- projects and workspaces: a new chat in a project, and loading a conversation to read it
  'workspaces.open': 'mac',
  'workspaces.load': 'phone',
  'workspaces.refresh': 'mac',
  'workspaces.newWorktree': 'mac',
  'workspaces.newChat': 'mac',
  'workspaces.startChat': 'phone',
  'workspaces.startWorktree': 'phone',
  'workspaces.branches': 'mac',
  'workspaces.fork': 'mac',
  'workspaces.continueInWorktree': 'mac',
  'workspaces.archive': 'mac',
  'workspaces.restore': 'mac',
  'workspaces.archivePlan': 'mac',
  'workspaces.freeSpace': 'mac',
  'workspaces.remove': 'mac',
  'workspaces.commit': 'mac',
  'workspaces.merge': 'mac',
  'workspaces.prepareRemoval': 'mac',
  'workspaces.applyEnvBack': 'mac',
  'workspaces.askClaudeToReview': 'mac',
  'workspaces.askClaudeToMerge': 'mac',
  'workspaces.compact': 'mac',
  'workspaces.openInFinder': 'mac',
  'workspaces.setGroup': 'mac',
  'workspaces.renameGroup': 'mac',
  'workspaces.ungroup': 'mac',
  'workspaces.arrange': 'mac',
  'workspaces.newGroup': 'mac',
  'workspaces.showProject': 'mac',
  'workspaces.hideProject': 'mac',
  'workspaces.removeProject': 'mac',
  'workspaces.cleanAgentWorktrees': 'mac',
  'workspaces.otherOrigins': 'mac',
  'workspaces.otherActivity': 'mac',
  'workspaces.worktreeInfo': 'mac',
  'workspaces.showConversation': 'mac',
  'workspaces.removeOther': 'mac',
  'workspaces.staleOthers': 'mac',
  'workspaces.cleanUpOthers': 'mac',
  'workspaces.addProject': 'mac',
  'workspaces.addFolder': 'mac',
  'workspaces.selectFile': 'mac',
  'workspaces.review': 'mac',
  // Paths on the Mac: the phone sees the scratch folder's files as outputs in a view instead.
  'workspaces.scratch': 'mac',

  // ---- runs, scripts, pull requests, terminals, environment
  'workbench.run': 'mac',
  'workbench.stopRun': 'mac',
  'workbench.runSetup': 'mac',
  'workbench.setScript': 'mac',
  'workbench.shareScripts': 'mac',
  'workbench.setModel': 'mac',
  'workbench.createPr': 'mac',
  'workbench.quickPr': 'mac',
  'workbench.gitFix': 'mac',
  'workbench.fixChecks': 'mac',
  'workbench.resolvePrConflicts': 'mac',
  'workbench.continueAfterMerge': 'mac',
  'workbench.openPr': 'mac',
  'workbench.mergePr': 'mac',
  'workbench.prStep': 'mac',
  'workbench.cancelMergeWhenReady': 'mac',
  'workbench.refreshPrs': 'mac',
  'workbench.editPrPrompt': 'mac',
  'workbench.resetPrPrompt': 'mac',
  'workbench.measureDisk': 'mac',
  'workbench.search': 'mac',
  'workbench.openHit': 'mac',
  'workbench.saveTemplate': 'mac',
  'workbench.removeTemplate': 'mac',
  'terminals.shell': 'mac',
  'terminals.global': 'mac',
  'terminals.close': 'mac',
  'terminals.rename': 'mac',
  'terminals.restart': 'mac',
  'env.get': 'mac',
  'env.set': 'mac',
  'env.claudeDotenv': 'mac',
  'env.testDatabase': 'mac',

  // ---- images in a message: a photo from the phone goes in as bytes, never as a Mac path
  'attachments.add': 'phone',
  'attachments.addFile': 'mac',
  'attachments.expand': 'phone',
  'attachments.read': 'phone',
  'attachments.open': 'mac',
  'attachments.reattach': 'mac',

  'daemon.stop': 'mac',
  'projects.icon': 'mac',
  'projects.setIcon': 'mac',
  'projects.add': 'mac',
  'projects.addFolder': 'mac',
  'projects.suggest': 'mac',
  'projects.iconAt': 'mac',
  'local.listDirs': 'mac',
  'local.openFolder': 'mac',
  'local.statFiles': 'mac',

  // ---- the Beluga network: reading and writing your chats, yes; managing friends and groups, no
  'network.status': 'phone',
  'network.setEnabled': 'mac',
  'network.friends.list': 'phone',
  'network.friends.invite': 'mac',
  'network.friends.accept': 'mac',
  'network.friends.cancelInvite': 'mac',
  'network.friends.remove': 'mac',
  // Asking someone in your room is the Mac's (the sidebar's Not friends yet); answering a request is a NeedsYou item, on the phone too.
  'network.friends.addFromRoom': 'mac',
  'network.friends.answerOffer': 'phone',
  'network.dm.send': 'phone',
  'network.dm.history': 'phone',
  'network.groups.list': 'phone',
  'network.groups.create': 'mac',
  'network.groups.send': 'phone',
  'network.groups.history': 'phone',
  'network.groups.addMember': 'mac',
  'network.groups.removeMember': 'mac',
  'network.groups.setAdmin': 'mac',
  'network.groups.leave': 'mac',
  'network.groups.delete': 'mac',
  'network.groups.rename': 'mac',
  'network.groups.invite': 'mac',
  'network.groups.join': 'mac',
  // Someone asks to join a channel you run: an answer, like an approval.
  'network.groups.approve': 'phone',
  'network.groups.decline': 'phone',
  'network.presence.set': 'phone',
  'network.presence.get': 'phone',
  'network.post': 'phone',
  'network.files.add': 'mac',
  'network.files.addData': 'phone',
  'network.files.download': 'phone',
  'network.files.cancel': 'phone',
  'network.files.open': 'mac',
  'network.files.reveal': 'mac',
  'network.files.saveTo': 'mac',
  'network.files.preview': 'phone',
  'network.channels.main': 'phone',
  'network.read': 'phone',

  'stripe.connect': 'mac',
  'stripe.disconnect': 'mac',
  'stripe.refresh': 'mac',

  // ---- supporting Beluga: the star and coffee asks are the Mac's (they open web pages there)
  'support.answer': 'mac',

  // ---- Your Mac's chats (BLG-102): since 1.14 the phone lists them, starts one and deletes one
  // (it's chatting). Which tab is open is the Mac's: the phone opens any chat without moving it.
  'assistant.newChat': 'phone',
  'assistant.openChat': 'mac',
  'assistant.deleteChat': 'phone',

  // ---- Claude Code's sessions: what its agents made (outputs, background logs), not their steps' code
  'claudeCode.steps': 'mac',
  'claudeCode.step': 'mac',
  'claudeCode.findAgent': 'mac',
  'claudeCode.outputs': 'phone',
  'claudeCode.output': 'phone',
  'claudeCode.taskOutput': 'phone',
  'claudeCode.skills': 'mac',
  'claudeCode.mcpServers': 'mac',
  'claudeCode.mcpSignIn': 'mac',
  'claudeCode.mcpSignedIn': 'mac',
  // A step's details are code (commands, diffs); the phone gets steps in words in its views.
  'agent.steps': 'mac',
  'agent.step': 'mac',

  // ---- tasks between Claudes: answering and asking, not your rules or capabilities
  'gateway.list': 'phone',
  'gateway.confirm': 'phone',
  'gateway.setAskFreely': 'mac',
  'gateway.cancel': 'phone',
  'gateway.ask': 'phone',
  'gateway.setNote': 'mac',
  'gateway.decide': 'phone',
  'gateway.answer': 'phone',
  'gateway.saveRule': 'mac',
  'gateway.removeRule': 'mac',
  'gateway.setCapabilities': 'mac',
  'gateway.image': 'phone',

  // ---- the board: a comment and a task's status (moving it along), nothing structural
  'board.create': 'mac',
  'board.update': 'mac',
  'board.move': 'phone',
  'board.editBrief': 'mac',
  'board.restoreRevision': 'mac',
  'board.comment': 'phone',
  'board.relate': 'mac',
  'board.addProof': 'mac',
  'board.removeProof': 'mac',
  'board.remove': 'mac',
  // Start a task in a new worktree (with Claude on it), as the Mac's Start does.
  'board.start': 'phone',
  'board.settleGone': 'mac',
  'board.setAutoTasks': 'mac',
  'board.setPrefix': 'mac',
  // Connecting a tracker is a key and settings: the Mac's.
  'board.syncTeams': 'mac',
  'board.syncConnect': 'mac',
  'board.syncDisconnect': 'mac',
  'board.syncAuto': 'mac',
  // Sync Now is a tap that fits anywhere, but the phone shows no sync status yet.
  'board.syncNow': 'mac',
  'board.archive': 'mac',
  'board.archiveDone': 'mac',
  'board.unarchive': 'mac',
  'board.emptyArchive': 'mac',

  // ---- plans: approve, decide at a milestone's gate, send back with words; never edit their structure
  'plans.create': 'phone',
  'plans.here': 'mac',
  'plans.approve': 'phone',
  'plans.discard': 'phone',
  'plans.edit': 'mac',
  'plans.setAutonomy': 'phone',
  'plans.setPaused': 'mac',
  'plans.setParallel': 'mac',
  'plans.setTestsAt': 'mac',
  'plans.tidyUp': 'mac',
  'plans.pass': 'phone',
  'plans.recheck': 'phone',
  'plans.sendBack': 'phone',
  'plans.openPr': 'mac',
  'plans.mergePr': 'mac',
  'plans.mergeLocal': 'mac',
  'plans.startTask': 'mac',
  'plans.resumeTask': 'mac',
  'plans.remove': 'mac',
  'plans.setStyle': 'mac',

  // ---- GitHub issues: the Mac's Issues view for now. Reading them and handing one to Claude fits the
  // phone too (BLG-170): until its screen exists, a task made from one shows on the phone's board.
  'issues.list': 'mac',
  'issues.get': 'mac',
  'issues.investigate': 'mac',
  'issues.fix': 'mac',
  'issues.toTask': 'mac',
  'issues.comment': 'mac',
  // A project's GitHub Actions: the Mac's Actions and run pages (the phone has no GitHub screens yet).
  'ci.runs': 'mac',
  'ci.run': 'mac',
  'ci.workflows': 'mac',
  'ci.log': 'mac',
  'ci.rerun': 'mac',
  'ci.cancel': 'mac',
  // Team boards: answering an offer is the phone's (a NeedsYou card); leaving a team is the Mac's.
  'team.answer': 'phone',
  'team.leave': 'mac',
  'team.ackAssignment': 'phone',
  // Shared plans: sharing one is the Mac's (its menu); reviewing one and settling suggestions are answers, the phone's too.
  'team.sharePlan': 'mac',
  'team.reviewPlan': 'phone',
  'team.applySuggestion': 'phone',
  'team.dismissSuggestion': 'phone',

  // ---- git, live views' sources, editing files: the Mac's
  'git.fetch': 'mac',
  'git.fetchIfStale': 'mac',
  'git.updateMain': 'mac',
  'git.stashAndUpdate': 'mac',
  'git.moveAndUpdate': 'mac',
  'git.switchToDefault': 'mac',
  'git.askClaude': 'mac',
  'git.github': 'mac',
  'git.githubRepo': 'mac',
  'git.log': 'mac',
  'git.mergePreview': 'mac',
  'git.commit': 'mac',
  'git.filters': 'mac',
  'git.worktreeAt': 'mac',
  'view.fetch': 'mac',
  'files.searchContent': 'mac',
  'files.save': 'mac',
  'files.formatter': 'mac',
  'files.format': 'mac',

  // ---- the phone itself: pairing and removing are done on the Mac
  'companion.pair.start': 'mac',
  'companion.pair.approve': 'mac',
  'companion.pair.cancel': 'mac',
  'companion.devices.remove': 'mac',
  'companion.phone.use': 'mac',
  'companion.phone.pairAdb': 'mac',
  'companion.phone.wifi': 'mac',
  'companion.phone.pairCable': 'mac',
  'companion.phone.settings': 'mac',
  'companion.phone.act': 'mac',
  'companion.phone.macros': 'mac',
  'companion.phone.macroRun': 'mac',
  'companion.phone.macroDelete': 'mac',
  'companion.older': 'phone',
  'companion.ask': 'phone',
  'companion.post': 'phone',
  'companion.askPerson': 'phone',
  // Only ever the calling phone's own certificate.
  'companion.signOut': 'phone',
  // Your Mac's one setting the phone may change (BLG-127): whether it stays awake for the phone.
  'companion.keepAwake': 'phone',
  // The Mac app's window shows what the phone has open; an icon the views named by its checksum.
  'companion.openOnMac': 'phone',
  'companion.icon': 'phone',
  // Merging a worktree (a deliberate act: the phone confirms with a sheet first): the Mac's checks,
  // its merge, and Claude resolving conflicts. Files by name only; workspaces.merge itself stays the Mac's.
  'companion.mergeCheck': 'phone',
  'companion.merge': 'phone',
  'companion.resolve': 'phone',
  'companion.branchStep': 'phone',
  // A live view's rows, run on the Mac with view.fetch's rules (only your own Claude's views, only sources they name).
  'companion.viewFetch': 'phone',
  // A task described in words: Claude's draft shown first, then added.
  'companion.draftTask': 'phone',
  'companion.addTask': 'phone',
  // A worktree's files, read-only, through the file gate (worktree-files.ts): inside it, never secrets.
  'companion.files.list': 'phone',
  'companion.files.find': 'phone',
  'companion.files.read': 'phone',
  // A worktree's terminals, the same sessions as the Mac's (terminals.ts): your own paired phone
  // types into them; who attached and how much they typed is logged.
  'companion.terminals': 'phone',
  'companion.termOpen': 'phone',
  'companion.termClose': 'phone',
  // A sub-agent opened on the phone (BLG-110): its steps in words and its report, code stripped.
  'companion.subAgent': 'phone',
  // Which conversations the phone saved files from are archived or deleted (BLG-124): names only.
  'companion.gone': 'phone',
  'companion.voice': 'phone',
  'companion.voicePrepare': 'phone',
  'companion.transcribe': 'phone',
  // The Mac app's own microphone; the phone has companion.transcribe.
  'voice.models': 'mac',
  'voice.prepare': 'mac',
  'voice.transcribe': 'mac',
  // Settings › Terminal › Import from…, and the welcome's terminal step: Mac settings only.
  'terminalImport.detect': 'mac',
  // Sentinel (docs/sentinel.md): the phone runs one, pauses or resumes it, reads its runs and
  // reports, and answers a run waiting for a merge. Making and changing sentinels is the Mac's.
  'sentinel.run': 'phone',
  'sentinel.pause': 'phone',
  'sentinel.runs': 'phone',
  'sentinel.runGet': 'phone',
  'sentinel.decide': 'phone',
  'sentinel.create': 'mac',
  'sentinel.update': 'mac',
  'sentinel.remove': 'mac',
  'sentinel.duplicate': 'mac',
  'sentinel.stop': 'mac',
  // Claude changing a sentinel (the page's box, Describe it) is the Mac's: the phone has no editor.
  'sentinel.ask': 'mac',
  'sentinel.recipes': 'mac',
  'sentinel.setRunAtOnce': 'mac',
  'sentinel.rotateSecret': 'mac',
  'sentinel.webhookUrl': 'mac',
  // Numbers and dashboards (docs/sentinel.md §10): the phone reads a number over time and pulls a
  // dashboard to refresh it (Run Now on its sentinels); arranging dashboards is the Mac's.
  'sentinel.metricRead': 'phone',
  'dashboard.refresh': 'phone',
  'dashboard.create': 'mac',
  'dashboard.update': 'mac',
  'dashboard.remove': 'mac',
  'dashboard.addTile': 'mac',
  'dashboard.updateTile': 'mac',
  'dashboard.removeTile': 'mac',
  'dashboard.moveTile': 'mac',
  'dashboard.ask': 'mac',
  // The Sentinel chat (docs/sentinel.md §12): the phone writes and answers in the open one through
  // companion.ask, as in any conversation it can write in; managing the chats is the Mac's.
  'sentinel.chatNew': 'mac',
  'sentinel.chatOpen': 'mac',
  'sentinel.chatClear': 'mac',
  'sentinel.chatDelete': 'mac',
};

/** A method the phone may call (unknown names are not). */
export const phoneMay = (method: string): method is Method => Object.hasOwn(PHONE, method) && PHONE[method as Method] === 'phone';
