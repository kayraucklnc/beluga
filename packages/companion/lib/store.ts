import { AppState, type AppStateStatus, Linking, Platform } from 'react-native';
import { fromB64, fromUtf8, toB64 } from './b64';
import { kv } from './kv';
import { BareTransport } from './link/bare';
import { type Call, calls } from './link/calls';
import { DemoTransport } from './link/demo/transport';
import { BACKGROUND_GRACE_MS, COMPANION_PIECE, COMPANION_PROTO, compatible, SINCE, MAX_UPLOAD_BYTES, isMacTopic, type MacFrame, type NeedsYou, type OutputView, type Topic, viewSchema } from './link/protocol';
import { type Diagnosis, type PairRefusal, diagnose } from './link/diagnose';
import { checkOnline } from './link/online';
import { graceExpired, onResume, PROBE_TIMEOUT_MS, retryDelay } from './link/resume';
import type { Attempt, DeviceSecret, LinkHints, LinkPathName, LinkPhase, Pairing } from './link/rpc';
import type { PairInput, PairStep, PathInfo, PhaseInfo, Transport } from './link/transport';
import { secure } from './secure';

/**
 * The phone's one store: which Mac, the link's state, the views on screen (and the last ones,
 * cached for when your Mac is asleep), calls and the outbox, files fetched by ref. Screens read it
 * through lib/hooks.ts (useSyncExternalStore), so a view arriving re-renders only what shows it.
 *
 * Battery (docs/companion.md): the link opens when the app comes to the front and closes
 * BACKGROUND_GRACE_MS after it leaves. Nothing here polls; what changes comes from the Mac.
 */

export type Mode = 'demo' | 'bare';
export interface LinkState {
  readonly mode?: Mode;
  /** idle: not paired; dialing; open; asleep: tried, the Mac doesn't answer; closed: in the background. */
  readonly phase: 'idle' | LinkPhase | 'asleep';
  readonly detail?: string;
  readonly mac?: { name: string; version: string };
  readonly me?: { name: string; peerId: string };
  /** The two sides can't talk: whose update would fix it. */
  readonly outdated?: 'mac' | 'app';
  /** The Mac's protocol version (its minor says what it has: SINCE). */
  readonly proto?: { major: number; minor: number };
  readonly pairing?: Pairing;
  readonly ready: boolean;
  /** Why it can't connect, in plain words (the away band and its "Why?" sheet). */
  readonly diagnosis?: Diagnosis;
  /** How the open link got through, and what was tried (Settings › Advanced). */
  readonly path?: LinkPathName;
  readonly tried?: readonly Attempt[];
}

/** Relay URLs kept (newest first). */
const RELAYS_KEPT = 3;

export interface CachedView<T = unknown> {
  readonly data: T;
  readonly rev: number;
  /** When it arrived (for "as of 10:42"). */
  readonly at: number;
  /** From the cache, not (yet) from the Mac this session. */
  readonly stale: boolean;
}

export interface OutboxItem {
  readonly id: string;
  readonly call: Call;
  readonly at: number;
}

export interface FileState {
  readonly status: 'loading' | 'ready' | 'error';
  /** Pictures: a data: URI. */
  readonly uri?: string;
  /** Text files: what has come so far. */
  readonly text?: string;
  /** Bytes received, and the file's size on the Mac. */
  readonly got: number;
  readonly size?: number;
  readonly mime?: string;
  readonly error?: string;
}

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone?: 'ok' | 'warn' | 'error' | 'info';
  readonly topic?: Topic;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
/** A terminal's output or status, as the Mac sends it (1.7). */
export type TermFrame = Extract<MacFrame, { t: 'term_data' | 'term_status' }>;
type Fetch = { key: string; ref: string; variant: 'thumb' | 'full' | 'text'; parts: string[]; base: string; got: number };

const APP = 'beluga-companion/0.16.0';
const PLATFORM: 'android' | 'ios' = Platform.OS === 'ios' ? 'ios' : 'android';

