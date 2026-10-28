import { homeWidgets } from '../modules/home-widgets';
import type { WidgetsView } from './link/protocol';
import { store } from './store';

/**
 * Board tiles on the Home screen (BLG-361, docs/sentinel.md "On the phone's Home screen"). The
 * Mac sends every tile in words as the `widgets` view; this hands each one to the Android widget
 * (modules/home-widgets), which keeps it and draws with the app closed, with each project's icon
 * once (`companion.icon`, by checksum). Watched while the app is open, so the widget's tile picker
 * has your tiles before the first widget is placed; with Stay connected it keeps coming while away
 * when a widget is on the Home screen.
 */
let started = false;
let last = '';

export function startWidgets(): void {
  if (started || !homeWidgets.available) return;
  started = true;
  store.watch('widgets');
  store.keepWhileAway('widgets', () => homeWidgets.placed() > 0);
  store.subscribe('view:widgets', hand);
  hand();
}

function hand(): void {
  const v = store.view<WidgetsView>('widgets');
  if (!v) {
    // Signed out (or never paired): the widgets forget the tiles.
    if (!store.getState().mode && last !== '[]') {
      last = '[]';
      homeWidgets.set(JSON.stringify({ tiles: [], got: Date.now() }));
    }
    return;
  }
  if (v.stale) return;
  for (const sum of new Set(v.data.tiles.flatMap((t) => (t.icon ? [t.icon] : [])))) icon(sum);
  // A view comes again when anything the Mac shows changes: the widgets redraw only when a tile did.
  const tiles = JSON.stringify(v.data.tiles);
  if (tiles === last) return;
  last = tiles;
  homeWidgets.set(JSON.stringify({ tiles: v.data.tiles, got: v.at }));
}

const waiting = new Set<string>();

/** A project's icon to the widget, once: from the app's cache, or when the Mac sends it. */
function icon(sum: string): void {
  if (homeWidgets.hasIcon(sum)) return;
  const give = (uri: string | undefined): boolean => {
    const b64 = uri?.match(/^data:image\/(?:png|jpeg);base64,(.+)$/)?.[1];
    if (b64) homeWidgets.saveIcon(sum, b64);
    return Boolean(uri);
  };
  // Asks the Mac for it (once, while the link is open).
  if (give(store.icon(sum)) || waiting.has(sum)) return;
  waiting.add(sum);
  const off = store.subscribe(`icon:${sum}`, () => {
    if (!give(store.cachedIcon(sum))) return;
    waiting.delete(sum);
    off();
  });
}
