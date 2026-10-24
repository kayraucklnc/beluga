import * as Device from 'expo-device';
import { toB64, utf8 } from '../../b64';
import {
  COMPANION_PIECE,
  COMPANION_PROTO,
  type ConvSummary,
  type ConvView,
  type HomeView,
  type MacFrame,
  type NeedsYou,
  type OutputView,
  type PhoneFrame,
  type PlansView,
  type PlanView,
  type TasksView,
  type Topic,
  type TurnView,
  VIEW_COALESCE_MS,
} from '../protocol';
import type { DeviceSecret, LinkPhase } from '../rpc';
import { Emitter, type PairInput, type PairStep, type Transport } from '../transport';
import { type DemoWorld, e2eLine, makeWorld, ref, turn } from './data';
import { demoRows } from './render-demo';
import type { ViewQuery } from '../../render';
import { DEMO_IMAGES } from './images.generated';

/**
 * A Mac inside the app, for exploring without one: it answers the protocol exactly as
 * src/companion/host.ts does (welcome, views of the subscribed topics coalesced to one per 500 ms,
 * results, file chunks, nudges), and its world moves: the tests tick, sub-agents finish and hand
 * in pictures, friends write back, what you approve goes away.
 *
 * It can also fall asleep (Settings › Demo), to show the cached views and the outbox.
 */
export const DEMO_MAC = { name: 'MacBook Pro', version: '0.11.0' };
/**
 * You, in the demo: the phone owner's name when the phone's own name gives it ("Mia's Galaxy" →
 * Mia), else no name (Home then just says hello).
 */
