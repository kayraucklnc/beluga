import { linkHint, linkSpans } from './links.js';
import type { Line } from './text.js';
import { windowLines } from './text.js';
import type { Zone } from './workspace-models.js';

/** Where the chat's lines are drawn: first content column and row, rows shown, scroll from the bottom. */
export interface ChatBox {
  readonly x: number;
  readonly top: number;
  readonly rows: number;
  readonly scroll: number;
}

/**
 * Click zones (screen coordinates) for the links in the visible part of the chat, plus
 * the one under the pointer. Lines are bottom-aligned in the pane, like ChatView draws them.
 */
export function chatLinkModel(
  lines: readonly Line[],
  box: ChatBox,
  hover?: { readonly x: number; readonly y: number; readonly alt?: boolean },
  cwd?: string,
): { zones: Zone[]; zone?: Zone; hover?: { line: number; x0: number; x1: number; alt?: boolean } } {
  const rows = Math.max(0, box.rows);
  const visible = windowLines(lines, rows, box.scroll);
  const firstIndex = Math.max(0, lines.length - Math.min(box.scroll, Math.max(0, lines.length - rows)) - visible.length);
  const firstY = box.top + rows - visible.length;
  const zones: Zone[] = [];
  let zone: Zone | undefined;
  let hit: { line: number; x0: number; x1: number; alt?: boolean } | undefined;
  visible.forEach((line, i) => {
    for (const span of linkSpans(line)) {
      const z: Zone = { x0: box.x + span.x0, x1: box.x + span.x1, y: firstY + i, action: { type: 'open_link', link: span.link }, hint: linkHint(span.link, cwd) };
      zones.push(z);
      if (hover && hover.y === z.y && hover.x >= z.x0 && hover.x <= z.x1) {
        zone = z;
        hit = { line: firstIndex + i, x0: span.x0, x1: span.x1, ...(hover.alt ? { alt: true } : {}) };
      }
    }
  });
  return { zones, zone, hover: hit };
}
