import { randomBytes } from 'node:crypto';
import type { AgentBackend } from '../../agent/types.js';
import type { NoticeEvent } from '../notify.js';
import { type Action, type Store, peerName } from '../store.js';
import { type TrustLevel, defaultTrust } from '../trust.js';
import { TaskBook } from './book.js';
import { type GatewayState, type PeerCard, type TaskView, isFinal } from './model.js';
import { type Expects, type GatewayMsg, type Need, OFFERED, type PeerCardMsg, type TaskResult, type TaskUpdate } from './protocol.js';
import { describeForClaude, oneLine, resumePrompt } from './result.js';
import { validate } from './schema.js';
import { type Pending, type ServeShell, TaskServer, defaultScratch } from './serve.js';
import { Courier, type MeshPort, type RoomPort, type Via } from './transport.js';

/**
 * The gateway: tasks between Claudes. Your Claude (or you) asks a friend's Claude to do
 * something, or runs one command on their Mac; their klaud decides by their trust in you,
 * their Claude does the work and the result comes back to you only. If your Claude's turn
 * ended before the result arrived, a new turn starts in the same conversation with it, so the
 * work carries on (and can go on to ask the next person).
 *
 * Works over the klaud network (friends, mesh links, store-and-forward) and over today's rooms
 * (people in the same room). Tasks are kept in ~/.klaud/tasks/ on both sides.
 */

export interface GatewayDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly selfName: () => string;
  /** ~/.klaud/tasks (null: memory only). */
  readonly dir: string | null;
  /** Where scratch folders go when `dir` is null. */
  readonly scratch?: string;
  readonly agent: () => AgentBackend | undefined;
  /** Ask you (today's approval cards), with a way to take the question back. */
  readonly approve: (kind: 'request' | 'tool', title: string, detail: string, peer: string) => Pending;
  readonly setTrust: (peerId: string, level: TrustLevel) => void;
  /** Commands friends' tasks run here (PeerRun's gates: full trust runs, others ask, secrets never). */
  readonly serveShell?: ServeShell;
  /** Start a new turn of your Claude in a conversation, with this prompt (resume). */
  readonly resume: (channel: string, prompt: string) => void;
  readonly projectRoot: (name: string) => string | undefined;
  /** Your projects friends may name. */
  readonly projects: () => readonly string[];
  /** Your "Ask me for…" note, and saving it. */
  readonly loadNote: () => string;
  readonly saveNote: (note: string) => void;
  readonly notify?: (e: NoticeEvent) => void;
  readonly room?: () => RoomPort | undefined;
  /** How long a "Ask Alice's Claude?" card waits for you (default 10 minutes). */
  readonly confirmTimeoutMs?: number;
  readonly now?: () => number;
}

/** What your Claude (or you) asks for. */
export interface AskInput {
  /** A name (friend or someone in the room) or a peer id. */
  readonly person: string;
  readonly ask: string;
  readonly kind?: 'ask' | 'run';
  readonly needs?: readonly Need[];
  readonly project?: string;
  readonly expects?: Expects;
  readonly deadlineSec?: number;
  readonly command?: string;
  readonly cwd?: string;
  readonly timeoutSec?: number;
  readonly by: 'agent' | 'person';
  /** The conversation your Claude asks from (its answer continues there). */
  readonly conversation?: string;
}

/** Someone your Claude could ask, as who_can shows them. */
export interface Candidate {
  readonly name: string;
  readonly peerId: string;
  readonly via: 'friend' | 'room' | 'friend+room';
  readonly online: boolean;
  readonly status?: string;
  /** Your trust in them. */
  readonly your_trust: TrustLevel;
  /** Their trust in you, as they told you (unknown until their klaud says). */
  readonly their_trust?: TrustLevel;
  /** You'll be asked before your Claude contacts them. */
  readonly asks_you_first: boolean;
  readonly claude: boolean;
  readonly offers: readonly Need[];
  readonly projects: readonly string[];
  readonly ask_me_for?: string;
  /** Offers what you asked about (when you named a need). */
  readonly fits?: boolean;
}

/** A gateway mesh: the port, and a way to hear its frames and new links (see launch.ts). */
export interface MeshNode extends MeshPort {
  listen(handlers: { readonly frame: (from: string, payload: unknown) => void; readonly link: (peerId: string) => void }): () => void;
}

const TICK_MS = 10_000;
const DEFAULT_CONFIRM_MS = 10 * 60_000;
const MAX_STEPS = 12;

