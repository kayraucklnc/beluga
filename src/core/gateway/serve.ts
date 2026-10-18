import os from 'node:os';
import path from 'node:path';
import type { AgentBackend, AgentPlace } from '../../agent/types.js';
import type { TrustLevel } from '../trust.js';
import type { TaskBook } from './book.js';
import { type TaskOutcome, type TaskView, approvalTitle, isFinal } from './model.js';
import { type Need, OFFERED, type ResultStatus, type TaskCancel, type TaskRequest } from './protocol.js';
import { oneLine, parseAnswer, readResultFiles, taskPrompt } from './result.js';
import type { Courier } from './transport.js';

/**
 * The receiving side of the gateway: a friend's Claude asks yours (or asks to run a command
 * here). Trust decides first: blocked → declined; Trusted / Full trust → it runs; Ask me each
 * time → today's approval card ("Kayra's Claude wants to: …", Allow / Always / Deny). Then
 * your Claude works on it in the project it names (if there is one) or in a fresh scratch
 * folder, its steps go back as updates, and its final answer goes back as the result, to the
 * requester only. Tool approvals inside the run work as for any friend's request.
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
export type ServeShell = (from: string, ask: ShellAsk, hooks: { onAsking: () => void; onStarted: (cwd: string) => void }) => Promise<ShellReply>;

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
  readonly approve: (kind: 'request' | 'tool', title: string, detail: string, peer: string) => Pending;
  readonly setTrust: (peerId: string, level: TrustLevel) => void;
  readonly serveShell?: ServeShell;
  readonly projectRoot: (name: string) => string | undefined;
  readonly model: () => { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  readonly notify: (title: string, body: string) => void;
  /** Where scratch folders go when the book has no folder. */
  readonly scratch: string;
  readonly now: () => number;
}

/** Received tasks one person may have open here at once. */
const MAX_OPEN_PER_PERSON = 5;
/** Friends' tasks your Claude works on at the same time. */
const MAX_RUNNING = 2;
const MAX_STEPS = 12;
const STEP_EVERY_MS = 400;

