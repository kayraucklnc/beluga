import { router } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Platform } from 'react-native';
import type { Graph, View as ViewSpec } from './render';
import type { BlockAt } from '../components/render/data';

/**
 * Data full screen (BLG-71): a table, chart, view, graph or text table opened from its card's
 * Expand. The app stays upright everywhere else; only the full-screen page may turn sideways.
 */
export type Full =
  | { readonly kind: 'view'; readonly view: ViewSpec; readonly at?: BlockAt }
  | { readonly kind: 'graph'; readonly graph: Graph }
  | { readonly kind: 'text'; readonly text: string };

let shown: Full | undefined;

/** What the full-screen page shows (the last one opened). */
export const fullShown = (): Full | undefined => shown;

export function openFull(f: Full): void {
  shown = f;
  router.push('/data');
}

/** Upright (the whole app), or free to turn (the full-screen page). Nothing to do on the web. */
export function allowTurning(on: boolean): void {
  if (Platform.OS === 'web') return;
  void (on ? ScreenOrientation.unlockAsync() : ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)).catch(() => undefined);
}
