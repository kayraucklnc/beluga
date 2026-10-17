import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type BodyInput, type BodyOf, MAX_DOWNLOAD_BYTES } from '../protocol.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import { git } from '../workspaces/git.js';
import { klaudeHome } from '../workspaces/store.js';
import { formatBytes } from '../workspaces/disk.js';
import { type Requester, downloadFile, fetchBytes, safeFileName, uniquePath } from './downloads.js';
import type { NoticeEvent } from './notify.js';
import { type ShareService, isSecretPath } from './shares.js';
import { type LogItem, type Store, clean, peerName } from './store.js';
import { trustOf } from './trust.js';
import type { WorkspaceController } from './workspace-controller.js';
import type { WorkspaceSharing } from './workspace-sharing.js';
import type { Workspace } from '../workspaces/types.js';

export interface RemoteWorkDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly send: (body: BodyInput, opts: { to: string }) => boolean;
  /** Request/response over the room (used for file chunks). */
  readonly request: Requester;
  readonly shares: ShareService;
  readonly controller?: WorkspaceController;
  readonly sharing: WorkspaceSharing;
  /** Ask the owner (you) to approve something. */
  readonly approve: (title: string, detail: string) => Promise<boolean>;
  /** Run your Claude for someone else, in one of your workspaces. */
  readonly runFor: (from: string, channel: string, prompt: string, plan: boolean) => void;
  /** Ask your own Claude in a conversation and wait for its answer. */
  readonly askAndWait: (prompt: string, channel: string, timeoutMs: number) => Promise<string>;
  readonly askOwnClaude: (prompt: string, channel: string) => void;
  readonly nameTask: (prompt: string) => Promise<string>;
  readonly notify: (event: NoticeEvent) => void;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  readonly onWorktreeCreated?: (ws: Workspace) => void;
  /** Where downloads land (default ~/Downloads/klaude). */
  readonly downloadDir?: string;
  /** How long a request waits for the other person (default 6 minutes: approvals take time). */
  readonly waitMs?: number;
}

