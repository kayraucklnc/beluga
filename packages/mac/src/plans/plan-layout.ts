/**
 * How a plan's page is laid out, as plain data: canvas or list, whether each plan's chat is open,
 * and how wide the chat is. Saved in localStorage; no DOM here, so it's tested on its own.
 */

export type Display = 'graph' | 'outline';

export interface PlanLayout {
  readonly display: Display;
  /** Each plan's chat that you closed (open is the default, so only the closed ones are kept). */
  readonly closed: readonly string[];
  /** The chat column's width, in pixels (one for every plan). */
  readonly chatWidth: number;
}

export const PLAN_LAYOUT_KEY = 'beluga.plan.v1';
export const CHAT_MIN = 300;
export const CHAT_DEFAULT = 380;
/** The chat never takes more than this share of the plan's width: the map stays the bigger part. */
export const CHAT_MAX_SHARE = 0.5;
/** How many closed chats are remembered (the oldest are forgotten). */
const REMEMBERED = 200;

export const DEFAULT_PLAN_LAYOUT: PlanLayout = { display: 'graph', closed: [], chatWidth: CHAT_DEFAULT };

/** A saved layout made whole (older versions kept one `chat` flag for every plan: closed then means closed nowhere yet). */
export function readPlanLayout(raw: unknown): PlanLayout {
  const r = (raw ?? {}) as { display?: unknown; closed?: unknown; chatWidth?: unknown };
  return {
    display: r.display === 'outline' ? 'outline' : 'graph',
    closed: Array.isArray(r.closed) ? r.closed.filter((x): x is string => typeof x === 'string').slice(-REMEMBERED) : [],
    chatWidth: typeof r.chatWidth === 'number' && Number.isFinite(r.chatWidth) ? Math.max(CHAT_MIN, Math.round(r.chatWidth)) : CHAT_DEFAULT,
  };
}

export const chatOpen = (layout: PlanLayout, planId: string): boolean => !layout.closed.includes(planId);

/** Open or close one plan's chat. */
export function setChatOpen(layout: PlanLayout, planId: string, open: boolean): PlanLayout {
  const rest = layout.closed.filter((x) => x !== planId);
  return { ...layout, closed: open ? rest : [...rest, planId].slice(-REMEMBERED) };
}

/** The chat's width beside a plan area this wide: at least CHAT_MIN, at most CHAT_MAX_SHARE of it. */
export function clampChatWidth(width: number, areaWidth: number): number {
  const max = Math.max(CHAT_MIN, Math.floor(areaWidth * CHAT_MAX_SHARE));
  return Math.round(Math.min(max, Math.max(CHAT_MIN, Number.isFinite(width) ? width : CHAT_DEFAULT)));
}
