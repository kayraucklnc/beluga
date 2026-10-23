import type { CcStep, CcSteps } from './model.js';
import { Tail, type TailOptions, headLines } from './tail.js';
import { type Facts, type Launch, type Sent, type StepDetail, type StepDraft, type TaskNotice, type ToolResult, factsOf, parseLine } from './transcript.js';
import { type StepRecord, sizeOf, thinkingTitle } from '../../shared/steps.js';
import { OutputLog } from './outputs.js';
import type { BgLaunch } from './tasks.js';

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
/** Characters of step details (inputs, outputs, thinking) kept per transcript; the oldest go first. */
export const MAX_DETAIL_CHARS = 2_000_000;
/** Background commands remembered per transcript (the oldest go first). */
const MAX_BG = 60;
/** Messages sent (SendMessage) remembered per transcript, for a team's timeline. */
const MAX_SENDS = 40;

/** Who sent or got a message, in words: the lead session, else what the watcher knows the agent as. */
export type Labeler = (who: string) => string;
export const leadLabel = (who: string): string | undefined => (who === 'lead' || who === 'main' ? 'the lead session' : undefined);

/** Thinking that seems to have taken longer than this was really a pause (you away): no duration. */
const MAX_THINKING_MS = 10 * 60_000;

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
  /** The effort its last answer ran at. */
  effort?: string;
  /** Claude ended its turn and nothing came after. */
  final = false;
  /** Steps seen in all (the kept ones are the newest MAX_STEPS). */
  count = 0;
  /** Sub-agents it started, how their tool calls ended, and background tasks reporting back. */
  readonly launches = new Map<string, Launch>();
  readonly results = new Map<string, ToolResult>();
  readonly notices = new Map<string, TaskNotice>();
  /** Messages it sent to other sessions (SendMessage), oldest first. */
  sends: Sent[] = [];
  /** Files it made or looked at (screenshots, logs, test output). */
  readonly outputs = new OutputLog();
  /** Background commands and watches it started, by the tool call that started each (newest last; bounded). */
  readonly bg = new Map<string, BgLaunch>();
  /** Names agents (set by the watcher, which knows them); ids show as they are without it. */
  labeler?: Labeler;
  /** What opening a step shows, by seq (bounded: see MAX_DETAIL_CHARS). */
  private readonly details = new Map<number, StepDetail>();
  private detailChars = 0;

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

  /** What it's doing (or did last), in words. A message it was woken by counts. */
  get current(): string | undefined {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i]!;
      if (s.kind === 'message') return `${s.report ? 'Report' : 'Message'} from ${this.label(s.from ?? '')}: ${firstWords(s.text)}`;
      if (s.kind === 'tool' || s.kind === 'text') return s.kind === 'text' ? firstWords(s.text) : this.named(s).text;
    }
    return undefined;
  }

  private label(who: string): string {
    return leadLabel(who) ?? this.labeler?.(who) ?? who;
  }

  /** A step with the agents it mentions by name: who sent a message, whom a message went to. */
  private named(s: CcStep): CcStep {
    if (s.kind === 'message') return { ...s, who: this.label(s.from ?? '') };
    if (s.to && s.text.startsWith(`→ sent to ${s.to}`)) return { ...s, text: `→ sent to ${this.label(s.to)}${s.text.slice(`→ sent to ${s.to}`.length)}` };
    return s;
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
    const before = this.lastTs;
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
    if (f.effort) this.effort = f.effort;
    if (f.final !== undefined) this.final = f.final;
    for (const l of f.launches) this.launches.set(l.toolUseId, l);
    if (f.outputs?.length) this.outputs.add(f.outputs);
    for (const b of f.bg ?? []) {
      this.bg.set(b.toolUseId, b);
      if (this.bg.size > MAX_BG) this.bg.delete(this.bg.keys().next().value!);
    }
    if (f.sends?.length) this.sends = [...this.sends, ...f.sends].slice(-MAX_SENDS);
    for (const n of f.notices) {
      const old = this.notices.get(n.taskId);
      if (!old || old.ts <= n.ts) this.notices.set(n.taskId, n);
    }
    for (const r of f.results) {
      this.settle(r);
      if (r.async || r.agentId || r.taskId || this.launches.has(r.toolUseId)) this.results.set(r.toolUseId, r);
    }
    for (const draft of f.steps) this.push(draft.kind === 'thinking' ? withThinkingTime(draft, before) : draft);
  }

  /** A tool call ended: its step shows done or failed. */
  private settle(r: ToolResult): void {
    for (let i = this.steps.length - 1; i >= Math.max(0, this.steps.length - RESULT_LOOKBACK); i--) {
      const s = this.steps[i]! as CcStep & { toolUseId?: string };
      if (s.toolUseId !== r.toolUseId) continue;
      // An agent sent to the background keeps "running" in its own transcript, not here.
      this.steps[i] = { ...s, status: r.error ? 'error' : 'done', ...(r.ts >= s.ts && s.ts ? { durationMs: r.ts - s.ts } : {}) };
      if (r.output !== undefined) {
        const old = this.details.get(s.seq);
        this.keepDetail(s.seq, { ...old, output: r.output, ...(r.truncated || old?.truncated ? { truncated: true } : {}) });
      }
      return;
    }
  }

  private push(draft: StepDraft): void {
    // The same note or message arriving twice (through two channels) shows once.
    if ((draft.kind === 'note' || draft.kind === 'message') && this.steps.slice(-NOTE_DEDUPE).some((s) => s.kind === draft.kind && s.text === draft.text && s.from === draft.from)) return;
    this.count++;
    const { details, ...step } = draft;
    const seq = ++this.seq;
    this.steps.push({ ...step, seq } as CcStep);
    if (details) this.keepDetail(seq, details);
    if (this.steps.length > MAX_STEPS) {
      this.steps = this.steps.slice(-MAX_STEPS);
      const oldest = this.steps[0]!.seq;
      for (const k of [...this.details.keys()]) if (k < oldest) this.dropDetail(k);
    }
  }

  private keepDetail(seq: number, d: StepDetail): void {
    this.dropDetail(seq);
    this.details.set(seq, d);
    this.detailChars += detailSize(d);
    // Too much kept: the oldest steps lose their details (they still show their line).
    for (const k of this.details.keys()) {
      if (this.detailChars <= MAX_DETAIL_CHARS || k === seq) break;
      this.dropDetail(k);
    }
  }

  private dropDetail(seq: number): void {
    const old = this.details.get(seq);
    if (!old) return;
    this.detailChars -= detailSize(old);
    this.details.delete(seq);
  }

  /** One kept step with what opening it shows, as the same record Beluga's own runs keep (shared/steps.ts). */
  detail(seq: number): StepRecord | undefined {
    const s = this.steps.find((x) => x.seq === seq);
    if (!s || (s.kind !== 'tool' && s.kind !== 'thinking')) return undefined;
    const d = this.details.get(seq);
    const base = { id: String(seq), title: s.kind === 'thinking' ? thinkingTitle(s.durationMs, Boolean(s.hidden)) : s.text, status: s.status ?? 'done', startedAt: s.ts, ...(s.durationMs !== undefined ? { durationMs: s.durationMs, endedAt: s.ts + s.durationMs } : {}) } as const;
    if (s.kind === 'thinking') return { ...base, kind: 'thinking', ...(s.hidden ? { hidden: true } : {}), ...(d?.text !== undefined ? { text: d.text } : {}), ...(d?.truncated ? { truncated: true } : {}) };
    return {
      ...base,
      kind: 'tool',
      ...(s.tool ? { tool: s.tool } : {}),
      ...(d?.input ? { input: d.input } : {}),
      ...(d?.output !== undefined ? { output: d.output } : {}),
      ...(s.status === 'error' ? { isError: true } : {}),
      // Details dropped to stay small, or cut to fit.
      ...(d?.truncated || !d ? { truncated: true } : {}),
    };
  }

  /** A page of the kept steps (see PageOptions), without internal fields. */
  page(opts: PageOptions = {}): CcSteps {
    const limit = Math.max(1, Math.min(MAX_STEPS, opts.limit ?? MAX_STEPS));
    const clean = (s: CcStep): CcStep => {
      const { toolUseId: _id, ...rest } = s as CcStep & { toolUseId?: string };
      // Opening it shows something only while its details are kept.
      return this.named(rest.detail && !this.details.has(rest.seq) ? { ...rest, detail: false } : rest);
    };
    const oldest = this.steps[0]?.seq ?? 0;
    const after = opts.after;
    const before = opts.before;
    const pool = after !== undefined ? this.steps.filter((s) => s.seq > after) : before !== undefined ? this.steps.filter((s) => s.seq < before) : this.steps;
    const page = pool.slice(-limit);
    return { steps: page.map(clean), more: page.length > 0 && page[0]!.seq > oldest };
  }
}

const detailSize = (d: StepDetail): number => sizeOf({ id: '', kind: 'tool', title: '', status: 'done', startedAt: 0, ...d });

/** Thinking took from the entry before it until it was written (unless that's an implausibly long pause). */
function withThinkingTime(draft: StepDraft, before: number): StepDraft {
  const ms = before && draft.ts ? draft.ts - before : -1;
  const durationMs = ms >= 0 && ms <= MAX_THINKING_MS ? ms : undefined;
  return { ...draft, text: thinkingTitle(durationMs, Boolean(draft.hidden)), ...(durationMs !== undefined ? { durationMs } : {}) };
}

/** The start of Claude's words, for "what it's doing". */
function firstWords(text: string, max = 120): string {
  const line = text.split('\n').map((l) => l.replace(/[*_`#>]/g, '').trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