export const DEMO_ME = { name: ownerName(Device.deviceName), peerId: 'you-7f3a' };
export function ownerName(deviceName: string | null | undefined): string {
  const m = /^\s*([\p{L}][\p{L}'-]{0,30})['’]s\s/u.exec(deviceName ?? '');
  return m ? m[1]! : '';
}

export class DemoTransport implements Transport {
  readonly kind = 'demo' as const;
  private world: DemoWorld = makeWorld();
  private readonly frames = new Emitter<[MacFrame]>();
  private readonly phases = new Emitter<[LinkPhase, string?]>();
  private open_ = false;
  private asleep = false;
  private subs = new Set<Topic>();
  private readonly revs = new Map<string, number>();
  private readonly sentHash = new Map<string, string>();
  private readonly dirty = new Set<Topic>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private e2e = 137;
  private readonly uploads = new Map<string, OutputView>();
  private readonly puts = new Map<number, { name: string; mime: string; parts: string[] }>();
  private convSeq = 0;

  /** Let the demo Mac sleep (it stops answering) or wake. */
  setAsleep(asleep: boolean): void {
    this.asleep = asleep;
    if (asleep && this.open_) {
      this.stopLive();
      this.open_ = false;
      this.phases.emit('unreachable', 'Your Mac is asleep');
    }
  }
  get sleeping(): boolean {
    return this.asleep;
  }

  open(hello: PhoneFrame & { t: 'hello' }): void {
    if (this.open_) return;
    this.phases.emit('dialing');
    this.later(this.asleep ? 2200 : 650, () => {
      if (this.asleep) {
        this.phases.emit('unreachable', 'Your Mac is asleep');
        return;
      }
      this.open_ = true;
      this.subs = new Set(hello.topics);
      this.sentHash.clear();
      for (const t of this.subs) this.dirty.add(t);
      this.phases.emit('open');
      this.frames.emit({ t: 'welcome', v: { ...COMPANION_PROTO }, min: { major: 1, minor: 0 }, mac: DEMO_MAC, me: DEMO_ME });
      this.flush();
      this.startLive();
    });
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.stopLive();
    this.phases.emit('closed');
  }

  send(frame: PhoneFrame): void {
    if (!this.open_) return;
    switch (frame.t) {
      case 'sub':
        this.subs = new Set(frame.topics);
        for (const t of frame.topics) if (!this.sentHash.has(t)) this.dirty.add(t);
        this.schedule();
        return;
      case 'call':
        // A little latency, as over a real link.
        this.later(180 + Math.random() * 220, () => this.call(frame.id, frame.method, frame.args));
        return;
      case 'get':
        this.later(120 + Math.random() * 200, () => this.get(frame.id, frame.ref, frame.variant, frame.off));
        return;
      case 'put':
        this.later(40, () => this.put(frame));
        return;
      case 'bye':
        this.close();
        return;
      default:
        return;
    }
  }

  onFrame(listener: (frame: MacFrame) => void): () => void {
    return this.frames.on(listener);
  }
  onPhase(listener: (phase: LinkPhase, detail?: string) => void): () => void {
    return this.phases.on(listener);
  }

  pair(input: PairInput, onStep: (step: PairStep) => void): { cancel(): void } {
    let cancelled = false;
    const secret: DeviceSecret = { seed: Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('') };
    onStep({ step: 'dialing' });
    const t1 = setTimeout(() => !cancelled && onStep({ step: 'waiting', fingerprint: '🐋 🌵 🎈 🦊' }), 1100);
    const t2 = setTimeout(
      () =>
        !cancelled &&
        onStep({ step: 'paired', secret, pairing: { cert: { v: 1, owner: DEMO_ME.peerId, name: input.name, platform: input.platform, demo: true }, address: '0'.repeat(64), macName: DEMO_MAC.name, me: DEMO_ME.name } }),
      4200,
    );
    return {
      cancel: () => {
        cancelled = true;
        clearTimeout(t1);
        clearTimeout(t2);
      },
    };
  }

  dispose(): void {
    this.stopLive();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.frames.clear();
    this.phases.clear();
  }

  // ---- views

  private view(topic: Topic): unknown {
    const w = this.world;
    if (topic === 'home') return this.home();
    // Your Mac isn't a project: Home and the Ask sheet have it (1.5).
    if (topic === 'work') return { projects: w.projects.map((p) => ({ id: p.id, name: p.name, conversations: p.convs.map((t) => this.summary(w.convs.get(t)!)), ...(w.icons[p.id] ? { icon: w.icons[p.id]!.sum } : {}) })) };
    if (topic === 'tasks') return this.tasks();
    if (topic.startsWith('task:')) return w.tasks.find((t) => t.topic === topic);
    if (topic === 'plans') return { plans: w.plans.map((p) => ({ id: p.id, title: p.title, state: p.state, topic: p.topic, ...count(p) })) } satisfies PlansView;
    if (topic === 'chats') return { chats: [...w.chats].map(([t, c]) => ({ topic: t, name: c.name, kind: c.kind, last: lastLine(c.messages.at(-1)), lastAt: c.messages.at(-1)?.ts, unread: c.unread })).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)) };
    if (topic === 'people') return { people: w.people };
    if (topic.startsWith('conv:')) {
      const c = w.convs.get(topic);
      if (!c) return undefined;
      const merge = w.merges.get(topic);
      const outputs = c.turns.flatMap(allOutputs).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
      return { ...c, needsYou: w.needs.filter((n) => n.topic === topic), ...this.projectOf(c), outputs, ...(c.topic.startsWith('conv:beluga.') ? { mergeable: true } : {}), ...(merge ? { merge } : {}) };
    }
    if (topic.startsWith('plan:')) {
      const p = w.plans.find((x) => x.id === topic.slice(5));
      return p ? { ...p, needsYou: w.needs.filter((n) => n.topic === topic) } : undefined;
    }
    if (topic.startsWith('chat:')) {
      const c = w.chats.get(topic);
      return c ? { topic, name: c.name, kind: c.kind, messages: c.messages, more: false, live: c.peer === 'mia' ? ['Mia'] : [], members: this.membersOf(topic) } : undefined;
    }
    return undefined;
  }

  private home(): HomeView {
    const w = this.world;
    const review = w.tasks.filter((t) => t.status === 'in_review');
    const assistant = w.convs.get('conv:mac:assistant');
    return {
      mac: DEMO_MAC,
      me: DEMO_ME,
      ...(assistant ? { assistant: this.summary(assistant) } : {}),
      usage: w.usage,
      needsYou: w.needs,
      running: [...w.convs.values()].filter((c) => c.working || w.needs.some((n) => n.topic === c.topic)).map((c) => this.summary(c)),
      // Outputs live with their conversation (1.3); Home hints at new ones per worktree.
      outputs: [],
      unread: { work: 1, chats: [...w.chats.values()].reduce((n, c) => n + c.unread, 0) },
      ...(review.length ? { review: { count: review.length, first: { topic: review[0]!.topic, key: review[0]!.key, title: review[0]!.title } } } : {}),
    };
  }

  /** A conversation's project and its icon (the demo names its projects by id). */
  private projectOf(c: ConvView): { projectId?: string; icon?: string } {
    const p = this.world.projects.find((x) => x.convs.includes(c.topic));
    if (!p || p.id === 'asked') return {};
    const icon = this.world.icons[p.id]?.sum;
    return { projectId: p.id, ...(icon ? { icon } : {}) };
  }

  /** The board by project and status, as views.ts groups it. */
  private tasks(): TasksView {
    const order = ['in_progress', 'in_review', 'todo', 'backlog', 'done'];
    const label: Record<string, string> = { in_progress: 'In Progress', in_review: 'In Review', todo: 'Ready', backlog: 'Backlog', done: 'Done' };
    const projects = this.world.projects.filter((p) => this.world.tasks.some((t) => t.projectId === p.id));
    return {
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        ...(this.world.icons[p.id] ? { icon: this.world.icons[p.id]!.sum } : {}),
        groups: order
          .map((status) => ({ status, label: label[status]!, tasks: this.world.tasks.filter((t) => t.projectId === p.id && t.status === status).map(({ id, topic, key, title, status: st, priority, assignee, checks, conv, pr, updatedAt }) => ({ id, topic, key, title, status: st, priority, updatedAt, ...(assignee ? { assignee } : {}), ...(checks ? { checks } : {}), ...(conv ? { conv } : {}), ...(pr ? { pr: { number: pr.number, state: pr.state } } : {}) })) }))
          .filter((g) => g.tasks.length),
      })),
    };
  }

  private summary(c: ConvView): ConvSummary {
    const last = c.turns.at(-1);
    const waiting = this.world.needs.some((n) => n.topic === c.topic);
    const agents = last?.subagents?.filter((a) => a.status === 'running').length ?? 0;
    const since = [...c.turns].reverse().find((t) => t.who === 'claude')?.ts ?? 0;
    const fresh = c.turns.flatMap(allOutputs).filter((o) => (o.ts ?? 0) >= since).length;
    return {
      ...this.projectOf(c),
      ...(fresh ? { fresh } : {}),
      topic: c.topic,
      title: c.title,
      project: c.project,
      status: c.working ? 'working' : waiting ? 'waiting' : last?.status === 'failed' ? 'failed' : 'idle',
      last: (c.working ? last?.step : undefined) ?? stripMarkers((last?.prose.text ?? '').replace(/`(worktree|plan):([\w-]+)`/g, (_m, kind: string, id: string) => (kind === 'worktree' ? this.world.convs.get(`conv:ws:${id}`)?.title : this.world.plans.find((p) => p.id === id)?.title) ?? id)),
      lastAt: last?.ts,
      needsYou: waiting,
      agents: agents || undefined,
      unread: c.topic === 'conv:weather.radar' ? 1 : undefined,
    };
  }

  /** Mark topics changed; the subscribed ones go out coalesced (VIEW_COALESCE_MS). */
  private touch(...topics: Topic[]): void {
    for (const t of topics) this.dirty.add(t);
    this.dirty.add('home');
    this.schedule();
  }
  private schedule(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, VIEW_COALESCE_MS);
  }
  private flush(): void {
    if (!this.open_) return;
    for (const topic of [...this.dirty]) {
      if (!this.subs.has(topic)) continue;
      this.dirty.delete(topic);
      const data = this.view(topic);
      if (data === undefined) continue;
      const json = JSON.stringify(data);
      if (this.sentHash.get(topic) === json) continue;
      this.sentHash.set(topic, json);
      const rev = (this.revs.get(topic) ?? 0) + 1;
      this.revs.set(topic, rev);
      this.frames.emit({ t: 'view', topic, rev, data });
    }
  }

  // ---- calls

  private result(id: number, value: unknown): void {
    this.frames.emit({ t: 'result', id, ok: true, value });
  }

  /** The needs-you item a call answers: the one whose buttons or template make that call. */
  private needFor(method: string, args: readonly unknown[]): NeedsYou | undefined {
    const key = JSON.stringify(args[0]);
    return this.world.needs.find((n) => [...n.actions, ...(n.answer ? [n.answer] : [])].some((a) => a.method === method && JSON.stringify(a.args[0]) === key && (method !== 'network.groups.approve' && method !== 'network.groups.decline' ? true : JSON.stringify(a.args[1]) === JSON.stringify(args[1]))));
  }

  private resolve(item: NeedsYou | undefined): void {
    if (!item) return;
    const w = this.world;
    w.needs = w.needs.filter((n) => n.id !== item.id);
    this.touch(...(item.topic ? [item.topic] : []), 'plans');
  }

  private call(id: number, method: string, args: readonly unknown[]): void {
    if (!this.open_) return;
    const w = this.world;
    const str = (i: number): string => (typeof args[i] === 'string' ? (args[i] as string) : '');
    const ok = (value: unknown = null) => this.result(id, value);
    const item = this.needFor(method, args);
    switch (method) {
      // ---- what needs you (the calls views.ts puts on the buttons)
      case 'host.answerApproval':
        this.resolve(item);
        if (item?.id === 'n-deploy' && args[0] !== 'no') this.deploy();
        return ok();
      case 'gateway.decide':
        this.resolve(item);
        if (item?.id === 'n-mia' && (args[1] as { answer?: string })?.answer !== 'no') this.later(1800, () => this.chatReply('chat:dm:mia', "Mia's Claude", 'Got it, thank you! Sending Mia the screenshot now.', true));
        return ok();
      case 'gateway.answer':
      case 'gateway.confirm':
      case 'invites.letIn':
      case 'invites.decline':
      case 'network.groups.approve':
      case 'network.groups.decline':
      case 'plans.approve':
      case 'plans.discard':
      case 'plans.recheck':
        this.resolve(item);
        return ok();
      case 'plans.pass':
      case 'plans.sendBack': {
        this.resolve(item);
        const m1 = w.plans[0]?.milestones[0];
        if (m1 && method === 'plans.sendBack') {
          m1.state = 'running';
          this.touch('plan:phones', 'plans');
        }
        return ok();
      }
      case 'questions.pick':
      case 'questions.answer': {
        this.resolve(item);
        const a = args[1] as { kind?: string; answers?: Record<string, string> } | undefined;
        const picked = a?.answers ? Object.values(a.answers).filter(Boolean).join(', ') : '';
        if (item?.id === 'n-empty') this.claudeSays('conv:beluga.onboarding', picked ? `Going with "${picked}". I'll draw it next.` : "Skipped: I'll keep the current empty state.");
        if (item?.id === 'n-checks') this.claudeSays('conv:beluga.onboarding', picked ? `Before the build ships I'll run: ${picked}.` : "Skipped: I'll run the usual checks.");
        if (item?.id === 'n-plan' && a?.kind === 'answers') {
          const plan = w.plans[0]!;
          plan.milestones[3]!.state = 'running';
          plan.milestones[3]!.tasks[0]!.state = 'running';
          this.touch('plan:phones', 'plans');
        }
        return ok();
      }

      // ---- asking, writing, stopping
      case 'companion.ask': {
        const a = args[0] as { target: { project?: string; topic?: string }; text: string; files?: string[] };
        const files = (a.files ?? []).map((r) => this.uploads.get(r)).filter((v): v is OutputView => !!v);
        return ok({ topic: this.submit(a.text, a.target, files) });
      }
      case 'companion.askPerson': {
        const a = args[0] as { peerId: string; text: string; needs?: string[] };
        const person = w.people.find((p) => p.peerId === a.peerId);
        if (!person) return this.frames.emit({ t: 'result', id, ok: false, error: 'Not a friend.' });
        return ok(this.askPerson(person.name, a.text, a.needs?.includes('screen') ?? false));
      }
      case 'companion.post': {
        const a = args[0] as { conversation: string; text: string; files?: string[]; ask?: unknown };
        const topic = `chat:${a.conversation}` as Topic;
        const chat = w.chats.get(topic);
        if (chat) {
          const files = (a.files ?? []).map((r) => this.uploads.get(r)).filter((v): v is OutputView => !!v);
          chat.messages = [...chat.messages, { id: `m${Date.now()}`, from: 'You', mine: true, text: a.text, ts: Date.now(), ...(files.length ? { files } : {}) }];
          chat.unread = 0;
          this.touch(topic, 'chats');
          const who = chat.kind === 'dm' ? chat.name : 'Ada';
          if (a.ask) {
            // Only the Claudes asked answer: yours, one person's, or everyone's.
            const members = this.membersOf(topic);
            const asked = a.ask === 'all' ? members : members.filter((m) => (a.ask as string[]).includes(m.peerId));
            asked.forEach((m, i) =>
              this.later(2200 + i * 1400, () =>
                this.chatReply(topic, m.me ? 'Your Claude' : `${m.name}'s Claude`, m.me ? 'From your Mac: the radar fix is merged on main and the phone build passed.' : `From ${m.name}'s Mac: the radar build there is from this morning, with the cross-fade in. Tests pass.`, true),
              ),
            );
          }
          else this.later(2400, () => this.chatReply(topic, who, files.length ? 'oh nice photo 😍' : pick(['ha, nice', 'on it 👍', 'can you send a screenshot?', 'looks great from here', 'ok, give me 5 min'])));
        }
        return ok();
      }
      case 'host.stopRun': {
        const c = w.convs.get(`conv:${str(0)}`);
        const last = c?.turns.at(-1);
        if (c && last?.status === 'working') {
          c.turns = [...c.turns.slice(0, -1), { ...last, status: 'stopped', step: undefined, endTs: Date.now(), subagents: last.subagents?.map((x) => (x.status === 'running' ? { ...x, status: 'failed' as const } : x)) }];
          c.working = false;
          this.touch(c.topic, 'work');
        }
        return ok({ stopped: true, returned: [] });
      }
      case 'network.read': {
        const chat = w.chats.get(`chat:${str(0)}` as Topic);
        if (chat) {
          chat.unread = 0;
          this.touch('chats');
        }
        return ok();
      }
      case 'companion.older':
        return ok({ turns: [], more: false });

      // ---- steer and queue while Claude works (session.submit, as the Mac's composer)
      case 'session.submit': {
        const text = str(0);
        const opts = (args[1] ?? {}) as { channel?: string; urgent?: boolean };
        const c = w.convs.get(`conv:${opts.channel ?? ''}`);
        if (!c) return ok();
        if (c.working && !opts.urgent) {
          c.queue = [...(c.queue ?? []), { id: `q${Date.now()}`, text }];
          this.touch(c.topic);
          return ok();
        }
        if (c.working && opts.urgent) this.steerInto(c, text);
        else this.submit(text, { topic: c.topic });
        return ok();
      }
      case 'host.promote': {
        const c = [...w.convs.values()].find((x) => x.queue?.some((q) => q.id === str(0)));
        const q = c?.queue?.find((x) => x.id === str(0));
        if (!c || !q) return ok(false);
        c.queue = c.queue!.filter((x) => x.id !== q.id);
        this.steerInto(c, q.text);
        return ok(true);
      }
      case 'host.cancelQueued': {
        for (const c of w.convs.values())
          if (c.queue?.some((q) => q.id === str(0))) {
            c.queue = c.queue.filter((q) => q.id !== str(0));
            this.touch(c.topic);
          }
        return ok(true);
      }

      // ---- a live view's rows (the demo's shop.db), paged, sorted and filtered as the Mac does
      case 'companion.viewFetch': {
        const a = args[0] as { source?: { query?: string }; query: ViewQuery };
        this.later(260, () => ok(demoRows(a.source?.query ?? '', a.query)));
        return;
      }

      // ---- open on your Mac, project icons
      case 'companion.openOnMac':
        return ok({ opened: true });
      case 'companion.icon': {
        const icon = Object.values(w.icons).find((i) => i.sum === str(0));
        if (!icon) return this.frames.emit({ t: 'result', id, ok: false, error: 'That icon is no longer offered' });
        return ok({ sum: icon.sum, mime: 'image/svg+xml', b64: toB64(utf8(icon.svg)) });
      }

      // ---- tasks
      case 'board.comment': {
        const t = w.tasks.find((x) => x.key === str(0));
        if (t) {
          t.activity = [...t.activity, { id: `c${Date.now()}`, at: Date.now(), who: 'You', text: 'commented', body: str(1), comment: true }];
          this.touch(t.topic);
        }
        return ok();
      }
      case 'board.move': {
        const t = w.tasks.find((x) => x.key === str(0));
        if (t) {
          const was = t.status;
          t.status = str(1);
          t.moves = ['todo', 'in_progress', 'in_review', 'done', 'backlog', 'canceled'].filter((s) => s !== t.status).map((s) => ({ status: s, label: STATUS_LABEL[s]! }));
          t.activity = [...t.activity, { id: `m${Date.now()}`, at: Date.now(), who: 'You', text: `moved this from ${STATUS_LABEL[was] ?? was} to ${STATUS_LABEL[t.status] ?? t.status}` }];
          t.updatedAt = Date.now();
          this.touch(t.topic, 'tasks');
        }
        return ok();
      }
      // ---- asking in a project (1.5): a new worktree with Claude on it, or a plan to approve
      case 'workspaces.startWorktree': {
        const opts = (args[2] ?? {}) as { plan?: boolean };
        const project = str(0);
        const id = `wt-${++this.convSeq}${Math.random().toString(36).slice(2, 6)}`;
        const topic = `conv:ws:${id}` as Topic;
        const name = str(1).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'worktree';
        w.convs.set(topic, { topic, title: name, project, turns: [], more: false, needsYou: [], canSend: true, working: false });
        w.projects.find((x) => x.id === project)?.convs.unshift(topic);
        this.submit(str(1), { topic }, [], opts.plan ? 'Here’s the plan: read the redirect, keep the deep link through sign-in, add a widget test. Approve it on your Mac or here and I’ll start.' : undefined);
        return ok(id);
      }
      case 'plans.create': {
        const a = args[0] as { projectId: string; goal: string };
        const id = `pl-${++this.convSeq}`;
        const title = a.goal.length > 48 ? `${a.goal.slice(0, 47)}…` : a.goal;
        const plan: PlanView = { id, title, goal: a.goal, state: 'draft', milestones: [], needsYou: [] };
        w.plans = [plan, ...w.plans];
        this.touch(`plan:${id}` as Topic, 'plans');
        // Claude drafts it: milestones and tasks arrive, then it waits for your approval.
        this.later(2600, () => {
          plan.milestones = [
            { id: `${id}-m1`, title: 'Groundwork', state: 'todo', criteria: ['The tests pass'], tasks: [{ id: `${id}-t1`, title: 'Read how it works today', state: 'todo' }, { id: `${id}-t2`, title: 'The data model', state: 'todo' }] },
            { id: `${id}-m2`, title: 'Ship it', state: 'todo', criteria: ['Works on a Pixel 7'], tasks: [{ id: `${id}-t3`, title: 'The screen', state: 'todo' }] },
          ];
          w.needs = [{ id: `plan:${id}:approve:1`, kind: 'plan', title: `Approve the plan “${title}”?`, detail: a.goal, topic: `plan:${id}` as Topic, actions: [{ label: 'Approve', tone: 'main', method: 'plans.approve', args: [id] }, { label: 'Discard', tone: 'danger', method: 'plans.discard', args: [id] }] } as NeedsYou, ...w.needs];
          this.touch(`plan:${id}` as Topic, 'plans');
        });
        return ok({ id, home: `ws:${id}-home`, projectId: a.projectId, status: 'draft' });
      }
      case 'board.start': {
        const t = w.tasks.find((x) => x.key === str(0) || x.id === str(0));
        if (!t) return this.frames.emit({ t: 'result', id, ok: false, error: 'No such task' });
        const topic = this.submit(`Work on ${t.key}: ${t.title}`, { project: t.projectId });
        const c = w.convs.get(topic)!;
        c.title = t.title;
        t.status = 'in_progress';
        t.conv = topic;
        t.worktree = `${t.key.toLowerCase()}-${t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`;
        t.assignee = 'your Claude';
        t.activity = [...t.activity, { id: `s${Date.now()}`, at: Date.now(), who: 'Beluga', text: `its work is being done in worktree ${t.worktree}` }];
        this.touch(t.topic, 'tasks', 'work');
        return ok(topic.replace(/^conv:/, '').replace(/^ws:/, ''));
      }
      case 'companion.draftTask': {
        const a = args[0] as { projectId: string; text: string };
        const words = a.text.trim().replace(/\s+/g, ' ');
        const title = words.length > 70 ? `${words.slice(0, 69)}…` : words.replace(/^./, (ch) => ch.toUpperCase()).replace(/[.!]$/, '');
        // Claude takes a moment to write it, as the Mac's drafter does.
        this.later(1400, () =>
          ok({
            title,
            goal: `${words.replace(/^./, (ch) => ch.toUpperCase())}${/[.!?]$/.test(words) ? '' : '.'} Done means it works on the phone and the Mac alike, and nothing that worked before breaks.`,
            acceptance: ['It works from the phone, in light and dark', 'The Mac shows the same', 'Tests cover it'],
            labels: ['companion'],
            priority: /urgent|asap|broken|crash/i.test(words) ? 'high' : 'medium',
          }),
        );
        return;
      }
      case 'companion.addTask': {
        const a = args[0] as { projectId: string; title: string; goal: string; acceptance: string[]; labels: string[]; priority?: string };
        const n = 52 + w.tasks.length;
        const key = `${a.projectId === 'pixel-weather' ? 'PXW' : 'BLG'}-${n}`;
        const task: (typeof w.tasks)[number] = {
          id: `iss-${n}`,
          topic: `task:iss-${n}`,
          key,
          title: a.title,
          status: 'todo',
          priority: a.priority ?? 'none',
          projectId: a.projectId,
          project: w.projects.find((p) => p.id === a.projectId)?.name ?? a.projectId,
          ...(w.icons[a.projectId] ? { icon: w.icons[a.projectId]!.sum } : {}),
          goal: { text: a.goal, code: [] },
          acceptance: a.acceptance.map((text) => ({ text, state: 'open' })),
          checks: a.acceptance.length ? { done: 0, total: a.acceptance.length } : undefined,
          activity: [{ id: `a${n}`, at: Date.now(), who: 'You', text: 'created this' }],
          moves: ['in_progress', 'in_review', 'done', 'backlog', 'canceled'].map((s) => ({ status: s, label: STATUS_LABEL[s]! })),
          updatedAt: Date.now(),
        };
        if (!task.checks) delete task.checks;
        w.tasks = [...w.tasks, task];
        this.touch('tasks');
        return ok({ id: task.id, key });
      }

      // ---- merging a worktree (the Mac's checks, merge, Claude resolving)
      case 'companion.mergeCheck': {
        const topic = str(0) as Topic;
        const resolved = w.merges.get(topic)?.phase === 'resolved';
        const conflicts = resolved ? [] : ['relay.ts', 'push.test.ts'];
        return ok({
          from: 'beluga/push-relay',
          into: 'main',
          commits: 4,
          files: 7,
          subjects: ['Seal pushes to the phone’s box key', 'Sign requests with the relay key', 'Deploy to staging', 'Tests for the relay'],
          checks: [
            { id: 'folder', tone: 'ok', text: 'Your main folder is on main, with no uncommitted changes' },
            ...(conflicts.length ? [{ id: 'conflicts', tone: 'block', text: `2 files would conflict: ${conflicts.join(', ')}. Claude can merge it and resolve them.`, fix: 'claude' }] : [{ id: 'conflicts', tone: 'ok', text: 'No conflicts' }]),
            { id: 'newer', tone: 'info', text: 'main has 2 newer commits that beluga/push-relay doesn’t. The merge keeps both.' },
          ],
          canMerge: !conflicts.length,
          confirm: 'Merge 4 Commits',
          ...(conflicts.length ? { conflicts } : {}),
        });
      }
      case 'companion.merge': {
        const topic = str(0) as Topic;
        const clean = w.merges.get(topic)?.phase === 'resolved';
        w.merges.set(topic, { phase: 'merging', at: Date.now() });
        this.touch(topic);
        this.later(1600, () => {
          w.merges.set(topic, clean ? { phase: 'merged', at: Date.now() } : { phase: 'conflicts', at: Date.now(), conflicts: ['relay.ts', 'push.test.ts'] });
          this.touch(topic);
        });
        return ok({ phase: 'merging', at: Date.now() });
      }
      case 'companion.resolve': {
        const topic = str(0) as Topic;
        const conflicts = ['relay.ts', 'push.test.ts'];
        w.merges.set(topic, { phase: 'resolving', at: Date.now(), conflicts });
        const c = w.convs.get(topic);
        if (c && !c.working) this.submit('Merge beluga/push-relay into main and resolve the conflicts in relay.ts and push.test.ts, then run the tests.', { topic });
        this.touch(topic);
        this.later(7000, () => {
          w.merges.set(topic, { phase: 'merged', at: Date.now() });
          this.touch(topic);
        });
        return ok({ phase: 'resolving', at: Date.now(), conflicts });
      }
      case 'companion.signOut':
        ok({ signedOut: true });
        this.later(50, () => this.frames.emit({ t: 'bye', reason: 'signed out' }));
        return;
      default:
        this.frames.emit({ t: 'result', id, ok: false, error: `The demo Mac doesn't do ${method}.` });
    }
  }

  /** Who's in a chat (you first), as views.ts sends it (1.2). */
  private membersOf(topic: string): { peerId: string; name: string; me?: boolean }[] {
    const chat = this.world.chats.get(topic as Topic);
    const me = { peerId: DEMO_ME.peerId, name: DEMO_ME.name || 'You', me: true };
    if (!chat) return [me];
    if (chat.kind === 'dm') return [me, { peerId: chat.peer ?? 'friend', name: chat.name }];
    return [me, ...['Mia', 'Ada', 'Sam', 'Theo'].map((name) => ({ peerId: name.toLowerCase(), name }))];
  }

  /** A file from the phone, piece by piece (`put`): each piece answered, the last with its `up:` ref. */
  private put(f: Extract<PhoneFrame, { t: 'put' }>): void {
    const got = this.puts.get(f.id) ?? { name: f.name, mime: f.mime, parts: [] as string[] };
    got.parts.push(f.b64);
    this.puts.set(f.id, got);
    if (!f.eof) return this.result(f.id, { received: f.off + Math.floor((f.b64.length * 3) / 4) });
    this.puts.delete(f.id);
    const up = `up:${Math.random().toString(36).slice(2, 12)}`;
    const view: OutputView = { ref: ref(got.name), name: got.name, kind: got.mime.startsWith('image/') ? 'image' : 'file', size: f.size, ts: Date.now() };
    this.world.files.set(view.ref, { view, mime: got.mime, b64: got.parts.join('') });
    this.uploads.set(up, view);
    this.result(f.id, { ref: up });
  }

  /** Your message (and photos) into a conversation, or a new one in a project; Claude gets to work. */
  private submit(text: string, target: { project?: string; topic?: string }, files: OutputView[] = [], said?: string): Topic {
    const w = this.world;
    let topic = (target.topic ?? '') as Topic;
    let conv = target.topic ? w.convs.get(target.topic) : undefined;
    if (!conv) {
      const project = target.project ?? 'beluga';
      topic = `conv:${project}.ask-${++this.convSeq}` as Topic;
      const title = text.length > 60 ? `${text.slice(0, 59)}…` : text;
      conv = { topic, title, project, turns: [], more: false, needsYou: [], canSend: true, working: false };
      w.convs.set(topic, conv);
      w.projects.find((x) => x.id === project)?.convs.unshift(topic);
    }
    const now = Date.now();
    const you: TurnView = { ...turn({ id: `y${now}`, who: 'you', name: 'You' }, text, now), ...(files.length ? { outputs: files } : {}) };
    const claude: TurnView = turn({ id: `c${now}`, who: 'claude', name: 'Claude', status: 'working', step: 'Thinking', steps: 0, live: { phase: 'thinking', since: now }, trail: [] }, '', now + 1);
    conv.turns = [...conv.turns, you, claude];
    conv.working = true;
    this.touch(topic, 'work');
    const shot = topic === 'conv:mac:assistant' && /screenshot|screen/i.test(text);
    const answer = said ?? (shot
      ? 'Here’s your screen now: the radar build in the Simulator, and the login fix’s tests running in Terminal.'
      : topic === 'conv:mac:assistant'
        ? 'Nothing heavy: Xcode at 34% CPU, the Simulator at 12%, Beluga under 2%. 9.5 GB of 24 GB memory free.'
        : files.length
      ? `Got your photo (${files[0]!.name}). It matches what I see in the radar build; nothing to change.`
      : 'Done. The tests pass (40/40) and nothing else needed changing.');
    let outputs: OutputView[] | undefined;
    if (shot) {
      const view: OutputView = { ref: ref('screen'), name: `screen-${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}.png`, kind: 'image', size: 98_000, ts: Date.now() + 4000 };
      w.files.set(view.ref, { view, mime: 'image/jpeg', image: 'desktop' });
      outputs = [view];
    }
    const steps = topic === 'conv:mac:assistant' ? (shot ? ['Taking a screenshot', 'Writing the answer'] : ['Running ps -Ao pid,pcpu,pmem,comm', 'Writing the answer']) : ['Reading the code', 'Running the tests · 12/40', 'Running the tests · 40/40', 'Writing the answer'];
    this.work(topic, claude.id, 'Claude', steps, answer, outputs);
    return topic;
  }

  /** Ask a friend's Claude (companion.askPerson): a task conversation in "Asked of friends". */
  private askPerson(name: string, text: string, screen: boolean): { topic: Topic; task: string } {
    const w = this.world;
    const task = `t${++this.convSeq}${Math.random().toString(36).slice(2, 6)}`;
    const topic = `conv:task:${task}` as Topic;
    const title = screen ? `Screenshot of ${name}'s desktop` : text.length > 60 ? `${text.slice(0, 59)}…` : text;
    const now = Date.now();
    const theirs: TurnView = turn({ id: `f${now}`, who: 'friend', name: `${name}'s Claude`, status: 'working', step: `Waiting for ${name}'s Claude`, steps: 1 }, '', now + 1);
    w.convs.set(topic, { topic, title, project: `Asked of friends · ${name}`, turns: [turn({ id: `y${now}`, who: 'you', name: 'You' }, text, now), theirs], more: false, needsYou: [], canSend: true, working: true });
    w.projects.find((x) => x.id === 'asked')?.convs.unshift(topic);
    this.touch(topic, 'work');
    let outputs: OutputView[] | undefined;
    if (screen) {
      const view: OutputView = { ref: ref('desktop'), name: `${name.toLowerCase()}-desktop.png`, kind: 'image', size: 98_000, ts: Date.now() + 5000 };
      w.files.set(view.ref, { view, mime: 'image/jpeg', image: 'desktop' });
      outputs = [view];
    }
    this.work(topic, theirs.id, `${name}'s Claude`, screen ? [`${name} approved`, 'Taking the screenshot', 'Sending it'] : [`${name} approved`, 'Looking into it', 'Writing the answer'], screen ? `Here's ${name}'s desktop: the radar build on the left, the forecast chart on the right.` : `${name} is on the radar fix; the cross-fade is in and they're testing on a Pixel 7 now.`, outputs);
    return { topic, task };
  }

  /** A turn at work: its steps tick over, then it answers (and hands in what it made). */
  private work(topic: Topic, turnId: string, _who: string, steps: string[], answer: string, outputs?: OutputView[]): void {
    const w = this.world;
    steps.forEach((s, i) =>
      this.later(1300 * (i + 1), () => {
        const c = w.convs.get(topic);
        const last = c?.turns.at(-1);
        if (!c || !last || last.id !== turnId || last.status !== 'working') return;
        // As views.ts sends it: what it does now, and the step before it done in the trail.
        const [words, progress] = s.split(' · ');
        const writing = /^Writing the answer/.test(s);
        const live: TurnView['live'] = writing ? { phase: 'writing', since: Date.now() } : { phase: 'step', words, tool: toolGuess(s), since: Date.now(), ...(progress ? { progress } : {}) };
        const was = last.live;
        const prev = was?.phase === 'step' && was.words ? [...(last.trail ?? []).filter((x) => x.text !== pastOf(was.words!)), { tool: was.tool ?? 'tool', text: pastOf(was.words) }] : (last.trail ?? []);
        const trail = writing ? prev : [...prev, { tool: toolGuess(s), text: pastOf(words!) }];
        c.turns = [...c.turns.slice(0, -1), { ...last, step: s, steps: i + 2, live, trail }];
        this.touch(topic);
      }),
    );
    this.later(1300 * (steps.length + 1), () => {
      const c = w.convs.get(topic);
      const last = c?.turns.at(-1);
      if (!c || !last || last.id !== turnId || last.status !== 'working') return;
      const { live: _live, ...rest } = last;
      c.turns = [...c.turns.slice(0, -1), { ...rest, status: 'done', step: undefined, endTs: Date.now(), prose: { text: answer, code: [] }, ...(outputs ? { outputs } : {}) }];
      c.working = false;
      this.touch(topic, 'work');
      if (!this.subs.has(topic)) this.frames.emit({ t: 'nudge', kind: 'done', title: c.title, body: answer.slice(0, 120), topic });
    });
  }

  /** Steer: your words reach the turn Claude is on (it reads them at its next step). */
  private steerInto(c: ConvView, text: string): void {
    const at = c.turns.findLastIndex((t) => t.status === 'working');
    const now = Date.now();
    const you = turn({ id: `y${now}`, who: 'you', name: 'You' }, text, now);
    if (at < 0) {
      c.turns = [...c.turns, you];
    } else {
      const live = c.turns[at]!;
      const steered = { ...live, trail: [...(live.trail ?? []), { tool: 'plan', text: 'Read your message' }] };
      c.turns = [...c.turns.slice(0, at), you, steered, ...c.turns.slice(at + 1)];
    }
    this.touch(c.topic);
  }

  private claudeSays(topic: Topic, text: string): void {
    const c = this.world.convs.get(topic);
    if (!c) return;
    const now = Date.now();
    c.turns = [...c.turns, turn({ id: `s${now}`, who: 'claude', name: 'Claude', status: 'done', endTs: now }, text, now)];
    this.touch(topic);
  }

  private chatReply(topic: Topic, from: string, text: string, claude = false): void {
    const chat = this.world.chats.get(topic);
    if (!chat) return;
    chat.messages = [...chat.messages, { id: `r${Date.now()}`, from, mine: false, text, ts: Date.now(), ...(claude ? { claude } : {}) }];
    if (!this.subs.has(topic)) {
      chat.unread += 1;
      this.frames.emit({ t: 'nudge', kind: 'mentions', title: chat.name, body: `${from}: ${text}`, topic });
    }
    this.touch(topic, 'chats');
  }

  private deploy(): void {
    const topic: Topic = 'conv:beluga.push';
    const c = this.world.convs.get(topic);
    if (!c) return;
    const last = c.turns.at(-1)!;
    c.working = true;
    c.turns = [...c.turns.slice(0, -1), { ...last, step: 'Deploying to staging', steps: 13 }];
    this.touch(topic, 'work');
    this.later(3500, () => {
      const l = c.turns.at(-1)!;
      c.working = false;
      c.turns = [...c.turns.slice(0, -1), { ...l, status: 'done', step: undefined, endTs: Date.now(), steps: 15, prose: { text: `${l.prose.text}\n\nDeployed: **beluga-push-staging** is live. A test push reached the Pixel in 340 ms.`, code: l.prose.code } }];
      this.touch(topic, 'work');
    });
  }

  // ---- files

  private get(id: number, outRef: string, variant: 'thumb' | 'full' | 'text', off: number): void {
    const f = this.world.files.get(outRef);
    if (!f) {
      this.frames.emit({ t: 'result', id, ok: false, error: 'Not an output (or not any more).' });
      return;
    }
    if (f.image || f.b64) {
      const b64 = f.b64 ?? DEMO_IMAGES[f.image!].b64;
      // Pieces of COMPANION_PIECE bytes, as the Mac sends them.
      const piece = (COMPANION_PIECE / 3) * 4;
      const size = Math.floor((b64.length * 3) / 4);
      for (let at = 0; at < b64.length; at += piece) {
        const part = b64.slice(at, at + piece);
        this.frames.emit({ t: 'chunk', id, off: (at / 4) * 3, b64: part, eof: at + piece >= b64.length, size, mime: f.mime });
      }
      return;
    }
    const bytes = utf8(f.text ?? '');
    const end = Math.min(bytes.length, off + COMPANION_PIECE);
    this.frames.emit({ t: 'chunk', id, off, b64: toB64(bytes.subarray(off, end)), eof: end >= bytes.length, size: bytes.length, mime: f.mime });
    void variant;
  }

  // ---- the world moving while you look

  private startLive(): void {
    this.stopLive();
    this.ticker = setInterval(() => this.tick(), 1100);
  }
  private stopLive(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private tick(): void {
    const w = this.world;
    const topic: Topic = 'conv:beluga.onboarding';
    const c = w.convs.get(topic);
    const last = c?.turns.at(-1);
    if (!c || !last || last.status !== 'working' || !last.subagents) return;
    const agent = last.subagents.find((a) => a.id === 'a-e2e')!;
    if (this.e2e < 215) {
      const from = this.e2e;
      this.e2e = Math.min(215, this.e2e + 1 + Math.floor(Math.random() * 3));
      const log = agent.outputs[0]!;
      const file = w.files.get(log.ref)!;
      for (let n = from + 1; n <= this.e2e; n++) file.text += `${e2eLine(n)}\n`;
      if (this.e2e === 215) file.text += '\n  211 passed, 4 flaky (retried and passed)\n  Finished in 1m 48s\n';
      const size = utf8(file.text ?? '').length;
      const newLog = { ...log, size, ts: Date.now() };
      file.text = file.text ?? '';
      w.files.set(log.ref, { ...file, view: newLog });
      const done = this.e2e === 215;
      const updated = { ...agent, status: done ? ('done' as const) : ('running' as const), steps: [...agent.steps.slice(0, -1), done ? 'Ran 215 tests · 211 passed, 4 flaky' : `Running 215 tests · ${this.e2e} done`], step: done ? undefined : `Running the tests · ${this.e2e}/215`, ...(done ? { endTs: Date.now(), trail: [...(agent.trail ?? []), { tool: 'write', text: 'Wrote timings.json' }] } : {}), outputs: [newLog, ...agent.outputs.slice(1)] };
      // The helper looking into the flaky test moves on every few seconds.
      const FLAKY = [
        { step: 'Reading needs-you.spec.ts', tool: 'read', done: 'Read needs-you.spec.ts' },
        { step: 'Searching for swipeThreshold', tool: 'search', done: 'Searched for swipeThreshold' },
        { step: 'Editing Needs.tsx', tool: 'edit', done: 'Edited Needs.tsx' },
        { step: 'Running the tests', tool: 'test', done: 'Ran the tests' },
      ];
      const k = Math.floor(this.e2e / 12) % FLAKY.length;
      const subs = last.subagents.map((a) => {
        if (a.id === agent.id) return updated;
        if (a.id !== 'a-flaky' || a.status !== 'running') return a;
        if (a.step === FLAKY[k]!.step) return a;
        const prev = FLAKY.find((f) => f.step === a.step);
        return { ...a, step: FLAKY[k]!.step, tool: FLAKY[k]!.tool, count: (a.count ?? 0) + 1, trail: prev ? [...(a.trail ?? []), { tool: prev.tool, text: prev.done }].slice(-30) : a.trail };
      });
      const live: TurnView['live'] = done ? { phase: 'writing', since: Date.now() } : { ...(last.live ?? { phase: 'step', words: 'Running the tests', tool: 'test' }), progress: `${this.e2e}/215`, agents: subs.filter((a) => a.status === 'running').length };
      c.turns = [...c.turns.slice(0, -1), { ...last, step: done ? 'Writing the summary' : `Running the tests · ${this.e2e}/215`, steps: (last.steps ?? 0) + (this.e2e % 5 === 0 ? 1 : 0), subagents: subs, live }];
      this.touch(topic, 'work');
      if (done) {
        this.later(4000, () => {
          const l = c.turns.at(-1)!;
          c.working = false;
          c.turns = [...c.turns.slice(0, -1), { ...l, status: 'done', step: undefined, endTs: Date.now(), prose: { text: `${l.prose.text}\n\nAll three are back:\n- **Contrast**: captions were 3.6 : 1 on the brightest fold; raised to 4.1 : 1. Report attached.\n- **Screenshots**: both pairing steps, on a Pixel 9 sized screen.\n- **e2e**: 211 of 215 passed first time; 4 were flaky and passed on retry. The slowest suites are in the chart.`, code: [] } }];
          this.touch(topic, 'work');
          if (!this.subs.has(topic)) this.frames.emit({ t: 'nudge', kind: 'done', title: c.title, body: 'All three sub-agents are back: contrast, screenshots, e2e.', topic });
        });
      }
    }
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }
}

