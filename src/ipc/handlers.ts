import type { Session } from '../core/session.js';
import type { WorkspaceController } from '../core/workspace-controller.js';
import type { Workbench } from '../core/workbench.js';
import { listLocalDirs, localDirKey, openWithSystem } from '../core/local.js';
import type { Args, Method } from './api.js';

/**
 * What each API method does (see api.ts for the list and its arguments). Runs in the core:
 * in the daemon for every connected client, or in the terminal UI's own process.
 * Results are plain data (they cross a socket).
 */
type Handler<M extends Method> = (s: Session, ...args: Args<M>) => unknown;
export type Handlers = { readonly [M in Method]: Handler<M> };

// Without projects (some tests, the guest-only mode) these do nothing, as before.
const ctl = (s: Session): WorkspaceController | undefined => s.workspaces;
const bench = (s: Session): Workbench | undefined => s.workbench;

/** A terminal program started (or already running), by key; undefined when it couldn't start. */
const started = (pty: { id: string } | undefined): string | undefined => pty?.id;

export const HANDLERS = {
  'session.submit': (s, raw, opts) => s.submit(raw, opts),
  'session.copyInvite': (s) => s.copyInvite(),
  'session.copyLastAnswer': (s) => s.copyLastAnswer(),
  'session.copyText': (s, text, success) => s.copyText(text, success),
  'session.setPrefs': (s, prefs) => s.setPrefs(prefs),
  'session.setPlanMode': (s, channel, on) => s.setPlanMode(channel, on),
  'session.setClaudeSharing': (s, policy) => s.setClaudeSharing(policy),
  'session.rename': (s, name) => s.rename(name),
  'session.zoom': (s, dir) => s.zoom(dir),
  'session.shareFolder': (s, dir, writable, only) => s.shareFolder(dir, writable, only),
  'session.unshareFolder': (s, name) => s.unshareFolder(name),
  'session.follow': (s, name) => s.follow(name),
  'session.clearChat': (s, channel, opts) => s.clearChat(channel, opts),
  'session.removePerson': (s, peerId) => s.removePerson(peerId),
  'session.newInviteLink': (s) => s.newInviteLink(),
  'session.setRoomOpen': (s, open) => s.setRoomOpen(open),
  'session.setFriendWorktrees': (s, value) => s.setFriendWorktrees(value),
  'session.setAccess': (s, peerId, scope) => s.setAccess(peerId, scope),
  'session.runOnPeerByHand': (s, name, command, channel) => s.runOnPeerByHand(name, command, channel),
  'session.stopAgent': (s) => s.stopAgent(),
  'session.quit': (s) => s.quit(),
  'session.serveFolder': (s, name, root, allowed) => s.serveFolder(name, root, allowed),
  'session.localLocation': (s, abs, dir) => s.localLocation(abs, dir),
  'session.testNotification': (s) => {
    s.notifier.notify({ kind: 'done', title: 'Notifications work', body: 'This is how klaud tells you Claude finished or needs you' });
    s.toast('Sent a test notification', 'success');
  },

  'host.answerApproval': (s, answer, id) => s.answerApproval(answer, id),
  'host.promote': (s, requestId) => s.host.promote(requestId),
  'host.cancelQueued': (s, requestId) => s.host.cancelQueued(requestId),

  'inbox.read': (s, which) => s.store.dispatch({ type: 'notice_read', ...(which?.channel !== undefined ? { channel: which.channel } : {}), ...(which?.id !== undefined ? { id: which.id } : {}) }),
  'inbox.clear': (s) => s.store.dispatch({ type: 'notice_clear' }),

  'questions.answer': (s, qid, answer) => s.questions.answer(qid, answer),
  'questions.pick': (s, qid, question, answer) => s.store.dispatch({ type: 'question_pick', qid, question, answer }),

  'people.setTrust': (s, peerId, level) => s.people.setTrust(peerId, level),
  'people.dismissPrompt': (s, peerId) => s.people.dismissPrompt(peerId),
  'people.forget': (s, peerId) => s.people.forget(peerId),

  'sharing.invite': (s, wsId, peerId, role) => {
    const ok = s.sharing.invite(wsId, peerId, role);
    void s.workspaces?.refresh();
    return ok;
  },
  'sharing.remove': (s, wsId, peerId) => s.sharing.remove(wsId, peerId),
  'sharing.leave': (s, owner, id) => s.sharing.leave(owner, id),

  'invites.create': async (s, opts) => {
    const link = await s.invites.create(opts);
    return link?.id;
  },
  'invites.revoke': (s, id) => s.invites.revoke(id),
  'invites.copyLink': (s, id) => s.invites.copyLink(id),
  'invites.letIn': (s, peerId, can) => s.invites.letIn(peerId, can),
  'invites.decline': (s, peerId) => s.invites.decline(peerId),
  'invites.change': (s, peerId, patch) => s.invites.change(peerId, patch),
  'invites.remove': (s, peerId) => s.invites.remove(peerId),

  'remote.requestWorktree': (s, peerId, project, task, plan) => s.remote.requestWorktree(peerId, project, task, plan),
  'remote.handoff': (s, wsId, peerId) => s.remote.handoff(wsId, peerId),

  'diff.load': (s, id) => s.diff.load(id),
  'diff.select': (s, index) => s.diff.select(index),
  'shell.run': (s, id, line) => s.shell.run(id, line),
  'shell.openEntry': (s, id, rel, dir) => s.shell.openEntry(id, rel, dir),

  'files.browseTo': (s, at) => s.browseTo(at),
  'files.enter': (s, index) => s.browserEnter(index),
  'files.up': (s) => s.browserUp(),
  'files.loadDir': (s, at) => s.loadDir(at),
  'files.open': (s, at, opts) => s.openLocation(at, opts),
  'files.openSpec': (s, spec) => s.openSpec(spec),
  'files.download': (s, at) => s.download(at),
  'files.downloadSpec': (s, spec) => s.downloadSpec(spec),
  'files.closeViewer': (s) => s.store.dispatch({ type: 'viewer_close' }),
  'files.readImage': (s) => {
    const image = s.store.getState().viewer?.image;
    return image ? { width: image.width, height: image.height, data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString('base64') } : undefined;
  },

  'workspaces.open': (s, id, tab) => ctl(s)?.open(id, tab),
  'workspaces.refresh': (s) => ctl(s)?.refresh(),
  'workspaces.newWorktree': async (s, projectId, name) => (await ctl(s)?.newWorktree(projectId, name))?.id,
  'workspaces.newChat': async (s, projectId, title, dir) => (await ctl(s)?.newChat(projectId, title, dir))?.id,
  'workspaces.startChat': (s, projectId, text, dir) => ctl(s)?.startChat(projectId, text, dir),
  'workspaces.startWorktree': (s, projectId, text) => ctl(s)?.startWorktree(projectId, text, (prompt) => s.nameTask(prompt)),
  'workspaces.fork': async (s, id, name) => (await ctl(s)?.fork(id, name))?.id,
  'workspaces.archive': (s, id, force) => ctl(s)?.archive(id, force),
  'workspaces.restore': (s, id) => ctl(s)?.restore(id),
  'workspaces.remove': (s, id) => ctl(s)?.remove(id),
  'workspaces.commit': (s, id, message) => ctl(s)?.commit(id, message),
  'workspaces.merge': (s, id) => ctl(s)?.merge(id),
  'workspaces.prepareRemoval': (s, id) => ctl(s)?.prepareRemoval(id),
  'workspaces.applyEnvBack': (s, id) => ctl(s)?.applyEnvBack(id),
  'workspaces.askClaudeToReview': (s, id) => ctl(s)?.askClaudeToReview(id),
  'workspaces.askClaudeToMerge': (s, id) => ctl(s)?.askClaudeToMerge(id),
  'workspaces.compact': (s, id, instructions) => ctl(s)?.compact(id, instructions),
  'workspaces.openInFinder': (s, id) => ctl(s)?.openInFinder(id),
  'workspaces.setGroup': (s, projectId, group) => ctl(s)?.setGroup(projectId, group),
  'workspaces.hideProject': (s, projectId) => ctl(s)?.hideProject(projectId),
  'workspaces.cleanAgentWorktrees': (s, projectId) => ctl(s)?.cleanAgentWorktrees(projectId),
  'workspaces.addProject': (s, dir) => ctl(s)?.addProject(dir),
  'workspaces.addFolder': (s, dir) => ctl(s)?.addFolder(dir),
  'workspaces.selectFile': (s, index) => ctl(s)?.selectFile(index),

  'workbench.run': (s, wsId) => started(bench(s)?.run(wsId)),
  'workbench.stopRun': (s, wsId) => bench(s)?.stopRun(wsId),
  'workbench.runSetup': (s, wsId) => bench(s)?.runSetup(wsId),
  'workbench.setScript': (s, projectId, kind, command) => bench(s)?.setScript(projectId, kind, command),
  'workbench.shareScripts': (s, projectId) => bench(s)?.shareScripts(projectId),
  'workbench.setModel': (s, channel, value) => (s.workbench ? s.workbench.setModel(channel, value) : s.setPrefs({ model: value || undefined })),
  'workbench.createPr': (s, id, extra) => bench(s)?.createPr(id, extra),
  'workbench.fixChecks': (s, id) => bench(s)?.fixChecks(id),
  'workbench.openPr': (s, id) => bench(s)?.openPr(id),
  'workbench.refreshPrs': (s, only) => bench(s)?.refreshPrs(only),
  'workbench.editPrPrompt': (s) => bench(s)?.editPrPrompt(),
  'workbench.resetPrPrompt': (s) => bench(s)?.resetPrPrompt(),
  'workbench.measureDisk': (s) => bench(s)?.measureDisk(),
  'workbench.search': (s, query) => bench(s)?.search(query),
  'workbench.openHit': (s, index) => bench(s)?.openHit(index),
  'workbench.saveTemplate': (s, text) => bench(s)?.saveTemplate(text),
  'workbench.removeTemplate': (s, id) => bench(s)?.removeTemplate(id),

  'terminals.shell': (s, wsId, size) => started(bench(s)?.shell(wsId, size)),
  'terminals.global': (s, key, dir, size) => started(bench(s)?.globalShell(key, dir, size)),
  'terminals.close': (s, key) => bench(s)?.closeTerminal(key),

  'daemon.stop': (s) => s.shutdown(),

  'local.listDirs': (s, dir) => {
    const entries = listLocalDirs(dir);
    s.store.dispatch({ type: 'dir_cache', key: localDirKey(dir), entries });
    return entries;
  },
  'local.openFolder': (_s, dir) => openWithSystem(dir),
} satisfies Handlers;

export type Result<M extends Method> = Awaited<ReturnType<(typeof HANDLERS)[M]>>;
