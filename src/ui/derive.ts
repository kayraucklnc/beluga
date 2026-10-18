import type { AppState } from '../core/store.js';
import { channelOf } from '../core/store.js';
import type { FsEntry } from '../protocol.js';
import { type ComposeState, actionButtons } from './actions.js';
import { approvalLines, isRunning } from './format.js';
import { offsetZones } from './hit.js';
import type { UiState } from './keymap.js';
import { type Geometry, computeLayout } from './layout.js';
import { type MenuSpec, menuSpec } from './menus.js';
import { type Suggestion, suggest, suggestionWindow } from './suggest.js';
import { type Model, type UiAction, type Zone, findWorkspace, overviewModel, projectsModel, reviewModel, tabsModel, workspaceHeaderModel } from './workspace-models.js';
import { highlightRange, width } from './text.js';
import { composerWrapWidth, wrapBuffer } from './composer-text.js';
import { theme } from './theme.js';
import { workspaceMentions } from '../core/mentions.js';
import { planFullModel, questionModel, sharedHeaderModel, sharedSection } from './collab-models.js';
import type { SharedWorkspace } from '../core/collab-store.js';
import type { Workspace } from '../workspaces/types.js';
import { draftModel, searchCursorRow, searchModel, topBarModel, trustCardModel, usageModel } from './work-models.js';
import { modelLabel, modelOf } from './menus.js';
import type { Line } from './text.js';

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
  /** Claude's plan, full screen (takes the whole body). */
  readonly planFull?: Model;
  readonly planMaxScroll: number;
  /** The plan waiting for approval, if any. */
  readonly planId?: string;
  readonly questionId?: string;
  /** Someone else's workspace you're in. */
  readonly shared?: SharedWorkspace;
  /** The top line (logo, status, inbox). */
  readonly topBar: Model;
  /** Search, Usage or a draft's templates, drawn in the main pane. */
  readonly pane?: Model;
  readonly paneScroll: number;
  /** Right side of the box you type in: the model picker and plan mode (both clickable). */
  readonly composerRight?: Line;
  /** Columns the draft wraps at (render, layout and ↑↓ all use it). */
  readonly composerWidth: number;
  /** Your requests waiting their turn in this conversation, oldest first. */
  readonly queuedIds: readonly string[];
  /** The card above the box is a trust question for this person. */
  readonly trustCard?: string;
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

/** Is your Claude busy in this conversation, would the draft go to it, and what of yours is waiting? */
function composeState(state: AppState, ui: UiState, selfId: string, channel: string, shared: boolean): ComposeState & { ids: string[] } {
  const mine = state.log.filter((l): l is Extract<AppState['log'][number], { type: 'agent' }> => l.type === 'agent' && l.channel === channel && l.owner === selfId);
  const ids = mine.filter((l) => l.status === 'queued').map((l) => l.requestId);
  const busy = !shared && mine.some((l) => isRunning(l.status) && l.status !== 'queued' && l.status !== 'awaiting_approval');
  const draft = ui.buffer.trim();
  // In a group room plain chat goes to people; only a mention reaches your Claude.
  const toClaude = channel !== 'room' || state.peers.length <= 1 || draft.startsWith('@');
  return { typing: Boolean(draft) && !draft.startsWith('/') && !ui.pending && toClaude, busy, queued: ids.length, ids };
}

