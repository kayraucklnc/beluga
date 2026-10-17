import type { AppState } from '../core/store.js';
import { channelOf } from '../core/store.js';
import type { FsEntry } from '../protocol.js';
import { actionButtons } from './actions.js';
import { approvalLines } from './format.js';
import { offsetZones } from './hit.js';
import type { UiState } from './keymap.js';
import { type Geometry, computeLayout } from './layout.js';
import { type MenuSpec, menuSpec } from './menus.js';
import { type Suggestion, suggest, suggestionWindow } from './suggest.js';
import { type Model, type UiAction, type Zone, findWorkspace, overviewModel, projectsModel, reviewModel, tabsModel, workspaceHeaderModel } from './workspace-models.js';
import { highlightRange } from './text.js';
import type { Workspace } from '../workspaces/types.js';

export interface Derived {
  /** Description of the hovered (or keyboard-selected) control, shown in the bottom bar. */
  readonly hint?: string;
  readonly headerItems: readonly UiAction[];
  readonly geometry: Geometry;
  readonly suggestions: readonly Suggestion[];
  readonly focus: UiState['focus'];
  readonly menu?: MenuSpec;
  readonly buttons: ReturnType<typeof actionButtons>;
  readonly approvalDetailLines: number;
  readonly channel: string;
  readonly workspace?: Workspace;
  readonly projects: Model;
  readonly projectsScroll: number;
  readonly projectItems: readonly UiAction[];
  readonly projectsCursorRow?: number;
  readonly tabs: Model;
  readonly header?: Model;
  readonly overview?: Model;
  readonly overviewScroll: number;
  readonly review?: Model;
  /** All clickable zones in screen coordinates. */
  readonly zones: readonly Zone[];
}

export interface DeriveInput {
  readonly state: AppState;
  readonly ui: UiState;
  readonly selfId: string;
  readonly columns: number;
  readonly rows: number;
  readonly frame: number;
  readonly listLocalDirs?: (dir: string) => readonly FsEntry[];
  /** Mouse position for hover feedback. */
  readonly hover?: { readonly x: number; readonly y: number };
}

const HOVER = { inverse: true } as const;

/** Highlight the zone under `pt` (or at a keyboard cursor) inside a model drawn at (ox, oy). */
function emphasize(model: Model, ox: number, oy: number, pt: { x: number; y: number } | undefined, scroll = 0): { model: Model; zone?: Zone } {
  if (!pt) return { model };
  const zone = model.zones.find((z) => z.y + oy - scroll === pt.y && pt.x >= z.x0 + ox && pt.x <= z.x1 + ox && z.action.type !== 'none');
  if (!zone) return { model };
  const lines = model.lines.map((l, i) => (i === zone.y ? highlightRange(l, zone.x0, zone.x1, zone.disabled ? { underline: true } : HOVER) : l));
  return { model: { ...model, lines }, zone };
}

