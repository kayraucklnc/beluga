import { describe, expect, it } from 'vitest';
import type { View } from '../src/core/store.js';
import { DEFAULT_LAYOUT, PANEL_MIN, PLAN_CENTER_MIN, clampPanelWidth, clampPlanPanelWidth, normalizeLayout, panelTabsFor, panelWidthFor, panelWidthPatch, planPanelDefault } from '../packages/mac/src/lib/panel-model.js';
import { CHAT_DEFAULT, CHAT_MIN } from '../packages/mac/src/plans/plan-layout.js';

const ws: View = { kind: 'workspace', id: 'w1', tab: 'chat' };

describe('the chat’s Plan tab', () => {
  it('is there only for a chat that has a plan', () => {
    expect(panelTabsFor(ws, 'chat')).not.toContain('plan');
    expect(panelTabsFor(ws, 'chat', false, true)[0]).toBe('plan');
    expect(panelTabsFor(ws, 'worktree', false, true)).not.toContain('plan');
    expect(panelTabsFor({ kind: 'room' }, undefined, false, true)).not.toContain('plan');
  });

  it('sits first in the top pane, also in a layout saved before it existed', () => {
    expect(DEFAULT_LAYOUT.top[0]).toBe('plan');
    expect(normalizeLayout({ top: ['changes', 'files'], bottom: ['terminal'] }).top).toContain('plan');
  });
});

describe('the panel’s width while the Plan tab shows', () => {
  it('starts at the Plan page’s proportions: the window less the sidebar and a 380 px chat', () => {
    expect(CHAT_DEFAULT).toBe(380);
    expect(planPanelDefault(1600)).toBe(1600 - 380);
    expect(planPanelDefault(1600, 248)).toBe(1600 - 248 - 380);
    expect(panelWidthFor(true, { panelWidth: 400 }, 1600, 248)).toBe(1600 - 248 - 380);
  });

  it('keeps the center at least 300 px wide', () => {
    expect(PLAN_CENTER_MIN).toBe(CHAT_MIN);
    expect(CHAT_MIN).toBe(300);
    expect(clampPlanPanelWidth(5000, 1600, 248)).toBe(1600 - 248 - 300);
    expect(panelWidthFor(true, { panelWidth: 400, planPanelWidth: 1500 }, 1600, 0)).toBe(1300);
  });

  it('never gets under the panel’s minimum', () => {
    expect(clampPlanPanelWidth(10, 1600)).toBe(PANEL_MIN);
    expect(panelWidthFor(true, { panelWidth: 400 }, 700, 248)).toBe(PANEL_MIN);
  });

  it('uses the width you dragged it to', () => {
    expect(panelWidthFor(true, { panelWidth: 400, planPanelWidth: 900 }, 1600, 248)).toBe(900);
  });

  it('a drag saves planPanelWidth while the Plan tab shows, panelWidth otherwise', () => {
    expect(panelWidthPatch(true, 950.4, 1600, 248)).toEqual({ planPanelWidth: 950 });
    expect(panelWidthPatch(true, 5000, 1600, 248)).toEqual({ planPanelWidth: 1600 - 248 - 300 });
    expect(panelWidthPatch(false, 450, 1600, 248)).toEqual({ panelWidth: clampPanelWidth(450, 1600, 248) });
  });

  it('other tabs keep their own width', () => {
    expect(panelWidthFor(false, { panelWidth: 420, planPanelWidth: 900 }, 1600, 248)).toBe(clampPanelWidth(420, 1600, 248));
  });
});
