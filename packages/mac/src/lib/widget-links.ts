/**
 * A desktop widget's link (BLG-309): "beluga://board/<board>?tile=<tile>" opens Sentinel on that
 * board and shows the tile; "beluga://sentinel" opens Sentinel.
 */
export function boardLinkOf(url: string): { readonly board?: string; readonly tile?: string } | undefined {
  if (/^beluga:\/\/sentinel\/?$/.test(url)) return {};
  const m = /^beluga:\/\/board\/([^/?#]+)(?:\?tile=([^&#]+))?/.exec(url);
  if (!m) return undefined;
  return { board: decodeURIComponent(m[1]!), ...(m[2] ? { tile: decodeURIComponent(m[2]) } : {}) };
}

/** Asked to show a board's tile (a widget was clicked): the board scrolls to it and marks it. */
export const SHOW_TILE = 'beluga:show-tile';
