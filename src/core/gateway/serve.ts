import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentBackend, AgentPlace, TaskTools } from '../../agent/types.js';
import { mentionsSecret } from '../../agent/policy.js';
import type { ClaudeAnswer, ClaudeQuestion } from '../../protocol.js';
import { isSecretPath } from '../shares.js';
import type { TrustLevel } from '../trust.js';
import { type AccessDecision, CAP_INFO, type Capabilities, Decision, type RequestFacts, type Rule, capFor, declineReason, ruleKindOf } from './access.js';
import type { TaskBook } from './book.js';
import { type SystemPort, captureScreen, describeDevice, deviceInfo, realSystem } from './device.js';
import { type TaskOutcome, type TaskView, approvalTitle, isFinal, requestGist } from './model.js';
import { type FileGet, MAX_FILES, MAX_QUESTIONS, type Need, type ResultStatus, type TaskAnswer, type TaskCancel, type TaskRequest } from './protocol.js';
import { oneLine, parseAnswer, readResultFiles, taskPrompt } from './result.js';
import { FileOffers } from './transfer.js';
import type { Courier } from './transport.js';

/**
 * The receiving side of the gateway: a friend's Claude asks yours, runs a command here, or asks
 * for a file. Your rules and capability settings decide first (access.ts): declined, let in at
 * once (you trust them, or a rule of yours covers it), or you're asked: the request sheet,
 * notification or menu-bar item says "Kayra's Claude wants to: …" with Approve once / Always
 * (a rule for requests like this one) / Decline. Then your Claude works on it in the project it
 * names (or a fresh scratch folder) with the tools you allowed (the screen, device info); its
 * steps go back as updates, its questions go back to the requester, and its final answer goes
 * back as the result, with screenshots and files (big ones fetched in pieces), to them only.
 */

export type Answer = 'yes' | 'no' | 'always';

/** A question for you (an approval card) that can be withdrawn. */
export interface Pending {
  readonly answer: Promise<Answer>;
  readonly withdraw: () => void;
}

/** A command a task asks to run here, and what came of it (see PeerRun.serveTask). */
export interface ShellAsk {
  readonly command: string;
  readonly cwd?: string;
  readonly project?: string;
  readonly timeoutSec: number;
  readonly why: string;
}
export interface ShellReply {
  readonly ok: boolean;
  readonly exitCode?: number;
  readonly output?: string;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
  readonly cwd?: string;
  readonly ms?: number;
  readonly error?: string;
}
/** `approved`: the gateway already decided (rules, capabilities, your answer); PeerRun still checks secrets and limits. */
export type ServeShell = (from: string, ask: ShellAsk, hooks: { onAsking: () => void; onStarted: (cwd: string) => void; approved?: boolean }) => Promise<ShellReply>;

/** Rules and capabilities, as the server uses them (see rule-book.ts). */
export interface AccessPort {
  decide(facts: RequestFacts, trust: TrustLevel): AccessDecision;
  remember(facts: RequestFacts, peerName: string, decision: Pick<Decision, 'scope' | 'command' | 'expiry'>): Rule;
  capabilities(): Capabilities;
}

