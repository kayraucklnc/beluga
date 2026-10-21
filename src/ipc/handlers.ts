import type { Session } from '../core/session.js';
import type { WorkspaceController } from '../core/workspace-controller.js';
import type { Workbench } from '../core/workbench.js';
import { listLocalDirs, localDirKey, openWithSystem } from '../core/local.js';
import { ATTACHMENT_SHARE, type FetchShared, attachmentOnDisk, chipText, expandChips, importImageFitting, mediaTypeOf, pathInfo, publishForRoom, readAttachment, registerAttachment, roomAttachmentsDir, saveImageBytes } from '../core/attachments.js';
import { fetchBytes } from '../core/downloads.js';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjects, isMainCheckout } from '../workspaces/discovery.js';
import { chooseProjectIcon, readProjectIcon, suggestProjects } from '../core/project-icons.js';
import type { Args, Method } from './api.js';
import { NETWORK_HANDLERS } from './network-handlers.js';
import { STRIPE_HANDLERS } from './stripe-handlers.js';
import { CLAUDE_CODE_HANDLERS } from './claude-code-handlers.js';
import { STEPS_HANDLERS } from './steps-handlers.js';
import { GATEWAY_HANDLERS } from './gateway-handlers.js';
import { BOARD_HANDLERS } from './board-handlers.js';
import { PLANS_HANDLERS } from './plans-handlers.js';
import { GIT_HANDLERS } from './git-handlers.js';

/**
 * What each API method does (see api.ts for the list and its arguments). Runs in the core:
 * in the daemon for every connected client, or in the terminal UI's own process.
 * Results are plain data (they cross a socket).
 */
type Handler<M extends Method> = (s: Session, ...args: Args<M>) => unknown;
export type Handlers = { readonly [M in Method]: Handler<M> };

// Without projects (some tests, the guest-only mode) these do nothing, as before.
const ctl = (s: Session): WorkspaceController | undefined => s.workspaces;
const rootOf = (s: Session, projectId: string): string | undefined => s.store.getState().projects.find((p) => p.id === projectId)?.root || undefined;
const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, os.homedir());
const bench = (s: Session): Workbench | undefined => s.workbench;