/** Everything the screen shows and where, so rendering and clicks always agree. */
export function derive({ state, ui, selfId, columns, rows, frame, listLocalDirs, hover }: DeriveInput): Derived {
  const suggestions = ui.focus === 'chat' && !ui.suggestHidden && !ui.menu ? suggest(ui.buffer, { peers: state.peers, selfId, dirCache: state.dirCache, listLocalDirs }) : [];
  const workspace = state.view.kind === 'workspace' ? findWorkspace(state.projects, state.view.id) : undefined;
  const reviewing = state.view.kind === 'workspace' && state.view.tab === 'review';
  const filesVisible = state.view.kind === 'files' || (state.view.kind === 'workspace' && state.view.tab === 'files');
  const viewerOk = state.view.kind === 'room' || filesVisible;
  let focus = ui.focus;
  if (focus === 'viewer' && !(state.viewer && viewerOk)) focus = 'chat';
  if (focus === 'files' && !filesVisible) focus = 'chat';
  if (focus === 'main' && !reviewing && state.view.kind !== 'overview') focus = 'chat';
  if (focus === 'header' && !workspace) focus = 'chat';
  const approval = state.approvals[0];
  const geometry = computeLayout({
    columns,
    rows,
    peopleCount: state.peers.length,
    hasViewer: Boolean(state.viewer) && viewerOk,
    suggestionCount: suggestionWindow(suggestions.length, ui.selected).rows,
    approvalDetail: approval?.detail,
    viewerFull: ui.viewerFull && focus === 'viewer',
    workspaceHeader: Boolean(workspace) && !ui.menu,
  });
  const g = geometry;
  const menu = ui.menu ? menuSpec(state, ui.menu.menu) : undefined;

  // Projects tree, scrolled so the keyboard cursor stays visible.
  const projectsRaw = projectsModel(state, new Set(ui.collapsed), frame, Math.max(1, g.sideWidth - 4));
  const itemRows = [...new Set(projectsRaw.zones.filter((z) => z.action.type !== 'none').map((z) => z.y))];
  const projectItems = itemRows.map((y) => projectsRaw.zones.filter((z) => z.y === y && z.action.type !== 'none').at(-1)!.action);
  const cursorRow = itemRows[Math.min(ui.projectsCursor, itemRows.length - 1)];
  const visibleRows = Math.max(1, g.projectsHeight - 2);
  const projectsScroll = focus === 'projects' && cursorRow !== undefined ? Math.max(0, cursorRow - visibleRows + 2) : 0;

  const tabsRaw = tabsModel(state, Math.max(1, g.mainWidth - 2));
  const headerRaw = workspace && g.headerHeight ? workspaceHeaderModel(state, workspace, Math.max(1, g.mainWidth - 2), frame) : undefined;
  const headerZones = headerRaw?.zones.filter((z) => z.y === 1) ?? [];
  const headerItems = headerZones.map((z) => z.action);
  const paneInner = Math.max(1, g.mainWidth - 4);
  const overviewRaw = state.view.kind === 'overview' && !menu ? overviewModel(state, frame, paneInner) : undefined;
  const reviewRaw = reviewing && !menu ? reviewModel(state.review, paneInner, Math.max(1, g.paneHeight - 2)) : undefined;

  // Hover feedback (and the keyboard cursor in the action row) highlight what you'd click.
  const proj = emphasize(projectsRaw, 2, g.bodyTop + 1, hover, projectsScroll);
  const projects = proj.model;
  const tab = emphasize(tabsRaw, g.mainX + 1, g.tabsY, hover);
  const tabs = tab.model;
  let header = headerRaw;
  let headerHover: Zone | undefined;
  if (headerRaw) {
    const cursorZone = focus === 'header' ? headerZones[Math.min(ui.headerCursor, headerZones.length - 1)] : undefined;
    const pt = cursorZone ? { x: cursorZone.x0 + g.mainX + 1, y: cursorZone.y + g.headerTop } : hover;
    const h = emphasize(headerRaw, g.mainX + 1, g.headerTop, pt);
    header = h.model;
    headerHover = h.zone;
  }
  const ov = overviewRaw ? emphasize(overviewRaw, g.mainX + 2, g.paneTop + 1, hover, Math.min(ui.overviewScroll, Math.max(0, overviewRaw.lines.length - (g.paneHeight - 2)))) : undefined;
  const overview = ov?.model;
  const rv = reviewRaw ? emphasize(reviewRaw, g.mainX + 2, g.paneTop + 1, hover) : undefined;
  const review = rv?.model;
  const hint = (headerHover ?? proj.zone ?? tab.zone ?? ov?.zone ?? rv?.zone)?.hint;

  const zones: Zone[] = [];
  if (g.sideWidth > 0) {
    zones.push(...offsetZones(projects.zones, 2, g.bodyTop + 1 - projectsScroll).filter((z) => z.y > g.bodyTop && z.y < g.bodyTop + g.projectsHeight - 1));
    zones.push(...offsetZones(tabs.zones, g.mainX + 1, g.tabsY));
  }
  if (header) zones.push(...offsetZones(header.zones, g.mainX + 1, g.headerTop));
  const overviewScroll = overview ? Math.min(ui.overviewScroll, Math.max(0, overview.lines.length - (g.paneHeight - 2))) : 0;
  if (overview) {
    zones.push(...offsetZones(overview.zones, g.mainX + 2, g.paneTop + 1 - overviewScroll).filter((z) => z.y > g.paneTop && z.y < g.paneTop + g.paneHeight - 1));
  }
  if (review) zones.push(...offsetZones(review.zones, g.mainX + 2, g.paneTop + 1));

  return {
    geometry,
    suggestions,
    focus,
    menu,
    buttons: actionButtons(focus, state, suggestions.length > 0, { full: ui.viewerFull, raw: ui.viewerRaw }),
    approvalDetailLines: approval ? approvalLines(approval.detail, columns - 4).length : 0,
    channel: channelOf(state.view),
    workspace,
    projects,
    projectsScroll,
    projectItems,
    projectsCursorRow: cursorRow,
    hint,
    headerItems,
    tabs,
    header,
    overview,
    overviewScroll,
    review,
    zones,
  };
}