export interface ServeContext {
  readonly book: TaskBook;
  readonly courier: Courier;
  /** One of your ids (in rooms, and on the network). */
  readonly isMe: (peerId: string) => boolean;
  readonly selfName: () => string;
  readonly trustFor: (peerId: string) => TrustLevel;
  readonly nameOf: (peerId: string) => string;
  readonly put: (task: TaskView) => TaskView;
  readonly agent: () => AgentBackend | undefined;
  /** Ask you; `task` links the card to the request it's about (the sheet and notifications find it). */
  readonly approve: (kind: 'request' | 'tool', title: string, detail: string, peer: string, task?: string) => Pending;
  readonly access: AccessPort;
  readonly serveShell?: ServeShell;
  readonly projectRoot: (name: string) => string | undefined;
  readonly model: () => { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  readonly notify: (title: string, body: string) => void;
  /** Where scratch folders go when the book has no folder. */
  readonly scratch: string;
  readonly now: () => number;
  /** The screen and device info (tests pass a pretend one). */
  readonly system?: SystemPort;
  readonly home?: string;
  /** Where a command from this person runs when it names no folder (PeerRun's choice: your shared folder, home with full trust). */
  readonly runFolder?: (from: string) => Promise<string | undefined>;
  /** How long a question waits for the requester's answer (default 15 minutes). */
  readonly questionWaitMs?: number;
}

/** Received tasks one person may have open here at once. */
const MAX_OPEN_PER_PERSON = 5;
/** Friends' tasks your Claude works on at the same time. */
const MAX_RUNNING = 2;
const MAX_STEPS = 12;
const STEP_EVERY_MS = 400;
const MAX_SCREENSHOTS = 4;
const QUESTION_WAIT_MS = 15 * 60_000;

const NEED_WORDS: Readonly<Record<Need, string>> = { project: 'work in a project', shell: 'run commands', files: 'read or write files', screen: 'see the screen', device: 'read device information' };

/** The capability a tool of a friend's task uses (checked on every call). */
const TOOL_NEEDS: Readonly<Record<string, Need>> = { Bash: 'shell', Write: 'files', Edit: 'files', MultiEdit: 'files', NotebookEdit: 'files' };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const SKIP: ClaudeAnswer = { kind: 'skip' };

type QuestionWaiter = { readonly task: string; readonly from: string; readonly resolve: (a: ClaudeAnswer) => void };

export class TaskServer {
  private readonly queue: Array<{ task: TaskView; req: TaskRequest; facts: RequestFacts }> = [];
  private running = 0;
  private readonly controllers = new Map<string, AbortController>();
  private readonly approvals = new Map<string, () => void>();
  /** Answers given on the request sheet (with the scope of "Always"), by task. */
  private readonly deciders = new Map<string, (d: Decision) => void>();
  /** "person:tool" pairs you said Always to (until Beluga quits). */
  private readonly alwaysTools = new Set<string>();
  /** Screenshots a task took (they go back with its result). */
  private readonly artifacts = new Map<string, string[]>();
  private readonly questions = new Map<string, QuestionWaiter>();
  private readonly asked = new Map<string, number>();
  readonly offers: FileOffers;

  constructor(private readonly ctx: ServeContext) {
    this.offers = new FileOffers(ctx.now);
  }

  /** Stop everything (Beluga quits): runs end, approvals are withdrawn. */
  stop(): void {
    for (const c of this.controllers.values()) c.abort();
    for (const w of this.approvals.values()) w();
    for (const q of this.questions.values()) q.resolve(SKIP);
    this.offers.drop();
  }

  private get system(): SystemPort {
    return this.ctx.system ?? realSystem;
  }

  private get home(): string {
    return this.ctx.home ?? os.homedir();
  }

  async onRequest(from: string, req: TaskRequest): Promise<void> {
    const { ctx } = this;
    if (req.from !== from || !ctx.isMe(req.to)) return;
    const known = ctx.book.get(req.id);
    if (known) {
      // Asked again (our result went missing): say it again; anything else is a replay.
      if (known.direction === 'received' && known.peerId === from && known.result) this.sendResult(known, known.result);
      return;
    }
    const level = ctx.trustFor(from);
    const name = ctx.nameOf(from);
    const me = ctx.selfName();
    const now = ctx.now();
    // Blocked people get their answer, and nothing of theirs is kept here.
    if (level === 'blocked') return this.declineUnkept(from, req.id, `${me} doesn't take requests from you`);
    const task = ctx.put({
      id: req.id,
      direction: 'received',
      peerId: from,
      peerName: name,
      kind: req.kind,
      ask: req.ask,
      ...(req.summary?.trim() ? { summary: oneLine(req.summary, 140) } : {}),
      needs: req.needs,
      by: req.by,
      state: 'queued',
      steps: [],
      createdAt: now,
      updatedAt: now,
      ...(req.project ? { project: req.project } : {}),
      ...(req.expects ? { expects: req.expects } : {}),
      ...(req.deadline ? { deadline: req.deadline } : {}),
      ...(req.command ? { command: req.command } : {}),
      ...(req.cwd ? { cwd: req.cwd } : {}),
      ...(req.timeoutSec ? { timeoutSec: req.timeoutSec } : {}),
      ...(req.path ? { path: req.path } : {}),
    });
    try {
      await this.admit(task, req, level);
    } catch (err) {
      // Whatever went wrong here, the requester hears it (nothing is left waiting).
      if (!this.isOver(task.id)) this.finish(this.current(task), 'failed', `${me}'s Beluga couldn't take it: ${errorText(err)}`);
    }
  }

