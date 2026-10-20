import type { AppState } from '@klaud/core/store.js';
import { type TopTab, topTabs } from '@klaud/ui/workspace-models.js';

/**
 * The Mac app's places: Overview, Tasks and Chat (the sidebar's top), then Search, Usage,
 * Terminal and Shared files (the toolbar, the sidebar's top icons, the right panel). ⌥1…7, the
 * Go menu, ⌃Tab and the palette follow this order; each keeps its key even when it's absent.
 * (The terminal app keeps its own tab order; the places and what they show are the same.)
 */

export type PlaceKind = TopTab['kind'] | 'tasks';

export interface Place extends Omit<TopTab, 'kind'> {
  readonly kind: PlaceKind;
  /** Its ⌥ key (1…7). */
  readonly key: number;
}

export const GO_ORDER: readonly PlaceKind[] = ['overview', 'tasks', 'room', 'search', 'usage', 'terminal', 'files'];

/** The places there are now, in order, each hint ending with its ⌥ key. */
export function macTabs(state: AppState): Place[] {
  const tabs = topTabs(state);
  return GO_ORDER.flatMap((kind, i): Place[] => {
    const key = i + 1;
    if (kind === 'tasks') return state.board.enabled ? [{ kind, key, label: 'Tasks', short: 'Tasks', hint: `Plan and track the work · ⌥${key}`, badge: 0 }] : [];
    const t = tabs.find((x) => x.kind === kind);
    return t ? [{ ...t, kind, key, hint: `${t.hint.replace(/ · (⌥|Alt\+)\d$/, '')} · ⌥${key}` }] : [];
  });
}

/** The place ⌥<digit> goes to. */
export const placeForKey = (state: AppState, digit: number): Place | undefined => macTabs(state).find((p) => p.key === digit);

/** The place ⌃Tab (+1) or ⌃⇧Tab (-1) goes to; from elsewhere, the first or last one. */
export function stepPlace(state: AppState, delta: 1 | -1): PlaceKind {
  const order = macTabs(state).map((p) => p.kind);
  const here = state.view.kind === 'task' ? 'tasks' : state.view.kind;
  const at = order.indexOf(here as PlaceKind);
  if (at < 0) return delta > 0 ? order[0]! : order[order.length - 1]!;
  return order[(at + delta + order.length) % order.length]!;
}
