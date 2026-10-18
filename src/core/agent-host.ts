import { randomUUID } from 'node:crypto';
import { mentionsSecret } from '../agent/policy.js';
import path from 'node:path';
import type { AgentBackend, FollowUp } from '../agent/types.js';
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
  /** People invited by link to edit: their requests edit and run commands in that folder without asking. */
  readonly canEditIn?: (peerId: string, channel: string) => boolean;
}

/**
 * The tool stays inside `cwd`: its file is there, or (Bash, which runs there) its command names
 * no path outside it (no `~`, `..` or `$`, absolute paths only under `cwd`). Anything else asks you.
 */
export function toolInside(toolName: string, input: Record<string, unknown>, cwd: string): boolean {
  const root = path.resolve(cwd);
  const within = (target: string): boolean => target === root || target.startsWith(root + path.sep);
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    // Variables and subshells ($HOME, $(…), `…`) could point anywhere: those ask.
    if (/[$`]/.test(command) || mentionsSecret(command)) return false;
    const paths = command.match(/(?:^|[\s'"=:(<>])(?:~|\/|\.\.)[^\s'";|&)]*/g) ?? [];
    return paths.every((m) => {
      const raw = m.replace(/^[\s'"=:(<>]/, '');
      return !raw.startsWith('~') && !raw.startsWith('..') && within(path.resolve(raw));
    });
  }
  const raw = [input.file_path, input.notebook_path, input.path].find((v) => typeof v === 'string' && v);
  return within(path.resolve(cwd, typeof raw === 'string' ? raw : '.'));
}

const MAX_PENDING_APPROVALS = 20;
const MAX_APPROVALS_PER_PERSON = 3;
const SEEN_REQUESTS = 1000;
const CONTEXT_LINES = 20;
/** Requests one person may have waiting for your Claude at once. */
const MAX_QUEUED_PER_PERSON = 10;

/** The queue for one conversation (the room, or a workspace). `askTo`: who gets Claude's questions. */
interface Lane {
  waiting: Array<{ from: string; body: BodyOf<'agent_request'>; urgent?: boolean; askTo?: string }>;
  pumping: boolean;
  current?: AbortController;
  interruptedBy?: string;
  /** Who started the current run. */
  runFrom?: string;
  /** Set while the run has answered but waits on background agents: messages go straight in. */
  followUps?: (followUp: FollowUp) => boolean;
}

/** Conversations whose Claude may work at the same time (keeps your plan's limits in mind). */
const MAX_PARALLEL_RUNS = 4;

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
  /** "person:project" pairs you said Always to (this session). */
  private readonly alwaysProjects = new Set<string>();
  /**
   * One queue per conversation: each workspace's Claude works on its own, at the same time as
   * the others, while messages within one conversation run in order (urgent ones jump the line).
   */
  private readonly lanes = new Map<string, Lane>();
  private running = 0;
  /** Approvals waiting per person, so one person can't crowd out everyone else's. */
  private readonly approvalsBy = new Map<string, number>();
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

  /** Stop whatever is running (when klaud quits). */
  abort(): void {
    for (const lane of this.lanes.values()) lane.current?.abort();
  }

  private lane(channel: string): Lane {
    let lane = this.lanes.get(channel);
    if (!lane) {
      lane = { waiting: [], pumping: false };
      this.lanes.set(channel, lane);
    }
    return lane;
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
    const lanes = [...this.lanes.values()];
    if (!lanes.some((l) => l.current || l.waiting.length)) {
      this.toast('Your Claude is not running anything');
      return;
    }
    for (const id of [...this.toolApprovals]) this.answerApproval('no', id);
    this.deps.questions.cancelAll();
    for (const lane of lanes) {
      const cancelled = lane.waiting;
      lane.waiting = [];
      lane.current?.abort();
      for (const { from, body } of cancelled) this.emitAgent(body.requestId, from, 'error', 'Cancelled by owner', body.channel);
    }
    this.toast('Stopping your Claude everywhere (queued requests cancelled)', 'warn');
  }


  /** Run one of your waiting requests now: it goes next and interrupts the current run. */
  promote(requestId: string): boolean {
    for (const lane of this.lanes.values()) {
      const i = lane.waiting.findIndex((w) => w.body.requestId === requestId && w.from === this.selfId);
      if (i < 0) continue;
      const [item] = lane.waiting.splice(i, 1);
      const at = lane.waiting.findIndex((w) => !w.urgent);
      lane.waiting.splice(at === -1 ? lane.waiting.length : at, 0, { ...item!, urgent: true });
      if (lane.current) {
        lane.interruptedBy = requestId;
        lane.current.abort();
      }
      return true;
    }
    return false;
  }

  /** Drop one of your waiting requests before it starts. */
  cancelQueued(requestId: string): boolean {
    for (const lane of this.lanes.values()) {
      const i = lane.waiting.findIndex((w) => w.body.requestId === requestId && w.from === this.selfId);
      if (i < 0) continue;
      const [item] = lane.waiting.splice(i, 1);
      this.emitAgent(requestId, item!.from, 'error', 'Cancelled before it started', item!.body.channel);
      return true;
    }
    return false;
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
    if (body.project && body.channel === 'room' && !this.projectRoot(body.project)) {
      this.emitAgent(body.requestId, from, 'denied', `There is no project called ${body.project} on this computer.`, body.channel);
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
    const lane = this.lane(body.channel);
    if (this.sendFollowUp(lane, from, body)) return;
    const urgent = body.urgent && from === this.selfId;
    if (urgent) {
      // After earlier urgent messages (keeping your order), ahead of everything else in this conversation.
      const at = lane.waiting.findIndex((w) => !w.urgent);
      lane.waiting.splice(at === -1 ? lane.waiting.length : at, 0, { from, body, urgent: true });
      if (lane.current) {
        lane.interruptedBy = body.requestId;
        lane.current.abort();
      }
    } else {
      const queued = [...this.lanes.values()].reduce((n, l) => n + l.waiting.filter((w) => w.from === from).length, 0);
      if (queued >= MAX_QUEUED_PER_PERSON) {
        this.emitAgent(body.requestId, from, 'denied', 'Too many requests waiting; try again when the current ones finish.', body.channel);
        return;
      }
      lane.waiting.push({ from, body, ...(askTo ? { askTo } : {}) });
      if (lane.current || lane.waiting.length > 1) this.emitAgent(body.requestId, from, 'queued', 'Waiting for the current task to finish', body.channel);
    }
    void this.pump(lane);
  }

  /**
   * While the current run only waits on its background agents, send a message from the same
   * person straight into it instead of queueing behind it (or interrupting and killing them).
   * Someone else's message still queues: approvals in that run are judged for its requester.
   */
  private sendFollowUp(lane: Lane, from: string, body: BodyOf<'agent_request'>): boolean {
    // A request for one of your projects runs in that project's folder, so it never joins a run elsewhere.
    if (!lane.followUps || lane.runFrom !== from || body.plan || body.project) return false;
    const emit = (event: BodyOf<'agent_event'>['event'], text = ''): void => this.emitAgent(body.requestId, from, event, text, body.channel);
    const sent = lane.followUps({
      prompt: body.prompt,
      requesterName: peerName(this.store.getState(), from),
      viaAgent: body.viaAgent,
      context: this.recentChat(body.channel),
      onEvent: (kind, text) => emit(kind, text),
      onDone: (final) => emit('done', final || '(done)'),
      onError: (reason) => emit('error', reason),
    });
    if (sent) emit('started');
    return sent;
  }

  private async pump(lane: Lane): Promise<void> {
    if (lane.pumping) return;
    lane.pumping = true;
    try {
      for (let next = lane.waiting.shift(); next; next = lane.waiting.shift()) {
        while (this.running >= MAX_PARALLEL_RUNS) await new Promise((r) => setTimeout(r, 200));
        this.running++;
        try {
          await this.runAgent(next.from, next.body, lane, next.askTo).catch((err: unknown) => this.system(`Agent run failed: ${errorText(err)}`, 'error'));
        } finally {
          this.running--;
        }
      }
    } finally {
      lane.pumping = false;
    }
  }

  /** The main folder of one of your projects, by name. */
  private projectRoot(name: string): string | undefined {
    return this.deps.workspaces?.manager.list.find((p) => p.root && p.name === name)?.root;
  }

  private async authorizeRequest(from: string, body: BodyOf<'agent_request'>): Promise<boolean> {
    if (from === this.selfId) return true;
    const state = this.store.getState();
    const level = trustOf(state, from);
    if (level === 'blocked') return false;
    const name = peerName(state, from);
    // A project isn't a shared folder: working in one asks you unless you fully trust them.
    if (body.project && body.channel === 'room') {
      const scope = `${from}:${body.project}`;
      if (level === 'full' || this.alwaysProjects.has(scope)) return true;
      this.emitAgent(body.requestId, from, 'awaiting_approval', `Waiting for ${state.self?.name ?? 'owner'} to approve`, body.channel);
      const answer = await this.ask('request', `${name}${body.viaAgent ? "'s Claude" : ''} wants your Claude to work in ${body.project} (Always: for ${body.project}, until klaud quits)`, body.prompt, from);
      if (answer === 'always') this.alwaysProjects.add(scope);
      return answer !== 'no';
    }
    if (level === 'trusted' || level === 'full') return true;
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

  private async runAgent(from: string, body: BodyOf<'agent_request'>, lane: Lane, askTo = from): Promise<void> {
    const agent = this.agent as AgentBackend;
    const controller = new AbortController();
    lane.current = controller;
    lane.runFrom = from;
    const requesterName = peerName(this.store.getState(), from);
    const root = body.project && body.channel === 'room' ? this.projectRoot(body.project) : undefined;
    // A friend's request in your project gets a fresh conversation in its main folder.
    const place = root ? { cwd: root, additionalDirectories: [], autoEdit: false, onSession: () => undefined } : this.deps.workspaces?.place(body.channel);
    if (body.channel !== 'room' && !place) {
      this.emitAgent(body.requestId, from, 'error', 'That workspace is archived or missing.', body.channel);
      if (lane.current === controller) lane.current = undefined;
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
        canUseTool: (toolName, input) => this.authorizeTool(from, requesterName, toolName, input, body.channel, place?.cwd),
        askUser: (question) => this.deps.questions.ask(askTo, body.requestId, body.channel, question),
        plan: body.plan,
        onFollowUps: (send) => {
          lane.followUps = send;
          // Anything that queued up behind this run from the same person can go in now.
          if (send) lane.waiting = lane.waiting.filter((w) => !this.sendFollowUp(lane, w.from, w.body));
        },
        ...this.modelFor(place?.model),
      });
      if (controller.signal.aborted) throw new Error('aborted');
      this.emitAgent(body.requestId, from, 'done', final || '(done)', body.channel);
    } catch (err) {
      const reason = lane.interruptedBy ? 'Interrupted by a newer message' : controller.signal.aborted ? 'Stopped by owner' : errorText(err);
      lane.interruptedBy = undefined;
      this.emitAgent(body.requestId, from, 'error', reason, body.channel);
    } finally {
      if (lane.current === controller) {
        lane.current = undefined;
        lane.followUps = undefined;
        lane.runFrom = undefined;
      }
      lane.interruptedBy = undefined; // never carry an interrupt label into the next run
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

  private async authorizeTool(requester: string, requesterName: string, toolName: string, input: Record<string, unknown>, channel = 'room', cwd?: string): Promise<boolean> {
    // Your own Claude doesn't nag you (unless you asked it to); fully trusted friends don't either.
    const state = this.store.getState();
    if (requester === this.selfId && state.prefs.selfApproval === 'never') return true;
    if (requester !== this.selfId && trustOf(state, requester) === 'full') return true;
    // Invited by link to edit this project: as if you prompted, inside its folder (secrets were already refused).
    if (cwd && requester !== this.selfId && this.deps.canEditIn?.(requester, channel) && toolInside(toolName, input, cwd)) return true;
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
