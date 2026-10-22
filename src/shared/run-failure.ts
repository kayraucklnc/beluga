import { isLimitNotice } from './claude-notices.js';

/**
 * How a run of Claude's ended when it didn't finish: it hit your usage limit (and when that
 * resets), Claude Code crashed (its exit code and last stderr lines), the network or Anthropic's
 * API failed, or you stopped it. Never a bare "exit code 1". The runner classifies (see
 * agent/runner.ts), the failed card's words carry it (a readable first line, the facts after a
 * marker), and screens and plans read it back. Browser-safe.
 */

export type RunFailureKind = 'usage_limit' | 'crash' | 'network' | 'api' | 'stopped';

export interface RunFailure {
  readonly kind: RunFailureKind;
  /** Usage limit: when it resets (epoch ms), when known. */
  readonly resetsAt?: number;
  /** Crash: Claude Code's exit code. */
  readonly exitCode?: number;
  /** The raw error, with Claude Code's last stderr lines (Show details). */
  readonly detail: string;
}

/** What Continue (and an automatic resume) sends: the same session goes on. */
export const CONTINUE_PROMPT = 'Continue where you left off.';

/** A crashed run is retried once, this long after it stopped. */
export const CRASH_RETRY_MS = 30_000;

const MARK = '⁣klaud-failure:';
const STDERR_LINES = 12;

/** "15:00" (local time). */
const hhmm = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** "15:00", or "Oct 24, 15:00" when it isn't today. */
export function resetWords(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  return today ? hhmm(at) : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${hhmm(at)}`;
}

/** The card's headline: "Claude hit your usage limit · resets at 15:00". */
export function failureTitle(f: RunFailure, now = Date.now()): string {
  switch (f.kind) {
    case 'usage_limit':
      return `Claude hit your usage limit${f.resetsAt ? ` · resets at ${resetWords(f.resetsAt, now)}` : ''}`;
    case 'crash':
      return `Claude Code stopped unexpectedly${f.exitCode !== undefined ? ` (exit ${f.exitCode})` : ''}`;
    case 'network':
      return 'Claude lost its connection to Anthropic';
    case 'api':
      return `Anthropic's API failed: ${firstLine(f.detail).slice(0, 120) || 'unknown error'}`;
    case 'stopped':
      return 'Stopped by you';
  }
}

/** A failure as a failed card's words: a readable line (for anyone, the TUI too), then the facts. */
export function encodeFailure(f: RunFailure, now = Date.now()): string {
  return `${failureTitle(f, now)}\n\n${MARK}${JSON.stringify(f)}`;
}

/** A failed card's words back as a failure (undefined: an older or plain error text). */
export function decodeFailure(text: string | undefined): RunFailure | undefined {
  const at = text?.lastIndexOf(MARK) ?? -1;
  if (!text || at < 0) return undefined;
  try {
    const f = JSON.parse(text.slice(at + MARK.length)) as RunFailure;
    return typeof f.kind === 'string' && typeof f.detail === 'string' ? f : undefined;
  } catch {
    return undefined;
  }
}

/** A failed card's words without the facts (what people read). */
export const failureText = (text: string): string => {
  const at = text.lastIndexOf(MARK);
  return at < 0 ? text : text.slice(0, at).trim();
};

const firstLine = (s: string): string => s.trim().split('\n')[0]?.trim() ?? '';

/**
 * When a limit notice says it resets: "…|1760000000" (epoch seconds), "resets 3pm", "resets at
 * 15:00", "resets 9:30pm (Europe/Istanbul)", "resets Oct 24". The next such time after `now`.
 */
export function resetFromText(text: string, now = Date.now()): number | undefined {
  const epoch = /limit reached\|(\d{9,13})/i.exec(text);
  if (epoch) return epoch[1]!.length > 10 ? Number(epoch[1]) : Number(epoch[1]) * 1000;
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (clock && (clock[2] || clock[3])) {
    let h = Number(clock[1]);
    const m = Number(clock[2] ?? 0);
    const ampm = clock[3]?.toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h > 23 || m > 59) return undefined;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const day = /resets?\s+(?:on\s+)?([A-Z][a-z]{2,8}\s+\d{1,2})\b/.exec(text);
  if (day) {
    const t = Date.parse(`${day[1]} ${new Date(now).getFullYear()}`);
    if (!Number.isNaN(t)) return t > now ? t : new Date(t).setFullYear(new Date(t).getFullYear() + 1);
  }
  return undefined;
}

const NETWORK = /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network error|connection error|getaddrinfo)\b/i;
const EXIT = /exited with code (-?\d+)|terminated by signal (\w+)/i;
const API_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'overloaded', 'invalid_request', 'model_not_found', 'server_error', 'cloud_credential_error']);

/** What the runner saw before a run ended. */
export interface RunEnd {
  /** The error thrown (Claude Code's own: "Claude Code process exited with code 1. stderr: …"). */
  readonly error?: string;
  /** A failed turn's text (an API error, Claude Code's limit notice). */
  readonly result?: string;
  /** The error kind Claude Code put on its last message ("rate_limit", "overloaded"…). */
  readonly apiError?: string;
  /** A rate_limit_event that said no: when that limit resets (0: unknown). */
  readonly rejectedUntil?: number;
  /** Claude Code's last stderr lines. */
  readonly stderr?: readonly string[];
  /** You (or a newer message) stopped it. */
  readonly stopped?: boolean;
}

/** How a run ended, in one of five kinds; never a bare "exit code 1". */
export function classifyRun(end: RunEnd, now = Date.now()): RunFailure {
  const stderr = (end.stderr ?? []).slice(-STDERR_LINES).join('\n').trim();
  const said = [end.result, end.error].filter(Boolean).join('\n').trim();
  const detail = [said, stderr && !said.includes(stderr) ? `stderr:\n${stderr}` : ''].filter(Boolean).join('\n\n').slice(0, 8000) || 'No error text';
  if (end.stopped) return { kind: 'stopped', detail };
  const all = [said, stderr].join('\n');
  const limitLine = all.split('\n').find((l) => isLimitNotice(l));
  if (end.rejectedUntil !== undefined || end.apiError === 'rate_limit' || limitLine) {
    const resetsAt = end.rejectedUntil || (limitLine ? resetFromText(limitLine, now) : undefined) || resetFromText(all, now);
    return { kind: 'usage_limit', ...(resetsAt ? { resetsAt } : {}), detail };
  }
  if (NETWORK.test(all)) return { kind: 'network', detail };
  if (end.apiError && API_ERRORS.has(end.apiError)) return { kind: 'api', detail };
  const exit = EXIT.exec(end.error ?? '');
  if (exit || end.error) return { kind: 'crash', ...(exit?.[1] !== undefined ? { exitCode: Number(exit[1]) } : {}), detail };
  return { kind: 'api', detail };
}

/** An error that carries how the run ended (its message is the card's words). */
export class RunFailedError extends Error {
  constructor(readonly failure: RunFailure) {
    super(encodeFailure(failure));
  }
}
