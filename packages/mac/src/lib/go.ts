import type { AppState } from '@klaud/core/store.js';
import { type TopTab, topTabs } from '@klaud/ui/workspace-models.js';

/**
 * The Mac app's places, in the sidebar's order: Chat, Overview, Shared files, Search, Usage,
 * Terminal. ⌥1…6, the Go menu and the palette follow it. (The terminal app keeps its own tab
 * order; the places and what they show are the same.)
 */
export const GO_ORDER: ReadonlyArray<TopTab['kind']> = ['room', 'overview', 'files', 'search', 'usage', 'terminal'];

/** The shared top tabs in the Mac order, each hint ending with its ⌥ key. */
export function macTabs(state: AppState): TopTab[] {
  const tabs = topTabs(state);
  return GO_ORDER.flatMap((kind, i) => {
    const t = tabs.find((x) => x.kind === kind);
    return t ? [{ ...t, hint: `${t.hint.replace(/ · (⌥|Alt\+)\d$/, '')} · ⌥${i + 1}` }] : [];
  });
}

/** The place ⌃Tab (+1) or ⌃⇧Tab (-1) goes to; from a workspace, the first or last one. */
export function stepPlace(state: AppState, delta: 1 | -1): TopTab['kind'] {
  const at = GO_ORDER.indexOf(state.view.kind as TopTab['kind']);
  if (at < 0) return delta > 0 ? GO_ORDER[0]! : GO_ORDER[GO_ORDER.length - 1]!;
  return GO_ORDER[(at + delta + GO_ORDER.length) % GO_ORDER.length]!;
}
