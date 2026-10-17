import type { BrowserState } from '../core/store.js';
import { approvalLines } from './format.js';

/** Every on-screen region, computed once so rendering and mouse hit-testing agree. */
export interface Geometry {
  readonly columns: number;
  readonly rows: number;
  readonly bodyTop: number;
  readonly bodyHeight: number;
  /** Left sidebar: Projects on top, People below. */
  readonly sideWidth: number;
  readonly projectsHeight: number;
  readonly peopleTop: number;
  readonly peopleHeight: number;
  /** Main area: tabs, then (for workspaces) a header, then the pane. */
  readonly mainX: number;
  readonly mainWidth: number;
  readonly tabsY: number;
  readonly headerTop: number;
  readonly headerHeight: number;
  readonly paneTop: number;
  readonly paneHeight: number;
  readonly chatWidth: number;
  readonly viewerWidth: number;
  readonly approvalTop: number;
  readonly approvalHeight: number;
  readonly suggestionsTop: number;
  readonly composerTop: number;
  readonly actionBarY: number;
  // Kept for the files panel and older call sites.
  readonly filesTop: number;
  readonly filesHeight: number;
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
  /** A workspace is open, so the main area shows its header. */
  readonly workspaceHeader?: boolean;
}

const TABS_HEIGHT = 2;
const HEADER_HEIGHT = 3;

export function computeLayout(input: LayoutInput): Geometry {
  const { columns, rows } = input;
  const full = Boolean(input.viewerFull && input.hasViewer);
  const sideWidth = full ? 0 : Math.min(36, Math.max(26, Math.floor(columns * 0.24)));
  const approvalHeight = input.approvalDetail === undefined ? 0 : 4 + approvalLines(input.approvalDetail, columns - 4).length;
  const bottom = 4 + input.suggestionCount + approvalHeight;
  const bodyTop = 1;
  const bodyHeight = Math.max(10, rows - 1 - bottom);
  const peopleHeight = full ? 0 : Math.min(input.peopleCount * 2 + 3, Math.max(5, Math.floor(bodyHeight * 0.4)));
  const projectsHeight = full ? 0 : bodyHeight - peopleHeight;
  const tabsHeight = full ? 0 : TABS_HEIGHT;
  const headerHeight = !full && input.workspaceHeader ? HEADER_HEIGHT : 0;
  const mainWidth = columns - sideWidth;
  const viewerWidth = full ? columns : input.hasViewer ? Math.floor(mainWidth * 0.5) : 0;
  const chatWidth = full ? 0 : mainWidth - viewerWidth;
  const approvalTop = bodyTop + bodyHeight;
  const suggestionsTop = approvalTop + approvalHeight;
  const composerTop = suggestionsTop + input.suggestionCount;
  const paneTop = bodyTop + tabsHeight + headerHeight;
  return {
    columns,
    rows,
    bodyTop,
    bodyHeight,
    sideWidth,
    projectsHeight,
    peopleTop: bodyTop + projectsHeight,
    peopleHeight,
    mainX: sideWidth,
    mainWidth,
    tabsY: bodyTop,
    headerTop: bodyTop + tabsHeight,
    headerHeight,
    paneTop,
    paneHeight: bodyHeight - tabsHeight - headerHeight,
    chatWidth,
    viewerWidth,
    approvalTop,
    approvalHeight,
    suggestionsTop,
    composerTop,
    actionBarY: composerTop + 3,
    filesTop: paneTop,
    filesHeight: bodyHeight - tabsHeight - headerHeight,
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
