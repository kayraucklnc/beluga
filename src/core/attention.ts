import { type Attention, NO_ATTENTION, type Store } from './store.js';

const union = (lists: ReadonlyArray<readonly string[]>): string[] => [...new Set(lists.flat())].sort();
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What each attached screen looks at, combined: a conversation is shown when any screen shows
 * it, and visible when a screen in front shows it. Unread counts and notifications follow this.
 */
export class AttentionRegistry {
  private readonly byClient = new Map<string, Attention>();

  constructor(private readonly store: Store) {}

  set(clientId: string, attention: Attention): void {
    this.byClient.set(clientId, attention);
    this.publish();
  }

  remove(clientId: string): void {
    if (this.byClient.delete(clientId)) this.publish();
  }

  /** Whether some screen in front shows this conversation. */
  visible(channel: string): boolean {
    return this.store.getState().attention.visible.includes(channel);
  }

  private publish(): void {
    const all = [...this.byClient.values()];
    const next: Attention = all.length
      ? { shown: union(all.map((a) => a.shown)), visible: union(all.map((a) => a.visible)), files: all.some((a) => a.files) }
      : NO_ATTENTION;
    const now = this.store.getState().attention;
    if (same(now.shown, next.shown) && same(now.visible, next.visible) && now.files === next.files) return;
    this.store.dispatch({ type: 'attention', attention: next });
  }
}