type Waiter = { peer: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const OUTBOX_TTL_MS = 15 * 60_000;
const NOTE_TIMEOUT_MS = 5 * 60_000;

export const handoffNotePrompt = (to: string): string =>
  `${to} is taking over this workspace on their own computer, with their own Claude. Write a short handoff note for them in Markdown: ` +
  'what the goal is, what is done, what is left (as a checklist), decisions made and why, and anything tricky (failing tests, ' +
  'gotchas, commands to run). Keep it under 300 words. Reply with only the note; do not change any files.';

export const continuePrompt = (from: string, note: string): string =>
  `You are taking over this work from ${from}, who worked on it on their computer. Their branch is checked out here. ` +
  `Here is their handoff note:\n\n${note}\n\nStart by checking the current state (git log, git status, run the tests), ` +
  'then tell me briefly where things stand and continue with what is left.';

/** "~/Desktop/a.pdf" → absolute, on this computer. */
export function expandPath(p: string, home = os.homedir()): string {
  const trimmed = p.trim();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/')) return path.join(home, trimmed.slice(2));
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.join(home, trimmed);
}

/**
 * Working on each other's computers: start a worktree on a friend's machine, hand a
 * workspace over to them, and move files between computers (for you or your Claudes).
 * Whoever owns the computer approves, unless they fully trust you.
 */
export class RemoteWork {
  private readonly waiters = new Map<string, Waiter>();
  /** Workspaces you asked friends to start, opened as soon as they're shared with you. */
  private readonly opening = new Set<string>();
  /** Handoffs you offered (hid → your workspace and who gets it). */
  private readonly handoffs = new Map<string, { wsId: string; to: string; share?: string }>();
  /** People your Claude is waiting on: files they send are saved without asking. */
  private readonly expecting = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: RemoteWorkDeps) {
    this.unsubscribe = deps.store.subscribe(() => this.openRequested());
  }

  stop(): void {
    this.unsubscribe();
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('Session closed'));
    }
    this.waiters.clear();
  }

  private get state() {
    return this.deps.store.getState();
  }

  private name(peerId: string): string {
    return peerName(this.state, peerId);
  }

  private wait<T>(id: string, peer: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${this.name(peer)} did not answer in time`));
      }, this.deps.waitMs ?? 6 * 60_000);
      timer.unref?.();
      this.waiters.set(id, { peer, resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  private settle(from: string, id: string, value: unknown): void {
    const w = this.waiters.get(id);
    if (!w || w.peer !== from) return;
    clearTimeout(w.timer);
    this.waiters.delete(id);
    w.resolve(value);
  }

  /** Your Claude is working with someone (asked their Claude): accept what they send back. */
  expectFrom(peerId: string, ms = 30 * 60_000): void {
    this.expecting.set(peerId, Date.now() + ms);
  }

  private expected(peerId: string): boolean {
    return (this.expecting.get(peerId) ?? 0) > Date.now();
  }

  /** May this person start work here? Asks you unless you fully trust them. */
  private async allowed(from: string, title: string, detail: string): Promise<boolean> {
    const level = trustOf(this.state, from);
    if (level === 'blocked') return false;
    if (level === 'full') return true;
    return this.deps.approve(title, detail);
  }

  // ------------------------------------------------------------ outbox

  /** Copy one file into a private, one-person share (so nothing else in its folder is exposed). */
  private async offerFile(abs: string, to: string): Promise<{ share: string; path: string; name: string; size: number }> {
    if (isSecretPath(abs)) throw new Error('That file holds secrets, so klaude never sends it');
    const stat = await fs.stat(abs).catch(() => undefined);
    if (!stat?.isFile()) throw new Error(`${abs} is not a file`);
    if (stat.size > MAX_DOWNLOAD_BYTES) throw new Error(`${path.basename(abs)} is larger than ${formatBytes(MAX_DOWNLOAD_BYTES)}`);
    const id = randomUUID().slice(0, 12);
    const dir = path.join(klaudeHome(), 'outbox', id);
    const name = safeFileName(path.basename(abs));
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(abs, path.join(dir, name));
    const share = `out-${id}`;
    this.deps.shares.upsert({ name: share, root: dir, writable: false, private: true, allowed: [to] });
    setTimeout(() => {
      this.deps.shares.remove(share);
      void fs.rm(dir, { recursive: true, force: true });
    }, OUTBOX_TTL_MS).unref?.();
    return { share, path: name, name, size: stat.size };
  }

  // --------------------------------------------------------- files: ask for one

  /**
   * Get a file from anywhere on a friend's computer (they approve unless they fully trust you).
   * Saved to `saveTo` (a folder) or ~/Downloads/klaude/<friend>/. Returns where it was saved.
   */
  async getFile(peerId: string, remotePath: string, saveTo?: string, why = ''): Promise<string> {
    const reqId = randomUUID();
    const answer = this.wait<BodyOf<'file_request_result'>>(reqId, peerId);
    if (!this.deps.send({ kind: 'file_request', reqId, path: remotePath, why: why.slice(0, 500) }, { to: peerId })) throw new Error('Not connected');
    const res = await answer;
    if (!res.ok || !res.share || !res.path) throw new Error(res.error ?? 'They declined');
    const from = this.name(peerId);
    if (!saveTo) return downloadFile({ owner: peerId, share: res.share, path: res.path }, from, this.deps.request, this.deps.store, this.deps.downloadDir);
    const bytes = await fetchBytes({ owner: peerId, share: res.share, path: res.path }, this.deps.request, MAX_DOWNLOAD_BYTES);
    const dir = expandPath(saveTo);
    await fs.mkdir(dir, { recursive: true });
    const target = await uniquePath(dir, safeFileName(res.name ?? res.path));
    await fs.writeFile(target, bytes);
    this.deps.toast(`Saved ${path.basename(target)} from ${from}`, 'success');
    return target;
  }

  async onFileRequest(from: string, body: BodyOf<'file_request'>): Promise<void> {
    const reply = (r: Omit<BodyOf<'file_request_result'>, 'kind' | 'reqId' | 'ok'> & { ok: boolean }) => this.deps.send({ kind: 'file_request_result', reqId: body.reqId, ...r }, { to: from });
    const abs = expandPath(body.path);
    if (isSecretPath(abs)) return void reply({ ok: false, error: 'That file holds secrets, so klaude never sends it' });
    const stat = await fs.stat(abs).catch(() => undefined);
    if (!stat?.isFile()) return void reply({ ok: false, error: `There is no file at ${body.path}` });
    const who = this.name(from);
    const ok = await this.allowed(from, `${who} wants a file from your computer`, `${abs.replace(os.homedir(), '~')} (${formatBytes(stat.size)})${body.why ? `\n${clean(body.why)}` : ''}`);
    if (!ok) return void reply({ ok: false, error: `${this.state.self?.name ?? 'The owner'} declined` });
    try {
      const offer = await this.offerFile(abs, from);
      reply({ ok: true, ...offer });
      this.deps.toast(`Sending ${offer.name} to ${who}`, 'success');
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  onFileRequestResult(from: string, body: BodyOf<'file_request_result'>): void {
    this.settle(from, body.reqId, body);
  }

  // ---------------------------------------------------------- files: send one

  /** Send a file from this computer to someone (they save it; automatically if they trust you). */
  async sendFile(peerId: string, localPath: string, note = ''): Promise<string> {
    const offer = await this.offerFile(expandPath(localPath), peerId);
    if (!this.deps.send({ kind: 'file_offer', fid: randomUUID(), ...offer, note: note.slice(0, 1000) }, { to: peerId })) throw new Error('Not connected');
    return `Offered ${offer.name} (${formatBytes(offer.size)}) to ${this.name(peerId)}. It downloads on their side.`;
  }

  async onFileOffer(from: string, body: BodyOf<'file_offer'>): Promise<void> {
    const who = this.name(from);
    const level = trustOf(this.state, from);
    if (level === 'blocked') return;
    const auto = level === 'trusted' || level === 'full' || this.expected(from);
    const ok = auto || (await this.deps.approve(`${who} sends you a file`, `${clean(body.name)} (${formatBytes(body.size)})${body.note ? `\n${clean(body.note)}` : ''}`));
    if (!ok) return;
    try {
      const saved = await downloadFile({ owner: from, share: body.share, path: body.path }, who, this.deps.request, this.deps.store, this.deps.downloadDir);
      this.deps.notify({ kind: 'people', title: `${who} sent you ${path.basename(saved)}`, body: saved.replace(os.homedir(), '~') });
    } catch (err) {
      this.deps.toast(`Couldn't get ${clean(body.name)} from ${who}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  // ----------------------------------------------- worktrees on a friend's computer

  /** Ask a friend to start a worktree for a task in one of their projects; their Claude does it. */
  async requestWorktree(peerId: string, project: string, task: string, plan = false): Promise<void> {
    const reqId = randomUUID();
    const answer = this.wait<BodyOf<'ws_request_result'>>(reqId, peerId);
    if (!this.deps.send({ kind: 'ws_request', reqId, project, task, plan }, { to: peerId })) return this.deps.toast('Not connected', 'error');
    this.deps.toast(`Asked ${this.name(peerId)} to start a worktree in ${project}. Waiting for them…`);
    try {
      const res = await answer;
      if (!res.ok || !res.wsId) {
        this.deps.toast(`${this.name(peerId)} didn't start it: ${res.error ?? 'declined'}`, 'warn');
        return;
      }
      this.deps.store.dispatch({ type: 'chat', id: randomUUID(), from: this.deps.selfId(), text: task, ts: Date.now(), byAgent: false, channel: `ws:${res.wsId}` });
      this.opening.add(res.wsId);
      this.openRequested();
    } catch (err) {
      this.deps.toast(err instanceof Error ? err.message : String(err), 'warn');
    }
  }

  private openRequested(): void {
    if (!this.opening.size) return;
    for (const w of this.state.shared) {
      if (!this.opening.has(w.id)) continue;
      this.opening.delete(w.id);
      this.deps.store.dispatch({ type: 'view', view: { kind: 'shared', owner: w.owner, id: w.id, tab: 'chat' } });
      this.deps.toast(`${w.name} is running on ${this.name(w.owner)}'s computer. You're in it together`, 'success');
    }
  }

  async onWsRequest(from: string, body: BodyOf<'ws_request'>): Promise<void> {
    const reply = (ok: boolean, extra: { wsId?: string; error?: string } = {}) => this.deps.send({ kind: 'ws_request_result', reqId: body.reqId, ok, ...extra }, { to: from });
    const ctl = this.deps.controller;
    if (!ctl || this.state.prefs.friendWorktrees === 'off') return void reply(false, { error: 'they turned off work from friends' });
    const project = ctl.manager.list.find((p) => p.root && p.name === body.project);
    if (!project) return void reply(false, { error: `there is no project called ${body.project} here` });
    const who = this.name(from);
    const ok = await this.allowed(from, `${who} wants to start a worktree in ${project.name} on your computer`, `${clean(body.task)}\n\nTheir Claude requests run on your computer with your Claude; you can follow and stop it any time.`);
    if (!ok) return void reply(false, { error: 'declined' });
    const name = await this.deps.nameTask(body.task);
    const ws = await ctl.newWorktree(project.id, name);
    if (!ws) return void reply(false, { error: "the worktree couldn't be created" });
    this.deps.sharing.invite(ws.id, from, 'contribute');
    reply(true, { wsId: ws.id });
    const channel = `ws:${ws.id}`;
    this.deps.store.dispatch({ type: 'chat', id: randomUUID(), from, text: clean(body.task), ts: Date.now(), byAgent: false, channel });
    this.deps.runFor(from, channel, body.task, body.plan);
  }

  onWsRequestResult(from: string, body: BodyOf<'ws_request_result'>): void {
    this.settle(from, body.reqId, body);
  }

  // ---------------------------------------------------------------- handoff

  /** Hand a worktree to someone: their Claude continues it on their computer. */
  async handoff(wsId: string, peerId: string): Promise<boolean> {
    const ctl = this.deps.controller;
    const ws = ctl?.manager.find(wsId);
    const to = this.name(peerId);
    if (!ctl || !ws || ws.kind !== 'worktree' || !ws.branch) {
      this.deps.toast('Only worktrees can be handed off', 'warn');
      return false;
    }
    const remote = await ctl.manager.remoteOf(ws.projectId);
    if (!remote) {
      this.deps.toast('This project has no origin remote, so the other computer could not find the same repository', 'warn');
      return false;
    }
    const channel = `ws:${wsId}`;
    ctl.open(wsId);
    this.deps.toast(`Claude is writing a handoff note for ${to}…`);
    let note: string;
    try {
      note = (await this.deps.askAndWait(handoffNotePrompt(to), channel, NOTE_TIMEOUT_MS)).trim();
    } catch {
      note = '';
    }
    if (!note) note = `Handed over from ${this.state.self?.name ?? 'a friend'}. See the chat history and git log for what was done.`;
    try {
      await ctl.manager.commitAll(wsId, `WIP: hand off to ${to}`);
    } catch (err) {
      // A hook or signing setup refused: hand over what's committed, and say so.
      this.deps.toast(`Couldn't commit the uncommitted changes (${err instanceof Error ? err.message.split('\n')[0] : String(err)}). Only committed work goes to ${to}`, 'warn');
    }
    const fresh = ctl.manager.find(wsId) ?? ws;
    const hid = randomUUID();
    let bundle: { share: string; path: string; size: number } | undefined;
    if ((fresh.status?.ahead ?? 0) > 0 || (await this.hasCommits(fresh))) {
      try {
        bundle = await this.makeBundle(fresh, hid, peerId);
      } catch (err) {
        this.deps.toast(`Couldn't pack the branch: ${err instanceof Error ? err.message : String(err)}`, 'error');
        return false;
      }
    }
    const project = ctl.manager.list.find((p) => p.id === ws.projectId);
    const history = this.state.log
      .filter((l) => l.channel === channel && (l.type === 'chat' || (l.type === 'agent' && l.status === 'done')))
      .slice(-60)
      .map((l) => (l.type === 'chat' ? { from: l.name, text: l.text.slice(0, 8000), ts: l.ts, byAgent: l.byAgent } : { from: l.type === 'agent' ? `${l.ownerName}'s Claude` : '', text: l.type === 'agent' ? l.text.slice(0, 8000) : '', ts: l.ts, byAgent: true }));
    this.handoffs.set(hid, { wsId, to: peerId, share: bundle?.share });
    const sent = this.deps.send(
      { kind: 'ws_handoff', hid, ws: { name: ws.name, project: project?.name ?? '', branch: ws.branch, base: ws.base ?? project?.base ?? 'origin/main' }, remote, note: note.slice(0, 60_000), history, ...(bundle ? { bundle } : {}) },
      { to: peerId },
    );
    if (!sent) {
      this.deps.toast('Not connected', 'error');
      return false;
    }
    this.deps.store.dispatch({ type: 'system', text: `Offered ${ws.name} to ${to}. Waiting for them to accept…`, channel });
    return true;
  }

  private async hasCommits(ws: Workspace): Promise<boolean> {
    const out = await git(ws.path, ['rev-list', '--count', `${ws.base ?? 'origin/main'}..HEAD`]).catch(() => '0');
    return Number(out.trim()) > 0;
  }

  /** Pack the branch's own commits (on top of its base) into a git bundle shared only with `to`. */
  private async makeBundle(ws: Workspace, hid: string, to: string): Promise<{ share: string; path: string; size: number }> {
    const dir = path.join(klaudeHome(), 'outbox', `handoff-${hid.slice(0, 12)}`);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'branch.bundle');
    await git(ws.path, ['bundle', 'create', file, ws.branch!, `^${ws.base ?? 'origin/main'}`]);
    const size = (await fs.stat(file)).size;
    if (size > MAX_DOWNLOAD_BYTES) throw new Error('the branch is too large to send');
    const share = `handoff-${hid.slice(0, 12)}`;
    this.deps.shares.upsert({ name: share, root: dir, writable: false, private: true, allowed: [to] });
    setTimeout(() => {
      this.deps.shares.remove(share);
      void fs.rm(dir, { recursive: true, force: true });
    }, OUTBOX_TTL_MS).unref?.();
    return { share, path: 'branch.bundle', size };
  }

  async onHandoff(from: string, body: BodyOf<'ws_handoff'>): Promise<void> {
    const reply = (ok: boolean, error?: string) => this.deps.send({ kind: 'ws_handoff_result', hid: body.hid, ok, ...(error ? { error } : {}) }, { to: from });
    const ctl = this.deps.controller;
    const who = this.name(from);
    if (!ctl || this.state.prefs.friendWorktrees === 'off') return void reply(false, 'they turned off work from friends');
    const ok = await this.allowed(
      from,
      `${who} wants to hand ${clean(body.ws.name)} (${clean(body.ws.project)}) over to you`,
      `You get their branch, the chat so far and a handoff note, in a new worktree. Your Claude continues it on this computer.\n\n${clean(body.note).slice(0, 600)}`,
    );
    if (!ok) return void reply(false, 'declined');
    const project = await ctl.manager.projectForRemote(body.remote);
    if (!project) {
      this.deps.toast(`You don't have ${clean(body.ws.project)} here. Clone ${clean(body.remote)}, then ask ${who} again`, 'warn');
      return void reply(false, `${this.state.self?.name ?? 'they'} don't have that repository cloned`);
    }
    try {
      const branch = await ctl.manager.freeBranchName(project.root, body.ws.name);
      if (body.bundle) {
        const bytes = await fetchBytes({ owner: from, share: body.bundle.share, path: body.bundle.path }, this.deps.request, MAX_DOWNLOAD_BYTES);
        const tmp = path.join(os.tmpdir(), `klaude-handoff-${body.hid.slice(0, 12)}.bundle`);
        await fs.writeFile(tmp, bytes);
        try {
          await git(project.root, ['fetch', tmp, `refs/heads/${body.ws.branch}:refs/heads/${branch}`]);
        } finally {
          await fs.rm(tmp, { force: true });
        }
      } else {
        await git(project.root, ['branch', branch, body.ws.base]);
      }
      const ws = await ctl.manager.createWorktreeOn(project.id, body.ws.name, branch, { handedFrom: who });
      const channel = `ws:${ws.id}`;
      const now = Date.now();
      const items: LogItem[] = [
        ...body.history.map((h, i): LogItem => ({ id: `ho-${body.hid}-${i}`, type: 'system', channel, text: `${clean(h.from)}: ${clean(h.text)}`, ts: h.ts, level: 'info' })),
        { id: `ho-${body.hid}-note`, type: 'system', channel, text: `Handed over by ${who}. Their note:\n${clean(body.note)}`, ts: now, level: 'info' },
      ];
      ctl.manager.saveHistory(ws.id, items);
      await ctl.refresh();
      ctl.open(ws.id);
      this.deps.onWorktreeCreated?.(ws);
      this.deps.sharing.invite(ws.id, from, 'view');
      reply(true);
      this.deps.askOwnClaude(continuePrompt(who, clean(body.note)), channel);
      this.deps.notify({ kind: 'people', title: `You took over ${ws.name} from ${who}`, body: 'Your Claude is picking it up', channel });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.toast(`Couldn't take over ${clean(body.ws.name)}: ${message}`, 'error');
      reply(false, message.slice(0, 400));
    }
  }

  onHandoffResult(from: string, body: BodyOf<'ws_handoff_result'>): void {
    const offer = this.handoffs.get(body.hid);
    if (!offer || offer.to !== from) return;
    this.handoffs.delete(body.hid);
    const who = this.name(from);
    const channel = `ws:${offer.wsId}`;
    if (!body.ok) {
      this.deps.store.dispatch({ type: 'system', text: `${who} didn't take it over: ${clean(body.error ?? 'declined')}`, channel, level: 'warn' });
      this.deps.toast(`${who} didn't take over the workspace`, 'warn');
      if (offer.share) this.deps.shares.remove(offer.share);
      return;
    }
    this.deps.controller?.manager.markHandedOff(offer.wsId, who);
    void this.deps.controller?.refresh();
    this.deps.store.dispatch({ type: 'system', text: `${who} took this over. Their Claude continues on their computer; it's under SHARED WITH ME so you can follow along. Archive this one when you like.`, channel });
    this.deps.notify({ kind: 'people', title: `${who} took over the workspace`, body: 'Follow along under SHARED WITH ME', channel });
  }
}