/** Everything the screen shows and where, so rendering and clicks always agree. */
export function derive({ state, ui, selfId, columns, rows, frame, listLocalDirs, hover }: DeriveInput): Derived {
  const searching = state.view.kind === 'search';
  const suggestions = ui.focus === 'chat' && !ui.suggestHidden && !ui.menu && !(searching && !ui.buffer.startsWith('/')) ? suggest(ui.buffer, { peers: state.peers, selfId, dirCache: state.dirCache, listLocalDirs, workspaces: state.view.kind === 'room' ? workspaceMentions(state.projects) : [] }) : [];
  const workspace = state.view.kind === 'workspace' ? findWorkspace(state.projects, state.view.id) : undefined;
  const shared = state.view.kind === 'shared' ? state.shared.find((w) => w.id === (state.view as { id: string }).id) : undefined;
  const pendingQuestion = state.questions[0];
  const planOpen = Boolean(ui.planFull && pendingQuestion?.qid === ui.planFull && pendingQuestion.question.kind === 'plan');
  const reviewing = state.view.kind === 'workspace' && state.view.tab === 'review';
  const filesVisible = state.view.kind === 'files' || ((state.view.kind === 'workspace' || state.view.kind === 'shared') && state.view.tab === 'files');
  const viewerOk = state.view.kind === 'room' || filesVisible;
  let focus = ui.focus;
  if (focus === 'viewer' && !(state.viewer && viewerOk)) focus = 'chat';
  if (focus === 'files' && !filesVisible) focus = 'chat';
  if (focus === 'main' && !reviewing && state.view.kind !== 'overview' && state.view.kind !== 'usage' && state.view.kind !== 'search') focus = 'chat';
  // The terminal gives the keyboard back while a menu, help or an approval needs it.
  if (focus === 'terminal' && (!(state.view.kind === 'workspace' && state.view.tab === 'terminal') || ui.menu || state.overlay || state.approvals.length)) focus = 'chat';
  // Claude's questions come first; then "how much do you trust this new person?".
  const trustPeer = !pendingQuestion && !ui.menu ? state.trustPrompts.find((id) => state.peers.some((p) => p.peerId === id)) : undefined;
  const approval = state.approvals[0];
  // The composer's right side (model picker, plan mode) takes a fixed column; the draft wraps beside it.
  const channel = channelOf(state.view);
  const chatty = channel !== 'draft' && state.view.kind !== 'search' && state.view.kind !== 'usage' && state.view.kind !== 'overview' && state.view.kind !== 'files';
  const modelText = ` ◆ ${modelLabel(state, channel === 'room' ? state.prefs.model : modelOf(state, channel))} ▾ `;
  const plan = state.planMode[channel] === true;
  const planText = plan ? ' ◉ plan mode ' : ' ○ plan mode ';
  const composerWidth = composerWrapWidth(columns, chatty ? width(modelText) + 3 + width(planText) + width(' ⇧Tab') : 0);
  const geometry = computeLayout({
    columns,
    rows,
    peopleCount: state.peers.length,
    hasViewer: Boolean(state.viewer) && viewerOk,
    suggestionCount: suggestionWindow(suggestions.length, ui.selected).rows,
    approvalDetail: approval?.detail,
    viewerFull: ui.viewerFull && focus === 'viewer',
    workspaceHeader: Boolean(workspace || shared) && !ui.menu,
    questionLines: pendingQuestion && !ui.menu && !planOpen ? questionModel(state, pendingQuestion, Math.max(10, columns - 4)).lines.length : trustPeer ? trustCardModel(state, trustPeer, Math.max(10, columns - 4)).lines.length : 0,
    composerLines: ui.buffer ? wrapBuffer(ui.buffer, composerWidth).length : 1,
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
  const questionRaw = pendingQuestion && g.questionHeight ? questionModel(state, pendingQuestion, Math.max(10, columns - 4)) : trustPeer && g.questionHeight ? trustCardModel(state, trustPeer, Math.max(10, columns - 4)) : undefined;
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
  const paneRaw = menu
    ? undefined
    : state.view.kind === 'search'
      ? searchModel(state, paneInner, frame)
      : state.view.kind === 'usage'
        ? usageModel(state, paneInner)
        : state.view.kind === 'draft' || state.view.kind === 'draft_worktree'
          ? draftModel(state, paneInner, state.view.kind === 'draft_worktree' ? 'worktree' : 'chat')
          : undefined;
  const paneRows = Math.max(1, g.paneHeight - 2);
  const paneScroll = !paneRaw
    ? 0
    : state.view.kind === 'search'
      ? Math.max(0, Math.min(searchCursorRow(state) - Math.floor(paneRows / 2), paneRaw.lines.length - paneRows))
      : Math.min(ui.overviewScroll, Math.max(0, paneRaw.lines.length - paneRows));
  const topRaw = topBarModel(state, Math.max(1, columns - 2));

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
  const pv = paneRaw ? emphasize(paneRaw, g.mainX + 2, g.paneTop + 1, hover, paneScroll) : undefined;
  const top = emphasize(topRaw, 1, 0, hover);
  // The composer's right side: model (click to change) and plan mode (click to switch).
  const composerY = g.composerTop + 1;
  const planX1 = columns - 3;
  const planX0 = planX1 - planText.length - ' ⇧Tab'.length + 1;
  const modelX1 = planX0 - 4;
  const modelX0 = modelX1 - modelText.length + 1;
  const composerZones: Zone[] = chatty
    ? [
        { x0: modelX0, x1: modelX1, y: composerY, action: { type: 'model_menu', channel }, hint: 'Pick the model for this conversation' },
        { x0: planX0, x1: planX1, y: composerY, action: { type: 'plan_toggle', channel }, hint: plan ? 'Plan mode is on: Claude plans first. Click to turn it off' : 'Turn on plan mode: Claude looks first and asks you to approve a plan' },
      ]
    : [];
  const hoverModel = hover && composerZones.find((z) => z.y === hover.y && hover.x >= z.x0 && hover.x <= z.x1);
  const composerRight: Line | undefined = chatty
    ? [
        { text: modelText, color: theme.muted, inverse: hoverModel?.action.type === 'model_menu' },
        { text: '   ' },
        { text: planText, color: plan ? theme.info : theme.border, bold: plan, inverse: hoverModel?.action.type === 'plan_toggle' },
        { text: ' ⇧Tab', color: theme.muted },
      ]
    : undefined;
  const planRaw = planOpen && pendingQuestion ? planFullModel(state, pendingQuestion, Math.max(10, columns - 4), Math.max(4, g.bodyHeight - 2), ui.planScroll) : undefined;
  const planV = planRaw ? emphasize(planRaw, 2, g.bodyTop + 1, hover) : undefined;
  const hint = (planV?.zone ?? headerHover ?? tab.zone ?? proj.zone ?? ov?.zone ?? rv?.zone ?? qv?.zone ?? pv?.zone ?? top.zone ?? hoverModel)?.hint;

  const compose = composeState(state, ui, selfId, channel, Boolean(shared));

  const zones: Zone[] = [];
  if (planV) zones.push(...offsetZones(planV.model.zones, 2, g.bodyTop + 1));
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
  if (pv) zones.push(...offsetZones(pv.model.zones, g.mainX + 2, g.paneTop + 1 - paneScroll).filter((z) => z.y > g.paneTop && z.y < g.paneTop + g.paneHeight - 1));
  zones.push(...offsetZones(top.model.zones, 1, 0), ...composerZones);

  return {
    geometry,
    suggestions,
    focus,
    menu,
    buttons: actionButtons(focus, state, suggestions.length > 0, { full: ui.viewerFull, raw: ui.viewerRaw }, focus === 'chat' ? compose : undefined),
    queuedIds: compose.ids,
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
    planFull: planV?.model,
    planMaxScroll: planRaw?.maxScroll ?? 0,
    planId: pendingQuestion?.question.kind === 'plan' ? pendingQuestion.qid : undefined,
    shared,
    zones,
    topBar: top.model,
    pane: pv?.model,
    paneScroll,
    composerRight,
    composerWidth,
    trustCard: questionRaw && !pendingQuestion ? trustPeer : undefined,
  };
}