/** A demo step's tool, from its words. */
const toolGuess = (s: string): string => (/test/i.test(s) ? 'test' : /^Read|^Looking/i.test(s) ? 'read' : /^Edit|^Writ/i.test(s) ? 'edit' : /screenshot|Taking/i.test(s) ? 'tool' : /^Send|^Deploy/i.test(s) ? 'run' : 'tool');
/** "Reading the code" → "Read the code" (what the trail says once a step is done). */
const pastOf = (s: string): string =>
  s
    .replace(/ · .*$/, '')
    .replace(/^Reading/, 'Read')
    .replace(/^Running/, 'Ran')
    .replace(/^Editing/, 'Edited')
    .replace(/^Writing/, 'Wrote')
    .replace(/^Taking/, 'Took')
    .replace(/^Sending/, 'Sent')
    .replace(/^Looking/, 'Looked')
    .replace(/^Deploying/, 'Deployed');

const STATUS_LABEL: Record<string, string> = { todo: 'Ready', in_progress: 'In Progress', in_review: 'In Review', done: 'Done', backlog: 'Backlog', canceled: 'Canceled' };

const count = (p: { milestones: { tasks: { state: string }[] }[] }): { done: number; total: number } => {
  const tasks = p.milestones.flatMap((m) => m.tasks);
  return { done: tasks.filter((t) => t.state === 'done').length, total: tasks.length };
};
const stripMarkers = (s: string): string => s.replace(/\[\[code:\d+\]\]/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
const lastLine = (m: { from: string; text: string; mine: boolean; files?: unknown[] } | undefined): string | undefined => (m ? `${m.mine ? 'You' : m.from}: ${m.text || (m.files?.length ? 'a photo' : '')}`.slice(0, 300) : undefined);
const allOutputs = (t: TurnView): OutputView[] => [...(t.outputs ?? []), ...(t.subagents ?? []).flatMap((a) => a.outputs)];
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
