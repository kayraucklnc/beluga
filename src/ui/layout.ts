import type { BrowserState } from '../core/store.js';
import { approvalLines } from './format.js';

/** Every on-screen region, computed once so rendering and mouse hit-testing agree. */
export interface Geometry {
  readonly columns: number;
  readonly rows: number;
  readonly sideWidth: number;
  readonly chatWidth: number;
  readonly viewerWidth: number;
  readonly bodyTop: number;
  readonly bodyHeight: number;
  readonly peopleHeight: number;
  readonly filesTop: number;
  readonly filesHeight: number;
  readonly approvalTop: number;
  readonly approvalHeight: number;
  readonly suggestionsTop: number;
  readonly composerTop: number;
  readonly actionBarY: number;
}

export interface LayoutInput {
  readonly columns: number;
  readonly rows: number;
  readonly peopleCount: number;
  readonly hasViewer: boolean;
  readonly suggestionCount: number;
  readonly approvalDetail?: string;
  /** The file viewer takes the whole body area. */
  readonly viewerFull?: boolean;
}

export function computeLayout(input: LayoutInput): Geometry {
  const { columns, rows } = input;
  const full = Boolean(input.viewerFull && input.hasViewer);
  const sideWidth = full ? 0 : Math.min(34, Math.max(24, Math.floor(columns * 0.22)));
  const viewerWidth = full ? columns : input.hasViewer ? Math.floor((columns - sideWidth) * 0.48) : 0;
  const chatWidth = columns - sideWidth - viewerWidth;
  const approvalHeight = input.approvalDetail === undefined ? 0 : 4 + approvalLines(input.approvalDetail, columns - 4).length;
  const bottom = 4 + input.suggestionCount + approvalHeight;
  const bodyTop = 1;
  const bodyHeight = Math.max(8, rows - 1 - bottom);
  const peopleHeight = Math.min(input.peopleCount * 2 + 3, Math.floor(bodyHeight / 2));
  const approvalTop = bodyTop + bodyHeight;
  const suggestionsTop = approvalTop + approvalHeight;
  const composerTop = suggestionsTop + input.suggestionCount;
  return {
    columns,
    rows,
    sideWidth,
    chatWidth,
    viewerWidth,
    bodyTop,
    bodyHeight,
    peopleHeight,
    filesTop: bodyTop + peopleHeight,
    filesHeight: bodyHeight - peopleHeight,
    approvalTop,
    approvalHeight,
    suggestionsTop,
    composerTop,
    actionBarY: composerTop + 3,
  };
}

/** Which browser rows are visible in the files panel (shared by render and hit-testing). */
export function fileWindow(browser: BrowserState, filesHeight: number): { start: number; count: number; firstRowOffset: number } {
  const header = (browser.loading ? 1 : 0) + (browser.error ? 1 : 0);
  const count = Math.max(1, filesHeight - 2 - header);
  const start = Math.max(0, Math.min(browser.cursor - Math.floor(count / 2), browser.rows.length - count));
  return { start, count, firstRowOffset: header };
}

/** Lay out labelled buttons left to right and report each one's column span. */
export function placeButtons<T extends { readonly label: string }>(buttons: readonly T[], startX: number, gap: number): Array<T & { x0: number; x1: number }> {
  let x = startX;
  return buttons.map((b) => {
    const placed = { ...b, x0: x, x1: x + b.label.length - 1 };
    x += b.label.length + gap;
    return placed;
  });
}
