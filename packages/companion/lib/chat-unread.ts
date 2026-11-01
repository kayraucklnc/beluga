import { useEffect, useMemo, useState } from 'react';
import { unreadSince } from '../../../src/shared/unread';
import type { CachedView } from './store';
import type { ChatView, Topic } from './link/protocol';

/** How long to wait for the Mac's view after opening a chat before going on without its count (offline). */
const FRESH_WAIT_MS = 3000;

interface Entry {
  readonly topic: Topic;
  readonly count: number;
  readonly upTo?: string | undefined;
}

/**
 * What was new when you opened a chat (BLG-574), as the Mac marks it: taken from the first view
 * the Mac sends after you opened it (the one kept from your last visit is older), so it's known
 * before the chat is marked read (`ready`). What comes in while you're there isn't marked.
 */
export function useUnreadOnOpen(topic: Topic, view: CachedView<ChatView> | undefined): { readonly unread: ReadonlySet<string>; readonly ready: boolean } {
  const opened = useMemo(() => Date.now(), [topic]);
  const [entry, setEntry] = useState<Entry | undefined>();
  const current = entry?.topic === topic ? entry : undefined;
  const c = view?.data;
  if (!current && c && view && !view.stale && view.at >= opened) setEntry({ topic, count: c.unread ?? 0, upTo: c.messages.at(-1)?.id });
  useEffect(() => {
    const t = setTimeout(() => setEntry((e) => (e?.topic === topic ? e : { topic, count: 0 })), FRESH_WAIT_MS);
    return () => clearTimeout(t);
  }, [topic]);
  const unread = useMemo(() => (current && c ? unreadSince(c.messages, current.count, current.upTo) : new Set<string>()), [c?.messages, current]);
  return { unread, ready: Boolean(current) };
}
