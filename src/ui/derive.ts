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
import { theme } from './theme.js';
import { workspaceMentions } from '../core/mentions.js';
import { questionModel, sharedHeaderModel, sharedSection } from './collab-models.js';
import type { SharedWorkspace } from '../core/collab-store.js';
import type { Workspace } from '../workspaces/types.js';

export interface Derived {
  /** Description of the hovered (or keyboard-selected) control, shown in the bottom bar. */
  readonly hint?: string;
  readonly headerItems: readonly UiAction[];
  /** Index of the first workspace button in `headerItems` (after the tabs). */
  readonly headerStart: number;
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
  /** Claude's question or plan card (first one waiting). */
  readonly question?: Model;
  readonly questionId?: string;
  /** Someone else's workspace you're in. */
  readonly shared?: SharedWorkspace;
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
/** The keyboard cursor stays visible even on a button that's already selected. */
const CURSOR = { inverse: true, underline: true, bold: true } as const;

/** Highlight the zone under `pt` (or at a keyboard cursor) inside a model drawn at (ox, oy). */
function emphasize(model: Model, ox: number, oy: number, pt: { x: number; y: number } | undefined, scroll = 0, style: typeof HOVER | typeof CURSOR = HOVER): { model: Model; zone?: Zone } {
  if (!pt) return { model };
  const zone = model.zones.find((z) => z.y + oy - scroll === pt.y && pt.x >= z.x0 + ox && pt.x <= z.x1 + ox && z.action.type !== 'none');
  if (!zone) return { model };
  const lines = model.lines.map((l, i) => (i === zone.y ? highlightRange(l, zone.x0, zone.x1, zone.disabled ? { underline: true } : style) : l));
  return { model: { ...model, lines }, zone };
}

/** Stack model `b` under model `a`. */
function appendModel(a: Model, b: Model): Model {
  if (!b.lines.length) return a;
  return { lines: [...a.lines, ...b.lines], zones: [...a.zones, ...b.zones.map((z) => ({ ...z, y: z.y + a.lines.length }))] };
}

/** Everything the screen shows and where, so rendering and clicks always agree. */
export function derive({ state, ui, selfId, columns, rows, frame, listLocalDirs, hover }: DeriveInput): Derived {
  const suggestions = ui.focus === 'chat' && !ui.suggestHidden && !ui.menu ? suggest(ui.buffer, { peers: state.peers, selfId, dirCache: state.dirCache, listLocalDirs, workspaces: state.view.kind === 'room' ? workspaceMentions(state.projects) : [] }) : [];
  const workspace = state.view.kind === 'workspace' ? findWorkspace(state.projects, state.view.id) : undefined;
  const shared = state.view.kind === 'shared' ? state.shared.find((w) => w.id === (state.view as { id: string }).id) : undefined;
  const pendingQuestion = state.questions[0];
  const reviewing = state.view.kind === 'workspace' && state.view.tab === 'review';
  const filesVisible = state.view.kind === 'files' || ((state.view.kind === 'workspace' || state.view.kind === 'shared') && state.view.tab === 'files');
  const viewerOk = state.view.kind === 'room' || filesVisible;
  let focus = ui.focus;
  if (focus === 'viewer' && !(state.viewer && viewerOk)) focus = 'chat';
  if (focus === 'files' && !filesVisible) focus = 'chat';
  if (focus === 'main' && !reviewing && state.view.kind !== 'overview') focus = 'chat';
  const approval = state.approvals[0];
  const geometry = computeLayout({
    columns,
    rows,
    peopleCount: state.peers.length,
    hasViewer: Boolean(state.viewer) && viewerOk,
    suggestionCount: suggestionWindow(suggestions.length, ui.selected).rows,
    approvalDetail: approval?.detail,
    viewerFull: ui.viewerFull && focus === 'viewer',
    workspaceHeader: Boolean(workspace || shared) && !ui.menu,
    questionLines: pendingQuestion && !ui.menu ? questionModel(state, pendingQuestion, Math.max(10, columns - 4)).lines.length : 0,
  });
  const g = geometry;
  const menu = ui.menu ? menuSpec(state, ui.menu.menu) : undefined;

  // Projects tree, scrolled so the keyboard cursor stays visible.
  const projectsRaw = appendModel(
    projectsModel(state, new Set(ui.collapsed), frame, Math.max(1, g.sideWidth - 4)),
    sharedSection(state, Math.max(1, g.sideWidth - 4), shared?.id),
  );
  const itemRows = [...new Set(projectsRaw.zones.filter((z) => z.action.type !== 'none').map((z) => z.y))];
  const projectItems = itemRows.map((y) => projectsRaw.zones.filter((z) => z.y === y && z.action.type !== 'none').at(-1)!.action);
  const cursorRow = itemRows[Math.min(ui.projectsCursor, itemRows.length - 1)];
  const visibleRows = Math.max(1, g.projectsHeight - 2);
  const projectsScroll = focus === 'projects' && cursorRow !== undefined ? Math.max(0, cursorRow - visibleRows + 2) : 0;

  const tabsRaw = tabsModel(state, Math.max(1, g.mainWidth - 2));
  const headerRaw = !g.headerHeight
    ? undefined
    : workspace
      ? workspaceHeaderModel(state, workspace, Math.max(1, g.mainWidth - 2), frame)
      : shared
        ? sharedHeaderModel(state, shared, Math.max(1, g.mainWidth - 2))
        : undefined;
  const questionRaw = pendingQuestion && g.questionHeight ? questionModel(state, pendingQuestion, Math.max(10, columns - 4)) : undefined;
  // Keyboard order across the top: the tabs, then the workspace's buttons (Chat, Files, Diff, Review…).
  const tabZones = g.sideWidth > 0 ? tabsRaw.zones : [];
  const headerZones = headerRaw?.zones.filter((z) => z.y === 1 && z.action.type !== 'none') ?? [];
  const topItems = [...tabZones.map((z) => ({ z, area: 'tabs' as const })), ...headerZones.map((z) => ({ z, area: 'header' as const }))];
  const headerItems = topItems.map((t) => t.z.action);
  const topCursor = focus === 'header' && ui.entered ? topItems[Math.min(ui.headerCursor, topItems.length - 1)] : undefined;
  // The top bar is focused but not entered yet: mark every button in it, so you see the whole area.
  const markRow = (m: Model, rowZones: readonly Zone[]): Model =>
    focus === 'header' && !ui.entered ? { ...m, lines: m.lines.map((l, i) => rowZones.filter((z) => z.y === i).reduce((acc, z) => highlightRange(acc, z.x0, z.x1, { underline: true, color: theme.accent }), l)) } : m;
  const paneInner = Math.max(1, g.mainWidth - 4);
  const overviewRaw = state.view.kind === 'overview' && !menu ? overviewModel(state, frame, paneInner) : undefined;
  const reviewRaw = reviewing && !menu ? reviewModel(state.review, paneInner, Math.max(1, g.paneHeight - 2)) : undefined;

  // Hover feedback (and the keyboard cursor in the action row) highlight what you'd click.
  const proj = emphasize(projectsRaw, 2, g.bodyTop + 1, hover, projectsScroll);
  const projects = proj.model;
  const tab0 = topCursor?.area === 'tabs' ? emphasize(tabsRaw, g.mainX + 1, g.tabsY, { x: topCursor.z.x0 + g.mainX + 1, y: g.tabsY }, 0, CURSOR) : emphasize(tabsRaw, g.mainX + 1, g.tabsY, hover);
  const tab = { ...tab0, model: markRow(tab0.model, tabZones) };
  const tabs = tab.model;
  let header = headerRaw;
  let headerHover: Zone | undefined;
  if (headerRaw) {
    const cursorZone = topCursor?.area === 'header' ? topCursor.z : undefined;
    const pt = cursorZone ? { x: cursorZone.x0 + g.mainX + 1, y: cursorZone.y + g.headerTop } : topCursor ? undefined : hover;
    const h = emphasize(headerRaw, g.mainX + 1, g.headerTop, pt, 0, cursorZone ? CURSOR : HOVER);
    header = markRow(h.model, headerZones);
    headerHover = h.zone;
  }
  const ov = overviewRaw ? emphasize(overviewRaw, g.mainX + 2, g.paneTop + 1, hover, Math.min(ui.overviewScroll, Math.max(0, overviewRaw.lines.length - (g.paneHeight - 2)))) : undefined;
  const overview = ov?.model;
  const rv = reviewRaw ? emphasize(reviewRaw, g.mainX + 2, g.paneTop + 1, hover) : undefined;
  const review = rv?.model;
  const qv = questionRaw ? emphasize(questionRaw, 2, g.questionTop + 1, hover) : undefined;
  const question = qv?.model;
  const hint = (headerHover ?? tab.zone ?? proj.zone ?? ov?.zone ?? rv?.zone ?? qv?.zone)?.hint;

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
  if (question) zones.push(...offsetZones(question.zones, 2, g.questionTop + 1));

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
    projectsCursorRow: focus === 'projects' && ui.entered ? cursorRow : undefined,
    headerStart: workspace || shared ? tabZones.length : 0,
    hint,
    headerItems,
    tabs,
    header,
    overview,
    overviewScroll,
    review,
    question,
    questionId: pendingQuestion?.qid,
    shared,
    zones,
  };
}
