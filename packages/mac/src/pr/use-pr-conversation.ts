import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { PrConversation, PrThread } from '@beluga/core/work-store.js';
import { useApi, useApp } from '../lib/beluga.js';
import { everyWhileShown } from '../lib/window-active.js';

/**
 * A worktree's PR conversation, kept per worktree for the window: the strip above the chat and
 * the panel share it. Asked again when the PR changes (a push, a review), when you post, and
 * every two minutes while the panel is open.
 */
interface Entry {
  readonly data?: PrConversation;
  readonly error?: string;
  readonly loading: boolean;
  /** The PR state it was read for (number, head, review). */
  readonly key?: string;
}

const entries = new Map<string, Entry>();
const open = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const emit = (): void => {
  version++;
  for (const l of listeners) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Whether the conversation panel is open above a worktree's chat. */
export function usePanelOpen(wsId: string): [boolean, (open: boolean) => void] {
  useSyncExternalStore(subscribe, () => version);
  const set = useCallback((value: boolean) => {
    if (value) open.add(wsId);
    else open.delete(wsId);
    emit();
  }, [wsId]);
  return [open.has(wsId), set];
}

/** Open the panel from elsewhere (the PR sheet). */
export function showPrConversation(wsId: string): void {
  open.add(wsId);
  emit();
}

type Fetch = (wsId: string) => Promise<{ ok: true; conversation: PrConversation } | { ok: false; message: string } | undefined>;

async function load(fetch: Fetch, wsId: string, key: string): Promise<void> {
  const had = entries.get(wsId);
  entries.set(wsId, { ...had, loading: true, key });
  emit();
  const out = await fetch(wsId).catch((err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }));
  const now = entries.get(wsId);
  if (!out) entries.set(wsId, { ...now, loading: false, key });
  else if (out.ok) entries.set(wsId, { data: out.conversation, loading: false, key });
  else entries.set(wsId, { ...(now?.data ? { data: now.data } : {}), error: out.message, loading: false, key });
  emit();
}

/** Counts for the strip: everything said, and the threads on lines still open. */
export function conversationCounts(c: PrConversation | undefined): { said: number; open: number } {
  if (!c) return { said: 0, open: 0 };
  const inThreads = c.threads.reduce((n, t) => n + t.comments.length, 0);
  return { said: c.comments.length + c.reviews.filter((r) => r.body.trim()).length + inThreads, open: c.threads.filter((t) => !t.resolved).length };
}

export function usePrConversation(wsId: string): { data?: PrConversation; error?: string; loading: boolean; refresh: () => void } {
  const api = useApi();
  const pr = useApp((st) => st.prs[wsId]);
  useSyncExternalStore(subscribe, () => version);
  const fetch: Fetch = useCallback((id) => api.workbench.prConversation(id) as ReturnType<Fetch>, [api]);
  const key = pr ? `${pr.number}/${pr.head ?? ''}/${pr.review ?? ''}/${pr.state}` : undefined;
  const isOpen = open.has(wsId);
  useEffect(() => {
    if (!key) return;
    const had = entries.get(wsId);
    if (had?.key !== key && !had?.loading) void load(fetch, wsId, key);
  }, [wsId, key, fetch]);
  useEffect(() => {
    if (!key || !isOpen) return;
    return everyWhileShown(() => void load(fetch, wsId, key), 120_000);
  }, [wsId, key, isOpen, fetch]);
  const entry = entries.get(wsId);
  const refresh = useCallback(() => {
    if (key) void load(fetch, wsId, key);
  }, [fetch, wsId, key]);
  return { ...(entry?.data ? { data: entry.data } : {}), ...(entry?.error ? { error: entry.error } : {}), loading: entry?.loading ?? Boolean(key), refresh };
}

/** One thing in the conversation, in time order: a comment, a review, or a thread on lines (at its first comment). */
export type ConversationItem =
  | { readonly kind: 'comment'; readonly at: number; readonly id: string; readonly comment: PrConversation['comments'][number] }
  | { readonly kind: 'review'; readonly at: number; readonly id: string; readonly review: PrConversation['reviews'][number] }
  | { readonly kind: 'thread'; readonly at: number; readonly id: string; readonly thread: PrThread };

export function timeline(c: PrConversation): ConversationItem[] {
  return [
    ...c.comments.map((comment) => ({ kind: 'comment' as const, at: comment.at, id: comment.id, comment })),
    ...c.reviews.map((review) => ({ kind: 'review' as const, at: review.at, id: review.id, review })),
    ...c.threads.map((thread) => ({ kind: 'thread' as const, at: thread.comments[0]?.at ?? 0, id: thread.id, thread })),
  ].sort((a, b) => a.at - b.at);
}
