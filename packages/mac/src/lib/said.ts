import type { LogItem } from '@klaud/core/store.js';

/**
 * The earlier conversation of a workspace someone shared with you arrives as system lines
 * ("bob: …"), which the terminal app shows as they are. Here each one that says who wrote it is
 * drawn as that person's (or their Claude's) message: an avatar, a name, the text.
 */
export function asChatRow(item: LogItem): LogItem {
  if (item.type !== 'system' || !item.said) return item;
  const { from, name, text, byAgent, ts } = item.said;
  return { id: item.id, type: 'chat', channel: item.channel, from, name, text, ts: ts || item.ts, byAgent };
}