  /** Decide a request that's now on the book, ask you if need be, and start it. */
  private async admit(task: TaskView, req: TaskRequest, level: TrustLevel): Promise<void> {
    const { ctx } = this;
    const name = task.peerName;
    const me = ctx.selfName();
    const now = ctx.now();
    const from = task.peerId;
    if (req.deadline && req.deadline < now) return this.finish(task, 'failed', 'Its deadline passed before it could start');
    const open = ctx.book.all().filter((t) => t.direction === 'received' && t.peerId === from && !isFinal(t.state)).length;
    if (open > MAX_OPEN_PER_PERSON) return this.finish(task, 'declined', `Too many of your requests are already waiting on ${me}'s Mac; try again when they're done`);
    if (req.kind === 'run' && !req.command) return this.finish(task, 'failed', 'It named no command to run');
    // Secrets stay off-limits at every trust level: refused before anyone is asked.
    if (req.kind === 'run' && mentionsSecret(req.command ?? '')) return this.finish(task, 'failed', 'Beluga never runs commands that touch secrets (.env files, keys, credentials)');
    if (req.kind === 'file' && !req.path) return this.finish(task, 'failed', 'It named no file');
    // A secret file is refused before anyone is asked too (the read checks again, links followed).
    if (req.kind === 'file' && isSecretPath(req.path ?? '')) return this.finish(task, 'declined', `${path.basename(req.path ?? '')}: not allowed (Beluga never sends secrets: .env files, keys, credentials)`);
    const facts = await this.factsFor(from, req);
    // It may have been stopped (or cancelled) meanwhile.
    if (this.isOver(task.id)) return;
    if (facts.folder && req.kind !== 'ask') this.update(task.id, this.folderOf(facts));
    // Decided before anything about your projects is said, and a project that isn't there reads
    // like one they can't have: nobody learns your project names by asking.
    const decided = ctx.access.decide(facts, level);
    if (decided.verdict === 'decline') return this.finish(task, 'declined', declineReason(decided, me));
    if (req.kind !== 'file' && req.project && !ctx.projectRoot(req.project)) return this.finish(task, 'declined', `That isn't available on ${me}'s Mac`);
    let allowedBy: string;
    // You said yes to this very request, having seen its path: that one file may come from anywhere,
    // not only the folders you share. A rule doesn't reach that far (its folder could be your home).
    // Secrets never.
    const youChose = decided.verdict === 'ask';
    if (decided.verdict === 'ask') {
      const answer = await this.ask(task, 'request', approvalTitle(task), this.detail(req, name, decided));
      if (this.isOver(task.id)) return;
      if (answer.answer === 'no') return this.finish(this.current(task), 'declined', `${me} declined${answer.reason?.trim() ? `: ${answer.reason.trim()}` : ''}`);
      if (answer.answer === 'always') {
        try {
          ctx.access.remember(facts, name, answer);
        } catch (err) {
          return this.finish(this.current(task), 'failed', `${me} said yes, but the rule couldn't be saved, so it didn't run: ${errorText(err)}`);
        }
        allowedBy = 'you approved it and made a rule for requests like it';
      } else allowedBy = 'you approved it';
    } else {
      allowedBy = decided.by === 'rule' ? 'a rule of yours allows it' : 'you trust them';
      const what = req.kind === 'run' ? `run \`${oneLine(req.command ?? '', 60)}\` on your Mac` : req.kind === 'file' ? `get ${path.basename(req.path ?? '')} from your Mac` : `ask your Claude to: ${requestGist(req, 80)}`;
      ctx.notify(`${name}${req.by === 'agent' ? "'s Claude" : ''} wants to ${what}`, `It runs without asking: ${allowedBy}`);
    }
    if (this.isOver(task.id)) return;
    this.update(task.id, { allowedBy });
    if (req.kind === 'run') return this.runCommand(this.current(task), req);
    if (req.kind === 'file') return this.sendFile(this.current(task), req, facts, youChose);
    this.queue.push({ task: this.current(task), req, facts });
    if (this.running >= MAX_RUNNING) this.update(task.id, { state: 'queued' }, 'Waiting for your Claude to finish another request');
    void this.pump();
  }

  /** Decline without keeping anything (a blocked person): the answer only, not queued for later. */
  private declineUnkept(to: string, id: string, summary: string): void {
    try {
      this.ctx.courier.send(to, { t: 'task_result', id, status: 'declined', summary, files: [], log: [], ts: this.ctx.now() }, false);
    } catch {
      // Not reachable: they ask again.
    }
  }

  onCancel(from: string, msg: TaskCancel): void {
    const task = this.ctx.book.get(msg.id);
    if (!task || task.direction !== 'received' || task.peerId !== from || isFinal(task.state)) return;
    this.halt(task, `${task.peerName} cancelled it`);
  }

