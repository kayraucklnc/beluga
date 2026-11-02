import { type ContextBreakdown, MAX_SUMMARY_CHARS, type ResponseUsage, breakdownFrom, contextTokens, contextWindowFor, windowOfRun } from '../shared/context-usage.js';

/** Claude Code tells the summary in a user message that starts like this, when it shows it at all. */
const SUMMARY_LEAD = /^This session is being continued from a previous conversation/;
const BREAKDOWN_TIMEOUT_MS = 1500;

/** Windows Claude Code reported at the end of a run, by model: the next run starts from the real size. */
const reportedWindows = new Map<string, number>();
const knownWindow = (model?: string): number => contextWindowFor(model, model ? reportedWindows.get(model) : undefined);

type Emit = (kind: 'context' | 'compact', text: string) => void;

/** A message from Claude Code, as far as the context report needs it. */
export type ContextMessage =
  | { readonly type: 'system'; readonly subtype: 'init'; readonly model?: string }
  | { readonly type: 'system'; readonly subtype: 'status'; readonly status?: string | null; readonly compact_result?: string }
  | { readonly type: 'system'; readonly subtype: 'compact_boundary'; readonly uuid?: string; readonly compact_metadata: { readonly trigger: string; readonly pre_tokens: number; readonly post_tokens?: number } }
  | { readonly type: 'assistant'; readonly parent_tool_use_id: string | null; readonly message: { readonly usage?: ResponseUsage | null } }
  | { readonly type: 'user'; readonly parent_tool_use_id: string | null; readonly message: { readonly content: unknown } }
  | { readonly type: string; readonly subtype?: string };

/**
 * Keeps a run's context meter live: what Claude saw on each response (input plus cache), the
 * model's window, compactions (with the summary Claude kept), and a breakdown when the run ends.
 */
export class ContextReport {
  private used = 0;
  private sent = -1;
  private model: string | undefined;
  private window: number;
  private compacting = false;
  /** The last compaction, so a summary that comes after it is paired with it. */
  private boundary: { key: string; summary?: string } | undefined;
  /** A summary that came before its compaction's boundary. */
  private early: string | undefined;
  private seq = 0;

  constructor(
    private readonly emit: Emit,
    model?: string,
  ) {
    this.model = model;
    this.window = knownWindow(model);
  }

  /** Tokens in the window now (after the last response or compaction). */
  get tokens(): number {
    return this.used;
  }

  observe(msg: ContextMessage): void {
    if (msg.type === 'system' && 'subtype' in msg) {
      if (msg.subtype === 'init' && 'model' in msg && msg.model) {
        this.model = msg.model;
        this.window = knownWindow(msg.model);
      }
      if (msg.subtype === 'status' && 'status' in msg) this.status(msg.status ?? null, msg.compact_result);
      if (msg.subtype === 'compact_boundary' && 'compact_metadata' in msg) this.compacted(msg.compact_metadata, msg.uuid);
    }
    if (msg.type === 'assistant' && 'message' in msg && msg.parent_tool_use_id === null) {
      const used = contextTokens((msg.message as { usage?: ResponseUsage | null }).usage ?? undefined);
      if (used > 0) {
        this.used = used;
        this.send();
      }
    }
    if (msg.type === 'user' && 'message' in msg && msg.parent_tool_use_id === null) {
      const text = textOf((msg.message as { content: unknown }).content);
      if (text && SUMMARY_LEAD.test(text)) this.summary(text);
    }
  }

  /** The run switched model mid-session (another was picked for the conversation): its window from now on. */
  switched(model: string | undefined): void {
    this.model = model;
    this.window = knownWindow(model);
    this.sent = -1;
    if (this.used) this.send();
  }

  /** Claude Code's PostCompact hook: the summary it continues from. */
  summary(text: string): void {
    const summary = text.trim().slice(0, MAX_SUMMARY_CHARS);
    if (!summary) return;
    if (!this.boundary) {
      this.early = summary;
      return;
    }
    if (this.boundary.summary) return;
    this.boundary = { ...this.boundary, summary };
    this.emit('compact', JSON.stringify({ key: this.boundary.key, summary }));
  }

  /** The run ended: its window as Claude Code reported it, and (when it can say) where the tokens come from. */
  async result(modelUsage: Readonly<Record<string, { readonly contextWindow?: number }>> | undefined, read?: () => Promise<unknown>): Promise<void> {
    this.window = windowOfRun(modelUsage, this.model);
    if (this.model && Object.values(modelUsage ?? {}).some((u) => (u.contextWindow ?? 0) > 0)) reportedWindows.set(this.model, this.window);
    const breakdown = read ? await readBreakdown(read, this.used) : undefined;
    if (!this.used) return;
    this.sent = -1;
    this.send(breakdown);
  }

  private status(status: string | null, result?: string): void {
    if (status === 'compacting' && !this.compacting) {
      this.compacting = true;
      this.emit('context', JSON.stringify({ compacting: true, window: this.window, ...(this.used ? { used: this.used } : {}) }));
    } else if (status !== 'compacting' && this.compacting && result === 'failed') {
      this.compacting = false;
      this.emit('context', JSON.stringify({ compacting: false, window: this.window, ...(this.used ? { used: this.used } : {}) }));
    }
  }

  private compacted(meta: { readonly trigger: string; readonly pre_tokens: number; readonly post_tokens?: number }, uuid?: string): void {
    this.compacting = false;
    const key = uuid ?? `c${++this.seq}`;
    const summary = this.early;
    this.early = undefined;
    this.boundary = { key, ...(summary ? { summary } : {}) };
    this.used = meta.post_tokens ?? 0;
    this.sent = this.used;
    this.emit('compact', JSON.stringify({ pre: meta.pre_tokens, post: this.used, trigger: meta.trigger === 'auto' ? 'auto' : 'manual', key, window: this.window, ...(summary ? { summary } : {}) }));
  }

  private send(breakdown?: ContextBreakdown): void {
    if (this.used === this.sent && !breakdown) return;
    this.sent = this.used;
    this.emit('context', JSON.stringify({ used: this.used, window: this.window, ...(this.model ? { model: this.model } : {}), ...(breakdown ? { breakdown } : {}) }));
  }
}

/** The text of a message's content (a string, or its text blocks). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: unknown) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('');
}

/** Ask Claude Code where the tokens come from (its /context data), briefly; nothing if it can't say. */
export async function readBreakdown(read: () => Promise<unknown>, used: number): Promise<ContextBreakdown | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), BREAKDOWN_TIMEOUT_MS);
      timer.unref?.();
    });
    const report = await Promise.race([read(), timeout]);
    return breakdownFrom(report as Parameters<typeof breakdownFrom>[0], used);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A prompt that is Claude Code's /compact command (sent as is, so Claude Code runs it). */
export const isCompactCommand = (prompt: string): boolean => /^\/compact(\s|$)/.test(prompt.trim());

/** The Claude Code session's breakdown call, when this version has it (`detail: 'summary'` answers locally). */
export function breakdownReader(q: unknown): (() => Promise<unknown>) | undefined {
  const get = (q as { getContextUsage?: (opts?: { detail?: 'summary' | 'full' }) => Promise<unknown> }).getContextUsage;
  return typeof get === 'function' ? () => get.call(q, { detail: 'summary' }) : undefined;
}
