import type { CcStep, CcSteps } from './model.js';
import { Tail, type TailOptions, headLines } from './tail.js';
import { type Facts, type Launch, type TaskNotice, type ToolResult, factsOf, parseLine } from './transcript.js';

/**
 * One transcript being watched (a session, or one of its sub-agents): reads what was added,
 * keeps its last steps (bounded), its title, folder, last activity, and what it says about the
 * sub-agents it started. Reads only; never writes.
 */

/** Steps kept per transcript (older ones drop off). */
export const MAX_STEPS = 200;
/** A note repeated this close (the same task reporting back through two channels) shows once. */
const NOTE_DEDUPE = 12;
/** Tool results looked for this far back. */
const RESULT_LOOKBACK = 80;

export interface PageOptions {
  /** Steps before this seq (older). */
  readonly before?: number;
  /** Steps after this seq (newer); wins over `before`. */
  readonly after?: number;
  readonly limit?: number;
}

export class TranscriptTracker {
  private readonly tail: Tail;
  private steps: CcStep[] = [];
  private seq = 0;
  private headRead = false;
  /** Claude Code's title, a summary's, and the first message (best first). */
  private aiTitle?: string;
  private summaryTitle?: string;
  private firstMessage?: string;
  /** The folder it started in (the head) and the latest one. */
  private homeCwd?: string;
  private lastCwd?: string;
  startedAt?: number;
  /** The newest entry's time. */
  private lastTs = 0;
  tokens?: number;
  model?: string;
  /** Claude ended its turn and nothing came after. */
  final = false;
  /** Steps seen in all (the kept ones are the newest MAX_STEPS). */
  count = 0;
  /** Sub-agents it started, how their tool calls ended, and background tasks reporting back. */
  readonly launches = new Map<string, Launch>();
  readonly results = new Map<string, ToolResult>();
  readonly notices = new Map<string, TaskNotice>();

  constructor(
    readonly file: string,
    opts: TailOptions = {},
  ) {
    this.tail = new Tail(file, opts);
  }

  get title(): string | undefined {
    return this.aiTitle ?? this.summaryTitle ?? this.firstMessage;
  }

  get cwd(): string | undefined {
    return this.homeCwd ?? this.lastCwd;
  }

  /** Last activity: the newest entry, or the file's last write if later. */
  get lastAt(): number {
    return Math.max(this.lastTs, this.tail.mtime);
  }

  /** What it's doing (or did last), in words. */
  get current(): string | undefined {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i]!;
      if (s.kind === 'tool' || s.kind === 'text') return s.kind === 'text' ? firstWords(s.text) : s.text;
    }
    return undefined;
  }

  /** Read what was added. Returns the facts of the new lines (callers react to launches, notices…). */
  update(): Facts[] {
    if (!this.headRead) this.readHead();
    const facts = this.tail.read().flatMap((line) => {
      const entry = parseLine(line);
      return entry ? [factsOf(entry, this.cwd)] : [];
    });
    for (const f of facts) this.apply(f);
    return facts;
  }

  /** How the transcript starts: the folder, when, and the first message (the tail may begin much later). */
  private readHead(): void {
    this.headRead = true;
    for (const line of headLines(this.file)) {
      const entry = parseLine(line);
      if (!entry) continue;
      const f = factsOf(entry);
      if (f.ts !== undefined && this.startedAt === undefined) this.startedAt = f.ts;
      if (f.cwd && !this.homeCwd) this.homeCwd = f.cwd;
      if (f.title && !this.firstMessage) this.firstMessage = f.title;
      if (f.aiTitle) this.aiTitle = f.aiTitle;
      if (this.homeCwd && this.firstMessage && this.startedAt !== undefined) break;
    }
  }

  private apply(f: Facts): void {
    if (f.ts !== undefined) {
      this.startedAt ??= f.ts;
      this.lastTs = Math.max(this.lastTs, f.ts);
    }
    if (f.cwd) this.lastCwd = f.cwd;
    if (f.aiTitle) this.aiTitle = f.aiTitle;
    if (f.title && !f.steps.length) this.summaryTitle = f.title;
    if (f.title && f.steps.length) this.firstMessage ??= f.title;
    if (f.tokens) this.tokens = f.tokens;
    if (f.model) this.model = f.model;
    if (f.final !== undefined) this.final = f.final;
    for (const l of f.launches) this.launches.set(l.toolUseId, l);
    for (const n of f.notices) {
      const old = this.notices.get(n.taskId);
      if (!old || old.ts <= n.ts) this.notices.set(n.taskId, n);
    }
    for (const r of f.results) {
      this.settle(r);
      if (r.async || r.agentId || this.launches.has(r.toolUseId)) this.results.set(r.toolUseId, r);
    }
    for (const draft of f.steps) this.push(draft);
  }

  /** A tool call ended: its step shows done or failed. */
  private settle(r: ToolResult): void {
    for (let i = this.steps.length - 1; i >= Math.max(0, this.steps.length - RESULT_LOOKBACK); i--) {
      const s = this.steps[i]! as CcStep & { toolUseId?: string };
      if (s.toolUseId !== r.toolUseId) continue;
      // An agent sent to the background keeps "running" in its own transcript, not here.
      this.steps[i] = { ...s, status: r.error ? 'error' : 'done' };
      return;
    }
  }

  private push(draft: CcStep | (Omit<CcStep, 'seq'> & { toolUseId?: string })): void {
    if (draft.kind === 'note' && this.steps.slice(-NOTE_DEDUPE).some((s) => s.kind === 'note' && s.text === draft.text)) return;
    this.count++;
    this.steps.push({ ...draft, seq: ++this.seq } as CcStep);
    if (this.steps.length > MAX_STEPS) this.steps = this.steps.slice(-MAX_STEPS);
  }

  /** A page of the kept steps (see PageOptions), without internal fields. */
  page(opts: PageOptions = {}): CcSteps {
    const limit = Math.max(1, Math.min(MAX_STEPS, opts.limit ?? MAX_STEPS));
    const clean = (s: CcStep): CcStep => {
      const { toolUseId: _id, ...rest } = s as CcStep & { toolUseId?: string };
      return rest;
    };
    const oldest = this.steps[0]?.seq ?? 0;
    const after = opts.after;
    const before = opts.before;
    const pool = after !== undefined ? this.steps.filter((s) => s.seq > after) : before !== undefined ? this.steps.filter((s) => s.seq < before) : this.steps;
    const page = pool.slice(-limit);
    return { steps: page.map(clean), more: page.length > 0 && page[0]!.seq > oldest };
  }
}

/** The start of Claude's words, for "what it's doing". */
function firstWords(text: string, max = 120): string {
  const line = text.split('\n').map((l) => l.replace(/[*_`#>]/g, '').trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