  /** The requester answered a question their task's Claude asked. */
  onAnswer(from: string, msg: TaskAnswer): void {
    const w = this.questions.get(msg.qid);
    if (!w || w.from !== from || w.task !== msg.id) return;
    this.questions.delete(msg.qid);
    w.resolve(msg.skip || !msg.answers ? SKIP : { kind: 'answers', answers: msg.answers });
  }

  /** The requester fetches a piece of a big file of a result. */
  async onFileGet(from: string, msg: FileGet): Promise<void> {
    this.ctx.courier.send(from, await this.offers.chunk(from, msg), false);
  }

  /** You stop a friend's task on your Mac. */
  stopTask(id: string): boolean {
    const task = this.ctx.book.get(id);
    if (!task || task.direction !== 'received' || isFinal(task.state)) return false;
    this.halt(task, `${this.ctx.selfName()} stopped it`);
    return true;
  }

  /**
   * Your answer on the request sheet (or a notification, the menu bar): once, always (with the
   * scope and expiry of the rule it writes), or no (with a reason). False if it isn't waiting.
   */
  decide(id: string, decision: Decision): boolean {
    const resolve = this.deciders.get(id);
    if (!resolve) return false;
    resolve(decision);
    // Take the approval card back (its own answer no longer counts).
    this.approvals.get(id)?.();
    return true;
  }

  /** What's known about a request, to decide it: where it would run or read, resolved. */
  private async factsFor(from: string, req: TaskRequest): Promise<RequestFacts> {
    const base = { peerId: from, kind: ruleKindOf(req.kind), needs: req.needs, ...(req.project ? { project: req.project } : {}), ...(req.command ? { command: req.command } : {}) };
    const raw = req.kind === 'file' ? req.path : req.project ? this.ctx.projectRoot(req.project) : req.kind === 'run' ? (req.cwd ?? (await this.ctx.runFolder?.(from)) ?? this.home) : req.cwd;
    if (!raw) return base;
    const abs = path.resolve(raw === '~' ? this.home : raw.startsWith('~/') ? path.join(this.home, raw.slice(2)) : raw);
    const real = await fs.realpath(abs).catch(() => abs);
    return { ...base, folder: req.kind === 'file' ? path.dirname(real) : real };
  }

  /** What the sheet shows of where it would run (and the scope "Always" would write). */
  private folderOf(facts: RequestFacts): Partial<TaskView> {
    return facts.folder ? { folder: facts.folder } : {};
  }

  private halt(task: TaskView, why: string): void {
    this.approvals.get(task.id)?.();
    const queued = this.queue.findIndex((q) => q.task.id === task.id);
    if (queued >= 0) this.queue.splice(queued, 1);
    for (const [qid, q] of this.questions) if (q.task === task.id) (this.questions.delete(qid), q.resolve(SKIP));
    this.finish(task, 'cancelled', why);
    this.controllers.get(task.id)?.abort();
    this.offers.drop(task.id);
  }

