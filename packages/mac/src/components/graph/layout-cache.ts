import type { GraphDirection } from '@klaud/shared/graph-spec.js';
import type { Placed, Route, Size } from './graph-model.js';

/**
 * Graphs already laid out, by their block's text: a conversation scrolled away from a graph and
 * back (its rows come and go) shows it again at once, at its right height.
 */

export interface Laid {
  readonly direction: GraphDirection;
  readonly places: ReadonlyMap<string, Placed>;
  readonly routes: ReadonlyMap<string, Route>;
  readonly bounds: Size;
}

const MAX = 60;
const laid = new Map<string, Laid>();

const keyOf = (code: string, mode: string): string => `${mode}\0${code}`;

export function cachedLayout(code: string | undefined, mode: string): Laid | undefined {
  return code === undefined ? undefined : laid.get(keyOf(code, mode));
}

export function rememberLayout(code: string | undefined, mode: string, value: Laid): void {
  if (code === undefined) return;
  const key = keyOf(code, mode);
  laid.delete(key);
  laid.set(key, value);
  // Oldest out first.
  if (laid.size > MAX) laid.delete(laid.keys().next().value!);
}
