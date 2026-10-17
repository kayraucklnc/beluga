import type { AppState } from '../core/store.js';
import { type ActionButton, buttonLabel } from './actions.js';
import { type Geometry, fileWindow, placeButtons } from './layout.js';
import type { MenuSpec } from './menus.js';
import type { UiAction, Zone } from './workspace-models.js';

export type Target =
  | { readonly kind: 'person'; readonly index: number }
  | { readonly kind: 'file'; readonly index: number }
  | { readonly kind: 'chat' }
  | { readonly kind: 'viewer' }
  | { readonly kind: 'files' }
  | { readonly kind: 'projects' }
  | { readonly kind: 'main' }
  | { readonly kind: 'terminal' }
  | { readonly kind: 'menu'; readonly index: number }
  | { readonly kind: 'suggestion'; readonly index: number }
  | { readonly kind: 'approval'; readonly answer: 'yes' | 'no' | 'always' }
  | { readonly kind: 'action'; readonly id: string }
  | { readonly kind: 'composer' }
  | { readonly kind: 'viewer_action'; readonly id: string }
  | { readonly kind: 'zone'; readonly action: UiAction; readonly hint?: string; readonly disabled?: boolean }
  | { readonly kind: 'none' };

export const APPROVAL_BUTTONS = [
  { answer: 'yes' as const, label: 'Ctrl+Y allow' },
  { answer: 'no' as const, label: 'Ctrl+N deny' },
  { answer: 'always' as const, label: 'Ctrl+T always allow this person' },
];
export const APPROVAL_GAP = 4;
export const ACTION_GAP = 3;
export const VIEWER_LEGEND_GAP = 3;

export interface HitContext {
  readonly state: AppState;
  readonly menu?: MenuSpec;
  readonly suggestionCount: number;
  readonly buttons: readonly ActionButton[];
  readonly approvalDetailLines: number;
  /** Buttons on the viewer's bottom line, if a file is open. */
  readonly viewerLegend?: ReadonlyArray<{ id: string; label: string }>;
  /** Clickable zones from the projects, tabs, overview, header and review models (screen coordinates). */
  readonly zones?: readonly Zone[];
}

const inside = (v: number, lo: number, len: number): boolean => v >= lo && v < lo + len;

/** Shift a model's zones from its own origin to screen coordinates. */
export const offsetZones = (zones: readonly Zone[], x: number, y: number): Zone[] => zones.map((z) => ({ ...z, x0: z.x0 + x, x1: z.x1 + x, y: z.y + y }));

/** Map a mouse position to the thing under it. Mirrors the layout used for rendering. */
export function hitTest(g: Geometry, x: number, y: number, ctx: HitContext): Target {
  if (y === g.actionBarY) {
    const hit = placeButtons(ctx.buttons.map((b) => ({ ...b, label: buttonLabel(b) })), 2, ACTION_GAP).find((b) => x >= b.x0 && x <= b.x1);
    return hit ? { kind: 'action', id: hit.id } : { kind: 'none' };
  }
  if (inside(y, g.composerTop, 3)) {
    // The model picker and plan mode live inside the box.
    const chip = ctx.zones?.find((z) => z.y === y && x >= z.x0 && x <= z.x1 && z.action.type !== 'none');
    return chip ? { kind: 'zone', action: chip.action, hint: chip.hint, disabled: chip.disabled } : { kind: 'composer' };
  }
  if (inside(y, g.suggestionsTop, ctx.suggestionCount)) return { kind: 'suggestion', index: y - g.suggestionsTop };
  if (g.approvalHeight > 0 && y === g.approvalTop + 2 + ctx.approvalDetailLines) {
    const hit = placeButtons(APPROVAL_BUTTONS, 2, APPROVAL_GAP).find((b) => x >= b.x0 && x <= b.x1);
    return hit ? { kind: 'approval', answer: hit.answer } : { kind: 'none' };
  }
  // Claude's question card sits below the body, so its buttons are checked before the body bounds.
  const below = !inside(y, g.bodyTop, g.bodyHeight);
  if (ctx.menu && x >= g.mainX && !below) {
    const index = y - (g.headerTop + 1 + ctx.menu.intro.length + 1);
    return index >= 0 && index < ctx.menu.options.length ? { kind: 'menu', index } : { kind: 'none' };
  }
  const zone = ctx.zones?.find((z) => z.y === y && x >= z.x0 && x <= z.x1 && z.action.type !== 'none');
  if (zone) return { kind: 'zone', action: zone.action, hint: zone.hint, disabled: zone.disabled };
  if (below) return { kind: 'none' };

  if (x < g.sideWidth) {
    if (y >= g.peopleTop) {
      const index = Math.floor((y - g.peopleTop - 1) / 2);
      return index >= 0 && index < ctx.state.peers.length ? { kind: 'person', index } : { kind: 'none' };
    }
    return { kind: 'projects' };
  }
  if (y < g.paneTop) return { kind: 'main' };
  const view = ctx.state.view;
  if (view.kind === 'workspace' && view.tab === 'terminal') return y > g.paneTop ? { kind: 'terminal' } : { kind: 'main' };
  const inViewer = x >= g.mainX + g.chatWidth && g.viewerWidth > 0;
  if (!inViewer && view.kind === 'files') {
    const win = fileWindow(ctx.state.browser, g.paneHeight);
    const row = y - g.paneTop - 1 - win.firstRowOffset;
    const index = win.start + row;
    return row >= 0 && row < win.count && index < ctx.state.browser.rows.length ? { kind: 'file', index } : { kind: 'files' };
  }
  if (inViewer) {
    if (ctx.viewerLegend && y === g.paneTop + g.paneHeight - 2) {
      const hit = placeButtons(ctx.viewerLegend, g.mainX + g.chatWidth + 2, VIEWER_LEGEND_GAP).find((b) => x >= b.x0 && x <= b.x1);
      if (hit) return { kind: 'viewer_action', id: hit.id };
    }
    return { kind: 'viewer' };
  }
  if (view.kind === 'overview' || view.kind === 'search' || view.kind === 'usage' || (view.kind === 'workspace' && view.tab === 'review')) return { kind: 'main' };
  return { kind: 'chat' };
}