  private detail(req: TaskRequest, name: string, decided: AccessDecision): string {
    const where = req.kind === 'file' ? `from ${req.path}` : req.project ? `in your project ${req.project}` : req.kind === 'run' ? `in ${req.cwd ?? 'your shared folder'}` : 'in a new scratch folder (~/.beluga/tasks/work)';
    const needs = req.needs.length ? req.needs.map((n) => NEED_WORDS[n]).join(', ') : 'nothing special';
    const back = req.kind === 'run' ? 'the output' : req.kind === 'file' ? 'the file' : req.expects === 'files' ? 'files' : req.expects ? 'structured data (JSON)' : 'a summary';
    const why = decided.by === 'rule' ? ' · a rule of yours says to ask' : decided.caps?.length ? ` · you asked to be asked before friends’ Claudes ${decided.caps.map((n) => NEED_WORDS[n]).join(' or ')}` : '';
    return [
      req.kind === 'run' ? `$ ${req.command ?? ''}${req.ask !== req.command ? `\nwhy: ${req.ask.slice(0, 500)}` : ''}` : req.ask.slice(0, 2000),
      '',
      `Needs: ${needs} · runs ${where} · sends back ${back}${req.deadline ? ` · by ${new Date(req.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}${why}`,
      `Always = allow requests like this from ${name} (same kind and needs${req.project ? `, in ${req.project}` : ''}); it becomes a rule you can change in Settings › People & access`,
    ].join('\n');
  }

  private async ask(task: TaskView, kind: 'request' | 'tool', title: string, detail: string): Promise<Decision> {
    this.update(task.id, { state: 'awaiting_approval' }, kind === 'tool' ? title : undefined);
    const pending = this.ctx.approve(kind, title, detail, task.peerId, kind === 'request' ? task.id : undefined);
    this.approvals.set(task.id, pending.withdraw);
    let fromSheet!: (d: Decision) => void;
    const sheet = new Promise<Decision>((resolve) => (fromSheet = resolve));
    if (kind === 'request') this.deciders.set(task.id, fromSheet);
    try {
      return await Promise.race([pending.answer.then((answer) => Decision.parse({ answer })), sheet]);
    } finally {
      this.approvals.delete(task.id);
      this.deciders.delete(task.id);
    }
  }

  private async pump(): Promise<void> {
    while (this.running < MAX_RUNNING && this.queue.length) {
      const next = this.queue.shift()!;
      if (this.isOver(next.task.id)) continue;
      this.running++;
      void this.runAsk(this.current(next.task), next.req).finally(() => {
        this.running--;
        void this.pump();
      });
    }
  }

  /** The place a task runs: the project it names, else a fresh scratch folder; plus your chosen folders when it may touch files. */
  private place(task: TaskView, req: TaskRequest): { place: AgentPlace; where: string; folders: string[] } {
    const caps = this.ctx.access.capabilities();
    const folders = req.needs.includes('files') && capFor(caps, 'files', this.ctx.trustFor(task.peerId)) !== 'off' ? caps.folders.filter((f) => !isSecretPath(f)) : [];
    const root = req.project ? this.ctx.projectRoot(req.project) : undefined;
    if (root) return { place: { cwd: root, additionalDirectories: folders, autoEdit: false, onSession: () => undefined }, where: `in ${req.project}`, folders };
    const dir = this.ctx.book.workDir(task.id, this.ctx.scratch);
    return { place: { cwd: dir, additionalDirectories: folders, autoEdit: true, onSession: () => undefined }, where: 'in a scratch folder', folders };
  }

  /** The tools a task gets for what it needed and was let in for: the screen, device info. */
  private toolsFor(task: TaskView, req: TaskRequest): TaskTools {
    const tools: { screenshot?: TaskTools['screenshot']; deviceInfo?: TaskTools['deviceInfo'] } = {};
    if (req.needs.includes('screen')) {
      tools.screenshot = async (app) => {
        const taken = this.artifacts.get(task.id) ?? [];
        if (taken.length >= MAX_SCREENSHOTS) throw new Error(`At most ${MAX_SCREENSHOTS} screenshots per request`);
        const dir = path.join(this.ctx.book.workDir(task.id, this.ctx.scratch), 'screens');
        const shot = await captureScreen(this.system, dir, app ? { app } : {});
        this.artifacts.set(task.id, [...taken, shot.file]);
        this.keepStep(task.id, `Took a screenshot of ${shot.of}`);
        const image = shot.view ? { data: (await fs.readFile(shot.view)).toString('base64'), mimeType: shot.view.endsWith('.png') ? 'image/png' : 'image/jpeg' } : undefined;
        return { text: `Screenshot of ${shot.of} (${Math.round(shot.bytes / 1024)} KB). It goes back to ${task.peerName} with your answer.`, ...(image ? { image } : {}) };
      };
    }
    if (req.needs.includes('device')) {
      tools.deviceInfo = async () => {
        const info = await deviceInfo(this.system);
        this.keepStep(task.id, 'Read the device information');
        return `${describeDevice(info)}\n\nAs JSON:\n${JSON.stringify(info, null, 2)}`;
      };
    }
    return tools;
  }

  private async runAsk(task: TaskView, req: TaskRequest): Promise<void> {
    const { ctx } = this;
    const agent = ctx.agent();
    if (!agent) return this.finish(task, 'failed', `${ctx.selfName()}'s Claude isn't running`);
    const { place, where, folders } = this.place(task, req);
    const full = ctx.trustFor(task.peerId) === 'full';
    const tools = this.toolsFor(task, req);
    const toolNames = [...(tools.screenshot ? ['screenshot'] : []), ...(tools.deviceInfo ? ['device_info'] : [])];
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.update(task.id, { state: 'working', startedAt: ctx.now(), where });
    let lastSent = 0;
    let held: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const step = (text: string): void => {
      // Steps are kept here at once; the other side hears at most a few a second.
      this.keepStep(task.id, text);
      held = text;
      const wait = STEP_EVERY_MS - (ctx.now() - lastSent);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        lastSent = ctx.now();
        if (held && !this.isOver(task.id)) this.sendUpdate(task.id, 'working', held);
      }, Math.max(0, wait));
      timer.unref?.();
    };
    try {
      const final = await agent.run({
        prompt: taskPrompt(req, ctx.selfName(), where, { tools: toolNames, folders }),
        requesterName: task.peerName,
        viaAgent: req.by === 'agent',
        context: [],
        place,
        scope: full ? 'full' : 'folder',
        signal: controller.signal,
        onEvent: (kind, text) => {
          if (kind === 'tool' && text) step(text.slice(0, 300));
        },
        onFileTouched: () => undefined,
        vetTool: (tool) => this.vetTool(task, tool),
        canUseTool: (tool, input) => this.authorizeTool(task, tool, input, full),
        askUser: (question) => this.askRequester(task, question, controller.signal),
        ...(toolNames.length ? { taskTools: tools } : {}),
        ...ctx.model(),
      });
      clearTimeout(timer);
      if (controller.signal.aborted || this.isOver(task.id)) return;
      const parsed = parseAnswer(final || '(done)', req.expects);
      const shots = this.artifacts.get(task.id) ?? [];
      const wanted = [...shots, ...parsed.files.filter((f) => !shots.includes(f))].slice(0, MAX_FILES);
      const roots = [place.cwd, ...folders, ...(shots.length ? [path.dirname(shots[0]!)] : [])];
      const { files, skipped } = await readResultFiles(wanted, { roots, anywhere: full, home: this.home, offer: (file) => this.offers.offer(task.id, task.peerId, file) });
      const problems = [...parsed.problems, ...skipped.map((s) => `file not sent: ${s}`)];
      this.finish(this.current(task), 'done', parsed.summary, {
        ...(parsed.data !== undefined ? { data: parsed.data } : {}),
        files,
        ...(problems.length ? { problems } : {}),
      });
    } catch (err) {
      clearTimeout(timer);
      if (this.isOver(task.id)) return;
      this.finish(this.current(task), 'failed', controller.signal.aborted ? 'Stopped' : errorText(err));
    } finally {
      this.controllers.delete(task.id);
      this.artifacts.delete(task.id);
      this.asked.delete(task.id);
    }
  }

  /**
   * Your Claude, working on their task, asks something: it goes back to the requester (their
   * Claude answers first, from what it knows, else they do). No answer in time: it goes on.
   */
  private async askRequester(task: TaskView, question: ClaudeQuestion, signal: AbortSignal): Promise<ClaudeAnswer> {
    if (question.kind !== 'question' || this.isOver(task.id)) return SKIP;
    const count = this.asked.get(task.id) ?? 0;
    if (count >= MAX_QUESTIONS) return SKIP;
    this.asked.set(task.id, count + 1);
    const qid = `q_${randomBytes(9).toString('base64url')}`;
    const questions = question.questions.map((q) => ({ question: q.question, header: q.header, options: q.options, multiSelect: q.multiSelect }));
    try {
      this.ctx.courier.send(task.peerId, { t: 'task_question', id: task.id, qid, questions, ts: this.ctx.now() }, true);
    } catch {
      return SKIP;
    }
    this.update(task.id, {}, `Asked ${task.peerName}: ${oneLine(questions[0]!.question, 140)}`);
    const answer = await new Promise<ClaudeAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.questions.delete(qid);
        resolve(SKIP);
      }, this.ctx.questionWaitMs ?? QUESTION_WAIT_MS);
      timer.unref?.();
      const done = (a: ClaudeAnswer): void => {
        clearTimeout(timer);
        resolve(a);
      };
      this.questions.set(qid, { task: task.id, from: task.peerId, resolve: done });
      signal.addEventListener('abort', () => (this.questions.delete(qid), done(SKIP)), { once: true });
    });
    if (!this.isOver(task.id)) this.update(task.id, {}, answer.kind === 'answers' ? `${task.peerName} answered` : `No answer from ${task.peerName}: going on`);
    return answer;
  }

  /** A tool's call, as the capability it uses, decided like a request (none: the tool needs no capability). */
  private toolAccess(task: TaskView, tool: string): { need: Need; decided: AccessDecision } | undefined {
    const need = TOOL_NEEDS[tool];
    if (!need) return undefined;
    const facts: RequestFacts = { peerId: task.peerId, kind: 'task', needs: [need], ...(task.project ? { project: task.project } : {}) };
    return { need, decided: this.ctx.access.decide(facts, this.ctx.trustFor(task.peerId)) };
  }

  /** Checked before every tool call of a friend's task: a capability that is Off, or a Decline rule, holds even with full trust. */
  private vetTool(task: TaskView, tool: string): string | undefined {
    const access = this.toolAccess(task, tool);
    if (access?.decided.verdict !== 'decline') return undefined;
    return `${this.ctx.selfName()} doesn't let friends' Claudes ${CAP_INFO[access.need].doing} here${access.decided.by === 'rule' ? ' (a rule for this person)' : ''}. Don't try another way; say so in your answer.`;
  }

  private async authorizeTool(task: TaskView, tool: string, input: Record<string, unknown>, full: boolean): Promise<boolean> {
    const access = this.toolAccess(task, tool);
    if (access?.decided.verdict === 'decline') return false;
    if (full) return true;
    // Commands are allowed for this person (their trust level's setting, or a rule): no need to ask.
    if (tool === 'Bash' && access?.decided.verdict === 'allow') return true;
    const scope = `${task.peerId}:${tool}`;
    if (this.alwaysTools.has(scope)) return true;
    const detail = typeof input.command === 'string' ? input.command : JSON.stringify(input).slice(0, 2000);
    const answer = await this.ask(task, 'tool', `Your Claude (working on ${task.peerName}'s request) wants to use ${tool.replace(/^mcp__beluga__/, '')}`, detail);
    if (!this.isOver(task.id)) this.update(task.id, { state: 'working' });
    if (answer.answer === 'always') this.alwaysTools.add(scope);
    return answer.answer !== 'no';
  }

  private async runCommand(task: TaskView, req: TaskRequest): Promise<void> {
    const { ctx } = this;
    if (!ctx.serveShell || !req.command) return this.finish(task, 'failed', `${ctx.selfName()}'s Beluga can't run commands for others here`);
    try {
      const reply = await ctx.serveShell(
        task.peerId,
        { command: req.command, timeoutSec: req.timeoutSec ?? 120, why: req.ask === req.command ? '' : oneLine(req.ask, 500), ...(req.cwd ? { cwd: req.cwd } : {}), ...(req.project ? { project: req.project } : {}) },
        {
          approved: true,
          onAsking: () => this.update(task.id, { state: 'awaiting_approval' }),
          onStarted: (cwd) => {
            this.update(task.id, { state: 'working', startedAt: ctx.now(), where: cwd }, `$ ${oneLine(req.command ?? '', 200)}`);
          },
        },
      );
      if (this.isOver(task.id)) return;
      if (!reply.ok) return this.finish(this.current(task), /declin|blocked/i.test(reply.error ?? '') ? 'declined' : 'failed', reply.error ?? 'It did not run');
      const head = reply.timedOut ? 'Stopped: it ran out of time' : `Exit code ${reply.exitCode ?? '?'}`;
      this.finish(this.current(task), 'done', `${head} on ${ctx.selfName()}'s Mac, in ${reply.cwd ?? 'their folder'}.${reply.truncated ? ' The output was long; this is its end.' : ''}\n\n${reply.output || '(no output)'}`, {
        data: { exitCode: reply.exitCode ?? null, output: reply.output ?? '', cwd: reply.cwd ?? null, timedOut: Boolean(reply.timedOut), truncated: Boolean(reply.truncated), ms: reply.ms ?? null },
      });
    } catch (err) {
      if (!this.isOver(task.id)) this.finish(this.current(task), 'failed', errorText(err));
    }
  }

  /** One file, sent by Beluga itself: from the folders you chose (anywhere with full trust), never secrets. */
  private async sendFile(task: TaskView, req: TaskRequest, facts: RequestFacts, youChose: boolean): Promise<void> {
    try {
      await this.readAndSend(task, req, facts, youChose);
    } catch (err) {
      if (!this.isOver(task.id)) this.finish(this.current(task), 'failed', `${this.ctx.selfName()}'s Beluga couldn't read it: ${errorText(err)}`);
    }
  }

  private async readAndSend(task: TaskView, req: TaskRequest, facts: RequestFacts, youChose: boolean): Promise<void> {
    const { ctx } = this;
    const me = ctx.selfName();
    const full = ctx.trustFor(task.peerId) === 'full' || youChose;
    const folders = ctx.access.capabilities().folders;
    if (!full && !folders.length) return this.finish(task, 'declined', `${me} hasn't chosen any folders friends may take files from`);
    const name = path.basename(req.path ?? '');
    this.update(task.id, { state: 'working', startedAt: ctx.now(), where: facts.folder ?? '' }, `Reading ${name}`);
    const { files, skipped } = await readResultFiles([req.path ?? ''], { roots: folders, anywhere: full, home: this.home, offer: (file) => this.offers.offer(task.id, task.peerId, file) });
    if (this.isOver(task.id)) return;
    const file = files[0];
    if (!file?.b64 && !file?.ref) {
      const why = skipped[0] ?? `${name} (not found)`;
      return this.finish(this.current(task), /not allowed|outside/.test(why) ? 'declined' : 'failed', `${me}'s Beluga didn't send it: ${why}`);
    }
    this.finish(this.current(task), 'done', `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB) from ${me}'s Mac.`, { files: [file] });
  }

  // ---- state

  private current(task: TaskView): TaskView {
    return this.ctx.book.get(task.id) ?? task;
  }

  private isOver(id: string): boolean {
    const t = this.ctx.book.get(id);
    return !t || isFinal(t.state);
  }

  private keepStep(id: string, step: string): void {
    const t = this.ctx.book.get(id);
    if (!t || isFinal(t.state)) return;
    this.ctx.put({ ...t, steps: [...t.steps, step].slice(-MAX_STEPS), updatedAt: this.ctx.now() });
  }

  private update(id: string, change: Partial<TaskView>, step?: string): void {
    const t = this.ctx.book.get(id);
    if (!t || isFinal(t.state)) return;
    const next = this.ctx.put({ ...t, ...change, ...(step ? { steps: [...t.steps, step].slice(-MAX_STEPS) } : {}), updatedAt: this.ctx.now() });
    if (next.state === 'queued' || next.state === 'awaiting_approval' || next.state === 'working') this.sendUpdate(id, next.state, step);
  }

  private sendUpdate(id: string, state: 'queued' | 'awaiting_approval' | 'working', step?: string): void {
    const t = this.ctx.book.get(id);
    if (!t) return;
    this.ctx.courier.send(t.peerId, { t: 'task_update', id, state, ...(step ? { step: step.slice(0, 300) } : {}), ts: this.ctx.now() }, false);
  }

  /** The end: kept here, and the result goes back to the requester (waiting in the outbox if they're offline). */
  private finish(task: TaskView, status: ResultStatus, summary: string, extra: { data?: unknown; files?: ReadonlyArray<{ name: string; size: number; b64?: string; ref?: string; sha256?: string; image?: boolean }>; problems?: readonly string[] } = {}): void {
    const t = this.current(task);
    if (isFinal(t.state)) return;
    const files = extra.files ?? [];
    const result: TaskOutcome = {
      status,
      summary,
      // What's offered for fetching stays known (the result may have to be sent again); inline bytes don't.
      files: files.map((f) => ({ name: f.name, size: f.size, ...(f.image ? { image: true } : {}), ...(f.ref ? { ref: f.ref } : {}), ...(f.sha256 ? { sha256: f.sha256 } : {}) })),
      log: t.steps,
      ...(extra.data !== undefined ? { data: extra.data } : {}),
      ...(extra.problems?.length ? { problems: extra.problems } : {}),
    };
    const done = this.ctx.put({ ...t, state: status, result, endedAt: this.ctx.now(), updatedAt: this.ctx.now() });
    this.sendResult(done, result, files);
  }

  private sendResult(task: TaskView, result: TaskOutcome, files: ReadonlyArray<{ name: string; size: number; b64?: string; ref?: string; sha256?: string; image?: boolean }> = result.files): void {
    try {
      this.ctx.courier.send(
        task.peerId,
        {
          t: 'task_result',
          id: task.id,
          status: result.status,
          summary: result.summary,
          files: files.map((f) => ({ name: path.basename(f.name), size: f.size, ...(f.b64 ? { b64: f.b64 } : {}), ...(f.ref ? { ref: f.ref } : {}), ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.image ? { image: true } : {}) })),
          log: result.log.slice(-60),
          ts: this.ctx.now(),
          ...(result.data !== undefined ? { data: result.data } : {}),
        },
        true,
      );
    } catch {
      // The outbox is full: the requester asks again (or the task shows as unanswered there).
    }
  }
}

export const defaultScratch = (): string => path.join(os.tmpdir(), 'beluga-tasks');
