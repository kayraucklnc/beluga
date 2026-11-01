/**
 * How many chats Your Mac and Sentinel each keep open as tabs (Settings › Agent › Open chats).
 * 0 means no limit. Past the limit a new chat is refused with a message that says where to raise it.
 */
export const CHAT_LIMIT_DEFAULT = 30;
/** No limit at all. */
export const CHAT_LIMIT_NONE = 0;
export const CHAT_LIMIT_MAX = 1000;
/** The choices Settings offers (No limit is CHAT_LIMIT_NONE). */
export const CHAT_LIMIT_PRESETS = [10, 30, 50, 100, CHAT_LIMIT_NONE] as const;

export const CHAT_LIMIT_WHERE = 'Settings › Agent › Open chats';

/** Whether one more chat fits beside `open` under `limit`. */
export const chatFits = (open: number, limit: number | undefined): boolean => {
  const n = limit ?? CHAT_LIMIT_DEFAULT;
  return n === CHAT_LIMIT_NONE || open < n;
};

/** "30 Your Mac chats are open, your limit. Delete one you're done with, or raise the limit in Settings › Agent › Open chats." */
export function chatLimitMessage(open: number, limit: number, what: string): string {
  const where = open > limit ? `${open} ${what} are open and your limit is ${limit}` : `${open} ${what} are open, your limit`;
  return `${where}. Delete one you’re done with, or raise the limit in ${CHAT_LIMIT_WHERE}.`;
}