const NEED_WORDS: Readonly<Record<Need, string>> = { project: 'work in a project', shell: 'run commands', files: 'read or make files', screen: 'look at the screen', device: 'read device information' };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class TaskServer {
  private readonly queue: Array<{ task: TaskView; req: TaskRequest }> = [];
  private running = 0;
  private readonly controllers = new Map<string, AbortController>();
  private readonly approvals = new Map<string, () => void>();
  /** "person:tool" pairs you said Always to (until klaud quits). */
  private readonly alwaysTools = new Set<string>();

  constructor(private readonly ctx: ServeContext) {}

  /** Stop everything (klaud quits): runs end, approvals are withdrawn. */
  stop(): void {
    for (const c of this.controllers.values()) c.abort();
    for (const w of this.approvals.values()) w();
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
    const task = ctx.put({
      id: req.id,
      direction: 'received',
      peerId: from,
      peerName: name,
      kind: req.kind,
      ask: req.ask,
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
    });
    if (level === 'blocked') return this.finish(task, 'declined', `${me} doesn't take requests from you`);
    const missing = req.needs.filter((n) => !OFFERED.includes(n));
    if (missing.length) return this.finish(task, 'declined', `${me}'s klaud can't ${missing.map((n) => NEED_WORDS[n]).join(' or ')} for others yet`);
    if (req.deadline && req.deadline < now) return this.finish(task, 'failed', 'Its deadline passed before it could start');
    const open = ctx.book.all().filter((t) => t.direction === 'received' && t.peerId === from && !isFinal(t.state)).length;
    if (open > MAX_OPEN_PER_PERSON) return this.finish(task, 'declined', `Too many of your requests are already waiting on ${me}'s Mac; try again when they're done`);
    if (req.kind === 'run') return this.runCommand(task, req);
    if (!req.kind || req.kind === 'ask') {
      if (req.project && !ctx.projectRoot(req.project)) return this.finish(task, 'declined', `There's no project called ${req.project} on ${me}'s Mac`);
      if (level === 'ask') {
        const answer = await this.ask(task, 'request', approvalTitle(task), this.detail(req, name));
        if (this.isOver(task.id)) return;
        if (answer === 'no') return this.finish(this.current(task), 'declined', `${me} declined`);
        if (answer === 'always') ctx.setTrust(from, 'trusted');
      } else {
        ctx.notify(`${name}${req.by === 'agent' ? "'s Claude" : ''} asked your Claude to: ${oneLine(req.ask, 80)}`, `You trust ${name}, so it runs without asking`);
      }
      this.queue.push({ task: this.current(task), req });
      if (this.running >= MAX_RUNNING) this.update(task.id, { state: 'queued' }, 'Waiting for your Claude to finish another request');
      void this.pump();
    }
  }

  onCancel(from: string, msg: TaskCancel): void {
    const task = this.ctx.book.get(msg.id);
    if (!task || task.direction !== 'received' || task.peerId !== from || isFinal(task.state)) return;
    this.halt(task, `${task.peerName} cancelled it`);
  }

  /** You stop a friend's task on your Mac. */
  stopTask(id: string): boolean {
    const task = this.ctx.book.get(id);
    if (!task || task.direction !== 'received' || isFinal(task.state)) return false;
    this.halt(task, `${this.ctx.selfName()} stopped it`);
    return true;
  }

  private halt(task: TaskView, why: string): void {
    this.approvals.get(task.id)?.();
    const queued = this.queue.findIndex((q) => q.task.id === task.id);
    if (queued >= 0) this.queue.splice(queued, 1);
    this.finish(task, 'cancelled', why);
    this.controllers.get(task.id)?.abort();
  }

  private detail(req: TaskRequest, name: string): string {
    const where = req.project ? `in your project ${req.project}` : 'in a new scratch folder (~/.klaud/tasks/work)';
    const needs = req.needs.length ? req.needs.map((n) => NEED_WORDS[n]).join(', ') : 'nothing special';
    const back = req.expects === 'files' ? 'files' : req.expects ? 'structured data (JSON)' : 'a summary';
    return [
      req.ask.slice(0, 2000),
      '',
      `Needs: ${needs} · runs ${where} · sends back ${back}${req.deadline ? ` · by ${new Date(req.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`,
      `Always = trust ${name} (their requests run without asking; commands and files outside shared folders still ask you)`,
    ].join('\n');
  }

  private async ask(task: TaskView, kind: 'request' | 'tool', title: string, detail: string): Promise<Answer> {
    this.update(task.id, { state: 'awaiting_approval' }, kind === 'tool' ? title : undefined);
    const pending = this.ctx.approve(kind, title, detail, task.peerId);
    this.approvals.set(task.id, pending.withdraw);
    try {
      return await pending.answer;
    } finally {
      this.approvals.delete(task.id);
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

  /** The place a task runs: the project it names, else a fresh scratch folder. */
  private place(task: TaskView, req: TaskRequest): { place: AgentPlace; where: string } {
    const root = req.project ? this.ctx.projectRoot(req.project) : undefined;
    if (root) return { place: { cwd: root, additionalDirectories: [], autoEdit: false, onSession: () => undefined }, where: `in ${req.project}` };
    const dir = this.ctx.book.workDir(task.id, this.ctx.scratch);
    return { place: { cwd: dir, additionalDirectories: [], autoEdit: true, onSession: () => undefined }, where: 'in a scratch folder' };
  }

  private async runAsk(task: TaskView, req: TaskRequest): Promise<void> {
    const { ctx } = this;
    const agent = ctx.agent();
    if (!agent) return this.finish(task, 'failed', `${ctx.selfName()}'s Claude isn't running`);
    const { place, where } = this.place(task, req);
    const full = ctx.trustFor(task.peerId) === 'full';
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
        prompt: taskPrompt(req, ctx.selfName(), where),
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
        canUseTool: (tool, input) => this.authorizeTool(task, tool, input, full),
        // Questions back to the requester come in a later phase: Claude goes on with its best judgment.
        askUser: async () => ({ kind: 'skip' }),
        ...ctx.model(),
      });
      clearTimeout(timer);
      if (controller.signal.aborted || this.isOver(task.id)) return;
      const parsed = parseAnswer(final || '(done)', req.expects);
      const { files, skipped } = await readResultFiles(parsed.files, { roots: [place.cwd], anywhere: full });
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
    }
  }

  private async authorizeTool(task: TaskView, tool: string, input: Record<string, unknown>, full: boolean): Promise<boolean> {
    if (full) return true;
    const scope = `${task.peerId}:${tool}`;
    if (this.alwaysTools.has(scope)) return true;
    const detail = typeof input.command === 'string' ? input.command : JSON.stringify(input).slice(0, 2000);
    const answer = await this.ask(task, 'tool', `Your Claude (working on ${task.peerName}'s request) wants to use ${tool.replace(/^mcp__klaud__/, '')}`, detail);
    if (!this.isOver(task.id)) this.update(task.id, { state: 'working' });
    if (answer === 'always') this.alwaysTools.add(scope);
    return answer !== 'no';
  }

  private async runCommand(task: TaskView, req: TaskRequest): Promise<void> {
    const { ctx } = this;
    if (!ctx.serveShell || !req.command) return this.finish(task, 'failed', `${ctx.selfName()}'s klaud can't run commands for others here`);
    try {
      const reply = await ctx.serveShell(
        task.peerId,
        { command: req.command, timeoutSec: req.timeoutSec ?? 120, why: req.ask === req.command ? '' : oneLine(req.ask, 500), ...(req.cwd ? { cwd: req.cwd } : {}), ...(req.project ? { project: req.project } : {}) },
        {
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
  private finish(task: TaskView, status: ResultStatus, summary: string, extra: { data?: unknown; files?: ReadonlyArray<{ name: string; size: number; b64?: string }>; problems?: readonly string[] } = {}): void {
    const t = this.current(task);
    if (isFinal(t.state)) return;
    const files = extra.files ?? [];
    const result: TaskOutcome = {
      status,
      summary,
      files: files.map((f) => ({ name: f.name, size: f.size })),
      log: t.steps,
      ...(extra.data !== undefined ? { data: extra.data } : {}),
      ...(extra.problems?.length ? { problems: extra.problems } : {}),
    };
    const done = this.ctx.put({ ...t, state: status, result, endedAt: this.ctx.now(), updatedAt: this.ctx.now() });
    this.sendResult(done, result, files);
  }

  private sendResult(task: TaskView, result: TaskOutcome, files: ReadonlyArray<{ name: string; size: number; b64?: string }> = result.files): void {
    try {
      this.ctx.courier.send(
        task.peerId,
        { t: 'task_result', id: task.id, status: result.status, summary: result.summary, files: files.map((f) => ({ name: path.basename(f.name), size: f.size, ...(f.b64 ? { b64: f.b64 } : {}) })), log: result.log.slice(-60), ts: this.ctx.now(), ...(result.data !== undefined ? { data: result.data } : {}) },
        true,
      );
    } catch {
      // The outbox is full: the requester asks again (or the task shows as unanswered there).
    }
  }
}

export const defaultScratch = (): string => path.join(os.tmpdir(), 'klaud-tasks');
