import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NeedsYou, OutputView, Topic } from './link/protocol';
import { type CachedView, type FileState, type LinkState, type OutboxItem, store, type Toast } from './store';

/** The screens' way into the store. Each hook re-renders only when its own key changes. */

export function useLink(): LinkState {
  return useSyncExternalStore(
    (fn) => store.subscribe('state', fn),
    () => store.getState(),
  );
}

/** Does the Mac have this (by its protocol's minor)? Re-renders when the link learns it. */
export function useSupports(what: Parameters<typeof store.supports>[0]): boolean {
  useLink();
  return store.supports(what);
}

/** A topic's view; subscribes to it on the Mac while the screen is mounted. */
export function useView<T>(topic: Topic | undefined): CachedView<T> | undefined {
  useEffect(() => (topic ? store.watch(topic) : undefined), [topic]);
  return useSyncExternalStore(
    (fn) => (topic ? store.subscribe(`view:${topic}`, fn) : () => {}),
    () => (topic ? store.view<T>(topic) : undefined),
  );
}

/** Needs-you items minus the ones you've just answered (until the Mac drops them). */
export function useVisibleNeeds(items: readonly NeedsYou[] | undefined): NeedsYou[] {
  useSyncExternalStore(
    (fn) => store.subscribe('hidden', fn),
    () => store.snapshot('hidden', () => ({})),
  );
  return (items ?? []).filter((n) => !store.isHidden(n.id));
}

export function useFile(ref: string | undefined, variant: 'thumb' | 'full' | 'text'): FileState | undefined {
  const key = `${ref}#${variant}`;
  useEffect(() => {
    if (ref) store.fetch(ref, variant);
  }, [ref, variant]);
  return useSyncExternalStore(
    (fn) => (ref ? store.subscribe(`file:${key}`, fn) : () => {}),
    () => (ref ? store.file(ref, variant) : undefined),
  );
}

/** The newest we know of an output (a growing log's size). */
export function useOutput(ref: string | undefined): OutputView | undefined {
  return useSyncExternalStore(
    (fn) => (ref ? store.subscribe(`out:${ref}`, fn) : () => {}),
    () => store.snapshot(`out:${ref}`, () => (ref ? store.output(ref) : undefined)),
  );
}

/** A project's icon (a data: URI) by its checksum: fetched once, then from the cache. */
export function useIcon(sum: string | undefined): string | undefined {
  const phase = useSyncExternalStore(
    (fn) => store.subscribe('state', fn),
    () => store.getState().phase,
  );
  useEffect(() => void store.icon(sum), [sum, phase]);
  return useSyncExternalStore(
    (fn) => (sum ? store.subscribe(`icon:${sum}`, fn) : () => {}),
    () => store.cachedIcon(sum),
  );
}

/** Seconds since `ts`, ticking once a second while shown (the phone counts; nothing streams). */
export function useSince(ts: number | undefined): number | undefined {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (ts === undefined) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ts]);
  return ts === undefined ? undefined : Math.max(0, Math.round((now - ts) / 1000));
}

/** "42s", "3m 05s", "1h 02m". */
export const elapsed = (s: number | undefined): string => {
  if (s === undefined) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

export function useOutbox(): OutboxItem[] {
  return useSyncExternalStore(
    (fn) => store.subscribe('outbox', fn),
    () => store.getOutbox(),
  );
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (fn) => store.subscribe('toasts', fn),
    () => store.getToasts(),
  );
}

/** "as of 10:42" for a view that didn't come from the Mac this session. */
export const asOf = (at: number): string => `as of ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

export function ago(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function until(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const m = Math.max(0, Math.round((ts - now) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}
