// How full a conversation's context window is, and when to compact it. Pure (no Node), so the
// core, the agent runner and the Mac app count the same way.

/** Claude's context window when nothing better is known (older models). */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** The long-context window: the Claude 5 family, Opus 4.6+, Sonnet 4.6, and any `[1m]` pick. */
export const LONG_CONTEXT_WINDOW = 1_000_000;

/**
 * Models whose window is 1M without a `[1m]` suffix: every Claude 5 model (Fable, Mythos, Opus,
 * Sonnet, Haiku 5.x), Opus 4.6–4.8 and Sonnet 4.6, by id or by Claude Code's alias (`opus`,
 * `sonnet`, `haiku`, `fable` pick the current 5.x model). Provider prefixes and suffixes
 * (`us.anthropic.…`, `…-v1:0`, `…@date`) don't matter. Haiku 4.5 and older stay at 200k.
 */
const LONG_CONTEXT_MODEL = /claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5|opus-4-[678]|sonnet-4-6)(?!\d)/i;
const LONG_CONTEXT_ALIAS = /^(?:opus|sonnet|haiku|fable|opusplan)$/i;

/** Auto-compact threshold: the range the setting allows, and where it starts. */
export const AUTO_COMPACT_MIN = 70;
export const AUTO_COMPACT_MAX = 95;
export const AUTO_COMPACT_DEFAULT = 85;

/** Where the meter turns amber, then red (percent used). */
export const CONTEXT_WARN_PCT = 70;
export const CONTEXT_FULL_PCT = 90;

/** Longest summary kept with a compaction divider (it travels inside one agent event). */
export const MAX_SUMMARY_CHARS = 40_000;

/**
 * What Claude is asked to keep when it compacts: the working memory that matters, so nothing
 * you agreed on is lost (the chat itself always stays on screen).
 */
export const COMPACT_INSTRUCTIONS =
  'Keep every decision made and why, the open tasks and next steps, the files and paths touched and what changed in them, commands and results that matter, errors still unresolved, and anything the user asked you to remember.';

/** Where the context comes from, roughly (for the meter's breakdown). */
export interface ContextBreakdown {
  /** What you and Claude said. */
  readonly conversation: number;
  /** Tool calls and what they returned (file reads, command output…). */
  readonly tools: number;
  /** Claude Code's system prompt, tools, CLAUDE.md and memory files. */
  readonly system: number;
}

/** The token counts on one model response (Messages API names). */
export interface ResponseUsage {
  readonly input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
}

/**
 * What the model actually saw on its last request: fresh input plus what came from the prompt
 * cache (read and newly written). Output isn't counted: it isn't in the window until the next turn.
 */
export function contextTokens(u: ResponseUsage | undefined): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/**
 * A model's context window: what Claude Code reported for it when it did, else from its id
 * (`…[1m]` or `…-1m` picks the 1M window, as do the 1M models above), else 200k.
 */
export function contextWindowFor(model?: string, reported?: number): number {
  if (reported && reported > 0) return reported;
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  if (/(\[1m\]|-1m\b)/i.test(model)) return LONG_CONTEXT_WINDOW;
  return LONG_CONTEXT_MODEL.test(model) || LONG_CONTEXT_ALIAS.test(model.trim()) ? LONG_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

/** The window of the main model among a run's per-model usage (the largest: helpers are smaller or equal). */
export function windowOfRun(modelUsage: Readonly<Record<string, { readonly contextWindow?: number }>> | undefined, model?: string): number {
  const reported = Math.max(0, ...Object.values(modelUsage ?? {}).map((u) => u.contextWindow ?? 0));
  return contextWindowFor(model, reported);
}

/** Percent of the window in use, 0–100 (whole numbers; never NaN). */
export function contextPct(info: { readonly used: number; readonly window: number } | undefined): number {
  if (!info || !(info.window > 0) || !(info.used > 0)) return 0;
  return Math.min(100, Math.round((info.used / info.window) * 100));
}

export type ContextTone = 'normal' | 'warn' | 'full';

/** Neutral, then amber at 70%, red at 90%. */
export const contextTone = (pct: number): ContextTone => (pct >= CONTEXT_FULL_PCT ? 'full' : pct >= CONTEXT_WARN_PCT ? 'warn' : 'normal');

/** A threshold from settings, kept inside the allowed range. */
export const clampThreshold = (pct: number | undefined): number =>
  Math.min(AUTO_COMPACT_MAX, Math.max(AUTO_COMPACT_MIN, Math.round(Number.isFinite(pct) ? (pct as number) : AUTO_COMPACT_DEFAULT)));

/**
 * Should Beluga compact this conversation now? Only with auto-compact on, the context known and at
 * or past the threshold, nothing compacting already, and not again before Claude has run since
 * the last try (a conversation whose summary is still big would otherwise loop).
 */
export function autoCompactDue(opts: { readonly on: boolean; readonly at: number; readonly info?: { readonly used: number; readonly window: number; readonly compacting?: boolean }; readonly triedSinceRun?: boolean }): boolean {
  if (!opts.on || !opts.info || opts.info.compacting || opts.triedSinceRun) return false;
  return contextPct(opts.info) >= clampThreshold(opts.at);
}

/** Environment for Claude Code so its own auto-compact follows the same threshold. */
export const compactEnv = (on: boolean, at: number): Record<string, string> => (on ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(clampThreshold(at)) } : {});

/** "128k", "1.2M", "940". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.max(0, Math.round(n)));
}

/** Claude Code's /context categories → our three rows, scaled so they add up to `used`. */
export function breakdownFrom(
  report: { readonly categories?: ReadonlyArray<{ readonly name: string; readonly tokens: number; readonly kind?: string }>; readonly messageBreakdown?: { readonly toolCallTokens?: number; readonly toolResultTokens?: number } } | undefined,
  used: number,
): ContextBreakdown | undefined {
  const rows = (report?.categories ?? []).filter((c) => (c.kind ?? 'used') === 'used' && c.tokens > 0);
  if (!rows.length) return undefined;
  const messages = rows.filter((c) => /^messages$/i.test(c.name)).reduce((n, c) => n + c.tokens, 0);
  const system = rows.reduce((n, c) => n + c.tokens, 0) - messages;
  const tools = Math.min(messages, (report?.messageBreakdown?.toolCallTokens ?? 0) + (report?.messageBreakdown?.toolResultTokens ?? 0));
  const total = messages + system;
  if (total <= 0) return undefined;
  const scale = used > 0 ? used / total : 1;
  const conversation = Math.round((messages - tools) * scale);
  const toolPart = Math.round(tools * scale);
  return { conversation, tools: toolPart, system: Math.max(0, Math.round(total * scale) - conversation - toolPart) };
}