class Store {
  private transport: Transport | undefined;
  private unsubs: (() => void)[] = [];
  private state: LinkState = { phase: 'idle', ready: false };
  private views = new Map<string, CachedView>();
  private subCounts = new Map<Topic, number>();
  private subTimer: ReturnType<typeof setTimeout> | undefined;
  private pending = new Map<number, Pending>();
  private fetches = new Map<number, Fetch>();
  private files = new Map<string, FileState>();
  private deferred = new Map<string, { ref: string; variant: 'thumb' | 'full' | 'text'; more: boolean }>();
  private outbox: OutboxItem[] = kv.get<OutboxItem[]>('outbox') ?? [];
  private hidden = new Set<string>();
  private latest = new Map<string, OutputView>();
  private toasts: Toast[] = [];
  private seq = 1;
  /** The Mac said welcome on this link (calls may go; they're answered). */
  private welcomed = false;
  private grace: ReturnType<typeof setTimeout> | undefined;
  /** The app is in front (AppState), and since when it's been away (the wall clock: BLG-105). */
  private active = false;
  private awayAt: number | undefined;
  /** When the dial in flight began; whether a check of the open link is out. */
  private dialingSince: number | undefined;
  private probing = false;
  /** One automatic retry at a time, backing off (lib/link/resume.ts retryDelay). */
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  private listeners = new Map<string, Set<() => void>>();
  private snapshots = new Map<string, unknown>();
  /** What the image viewer shows, and where it opened from (for the transition back). */
  gallery: { items: OutputView[]; index: number; origin?: { x: number; y: number; w: number; h: number } } = { items: [], index: 0 };

  // ---- subscribe (for useSyncExternalStore)

  subscribe(key: string, fn: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => void set!.delete(fn);
  }
  private emit(key: string): void {
    this.snapshots.delete(key);
    for (const fn of [...(this.listeners.get(key) ?? [])]) fn();
  }
  /** Stable snapshots: the same object until its key changes. */
  snapshot<T>(key: string, make: () => T): T {
    if (!this.snapshots.has(key)) this.snapshots.set(key, make());
    return this.snapshots.get(key) as T;
  }

  getState(): LinkState {
    return this.state;
  }
  private setState(patch: Partial<LinkState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state');
  }

  // ---- starting up, pairing, signing out

