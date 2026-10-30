import type { UsageUpdate } from '../../usage.js';
import type { AgentRef, NamedUsageWindow, Usage } from '../../../protocol.js';
import { toMs } from '../claude/usage.js';

/** The agent Codex's usage is filed under (one card per runtime; the model comes from the run). */
export const CODEX_USAGE_AGENT: AgentRef = { runtime: 'codex', label: 'Codex' };

/**
 * One of Codex's plan windows. The app-server says it in camelCase (`account/rateLimits/read`,
 * `account/rateLimits/updated`); its session logs (`token_count` events) in snake_case.
 */
interface CodexWindow {
  readonly usedPercent?: number | null;
  readonly used_percent?: number | null;
  readonly windowDurationMins?: number | null;
  readonly window_minutes?: number | null;
  readonly resetsAt?: number | null;
  readonly resets_at?: number | null;
}

export interface CodexRateLimits {
  readonly primary?: CodexWindow | null;
  readonly secondary?: CodexWindow | null;
  readonly planType?: string | null;
  readonly plan_type?: string | null;
}

const FIVE_HOURS = 300;
const WEEK = 7 * 24 * 60;

/** "Daily", "Monthly", "3-hour": a window Claude's 5-hour/week pair doesn't have. */
function nameOf(mins: number | undefined): string {
  if (mins === undefined) return 'Limit';
  if (mins === 24 * 60) return 'Daily';
  if (mins >= 28 * 24 * 60 && mins <= 31 * 24 * 60) return 'Monthly';
  if (mins % (24 * 60) === 0) return `${mins / (24 * 60)}-day`;
  if (mins % 60 === 0) return `${mins / 60}-hour`;
  return `${mins}-minute`;
}

/**
 * Codex's plan windows as a usage update: its 5-hour and weekly windows land where Claude's do (so
 * friends' rows compare them), any other by its own name; the plan ("plus", "pro") as the badge.
 * Undefined when it said nothing usable (signed in with an API key: no plan windows).
 */
export function fromRateLimits(limits: CodexRateLimits | null | undefined): UsageUpdate | undefined {
  if (!limits) return undefined;
  const update: { fiveHour?: Usage['fiveHour']; week?: Usage['week']; windows?: NamedUsageWindow[]; plan?: string } = {};
  const named: NamedUsageWindow[] = [];
  for (const w of [limits.primary, limits.secondary]) {
    // Codex says percent (11.0 is 11%), never a fraction: 0.5 is half a percent, not 50 (so not toPct).
    const used = w?.usedPercent ?? w?.used_percent;
    if (!w || typeof used !== 'number' || !Number.isFinite(used)) continue;
    const resetsAt = toMs(w.resetsAt ?? w.resets_at);
    const window = { pct: Math.max(0, Math.min(100, Math.round(used))), ...(resetsAt ? { resetsAt } : {}) };
    const mins = w.windowDurationMins ?? w.window_minutes ?? undefined;
    if (mins === FIVE_HOURS && !update.fiveHour) update.fiveHour = window;
    else if (mins === WEEK && !update.week) update.week = window;
    else named.push({ label: nameOf(mins), ...window });
  }
  if (named.length) update.windows = named;
  const plan = limits.planType ?? limits.plan_type;
  if (plan) update.plan = plan.slice(0, 32);
  return update.fiveHour || update.week || update.windows ? update : undefined;
}
