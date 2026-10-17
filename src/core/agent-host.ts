import { randomUUID } from 'node:crypto';
import type { AgentBackend } from '../agent/types.js';
import { type BodyInput, type BodyOf, MAX_TEXT } from '../protocol.js';
import type { People } from './people.js';
import type { QuestionBroker } from './questions.js';
import type { ShareService } from './shares.js';
import { type Store, peerName } from './store.js';
import { reachOf, trustOf } from './trust.js';
import type { WorkspaceController } from './workspace-controller.js';
import type { WorkspaceSharing } from './workspace-sharing.js';

export interface AgentHostDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly send: (body: BodyInput, opts?: { to?: string; keep?: boolean }) => boolean;
  readonly agent?: () => AgentBackend | undefined;
  readonly shares: ShareService;
  readonly sharing: WorkspaceSharing;
  readonly people: People;
  readonly questions: QuestionBroker;
  readonly workspaces?: WorkspaceController;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  readonly system: (text: string, level?: 'info' | 'warn' | 'error') => void;
  readonly approvalTimeoutMs: () => number;
  readonly refreshUsage: () => Promise<void>;
}

const MAX_PENDING_APPROVALS = 20;
const MAX_APPROVALS_PER_PERSON = 3;
const SEEN_REQUESTS = 1000;
const CONTEXT_LINES = 20;
/** Requests one person may have waiting for your Claude at once. */
const MAX_QUEUED_PER_PERSON = 10;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Your Claude serving requests (yours and other people's): who may use it, the queue, the
 * approvals you're asked for, running it in the right place with the right model, and
 * reporting what it does to everyone who should see it.
 */
export class AgentHost {
  /** Conversation the agent is currently working in (for its send_chat tool). */
  currentChannel = 'room';
  private readonly approvals = new Map<string, (answer: 'yes' | 'no' | 'always') => void>();
  private readonly alwaysTools = new Set<string>();
  /** Requests waiting for the agent, run one at a time (urgent ones jump the line). */
  /** `askTo`: who gets Claude's questions (default: whoever asked). */
  private waiting: Array<{ from: string; body: BodyOf<'agent_request'>; urgent?: boolean; askTo?: string }> = [];
  /** Approvals waiting per person, so one person can't crowd out everyone else's. */
  private readonly approvalsBy = new Map<string, number>();
  private pumping = false;
  private interruptedBy?: string;
  private current?: AbortController;
  /** Bumped by :stop so queued runs are cancelled too. */
  private generation = 0;
  private readonly seenRequests: string[] = [];
  private readonly toolApprovals = new Set<string>();
  /** Final agent events that could not be sent while disconnected. */
  private outbox: Array<{ body: BodyInput; opts: { to?: string; keep?: boolean } }> = [];

  constructor(private readonly deps: AgentHostDeps) {}

  private get store(): Store {
    return this.deps.store;
  }

  private get selfId(): string {
    return this.deps.selfId();
  }

  private get agent(): AgentBackend | undefined {
    return this.deps.agent?.();
  }

  private get approvalTimeoutMs(): number {
    return this.deps.approvalTimeoutMs();
  }

  private send(body: BodyInput, opts: { to?: string; keep?: boolean } = {}): boolean {
    return this.deps.send(body, opts);
  }

  private toast(text: string, level?: 'info' | 'success' | 'warn' | 'error'): void {
    this.deps.toast(text, level);
  }

  private system(text: string, level?: 'info' | 'warn' | 'error'): void {
    this.deps.system(text, level);
  }

  /** Stop whatever is running (when klaude quits). */
  abort(): void {
    this.current?.abort();
  }

  /** Send the final results that couldn't go out while you were disconnected. */
  flushOutbox(): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const item of queued) this.send(item.body, item.opts);
  }

  /** Run your Claude for someone else in one of your workspaces (they were invited to work there). */
  runFor(from: string, channel: string, prompt: string, plan = false): void {
    const body: BodyOf<'agent_request'> = { kind: 'agent_request', requestId: randomUUID(), prompt: prompt.slice(0, MAX_TEXT), viaAgent: false, channel, urgent: false, plan };
    this.deps.questions.track(body.requestId, this.selfId, channel);
    void this.onAgentRequest(from, body);
  }

  /**
   * Run your Claude in one of your conversations with text that came from someone else (e.g. a
   * handoff note). Their trust level decides what it may do without asking you; its questions
   * come to you.
   */
  runOnBehalf(from: string, channel: string, prompt: string): void {
    const body: BodyOf<'agent_request'> = { kind: 'agent_request', requestId: randomUUID(), prompt: prompt.slice(0, MAX_TEXT), viaAgent: true, channel, urgent: false, plan: false };
    this.deps.questions.track(body.requestId, this.selfId, channel);
    if (trustOf(this.store.getState(), from) === 'blocked') return;
    this.enqueue(from, body, this.selfId);
  }

  answerApproval(answer: 'yes' | 'no' | 'always', id?: string): boolean {
    const target = id ?? this.store.getState().approvals[0]?.id;
    const resolve = target ? this.approvals.get(target) : undefined;
    if (!target || !resolve) return false;
    this.approvals.delete(target);
    this.store.dispatch({ type: 'approval_remove', id: target });
    resolve(answer);
    return true;
  }

  stopAgent(): void {
    if (!this.current && this.waiting.length === 0) {
      this.toast('Your Claude is not running anything');
      return;
    }
    this.generation++;
    this.current?.abort();
    for (const id of [...this.toolApprovals]) this.answerApproval('no', id);
    this.deps.questions.cancelAll();
    const cancelled = this.waiting;
    this.waiting = [];
    for (const { from, body } of cancelled) this.emitAgent(body.requestId, from, 'error', 'Cancelled by owner', body.channel);
    this.toast('Stopping your Claude (queued requests cancelled)', 'warn');
  }

  private emitAgent(requestId: string, requester: string, event: BodyOf<'agent_event'>['event'], text = '', channel = 'room'): void {
    const final = event === 'done' || event === 'error' || event === 'denied';
    const body: BodyInput = { kind: 'agent_event', requestId, requester, event, text: text.slice(0, 60_000), channel };
    // Workspace conversations are private: events go to you and the people you invited, never to the room.
    const targets = channel === 'room' ? [{ keep: final }] : [this.selfId, ...this.deps.sharing.recipients(channel)].map((to) => ({ to }));
    for (const opts of targets) if (!this.send(body, opts) && final) this.outbox = [...this.outbox, { body, opts }].slice(-50);
  }

  async onAgentRequest(from: string, body: BodyOf<'agent_request'>): Promise<void> {
    // Drop replays of a request we've already seen.
    const key = `${from}:${body.requestId}`;
    if (this.seenRequests.includes(key)) return;
    this.seenRequests.push(key);
    if (this.seenRequests.length > SEEN_REQUESTS) this.seenRequests.shift();
    if (!this.agent) {
      this.emitAgent(body.requestId, from, 'denied', 'No agent is running on this machine.', body.channel);
      return;
    }
    const inWorkspace = body.channel !== 'room' && from !== this.selfId;
    if (inWorkspace && (this.deps.sharing.sharedFor(body.channel) || !this.deps.sharing.canPost(from, body.channel))) {
      this.emitAgent(body.requestId, from, 'denied', "That workspace isn't shared with you.", body.channel);
      return;
    }
    // Inviting someone to contribute to a workspace is your yes to their requests there
    // (each risky step still asks you, unless you fully trust them).
    const allowed = inWorkspace ? this.store.getState().policy !== 'deny' : await this.authorizeRequest(from, body);
    if (!allowed) {
      this.emitAgent(body.requestId, from, 'denied', 'Request declined by the machine owner.', body.channel);
      return;
    }
    this.enqueue(from, body);
  }

  /**
   * Queue a request. Normal requests wait their turn (and say so); urgent ones from you
   * interrupt the current run and go next, continuing the same conversation.
   */
  private enqueue(from: string, body: BodyOf<'agent_request'>, askTo?: string): void {
    const urgent = body.urgent && from === this.selfId;
    if (urgent) {
      // After earlier urgent messages (keeping your order), ahead of everything else.
      const at = this.waiting.findIndex((w) => !w.urgent);
      this.waiting.splice(at === -1 ? this.waiting.length : at, 0, { from, body, urgent: true });
      if (this.current) {
        this.interruptedBy = body.requestId;
        this.current.abort();
      }
    } else {
      if (this.waiting.filter((w) => w.from === from).length >= MAX_QUEUED_PER_PERSON) {
        this.emitAgent(body.requestId, from, 'denied', 'Too many requests waiting; try again when the current ones finish.', body.channel);
        return;
      }
      this.waiting.push({ from, body, ...(askTo ? { askTo } : {}) });
      if (this.current || this.waiting.length > 1) this.emitAgent(body.requestId, from, 'queued', 'Waiting for the current task to finish', body.channel);
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let next = this.waiting.shift(); next; next = this.waiting.shift()) {
        await this.runAgent(next.from, next.body, next.askTo).catch((err: unknown) => this.system(`Agent run failed: ${errorText(err)}`, 'error'));
      }
    } finally {
      this.pumping = false;
    }
  }

  private async authorizeRequest(from: string, body: BodyOf<'agent_request'>): Promise<boolean> {
    if (from === this.selfId) return true;
    const state = this.store.getState();
    const level = trustOf(state, from);
    if (level === 'blocked') return false;
    if (level === 'trusted' || level === 'full') return true;
    const name = peerName(state, from);
    this.emitAgent(body.requestId, from, 'awaiting_approval', `Waiting for ${state.self?.name ?? 'owner'} to approve`, body.channel);
    const reach = reachOf(state, from) === 'full' ? 'whole computer' : 'shared folders; anything else asks you';
    const answer = await this.ask('request', `${name}${body.viaAgent ? "'s Claude" : ''} wants your Claude to run this (${reach})`, body.prompt, from);
    if (answer === 'always') this.deps.people.setTrust(from, 'trusted');
    return answer !== 'no';
  }

  /** Ask you to approve something; `peer` is who it's for (each person can have a few waiting at most). */
  ask(kind: 'request' | 'tool', title: string, detail: string, peer?: string): Promise<'yes' | 'no' | 'always'> {
    if (this.approvals.size >= MAX_PENDING_APPROVALS) return Promise.resolve('no');
    if (peer && peer !== this.selfId && (this.approvalsBy.get(peer) ?? 0) >= MAX_APPROVALS_PER_PERSON) return Promise.resolve('no');
    if (peer) this.approvalsBy.set(peer, (this.approvalsBy.get(peer) ?? 0) + 1);
    const id = randomUUID();
    if (kind === 'tool') this.toolApprovals.add(id);
    return new Promise((resolve) => {
      // Nobody should be stuck waiting forever on an approval you didn't see.
      const expiry = setTimeout(() => {
        if (this.answerApproval('no', id)) this.toast(`An approval expired after ${Math.round(this.approvalTimeoutMs / 60_000)} min without an answer`, 'warn');
      }, this.approvalTimeoutMs);
      expiry.unref();
      this.approvals.set(id, (answer) => {
        clearTimeout(expiry);
        this.toolApprovals.delete(id);
        if (peer) this.approvalsBy.set(peer, Math.max(0, (this.approvalsBy.get(peer) ?? 1) - 1));
        resolve(answer);
      });
      this.store.dispatch({ type: 'approval_add', approval: { id, kind, title, detail } });
    });
  }

  private async runAgent(from: string, body: BodyOf<'agent_request'>, askTo = from): Promise<void> {
    const agent = this.agent as AgentBackend;
    const controller = new AbortController();
    this.current = controller;
    const requesterName = peerName(this.store.getState(), from);
    const place = this.deps.workspaces?.place(body.channel);
    if (body.channel !== 'room' && !place) {
      this.emitAgent(body.requestId, from, 'error', 'That workspace is archived or missing.', body.channel);
      if (this.current === controller) this.current = undefined;
      return;
    }
    this.currentChannel = body.channel;
    this.emitAgent(body.requestId, from, 'started', '', body.channel);
    try {
      const final = await agent.run({
        prompt: body.prompt,
        requesterName,
        viaAgent: body.viaAgent,
        context: this.recentChat(body.channel),
        ...(place ? { place } : {}),
        scope: from === this.selfId ? 'full' : reachOf(this.store.getState(), from),
        signal: controller.signal,
        onEvent: (kind, text) => this.emitAgent(body.requestId, from, kind, text, body.channel),
        onFileTouched: (abs) => this.announceAgentFocus(abs),
        canUseTool: (toolName, input) => this.authorizeTool(from, requesterName, toolName, input),
        askUser: (question) => this.deps.questions.ask(askTo, body.requestId, body.channel, question),
        plan: body.plan,
        ...this.modelFor(place?.model),
      });
      if (controller.signal.aborted) throw new Error('aborted');
      this.emitAgent(body.requestId, from, 'done', final || '(done)', body.channel);
    } catch (err) {
      const reason = this.interruptedBy ? 'Interrupted by a newer message' : controller.signal.aborted ? 'Stopped by owner' : errorText(err);
      this.interruptedBy = undefined;
      this.emitAgent(body.requestId, from, 'error', reason, body.channel);
    } finally {
      if (this.current === controller) this.current = undefined;
      this.interruptedBy = undefined; // never carry an interrupt label into the next run
      this.currentChannel = 'room';
      void this.deps.refreshUsage();
      if (body.channel !== 'room') void this.deps.workspaces?.refresh();
    }
  }

  /** The model and effort for a run: the conversation's own pick, else your defaults. */
  private modelFor(own: string | undefined): { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } {
    const prefs = this.store.getState().prefs;
    const model = own ?? prefs.model;
    return { ...(model ? { model } : {}), ...(prefs.effort ? { effort: prefs.effort } : {}) };
  }

  private async authorizeTool(requester: string, requesterName: string, toolName: string, input: Record<string, unknown>): Promise<boolean> {
    // Your own Claude doesn't nag you (unless you asked it to); fully trusted friends don't either.
    const state = this.store.getState();
    if (requester === this.selfId && state.prefs.selfApproval === 'never') return true;
    if (requester !== this.selfId && trustOf(state, requester) === 'full') return true;
    // "Always" is scoped to one requester and one tool, never global.
    const scope = `${requester}:${toolName}`;
    if (this.alwaysTools.has(scope)) return true;
    const detail = typeof input.command === 'string' ? input.command : JSON.stringify(input);
    const answer = await this.ask('tool', `Your Claude (working for ${requesterName}) wants to use ${toolName}`, detail, requester);
    if (answer === 'always') this.alwaysTools.add(scope);
    return answer !== 'no';
  }

  private announceAgentFocus(absPath: string): void {
    const hit = this.deps.shares.locate(absPath);
    if (hit) this.send({ kind: 'focus', owner: this.selfId, share: hit.share, path: hit.path, actor: 'agent' }, this.deps.shares.isPrivate(hit.share) ? { to: this.selfId } : {});
  }

  private recentChat(channel = 'room'): string[] {
    const state = this.store.getState();
    return state.log
      .filter((l) => l.type === 'chat' && l.channel === channel)
      .slice(-CONTEXT_LINES)
      .map((l) => (l.type === 'chat' ? `${l.name}: ${l.text}`.slice(0, 1000) : ''));
  }
}