  private booted = false;
  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    const mode = kv.get<Mode>('mode');
    const pairing = mode === 'bare' ? await secure.get<Pairing>('pairing') : undefined;
    for (const [topic, v] of Object.entries(kv.get<Record<string, { data: unknown; rev: number; at: number }>>('views') ?? {})) {
      this.views.set(topic, { ...v, stale: true });
    }
    if (mode === 'demo' || (mode === 'bare' && pairing)) this.use(mode, pairing);
    this.setState({ ready: true });
    this.active = AppState.currentState === 'active';
    AppState.addEventListener('change', (s) => this.onAppState(s));
    // Opened by a link (or a notification's) while in the background: back in front, so link now.
    // AppState says so too; whichever comes first dials, the other finds it dialing (single flight).
    Linking.addEventListener('url', () => this.foreground());
    if (mode && AppState.currentState === 'active') this.foreground();
  }

  private use(mode: Mode, pairing?: Pairing): void {
    this.dropTransport();
    const t: Transport = mode === 'demo' ? new DemoTransport() : new BareTransport(async () => {
      const p = await secure.get<Pairing>('pairing');
      const s = await secure.get<DeviceSecret>('device-secret');
      return p && s ? { pairing: p, secret: s } : undefined;
    });
    this.transport = t;
    if (t instanceof DemoTransport && kv.get<boolean>('demo-asleep')) t.setAsleep(true);
    this.unsubs = [t.onFrame((f) => this.onFrame(f)), t.onPhase((p, d, i) => this.onPhase(p, d, i)), (t as Transport).onPath?.((i: PathInfo) => this.onPath(i)) ?? (() => {})];
    this.setState({ mode, pairing, phase: 'closed' });
  }

  private dropTransport(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.transport?.dispose();
    this.transport = undefined;
    this.clearRetry();
    this.probing = false;
    this.dialingSince = undefined;
  }

  /** Pair with a Mac (or start the demo, `mode: 'demo'`). */
  pair(mode: Mode, input: Omit<PairInput, 'platform'>, onStep: (step: PairStep) => void): { cancel(): void } {
    const t: Transport = mode === 'demo' ? new DemoTransport() : new BareTransport(async () => undefined);
    const offPath = t.onPath?.((i) => this.onPath(i));
    const run = t.pair({ ...input, platform: PLATFORM, hints: this.hints() }, (step) => {
      if (step.step === 'failed' && !step.diagnosis) {
        // Say what went wrong in words: check the phone is online first, so nothing else is blamed for that.
        const known = step.refusal ? undefined : step.report;
        void (known ? checkOnline() : Promise.resolve(undefined)).then((online) =>
          onStep({ ...step, diagnosis: diagnose({ stage: 'pair', ...(online !== undefined ? { online } : {}), ...(step.report ? { report: step.report } : {}), ...(step.refusal ? { refusal: step.refusal as PairRefusal } : {}), reason: step.reason }) }),
        );
        return;
      }
      if (step.step === 'paired') {
        void (async () => {
          if (mode === 'bare') {
            await secure.set('pairing', step.pairing);
            await secure.set('device-secret', step.secret);
          }
          kv.set('mode', mode);
          offPath?.();
          t.dispose();
          this.use(mode, step.pairing);
          this.foreground();
          onStep(step);
        })();
        return;
      }
      onStep(step);
    });
    return { cancel: () => (run.cancel(), t.dispose()) };
  }

  /**
   * Sign out: the Mac removes this phone's certificate (companion.signOut), then the phone forgets
   * its keys, the pairing and every cached view. Away from the Mac, the local part still happens
   * (remove the phone on the Mac too: Settings › Phone).
   */
  async signOut(): Promise<{ onMac: boolean }> {
    let onMac = false;
    if (this.state.phase === 'open') onMac = await this.call(calls.signOut(), { queue: false }).then(() => true, () => false);
    this.transport?.send({ t: 'bye' });
    this.dropTransport();
    await secure.remove('pairing');
    await secure.remove('device-secret');
    kv.clear();
    this.views.clear();
    this.files.clear();
    this.outbox = [];
    this.hidden.clear();
    this.snapshots.clear();
    this.state = { phase: 'idle', ready: true };
    for (const key of this.listeners.keys()) this.emit(key);
    return { onMac };
  }

  /** The demo Mac falls asleep (or wakes): to see the phone's "away" state. Kept across launches. */
  setDemoAsleep(asleep: boolean): void {
    kv.set('demo-asleep', asleep);
    this.demo?.setAsleep(asleep);
    if (!asleep) this.retry();
  }

  get demo(): DemoTransport | undefined {
    return this.transport instanceof DemoTransport ? this.transport : undefined;
  }

  // ---- the link's life: open while you look

  private onAppState(s: AppStateStatus): void {
    if (s === 'active') this.foreground();
    else if (s === 'background') this.background();
  }

  /**
   * The app is in front again (or you asked to try again): make sure the link is really there.
   * Decided by lib/link/resume.ts: an open link is pinged and replaced if it doesn't answer; one
   * left open past the grace (Android froze it instead of closing it) is replaced at once; a dial
   * under way is left alone; anything else dials now, with the retries' backoff started afresh.
   */
  foreground(): void {
    this.active = true;
    if (this.grace) clearTimeout(this.grace);
    this.grace = undefined;
    const awayAt = this.awayAt;
    this.awayAt = undefined;
    this.clearRetry();
    this.retryAttempt = 0;
    const t = this.transport;
    if (!t) return;
    const next = onResume({ phase: this.state.phase, now: Date.now(), ...(awayAt !== undefined ? { awayAt } : {}), ...(this.dialingSince !== undefined ? { dialingSince: this.dialingSince } : {}), probing: this.probing });
    if (next.do === 'none') return;
    if (next.do === 'probe') {
      t.send({ t: 'focus', on: true });
      // The Mac stops a terminal's stream while the app is away: its screen draws afresh now.
      this.reattachTerms();
      this.probe();
      return;
    }
    this.dial(next.replace);
  }

  /** Dial now; `replace`: drop the link or dial there is first (it can't be trusted). */
  private dial(replace: boolean): void {
    const t = this.transport;
    if (!t) return;
    this.clearRetry();
    if (replace && (this.state.phase === 'open' || this.state.phase === 'dialing')) t.close('stale');
    this.dialingSince = Date.now();
    t.open({ t: 'hello', v: { ...COMPANION_PROTO }, app: APP, platform: PLATFORM, topics: this.topics() }, this.hints());
  }

  /** Ping the open link; if it doesn't answer in time it's half-open: dial a new one. */
  private probe(): void {
    const t = this.transport;
    if (!t?.probe || this.probing) return;
    this.probing = true;
    void t.probe(PROBE_TIMEOUT_MS).then(
      (ok) => {
        this.probing = false;
        if (ok || t !== this.transport || !this.active) return;
        if (this.state.phase === 'open' || this.state.phase === 'closed') this.dial(true);
      },
      () => void (this.probing = false),
    );
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** The link dropped, or the Mac didn't answer, while you look: try again by itself, backing off. */
  private scheduleRetry(): void {
    this.clearRetry();
    const delay = retryDelay({ phase: this.state.phase, active: this.active, attempt: this.retryAttempt }, Math.random());
    if (delay === undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const p = this.state.phase;
      if (!this.active || !this.transport || (p !== 'closed' && p !== 'asleep')) return;
      this.retryAttempt++;
      this.dial(false);
    }, delay);
  }

  // ---- reaching the Mac on any network (docs/companion.md, "Any network")

  /** The relays seen and the way that worked per network (kv: nothing secret). */
  private hints(): LinkHints {
    const h = kv.get<LinkHints>('link-hints') ?? { relays: [], prefer: {} };
    const paired = this.state.pairing?.relay;
    return paired && !h.relays.includes(paired) ? { ...h, relays: [...h.relays, paired] } : h;
  }

  private keepRelay(relay: string | undefined): void {
    if (!relay) return;
    const h = this.hints();
    if (h.relays[0] === relay) return;
    kv.set('link-hints', { ...h, relays: [relay, ...h.relays.filter((r) => r !== relay)].slice(0, RELAYS_KEPT) });
  }

  private onPath(i: PathInfo): void {
    const h = this.hints();
    kv.set('link-hints', { relays: i.relay ? [i.relay, ...h.relays.filter((r) => r !== i.relay)].slice(0, RELAYS_KEPT) : h.relays, prefer: i.network ? { ...h.prefer, [i.network]: i.way } : h.prefer });
    this.setState({ path: i.path, tried: i.tried });
  }

  background(): void {
    this.active = false;
    this.clearRetry();
    this.awayAt ??= Date.now();
    if (!this.transport || this.grace) return;
    if (this.state.phase === 'open') this.transport.send({ t: 'focus', on: false });
    this.armGrace(BACKGROUND_GRACE_MS);
  }

  private armGrace(ms: number): void {
    this.grace = setTimeout(() => {
      this.grace = undefined;
      // Android runs a timer paused in the background late, often just as the app comes back:
      // close only if it's still away, and long enough by the clock.
      if (this.active || this.awayAt === undefined) return;
      const now = Date.now();
      if (!graceExpired({ active: this.active, awayAt: this.awayAt, now })) return this.armGrace(this.awayAt + BACKGROUND_GRACE_MS - now);
      this.transport?.send({ t: 'bye' });
      this.transport?.close('background');
    }, ms);
  }

  /** Try again now (the "asleep" banner's button). */
  retry(): void {
    this.foreground();
  }

  private onPhase(phase: LinkPhase, detail?: string, info?: PhaseInfo): void {
    if (phase === 'dialing') {
      if (this.state.phase !== 'dialing' || this.dialingSince === undefined) this.dialingSince = Date.now();
      this.clearRetry();
    } else this.dialingSince = undefined;
    if (phase === 'open') {
      this.retryAttempt = 0;
      this.clearRetry();
      this.setState({ phase, detail: undefined, diagnosis: undefined });
      // Screens may have changed while dialing: say what's on screen now.
      this.transport?.send({ t: 'sub', topics: this.topics() });
      this.reattachTerms();
      const wanted = [...this.deferred.values()];
      this.deferred.clear();
      for (const w of wanted) {
        const key = `${w.ref}#${w.variant}`;
        if (this.files.get(key)?.status !== 'ready' || w.more) {
          this.files.delete(key);
          this.fetch(w.ref, w.variant, w.more);
        }
      }
      return;
    }
    if (phase === 'unreachable') {
      this.setState({ phase: 'asleep', detail, path: undefined });
      // In words, once we know whether the phone itself is online.
      void checkOnline().then((online) => {
        if (this.state.phase !== 'asleep') return;
        this.setState({ diagnosis: diagnose({ stage: 'link', online, ...(info?.report ? { report: info.report } : {}), ...(detail ? { reason: detail } : {}) }) });
      });
    } else {
      const d = phase === 'refused' ? diagnose({ stage: 'link', ...(info?.code !== undefined ? { closeCode: info.code } : {}), ...(detail ? { reason: detail } : {}) }) : undefined;
      this.setState({ phase, detail, path: phase === 'closed' ? this.state.path : undefined, diagnosis: d && d.problem !== 'unknown' ? d : undefined });
    }
    this.welcomed = false;
    if (phase === 'closed' || phase === 'unreachable') this.scheduleRetry();
    // Calls in flight won't be answered. Marked `lost`: the Mac may or may not have done it
    // (lib/sends.ts checks the Mac's view before it says either).
    for (const [, p] of this.pending) p.reject(Object.assign(new Error('The link closed.'), { lost: true }));
    this.pending.clear();
    for (const [id, f] of this.fetches) {
      this.fetches.delete(id);
      if (this.files.get(f.key)?.status === 'loading') {
        this.deferred.set(f.key, { ref: f.ref, variant: f.variant, more: false });
        this.setFile(f.key, { status: 'error', got: 0, error: 'Your Mac is away' });
      }
    }
  }

  private onFrame(f: MacFrame): void {
    switch (f.t) {
      case 'welcome': {
        const ok = compatible(COMPANION_PROTO, f.v, f.min);
        const outdated = ok ? undefined : COMPANION_PROTO.major < f.min.major ? ('app' as const) : ('mac' as const);
        const older = this.state.proto?.minor !== f.v.minor;
        this.setState({ mac: f.mac, me: f.me, outdated, proto: f.v });
        this.keepRelay(f.relay);
        // What's on screen again, now that it's known what this Mac has (an older one drops a `sub` naming a topic it doesn't know).
        if (older) this.transport?.send({ t: 'sub', topics: this.topics() });
        this.welcomed = !outdated;
        if (!outdated) this.flushOutbox();
        this.emit('linked');
        return;
      }
      case 'view': {
        const parsed = viewSchema(f.topic).safeParse(f.data);
        if (!parsed.success) {
          if (__DEV__) console.warn('[view] does not match protocol.ts', f.topic, parsed.error.issues.slice(0, 3));
          return;
        }
        const v: CachedView = { data: parsed.data, rev: f.rev, at: Date.now(), stale: false };
        this.views.set(f.topic, v);
        this.noteOutputs(parsed.data);
        // Needs-you you've answered come back hidden until the Mac drops them.
        this.emit(`view:${f.topic}`);
        this.persistViews();
        return;
      }
      case 'result': {
        const p = this.pending.get(f.id);
        if (p) {
          this.pending.delete(f.id);
          if (f.ok) p.resolve(f.value);
          else p.reject(new Error(f.error ?? 'Your Mac said no.'));
          return;
        }
        const fetch = this.fetches.get(f.id);
        if (fetch && !f.ok) {
          this.fetches.delete(f.id);
          this.setFile(fetch.key, { status: 'error', got: 0, error: f.error ?? 'Not available' });
        }
        return;
      }
      case 'chunk':
        this.onChunk(f);
        return;
      case 'term_data':
      case 'term_status':
        for (const fn of [...(this.termListeners.get(f.term) ?? [])]) fn(f);
        return;
      case 'nudge':
        this.toast({ text: `${f.title} · ${f.body}`, tone: f.kind === 'needsYou' ? 'warn' : 'info', topic: f.topic });
        return;
      case 'bye':
        this.setState({ phase: 'closed', detail: f.reason });
        return;
    }
  }

  /** Linked and welcomed: a call now goes, and is answered (unless the link drops). */
  get linked(): boolean {
    return this.welcomed && this.state.phase === 'open' && Boolean(this.transport);
  }

  // ---- views

  /** The topics on screen right now (what the Mac should send). */
  private topics(): Topic[] {
    return [...this.subCounts.keys()].filter((t) => this.knows(t)).slice(0, 16);
  }

  /** Does the Mac have this (its protocol's minor, SINCE)? Before its welcome, only what every 1.x has. */
  supports(what: keyof typeof SINCE): boolean {
    const v = this.state.proto;
    if (!v) return this.state.mode === 'demo';
    return v.major > COMPANION_PROTO.major || (v.major === COMPANION_PROTO.major && v.minor >= SINCE[what]);
  }
  private knows(topic: Topic): boolean {
    if (isMacTopic(topic)) return this.supports('assistant');
    return topic === 'tasks' || topic.startsWith('task:') ? this.supports('tasks') : true;
  }

  // ---- projects' icons: by checksum, fetched once (companion.icon), kept across launches

  private icons = new Map<string, string>();
  private iconAsked = new Set<string>();
  /** A project's icon as a data: URI; undefined while it comes (it's asked for once), or without one. */
  cachedIcon(sum: string | undefined): string | undefined {
    if (!sum) return undefined;
    const have = this.icons.get(sum) ?? kv.get<string>(`icon:${sum}`);
    if (have) this.icons.set(sum, have);
    return have;
  }
  /** The icon, asking the Mac for it once when it isn't here yet. */
  icon(sum: string | undefined): string | undefined {
    if (!sum) return undefined;
    const have = this.cachedIcon(sum);
    if (have) return have;
    if (this.state.phase !== 'open' || this.iconAsked.has(sum) || !this.supports('icon')) return undefined;
    this.iconAsked.add(sum);
    this.call<{ sum: string; mime: string; b64: string }>(calls.icon(sum), { queue: false }).then(
      (r) => {
        if (!r?.b64) return;
        const uri = `data:${r.mime};base64,${r.b64}`;
        this.icons.set(sum, uri);
        kv.set(`icon:${sum}`, uri);
        this.emit(`icon:${sum}`);
      },
      () => this.iconAsked.delete(sum),
    );
    return undefined;
  }

  /** A screen shows `topic`: subscribe while it's mounted. */
  watch(topic: Topic): () => void {
    this.subCounts.set(topic, (this.subCounts.get(topic) ?? 0) + 1);
    this.syncSubs();
    return () => {
      const n = (this.subCounts.get(topic) ?? 1) - 1;
      if (n <= 0) this.subCounts.delete(topic);
      else this.subCounts.set(topic, n);
      this.syncSubs();
    };
  }
  private syncSubs(): void {
    // Coalesced: a screen change unmounts one topic and mounts another in the same moment.
    if (this.subTimer) return;
    this.subTimer = setTimeout(() => {
      this.subTimer = undefined;
      if (this.state.phase === 'open') this.transport?.send({ t: 'sub', topics: this.topics() });
    }, 50);
  }

  view<T>(topic: Topic): CachedView<T> | undefined {
    return this.views.get(topic) as CachedView<T> | undefined;
  }

  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistViews(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      // The list topics and the last few conversations; enough for "your Mac is asleep".
      const keep: Record<string, { data: unknown; rev: number; at: number }> = {};
      const entries = [...this.views].sort((a, b) => b[1].at - a[1].at).slice(0, 24);
      for (const [k, v] of entries) keep[k] = { data: v.data, rev: v.rev, at: v.at };
      kv.set('views', keep);
    }, 1000);
  }

  private noteOutputs(data: unknown): void {
    const walk = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      const o = x as Record<string, unknown>;
      if (typeof o.ref === 'string' && o.ref.startsWith('out:') && typeof o.kind === 'string') {
        const prev = this.latest.get(o.ref);
        this.latest.set(o.ref, o as unknown as OutputView);
        if (prev && prev.size !== o.size) this.emit(`out:${o.ref}`);
        return;
      }
      for (const v of Object.values(o)) walk(v);
    };
    walk(data);
  }

  /** The newest we know of an output (its size grows while a log is written). */
  output(ref: string): OutputView | undefined {
    return this.latest.get(ref);
  }

  // ---- needs you: answered ones hide at once

  isHidden(id: string): boolean {
    return this.hidden.has(id);
  }
  hide(id: string, hidden = true): void {
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    this.emit('hidden');
  }

  // ---- calls and the outbox

  /** Make a call; while your Mac is away it waits in the outbox (and resolves `undefined`). */
  call<T = unknown>(c: Call, opts: { queue?: boolean } = {}): Promise<T | undefined> {
    if (this.state.phase !== 'open' || !this.transport) {
      if (opts.queue === false) return Promise.reject(new Error('Your Mac is away.'));
      this.outbox = [...this.outbox, { id: `o${Date.now()}${this.seq++}`, call: c, at: Date.now() }];
      kv.set('outbox', this.outbox);
      this.emit('outbox');
      this.toast({ text: `Queued for when your Mac wakes: ${c.label}`, tone: 'info' });
      return Promise.resolve(undefined);
    }
    const id = this.seq++;
    return new Promise<T | undefined>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport!.send({ t: 'call', id, method: c.method, args: [...c.args] });
    });
  }

  /**
   * Send a file to the Mac (`put`, pieces of COMPANION_PIECE in order, one id): → its `up:` ref,
   * for companion.ask / companion.post. Only while linked (a photo isn't queued).
   */
  async put(name: string, mime: string, b64: string): Promise<string> {
    const bytes = fromB64(b64);
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('That file is too big to send (up to 25 MB).');
    if (this.state.phase !== 'open' || !this.transport) throw new Error('Your Mac is away.');
    const id = this.seq++;
    for (let off = 0; ; off += COMPANION_PIECE) {
      const piece = bytes.subarray(off, off + COMPANION_PIECE);
      const eof = off + piece.length >= bytes.length;
      const value = (await new Promise<unknown>((resolve, reject) => {
        if (!this.transport) return reject(new Error('Your Mac is away.'));
        this.pending.set(id, { resolve, reject });
        this.transport.send({ t: 'put', id, name: name.slice(0, 200) || 'photo.jpg', mime: mime.slice(0, 100), size: bytes.length, off, b64: toB64(piece), eof });
      })) as { ref?: string } | undefined;
      if (eof) {
        if (!value?.ref) throw new Error("Your Mac didn't take the file.");
        return value.ref;
      }
    }
  }

  getOutbox(): OutboxItem[] {
    return this.outbox;
  }
  discard(id: string): void {
    this.outbox = this.outbox.filter((o) => o.id !== id);
    kv.set('outbox', this.outbox);
    this.emit('outbox');
  }
  private flushOutbox(): void {
    const items = this.outbox;
    if (!items.length) return;
    this.outbox = [];
    kv.set('outbox', this.outbox);
    this.emit('outbox');
    for (const item of items) {
      this.call(item.call, { queue: false }).then(
        () => this.toast({ text: `Sent: ${item.call.label}`, tone: 'ok' }),
        (e: Error) => this.toast({ text: `${item.call.label} failed: ${e.message}`, tone: 'error' }),
      );
    }
  }

  /** Answer a needs-you item: hide it now, show it again if the Mac says no. */
  async answer(item: NeedsYou, c: Call, done: string): Promise<void> {
    this.hide(item.id);
    try {
      await this.call(c);
      this.toast({ text: done, tone: 'ok' });
    } catch (e) {
      this.hide(item.id, false);
      this.toast({ text: (e as Error).message, tone: 'error' });
    }
  }

  // ---- files

  file(ref: string, variant: 'thumb' | 'full' | 'text'): FileState | undefined {
    return this.files.get(`${ref}#${variant}`);
  }

  /** Fetch an output (cached: nothing is fetched twice). `more`: the next piece of a text file. */
  fetch(ref: string, variant: 'thumb' | 'full' | 'text', more = false): void {
    const key = `${ref}#${variant}`;
    const have = this.files.get(key);
    if (have && !more && have.status !== 'error') {
      if (have.status === 'ready' || this.state.phase !== 'open') return;
    }
    if (have?.status === 'loading' && this.state.phase === 'open' && [...this.fetches.values()].some((f) => f.key === key)) return;
    if (this.state.phase !== 'open' || !this.transport) {
      // Fetched as soon as the link opens; until then it's loading (or away, if the Mac sleeps).
      this.deferred.set(key, { ref, variant, more });
      if (!have) this.setFile(key, { status: this.state.phase === 'asleep' ? 'error' : 'loading', got: 0, error: this.state.phase === 'asleep' ? 'Your Mac is asleep' : undefined });
      return;
    }
    const off = more ? (have?.got ?? 0) : 0;
    const id = this.seq++;
    this.fetches.set(id, { key, ref, variant, parts: [], base: more ? (have?.text ?? '') : '', got: off });
    this.setFile(key, { ...(have ?? { got: 0 }), status: 'loading' });
    this.transport.send({ t: 'get', id, ref: ref as OutputView['ref'], variant, off });
  }

  private onChunk(f: MacFrame & { t: 'chunk' }): void {
    const fetch = this.fetches.get(f.id);
    if (!fetch) return;
    fetch.parts.push(f.b64);
    if (!f.eof) return;
    this.fetches.delete(f.id);
    if (fetch.variant === 'text') {
      const bytes = fromB64(fetch.parts.join(''));
      const text = fetch.base + fromUtf8(bytes);
      this.setFile(fetch.key, { status: 'ready', text, got: fetch.got + bytes.length, size: f.size, mime: f.mime });
    } else {
      this.setFile(fetch.key, { status: 'ready', uri: `data:${f.mime};base64,${fetch.parts.join('')}`, got: f.size, size: f.size, mime: f.mime });
    }
  }

  private setFile(key: string, s: FileState): void {
    this.files.set(key, s);
    this.emit(`file:${key}`);
  }

  // ---- a worktree's terminals (1.7): streamed only while their screen is open

  private termListeners = new Map<string, Set<(f: TermFrame) => void>>();
  private termsOn = new Map<string, number>();

  /**
   * Show a terminal: its output and status come to `fn` (from a clean screen first) until the
   * returned function is called. Attached again when the link opens or the app comes back.
   */
  attachTerm(key: string, fn: (f: TermFrame) => void): () => void {
    let set = this.termListeners.get(key);
    if (!set) this.termListeners.set(key, (set = new Set()));
    set.add(fn);
    this.termsOn.set(key, (this.termsOn.get(key) ?? 0) + 1);
    if (this.state.phase === 'open') this.transport?.send({ t: 'term_attach', term: key });
    return () => {
      set!.delete(fn);
      const n = (this.termsOn.get(key) ?? 1) - 1;
      if (n > 0) return void this.termsOn.set(key, n);
      this.termsOn.delete(key);
      if (this.state.phase === 'open') this.transport?.send({ t: 'term_detach', term: key });
    };
  }

  /** Keys typed on the phone, into the session the Mac shows too (dropped while the Mac is away). */
  termInput(key: string, data: string): boolean {
    if (this.state.phase !== 'open' || !this.transport || !data) return false;
    for (let at = 0; at < data.length; at += 64_000) this.transport.send({ t: 'term_input', term: key, data: data.slice(at, at + 64_000) });
    return true;
  }

  private reattachTerms(): void {
    for (const key of this.termsOn.keys()) this.transport?.send({ t: 'term_attach', term: key });
  }

  // ---- toasts

  toast(t: Omit<Toast, 'id'>): void {
    const toast = { ...t, id: this.seq++ };
    this.toasts = [...this.toasts.slice(-2), toast];
    this.emit('toasts');
    setTimeout(() => this.dismissToast(toast.id), 3600);
  }
  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit('toasts');
  }
  getToasts(): Toast[] {
    return this.toasts;
  }
}

export const store = new Store();
