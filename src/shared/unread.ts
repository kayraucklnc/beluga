/**
 * What was new when you came into a chat, for the Mac's and the phone's "New messages" line
 * (BLG-573, BLG-574): the last `count` of their messages, up to the one that was last then
 * (`upTo`; what arrives while you're there is read as it comes).
 */
export function unreadSince(messages: readonly { readonly id: string; readonly mine: boolean }[], count: number, upTo?: string): ReadonlySet<string> {
  if (count <= 0) return new Set();
  const end = upTo === undefined ? -1 : messages.findIndex((m) => m.id === upTo);
  const then = end < 0 ? messages : messages.slice(0, end + 1);
  return new Set(
    then
      .filter((m) => !m.mine)
      .slice(-count)
      .map((m) => m.id),
  );
}

/** The line above them: "New message", "3 new messages". */
export const unreadLine = (count: number): string => (count === 1 ? 'New message' : `${count} new messages`);