/** Pull a file from a friend's share through this session's connection. */
const fetchShared = (s: Session): FetchShared => (at, max) => fetchBytes(at, s.files.request.bind(s.files), max);

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
  'session.compact': (s, channel, instructions) => s.compact(channel, instructions),
  'session.quit': (s) => s.quit(),
  'session.serveFolder': (s, name, root, allowed) => s.serveFolder(name, root, allowed),
  'session.localLocation': (s, abs, dir) => s.localLocation(abs, dir),
  'session.testNotification': (s) => {
    s.notifier.test();
    s.toast('Sent a test notification', 'success');
  },

  'host.answerApproval': (s, answer, id) => s.answerApproval(answer, id),
  'host.promote': (s, requestId) => s.host.promote(requestId),
  'host.stopRun': (s, channel) => s.host.stopRun(channel),
  'host.cancelQueued': (s, requestId) => s.host.cancelQueued(requestId),
  'host.reorderQueued': (s, requestId, index) => s.host.reorderQueued(requestId, index),

  'inbox.read': (s, which) => s.store.dispatch({ type: 'notice_read', ...(which?.channel !== undefined ? { channel: which.channel } : {}), ...(which?.id !== undefined ? { id: which.id } : {}) }),
  'inbox.unread': (s, id) => s.store.dispatch({ type: 'notice_unread', id }),
  'inbox.clear': (s, which) => s.store.dispatch({ type: 'notice_clear', ...(which?.id !== undefined ? { id: which.id } : {}) }),

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
  'files.download': (s, at, opts) => s.download(at, opts?.to !== undefined ? { to: opts.to } : {}),
  'files.downloadSpec': (s, spec) => s.downloadSpec(spec),
  'files.closeViewer': (s) => s.store.dispatch({ type: 'viewer_close' }),
  'files.readImage': (s) => {
    const image = s.store.getState().viewer?.image;
    return image ? { width: image.width, height: image.height, data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString('base64') } : undefined;
  },
  'files.readImageFile': async (s, at) => {
    const { mediaType, bytes } = await s.files.readImageFile(at);
    return { mediaType, data: bytes.toString('base64') };
  },
  'files.read': (s, at) => s.files.readFile(at),

  'workspaces.open': (s, id, tab) => ctl(s)?.open(id, tab),
  'workspaces.load': (s, id) => void ctl(s)?.ensureLoaded(id),
  'workspaces.refresh': (s) => ctl(s)?.refresh(),
  'workspaces.newWorktree': async (s, projectId, name, opts) => (await ctl(s)?.newWorktree(projectId, name, opts?.base ? { base: opts.base } : {}))?.id,
  'workspaces.newChat': async (s, projectId, title, dir) => (await ctl(s)?.newChat(projectId, title, dir))?.id,
  'workspaces.startChat': (s, projectId, text, dir) => ctl(s)?.startChat(projectId, text, dir),
  'workspaces.startWorktree': (s, projectId, text, opts) => ctl(s)?.startWorktree(projectId, text, (prompt) => s.nameTask(prompt), { ...(opts?.base ? { base: opts.base } : {}), ...(opts?.name ? { name: opts.name } : {}) }),
  'workspaces.branches': (s, projectId) => ctl(s)?.branches(projectId),
  'workspaces.fork': async (s, id, name) => (await ctl(s)?.fork(id, name))?.id,
  'workspaces.continueInWorktree': async (s, id, opts) =>
    // Claude starts there once whatever runs in the conversation now has finished (its session is complete then).
    (await ctl(s)?.continueInWorktree(id, (prompt) => s.nameTask(prompt), { ...(opts?.task ? { task: opts.task } : {}), ...(opts?.base ? { base: opts.base } : {}), ...(opts?.name ? { name: opts.name } : {}), after: s.host.idle(`ws:${id}`) }))?.id,
  'workspaces.archive': (s, id, force) => ctl(s)?.archive(id, force),
  'workspaces.restore': (s, id) => ctl(s)?.restore(id),
  'workspaces.archivePlan': (s, id) => ctl(s)?.archivePlan(id),
  'workspaces.freeSpace': (s, id) => ctl(s)?.freeSpace(id),
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
  'workspaces.renameGroup': (s, from, to) => ctl(s)?.renameGroup(from, to),
  'workspaces.ungroup': (s, name) => ctl(s)?.ungroup(name),
  'workspaces.arrange': (s, item, place) => ctl(s)?.arrange(item, place ?? {}) ?? false,
  'workspaces.newGroup': (s, name, opts) => ctl(s)?.newGroup(name, opts ?? {}),
  'workspaces.showProject': (s, root) => ctl(s)?.showProject(root) ?? false,
  'workspaces.hideProject': (s, projectId) => ctl(s)?.hideProject(projectId),
  'workspaces.removeProject': (s, projectId, opts) => ctl(s)?.removeProject(projectId, opts?.trash ?? false) ?? false,
  'workspaces.cleanAgentWorktrees': (s, projectId) => ctl(s)?.cleanAgentWorktrees(projectId),
  'workspaces.otherOrigins': (s, projectId) => ctl(s)?.others.origins(projectId) ?? {},
  'workspaces.otherActivity': (s, projectId) => ctl(s)?.others.activity(projectId) ?? {},
  'workspaces.worktreeInfo': (s, id) => ctl(s)?.others.info(id),
  'workspaces.showConversation': (s, id, sessionId) => ctl(s)?.showConversation(id, sessionId) ?? false,
  'workspaces.removeOther': (s, id, force) => ctl(s)?.removeOther(id, force ?? false) ?? false,
  'workspaces.staleOthers': (s, projectId, source) => ctl(s)?.others.stale(projectId, source) ?? [],
  'workspaces.cleanUpOthers': (s, projectId, ids) => ctl(s)?.others.cleanUp(projectId, ids),
  'workspaces.addProject': (s, dir) => ctl(s)?.addProject(dir),
  'workspaces.addFolder': (s, dir) => ctl(s)?.addFolder(dir),
  'workspaces.selectFile': (s, index) => ctl(s)?.selectFile(index),
  'workspaces.review': (s, id) => ctl(s)?.loadReview(id),
  'workspaces.scratch': (s, id) => ctl(s)?.scratch(id),

  'workbench.run': (s, wsId) => started(bench(s)?.run(wsId)),
  'workbench.stopRun': (s, wsId) => bench(s)?.stopRun(wsId),
  'workbench.runSetup': (s, wsId) => bench(s)?.runSetup(wsId),
  'workbench.setScript': (s, projectId, kind, command, team) => bench(s)?.setScript(projectId, kind, command, team),
  'workbench.shareScripts': (s, projectId) => bench(s)?.shareScripts(projectId),
  'workbench.setModel': (s, channel, value) => (s.workbench ? s.workbench.setModel(channel, value) : s.setPrefs({ model: value || undefined })),
  'workbench.createPr': (s, id, extra) => bench(s)?.createPr(id, extra),
  'workbench.fixChecks': (s, id) => bench(s)?.fixChecks(id),
  'workbench.openPr': (s, id) => bench(s)?.openPr(id),
  'workbench.refreshPrs': (s, only, recheckGh) => bench(s)?.refreshPrs(only, recheckGh),
  'workbench.editPrPrompt': (s) => bench(s)?.editPrPrompt(),
  'workbench.resetPrPrompt': (s) => bench(s)?.resetPrPrompt(),
  'workbench.measureDisk': (s) => bench(s)?.measureDisk(),
  'workbench.search': (s, query) => bench(s)?.search(query),
  'workbench.openHit': (s, index) => bench(s)?.openHit(index),
  'workbench.saveTemplate': (s, text, plan) => bench(s)?.saveTemplate(text, plan),
  'workbench.removeTemplate': (s, id) => bench(s)?.removeTemplate(id),

  'terminals.shell': (s, wsId, size) => started(bench(s)?.shell(wsId, size)),
  'terminals.global': (s, key, dir, size) => started(bench(s)?.globalShell(key, dir, size)),
  'terminals.close': (s, key) => bench(s)?.closeTerminal(key),
  'terminals.rename': (s, key, name) => bench(s)?.renameTerminal(key, name),

  // The values go back only to the screen that asked (Settings), never into the shared state.
  'env.get': (s, projectId) => s.env.get(projectId),
  'env.set': (s, projectId, rows, dotenv) => s.env.set(projectId, rows, dotenv),

  'attachments.add': async (_s, ext, base64) => {
    const bytes = Buffer.from(base64, 'base64');
    const file = await saveImageBytes(bytes, ext);
    const a = registerAttachment(file, bytes.byteLength);
    return { n: a.n, chip: chipText(a.n) };
  },
  'attachments.addFile': async (_s, file) => {
    const info = pathInfo(file);
    if (info.kind !== 'file' || !info.image) throw new Error(`${info.name} isn't an image file here`);
    const saved = await importImageFitting(info.path);
    const a = registerAttachment(saved, statSync(saved).size);
    return { n: a.n, chip: chipText(a.n), file: path.basename(saved) };
  },
  'attachments.expand': (s, text, channel) => {
    if (!text.includes('[image ') || text.startsWith('/')) return text;
    const state = s.store.getState();
    const friends = state.peers.filter((p) => p.peerId !== s.selfId).map((p) => p.peerId);
    const toRoom = channel === 'room' && friends.length > 0;
    // Sent to the room with friends there, a copy goes where they (and only they) can fetch it.
    const out = expandChips(text, s.selfId, toRoom ? (a) => publishForRoom(a) : (a) => path.basename(a.path));
    if (toRoom && out.attachments.length) s.serveFolder(ATTACHMENT_SHARE, roomAttachmentsDir(), friends);
    return out.text;
  },

  'attachments.read': async (s, owner, file) => {
    const bytes = await readAttachment(owner, file, s.selfId, fetchShared(s));
    return { mime: mediaTypeOf(file), size: bytes.byteLength, data: bytes.toString('base64') };
  },
  'attachments.open': async (s, owner, file) => openWithSystem(await attachmentOnDisk(owner, file, s.selfId, fetchShared(s))),

  'daemon.stop': (s) => s.shutdown(),

  'projects.icon': (s, projectId) => {
    const root = rootOf(s, projectId);
    return root ? readProjectIcon(root) : undefined;
  },
  'projects.setIcon': (s, projectId, image) => {
    const root = rootOf(s, projectId);
    if (!root) throw new Error('No such project');
    chooseProjectIcon(root, image ? expandHome(image) : undefined);
  },
  // A git project is added; a folder of them is watched (new ones in it show up too).
  'projects.add': (s, dir) => {
    const abs = expandHome(dir);
    if (isMainCheckout(abs)) return ctl(s)?.addProject(abs);
    if (findProjects([abs]).length) return ctl(s)?.addFolder(abs);
    s.toast(`${path.basename(abs)} isn't a git project, and has none inside`, 'warn');
    return undefined;
  },
  'projects.addFolder': (s, dir) => ctl(s)?.addFolder(expandHome(dir)),
  'projects.iconAt': (_s, dir) => readProjectIcon(expandHome(dir)),
  'projects.suggest': (s) => suggestProjects(s.store.getState().projects.map((p) => p.root).filter(Boolean)),
  'local.listDirs': (s, dir) => {
    const entries = listLocalDirs(dir);
    s.store.dispatch({ type: 'dir_cache', key: localDirKey(dir), entries });
    return entries;
  },
  'local.openFolder': (_s, dir) => openWithSystem(dir),
  'local.statFiles': (_s, paths) => paths.map(pathInfo),
  ...NETWORK_HANDLERS,
  ...STRIPE_HANDLERS,
  ...CLAUDE_CODE_HANDLERS,
  ...STEPS_HANDLERS,
  ...GATEWAY_HANDLERS,
  ...BOARD_HANDLERS,
  ...PLANS_HANDLERS,
  ...GIT_HANDLERS,
} satisfies Handlers;

export type Result<M extends Method> = Awaited<ReturnType<(typeof HANDLERS)[M]>>;