const taskId = (): string => `t_${randomBytes(9).toString('base64url')}`;
const isAgentFinal = (status: string): boolean => status === 'done' || status === 'error' || status === 'denied';

export class Gateway {
  readonly book: TaskBook;
  private readonly courier: Courier;
  private readonly server: TaskServer;
  private mesh: MeshNode | undefined;
  private readonly meshOff: Array<() => void> = [];
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly confirmTimers = new Map<string, NodeJS.Timeout>();
  /** Finished tasks whose result waits for your Claude's current run there to end. */
  private readonly toResume = new Set<string>();
  /** Results a wait_for picked up (it hands them to your Claude, so no new turn starts for them). */
  private readonly claimed = new Set<string>();
  private readonly told = new Map<string, string>();
  private readonly ticker: NodeJS.Timeout;
  private readonly offStore: Array<() => void> = [];
  private cardsQueued = false;
  private stopped = false;

  constructor(private readonly deps: GatewayDeps) {
    this.book = new TaskBook(deps.dir);
    this.courier = new Courier(this.book, { mesh: () => this.mesh, room: () => deps.room?.() });
    this.server = new TaskServer({
      book: this.book,
      courier: this.courier,
      isMe: (id) => id === deps.selfId() || id === this.mesh?.peerId,
      selfName: deps.selfName,
      trustFor: (id) => this.trustFor(id),
      nameOf: (id) => this.nameOf(id),
      put: (t) => this.put(t),
      agent: deps.agent,
      approve: deps.approve,
      setTrust: deps.setTrust,
      ...(deps.serveShell ? { serveShell: deps.serveShell } : {}),
      projectRoot: deps.projectRoot,
      model: () => {
        const prefs = deps.store.getState().prefs;
        return { ...(prefs.model ? { model: prefs.model } : {}), ...(prefs.effort ? { effort: prefs.effort } : {}) };
      },
      notify: (title, body) => deps.notify?.({ kind: 'people', title, body }),
      scratch: deps.scratch ?? defaultScratch(),
      now: () => this.now(),
    });
    // Tasks that were waiting on the other side when klaud quit are still there: keep waiting.
    // Received ones that were running here stopped with it.
    for (const t of this.book.all()) {
      if (t.direction === 'received' && !isFinal(t.state)) this.put({ ...t, state: 'failed', result: { status: 'failed', summary: 'klaud quit before it finished', files: [], log: t.steps }, endedAt: this.now(), updatedAt: this.now() });
      if (t.direction === 'sent' && t.state === 'confirm') this.put({ ...t, state: 'cancelled', result: { status: 'cancelled', summary: 'Not sent (klaud quit before you answered)', files: [], log: [] }, endedAt: this.now(), updatedAt: this.now() });
    }
    deps.store.dispatch({ type: 'gw_init', state: this.view() });
    this.offStore.push(deps.store.onAction((a) => this.onAction(a)));
    this.offStore.push(deps.store.subscribe(() => this.queueCards()));
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.ticker);
    for (const t of this.confirmTimers.values()) clearTimeout(t);
    for (const off of this.offStore) off();
    this.detachMesh();
    this.server.stop();
    for (const ws of this.waiters.values()) for (const w of ws) w();
    this.deps.store.dispatch({ type: 'gw_off' });
  }

  // ------------------------------------------------------------------ transports

  /** The klaud network came up: tasks go over friends' links too. */
  attachMesh(mesh: MeshNode): void {
    this.detachMesh();
    this.mesh = mesh;
    const off = mesh.listen({
      frame: (from, payload) => this.onFrame(from, 'mesh', payload),
      link: (peerId) => {
        this.courier.flush(peerId, true);
        this.told.delete(peerId);
        this.queueCards();
      },
    });
    this.meshOff.push(off);
    this.courier.flush(undefined, true);
    this.queueCards();
  }

  /** People came into (or left) the room: send what waits for them. */
  roomChanged(): void {
    this.courier.flush();
    this.queueCards();
  }

  detachMesh(): void {
    for (const off of this.meshOff.splice(0)) off();
    this.mesh = undefined;
  }

  /** A frame from someone in the room. */
  onRoomFrame(from: string, frame: unknown): void {
    this.onFrame(from, 'room', frame);
  }

  private onFrame(from: string, via: Via, raw: unknown): void {
    if (this.stopped || from === this.deps.selfId() || from === this.mesh?.peerId) return;
    // Over the network only friends get through; in a room, anyone in it (guests never reach here).
    if (via === 'mesh' && !this.mesh?.isFriend(from)) return;
    const msg = this.courier.receive(from, via, raw);
    if (msg) this.onMessage(from, msg);
  }

  private onMessage(from: string, msg: GatewayMsg): void {
    switch (msg.t) {
      case 'task_request':
        void this.server.onRequest(from, msg);
        return;
      case 'task_cancel':
        this.server.onCancel(from, msg);
        return;
      case 'task_update':
        this.onUpdate(from, msg);
        return;
      case 'task_result':
        this.onResult(from, msg);
        return;
      case 'card':
        this.onCard(from, msg);
        return;
    }
  }

  // ------------------------------------------------------------------ asking

  /** Ask someone's Claude (or run a command on their Mac). Returns the task at once. */
  ask(input: AskInput): TaskView {
    const peer = this.resolve(input.person);
    const kind = input.kind ?? 'ask';
    if (kind === 'run' && !input.command) throw new Error('Say which command to run');
    const ask = (input.ask || input.command || '').trim();
    if (!ask) throw new Error('Say what to ask');
    if (input.expects && input.expects !== 'files' && validateSchema(input.expects)) throw new Error(`The expects schema isn't usable: ${validateSchema(input.expects)}`);
    const level = this.trustFor(peer.peerId);
    const confirm = input.by === 'agent' && level !== 'trusted' && level !== 'full';
    const now = this.now();
    const task = this.put({
      id: taskId(),
      direction: 'sent',
      peerId: peer.peerId,
      peerName: peer.name,
      kind,
      ask,
      needs: [...new Set(input.needs ?? (kind === 'run' ? ['shell'] : []))] as Need[],
      by: input.by,
      state: confirm ? 'confirm' : 'sent',
      steps: [],
      createdAt: now,
      updatedAt: now,
      ...(input.project ? { project: input.project } : {}),
      ...(input.expects ? { expects: input.expects } : {}),
      ...(input.deadlineSec ? { deadline: now + input.deadlineSec * 1000 } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.timeoutSec ? { timeoutSec: input.timeoutSec } : {}),
      ...(input.conversation ? { conversation: input.conversation } : {}),
    });
    if (confirm) {
      this.deps.notify?.({ kind: 'needsYou', tag: 'approval', title: `Your Claude wants to ask ${peer.name}${kind === 'run' ? `’s Mac to run a command` : '’s Claude'}`, body: oneLine(ask, 140), ...(input.conversation ? { channel: input.conversation } : {}) });
      const timer = setTimeout(() => this.confirm(task.id, false, undefined, 'Not sent: nobody answered in time'), this.deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_MS);
      timer.unref();
      this.confirmTimers.set(task.id, timer);
    } else this.transmit(task);
    return this.book.get(task.id) ?? task;
  }

  /** Your answer on the "Ask Alice's Claude?" card: send it (maybe reworded), or not now. */
  confirm(id: string, yes: boolean, edited?: string, why?: string): TaskView {
    const task = this.need(id);
    if (task.direction !== 'sent' || task.state !== 'confirm') throw new Error('That request is not waiting for you');
    clearTimeout(this.confirmTimers.get(id));
    this.confirmTimers.delete(id);
    if (!yes) return this.finishLocal(task, 'cancelled', why ?? `Not sent: ${this.deps.selfName()} said not now`);
    const ask = edited?.trim() ? edited.trim().slice(0, 16_000) : task.ask;
    const sent = this.put({ ...task, ask, state: 'sent', updatedAt: this.now() });
    this.transmit(sent);
    return this.book.get(id) ?? sent;
  }

  /** Cancel a task you sent (or stop one a friend sent you). */
  cancel(id: string): TaskView {
    const task = this.need(id);
    if (isFinal(task.state)) return task;
    if (task.direction === 'received') {
      this.server.stopTask(id);
      return this.book.get(id) ?? task;
    }
    if (task.state === 'confirm') return this.confirm(id, false, undefined, 'Cancelled before it was sent');
    const waiting = this.book.waiting(task.peerId).some((o) => 'm' in o.frame && o.frame.m.t === 'task_request' && o.frame.m.id === id);
    if (waiting) this.book.dropTask(id);
    else this.courier.send(task.peerId, { t: 'task_cancel', id, ts: this.now() }, true);
    return this.finishLocal(task, 'cancelled', waiting ? 'Cancelled before it reached them' : 'Cancelled by you');
  }

  get(id: string): TaskView | undefined {
    return this.book.get(id);
  }

  /** Wait until the task has a result, or `timeoutMs` passes; `onChange` hears every step. */
  wait(id: string, timeoutMs: number, onChange?: (task: TaskView) => void): Promise<TaskView> {
    const first = this.need(id);
    if (isFinal(first.state)) return Promise.resolve(first);
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const done = (): void => {
        clearTimeout(timer);
        set.delete(check);
        if (!set.size) this.waiters.delete(id);
        resolve(this.book.get(id) ?? first);
      };
      const check = (): void => {
        const t = this.book.get(id);
        if (!t) return done();
        onChange?.(t);
        if (isFinal(t.state)) this.claimed.add(id);
        if (isFinal(t.state) || this.stopped) done();
      };
      const timer = setTimeout(done, Math.max(0, timeoutMs));
      timer.unref?.();
      set.add(check);
    });
  }

  /** The result as your Claude reads it (and it's then counted as given to it). */
  describe(id: string): string {
    const task = this.need(id);
    if (task.result) this.markDelivered(task);
    return describeForClaude(this.book.get(id) ?? task);
  }

  // ------------------------------------------------------------------ people

  /** Everyone your Claude could ask: friends and people in the room, with what they offer. */
  whoCan(need?: Need): Candidate[] {
    const state = this.deps.store.getState();
    const self = this.deps.selfId();
    const friends = state.network.enabled ? state.network.friends : [];
    const inRoom = state.peers.filter((p) => p.peerId !== self && !p.guest);
    const ids = [...new Set([...friends.map((f) => f.peerId), ...inRoom.map((p) => p.peerId)])];
    return ids.map((id) => {
      const friend = friends.find((f) => f.peerId === id);
      const room = inRoom.find((p) => p.peerId === id);
      const card = state.gateway.cards[id];
      const yours = this.trustFor(id);
      const theirs = card?.trust ?? state.granted[id]?.level;
      const offers = card?.offers ?? (room?.agent ? OFFERED : []);
      const status = friend ? `${friend.presence.state}${friend.presence.note ? ` · ${friend.presence.note}` : ''}` : undefined;
      return {
        name: friend?.name ?? room?.name ?? 'someone',
        peerId: id,
        via: friend && room ? 'friend+room' : friend ? 'friend' : 'room',
        online: Boolean(friend?.online || room),
        ...(status ? { status } : {}),
        your_trust: yours,
        ...(theirs ? { their_trust: theirs } : {}),
        asks_you_first: yours !== 'trusted' && yours !== 'full',
        claude: card?.claude ?? Boolean(room?.agent),
        offers,
        projects: card?.projects ?? room?.projects ?? [],
        ...(card?.note ? { ask_me_for: card.note } : {}),
        ...(need ? { fits: offers.includes(need) && theirs !== 'blocked' } : {}),
      } satisfies Candidate;
    });
  }

  /** Your "Ask me for…" note (what other Claudes see on your card). */
  setNote(note: string): void {
    const clean = note.replace(/\s+/g, ' ').trim().slice(0, 280);
    this.deps.saveNote(clean);
    this.deps.store.dispatch({ type: 'gw_note', note: clean });
    this.told.clear();
    this.queueCards();
  }

  // ------------------------------------------------------------------ inside

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private need(id: string): TaskView {
    const task = this.book.get(id);
    if (!task) throw new Error(`No task ${id}`);
    return task;
  }

  private view(): GatewayState {
    return { enabled: true, tasks: this.book.all(), cards: this.book.allCards(), note: this.deps.loadNote() };
  }

  /** Save a task, show it, and wake whoever waits on it. */
  private put(task: TaskView): TaskView {
    this.book.put(task);
    this.deps.store.dispatch({ type: 'gw_task', task });
    for (const w of [...(this.waiters.get(task.id) ?? [])]) w();
    return task;
  }

  /** Your trust in someone: chosen in the room, remembered from before, or your default. */
  trustFor(peerId: string): TrustLevel {
    const state = this.deps.store.getState();
    if (peerId === this.deps.selfId()) return 'full';
    return state.levels[peerId] ?? state.remembered[peerId]?.trust ?? defaultTrust(state);
  }

  /** Who you are to this person: your network address's id for friends (the same as in rooms, except in the demo). */
  private idFor(peerId: string): string {
    return this.mesh?.isFriend(peerId) ? this.mesh.peerId : this.deps.selfId();
  }

  nameOf(peerId: string): string {
    const state = this.deps.store.getState();
    const friend = state.network.friends.find((f) => f.peerId === peerId)?.name;
    if (friend) return friend;
    if (state.peers.some((p) => p.peerId === peerId)) return peerName(state, peerId);
    return this.mesh?.nameFor(peerId) ?? this.book.all().find((t) => t.peerId === peerId)?.peerName ?? peerId.slice(0, 6);
  }

  /** Someone by name (friends first, then the room) or by peer id. */
  private resolve(person: string): { peerId: string; name: string } {
    const wanted = person.trim().replace(/^@/, '').toLowerCase();
    const people = this.whoCan();
    const hit = people.find((p) => p.peerId === person.trim()) ?? people.find((p) => p.name.toLowerCase() === wanted && p.via !== 'room') ?? people.find((p) => p.name.toLowerCase() === wanted);
    if (!hit) throw new Error(`Nobody called "${person}" among your friends or the people in this room. Call who_can to see who's there.`);
    if (!this.courier.knows(hit.peerId)) throw new Error(`${hit.name} can't be reached`);
    return { peerId: hit.peerId, name: hit.name };
  }

  private transmit(task: TaskView): void {
    const sentNow = this.courier.send(
      task.peerId,
      {
        t: 'task_request',
        id: task.id,
        from: this.idFor(task.peerId),
        to: task.peerId,
        kind: task.kind,
        ask: task.ask,
        needs: [...task.needs],
        by: task.by,
        ts: this.now(),
        ...(task.project ? { project: task.project } : {}),
        ...(task.expects ? { expects: task.expects } : {}),
        ...(task.deadline ? { deadline: task.deadline } : {}),
        ...(task.command ? { command: task.command } : {}),
        ...(task.cwd ? { cwd: task.cwd } : {}),
        ...(task.timeoutSec ? { timeoutSec: task.timeoutSec } : {}),
      },
      true,
    );
    if (!sentNow) this.put({ ...task, steps: [...task.steps, `${task.peerName} is offline: it goes out when they're back`].slice(-MAX_STEPS), updatedAt: this.now() });
  }

  private finishLocal(task: TaskView, status: 'cancelled' | 'failed', summary: string): TaskView {
    return this.put({ ...task, state: status, result: { status, summary, files: [], log: task.steps }, endedAt: this.now(), updatedAt: this.now(), delivered: task.delivered ?? false });
  }

  private onUpdate(from: string, msg: TaskUpdate): void {
    const task = this.book.get(msg.id);
    if (!task || task.direction !== 'sent' || task.peerId !== from || isFinal(task.state) || task.state === 'confirm') return;
    this.put({ ...task, state: msg.state, ...(msg.step ? { steps: [...task.steps, msg.step].slice(-MAX_STEPS) } : {}), ...(msg.state === 'working' && !task.startedAt ? { startedAt: this.now() } : {}), updatedAt: this.now() });
  }

  private onResult(from: string, msg: TaskResult): void {
    const task = this.book.get(msg.id);
    // Only the person it was sent to answers it, once.
    if (!task || task.direction !== 'sent' || task.peerId !== from || isFinal(task.state) || task.state === 'confirm') return;
    const files = this.book.saveFiles(task.id, msg.files, this.deps.scratch ?? defaultScratch());
    const problems = task.expects && task.expects !== 'files' && msg.status === 'done' ? (msg.data === undefined ? ['No structured data came back'] : validate(msg.data, task.expects)) : task.expects === 'files' && msg.status === 'done' && !files.some((f) => f.path) ? ['No files came back'] : [];
    const done = this.put({
      ...task,
      state: msg.status,
      result: {
        status: msg.status,
        summary: msg.summary,
        files,
        log: msg.log,
        ...(msg.data !== undefined ? { data: msg.data } : {}),
        ...(task.expects && msg.status === 'done' ? { valid: problems.length === 0 } : {}),
        ...(problems.length ? { problems } : {}),
      },
      endedAt: this.now(),
      updatedAt: this.now(),
    });
    this.announce(done);
    this.settle(done);
  }

  private announce(task: TaskView): void {
    const who = task.kind === 'run' ? `Your command on ${task.peerName}'s Mac` : `${task.peerName}'s Claude`;
    const verb = task.state === 'done' ? (task.kind === 'run' ? 'finished' : 'replied') : task.state === 'declined' ? 'was declined' : task.state === 'cancelled' ? 'was cancelled' : 'failed';
    this.deps.notify?.({ kind: task.state === 'done' ? 'done' : 'problems', title: `${who} ${verb}`, body: oneLine((task.result?.summary ?? task.ask).replace(/[*_`#>]/g, ''), 140), ...(task.conversation ? { channel: task.conversation } : {}) });
  }

  private markDelivered(task: TaskView): void {
    this.toResume.delete(task.id);
    this.claimed.delete(task.id);
    if (!task.delivered) this.put({ ...task, delivered: true });
  }

  /** A result arrived: whoever waits for it gets it; else your Claude continues with it. */
  private settle(task: TaskView): void {
    if (task.by !== 'agent' || !task.conversation || task.delivered) return;
    // A wait_for is waiting: it hands the result to Claude (see describe).
    if (this.claimed.has(task.id) || this.waiters.get(task.id)?.size) return;
    if (this.busy(task.conversation)) {
      this.toResume.add(task.id);
      return;
    }
    this.resume(task);
  }

  private resume(task: TaskView): void {
    const current = this.book.get(task.id) ?? task;
    if (current.delivered || !current.conversation) return;
    this.markDelivered(current);
    this.deps.resume(current.conversation, resumePrompt(current));
  }

  /** Your Claude is working (or about to) in this conversation. */
  private busy(channel: string): boolean {
    const self = this.deps.selfId();
    return this.deps.store.getState().log.some((l) => l.type === 'agent' && l.channel === channel && l.owner === self && !isAgentFinal(l.status));
  }

  private onAction(action: Action): void {
    // A run of yours ended: results it didn't pick up start the next turn.
    if (action.type !== 'agent_event' || action.owner !== this.deps.selfId() || !isAgentFinal(action.event) || !this.toResume.size) return;
    setImmediate(() => {
      for (const id of [...this.toResume]) {
        const task = this.book.get(id);
        if (!task?.conversation) {
          this.toResume.delete(id);
          continue;
        }
        if (task.conversation === (action.channel ?? 'room') && !this.busy(task.conversation)) {
          this.toResume.delete(id);
          if (this.claimed.has(id) || this.waiters.get(id)?.size) continue;
          this.resume(task);
        }
      }
    });
  }

  private onCard(from: string, msg: PeerCardMsg): void {
    const card: PeerCard = { trust: msg.trust, offers: msg.offers, projects: msg.projects, claude: msg.claude, at: this.now(), ...(msg.note ? { note: msg.note } : {}) };
    this.book.putCard(from, card);
    this.deps.store.dispatch({ type: 'gw_card', peerId: from, card });
  }

  /** Tell everyone reachable what you offer them (when it changed, or they just came online). */
  private queueCards(): void {
    if (this.cardsQueued || this.stopped) return;
    this.cardsQueued = true;
    setImmediate(() => {
      this.cardsQueued = false;
      if (!this.stopped) this.tellCards();
    });
  }

  private tellCards(): void {
    const state = this.deps.store.getState();
    const self = this.deps.selfId();
    const people = new Set([...(state.network.enabled ? state.network.friends.filter((f) => f.online).map((f) => f.peerId) : []), ...state.peers.filter((p) => p.peerId !== self && !p.guest).map((p) => p.peerId)]);
    for (const id of [...this.told.keys()]) if (!people.has(id)) this.told.delete(id);
    const note = state.gateway.note;
    const projects = this.deps.projects().slice(0, 60);
    const claude = Boolean(this.deps.agent());
    for (const id of people) {
      if (!this.courier.reach(id)) continue;
      const trust = this.trustFor(id);
      const card: PeerCardMsg = { t: 'card', trust, offers: trust === 'blocked' ? [] : [...OFFERED], projects: trust === 'blocked' ? [] : [...projects], claude, ...(note ? { note } : {}) };
      const key = JSON.stringify(card);
      if (this.told.get(id) === key) continue;
      if (this.courier.send(id, card, false)) this.told.set(id, key);
    }
  }

  private tick(): void {
    if (this.stopped) return;
    for (const gone of this.book.expire(this.now())) {
      if (!('m' in gone.frame) || gone.frame.m.t !== 'task_request') continue;
      const task = this.book.get(gone.frame.m.id);
      if (task && !isFinal(task.state)) this.finishLocal(task, 'failed', `${task.peerName} didn't come online in time`);
    }
    this.courier.flush();
    this.queueCards();
  }
}

/** Why a schema can't be used (undefined: it can). */
function validateSchema(schema: Readonly<Record<string, unknown>>): string | undefined {
  try {
    if ((JSON.stringify(schema) ?? '').length > 8_000) return 'too large';
    validate(null, schema);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
