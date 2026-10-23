import { type DragEvent, type KeyboardEvent, memo, Suspense, useEffect, useRef, useState } from 'react';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { runId, setupId } from '@beluga/shared/terminal-keys.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Icon, type IconName } from '../components/Icon.js';
import { ActionsContext } from '../components/SpecMenu.js';
import { IconButton, Segmented, cx } from '../components/ui.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { currentTab, focusFor, paneShowing, paneTabsOf, placeTab, resetPanelLayout, setPanelTab, showPanelTab, tabShowing, tabsOf, useWorkspaceTabBridge } from '../lib/panel.js';
import { PANEL_DEFAULT, PANEL_LABELS, type PaneId, type PanelTab, SPLIT_MAX, SPLIT_MIN, PANES_DEFAULT, clampPanelWidth, clampShare, paneKey, panelDigit, panelFits, slotOf, viewsOf } from '../lib/panel-model.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { useMaking } from '../lib/making.js';
import { Inspector } from './Inspector.js';
import { ResizeHandle, usePresence, useWindowWidth } from './panel/ResizeHandle.js';
import { ChangesTab } from './panel/ChangesTab.js';
import { FilesTab } from './panel/FilesTab.js';
import { TerminalPane } from './panel/TerminalPane.js';
import { HistoryTab } from './panel/HistoryTab.js';
import { ScratchTab, useScratchNewest } from './panel/ScratchTab.js';
import { BackgroundTab, useBackgroundRunning } from './panel/BackgroundTab.js';
import s from './panel/panel.module.css';

const ICONS: Record<PanelTab, IconName> = {
  changes: 'diff',
  files: 'folder',
  terminal: 'terminal',
  info: 'inspector',
  history: 'clock',
  scratch: 'pulse',
  background: 'play',
};
const SLIDE_MS = 200;
const STEP = 24;

/** What a tab's label carries: the number of changed files, a running Run, something waiting on you. */
type Badges = Partial<Record<PanelTab, { count?: number; tone?: 'ok' | 'error' | 'warn' | 'accent' }>>;

function useBadges(): Badges {
  const view = useApp((st) => st.view);
  const projects = useApp((st) => st.projects);
  const terminals = useApp((st) => st.terminals);
  const exits = useApp((st) => st.termExits);
  const waiting = useApp((st) => st.approvals.length + st.questions.length);
  const ws = view.kind === 'workspace' ? findWorkspace(projects, view.id) : undefined;
  const changed = ws?.status?.changed ?? 0;
  // A Claude edit shows on the Changes tab (accent) until you look; it never switches tabs by itself.
  const seen = useRef(new Map<string, number>());
  const prefs = usePrefs();
  const looking = ws && tabShowing({ view, projects }, 'changes', prefs);
  if (ws && (looking || !seen.current.has(ws.id))) seen.current.set(ws.id, changed);
  const fresh = ws ? changed > 0 && changed !== seen.current.get(ws.id) : false;
  const running = (k: string): boolean => k in terminals && !(k in exits);
  const failed = ws ? [runId(ws.id), setupId(ws.id)].some((k) => (exits[k] ?? 0) !== 0) : false;
  const background = useBackgroundRunning(ws);
  // Something Claude saved to Scratch since you last looked: a dot until you do.
  const newest = useScratchNewest(ws?.id);
  const scratchSeen = useRef(new Map<string, number>());
  const lookingScratch = ws && tabShowing({ view, projects }, 'scratch', prefs);
  if (ws && newest !== undefined && (lookingScratch || !scratchSeen.current.has(ws.id))) scratchSeen.current.set(ws.id, newest);
  const freshScratch = ws && newest !== undefined ? newest > (scratchSeen.current.get(ws.id) ?? newest) : false;
  return {
    ...(freshScratch ? { scratch: { tone: 'accent' as const } } : {}),
    ...(background ? { background: { tone: 'ok' as const } } : {}),
    ...(changed
      ? {
          changes: {
            count: changed,
            ...(fresh ? { tone: 'accent' as const } : {}),
          },
        }
      : {}),
    ...(ws && (running(runId(ws.id)) || running(setupId(ws.id))) ? { terminal: { tone: 'ok' as const } } : failed ? { terminal: { tone: 'error' as const } } : {}),
    ...(waiting ? { info: { tone: 'warn' as const } } : {}),
  };
}

/** Changes' view you used last in each pane (History, say), so going back to Changes finds it. */
const changesView = new Map<string, PanelTab>();

/** The kind of data a dragged panel tab carries (only panel tabs drop on panes). */
const DRAG_TYPE = 'application/x-beluga-panel-tab';
/** The tab being dragged (the drag's data can't be read until it drops). */
let dragged: PanelTab | undefined;

/**
 * A pane's tabs, always named. Drag one along the strip or to the other pane to keep it there
 * (or right-click it: Move to Bottom / Top). Changes opens on the view you used last (History).
 */
function TabStrip({ pane, tabs, tab, open, badges, dock = false }: { pane: PaneId; tabs: readonly PanelTab[]; tab: PanelTab | undefined; open: boolean; badges: Badges; dock?: boolean }) {
  const view = useApp((st) => st.view);
  const projects = useApp((st) => st.projects);
  const prefs = usePrefs();
  const list = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<number>();
  const shown = tab ? slotOf(tab) : undefined;
  const pick = (t: PanelTab): void => {
    // Changes keeps its view: History, if that's where you were.
    const last = changesView.get(paneKey(view, pane));
    setPanelTab(view, t === 'changes' && last && viewsOf(last, tabsOf({ view, projects })).includes(last) ? last : t);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const at = tabs.findIndex((t) => slotOf(t) === shown);
    const next = tabs[(at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!;
    pick(next);
    list.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };
  // Where a dropped tab goes: before the tab under the pointer's left half, else at the end.
  const indexAt = (x: number): number => {
    const buttons = [...(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const i = buttons.findIndex((b) => {
      const r = b.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    return i < 0 ? tabs.length : i;
  };
  const onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDrop(indexAt(e.clientX));
  };
  const onDrop = (e: DragEvent): void => {
    const moving = dragged;
    setDrop(undefined);
    if (!moving || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    const before = tabs[indexAt(e.clientX)];
    placeTab({ view, projects }, moving, pane, before && slotOf(before) !== slotOf(moving) ? before : undefined);
  };
  const other: PaneId = pane === 'top' ? 'bottom' : 'top';
  return (
    <div
      ref={list}
      className={cx(s.tabs, dock && s.dockTabs, drop !== undefined && s.tabsDrop)}
      role="tablist"
      aria-label={pane === 'top' ? 'Panel' : 'Panel bottom'}
      onKeyDown={onKey}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!list.current?.contains(e.relatedTarget as Node | null)) setDrop(undefined);
      }}
      onDrop={onDrop}
    >
      {tabs.map((t, i) => {
        const b = badges[t] ?? (t === 'changes' ? badges.history : undefined);
        const on = open && slotOf(t) === shown;
        return (
          <ActionsContext
            key={t}
            items={[
              {
                label: other === 'bottom' ? 'Move to Bottom' : 'Move to Top',
                icon: other === 'bottom' ? 'panelBottom' : 'panelRight',
                onSelect: () => placeTab({ view, projects }, t, other),
              },
              {
                label: 'Reset Panel Layout',
                separate: true,
                onSelect: resetPanelLayout,
              },
            ]}
          >
            <button
              type="button"
              role="tab"
              data-tab={t}
              id={`panel-tab-${t}`}
              aria-controls={`panel-body-${pane}`}
              aria-selected={on}
              aria-label={PANEL_LABELS[t]}
              title={`${PANEL_LABELS[t]} (⌥⌘${panelDigit(t)}) · drag it to the other half, or right-click to move it`}
              tabIndex={slotOf(t) === shown ? 0 : -1}
              draggable
              className={cx(s.tab, on && s.tabOn, drop === i && s.dropBefore)}
              onClick={() => pick(t)}
              onDragStart={(e) => {
                dragged = t;
                e.dataTransfer.setData(DRAG_TYPE, t);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                dragged = undefined;
                setDrop(undefined);
              }}
            >
              {dock ? null : <Icon name={ICONS[t]} size={13} />}
              <span className={s.tabName}>
                <span>{PANEL_LABELS[t]}</span>
              </span>
              {b?.count ? <span className={cx(s.count, b.tone === 'accent' && s.countFresh)}>{b.count > 99 ? '99+' : b.count}</span> : b?.tone ? <span className={cx(s.tabDot, s[`tabDot_${b.tone}`])} /> : null}
            </button>
          </ActionsContext>
        );
      })}
      {drop === tabs.length ? <span className={s.dropEnd} aria-hidden="true" /> : null}
    </div>
  );
}

/** Changes' second view, switched at its top: what changed, or the branch's History. */
function ViewSwitch({ views, tab, pane }: { views: readonly PanelTab[]; tab: PanelTab; pane: PaneId }) {
  const view = useApp((st) => st.view);
  if (views.length < 2) return null;
  return (
    <div className={s.views}>
      <Segmented
        radio
        label={`${PANEL_LABELS[views[0]!]} views`}
        value={tab}
        onChange={(v) => {
          changesView.set(paneKey(view, pane), v);
          setPanelTab(view, v);
        }}
        options={views.map((v) => ({
          value: v,
          label: PANEL_LABELS[v],
          keys: `⌥⌘${panelDigit(v)}`,
        }))}
      />
    </div>
  );
}

/**
 * One pane: its tabs, Changes' view switch, and the tab's content. The bottom one closes to just
 * its tabs (the chevron, ⌘J for the terminal) and opens again from any of them.
 */
function Pane({ pane, lead, style, badges }: { pane: PaneId; lead: boolean; style?: React.CSSProperties; badges: Badges }) {
  const prefs = usePrefs();
  const view = useApp((st) => st.view);
  const projects = useApp((st) => st.projects);
  const state = { view, projects };
  const tabs = paneTabsOf(state, pane, prefs);
  const tab = currentTab(state, prefs, pane);
  const open = pane === 'top' || prefs.bottomOpen || lead;
  const wsId = view.kind === 'workspace' ? view.id : undefined;
  const making = useMaking();
  if (!tabs.length || !tab) return null;
  // Dropping on the pane's content puts the tab at the end of its strip.
  const onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
  };
  const onDrop = (e: DragEvent): void => {
    if (!dragged || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    placeTab(state, dragged, pane);
    dragged = undefined;
  };
  // Under the top pane, what runs is a dock of its own (its own background, edge and tabs), and
  // folded it's a slim bar: never read as more tabs of what's above it.
  const dock = pane === 'bottom' && !lead;
  return (
    <section className={cx(s.pane, !open && s.paneClosed, dock && s.dock, dock && !open && s.dockClosed)} style={open ? style : undefined} aria-label={pane === 'top' ? undefined : 'Bottom of the panel'} data-pane={pane}>
      <header
        className={lead ? s.head : cx(s.paneHead, dock && s.dockHead)}
        {...(lead ? { 'data-tauri-drag-region': true } : {})}
        {...(dock && !open ? { onClick: (e: React.MouseEvent) => e.target === e.currentTarget && setPrefs({ bottomOpen: true }), title: 'Show the terminal dock (⌘J)' } : {})}
      >
        {dock ? <Icon name="terminal" size={12} className={s.dockMark} /> : null}
        <TabStrip pane={pane} tabs={tabs} tab={tab} open={open} badges={badges} dock={dock} />
        {dock ? (
          <IconButton icon={open ? 'chevronDown' : 'chevronUp'} label={open ? 'Hide the terminal dock' : 'Show the terminal dock'} className={s.paneToggle} onClick={() => setPrefs({ bottomOpen: !open })} />
        ) : null}
      </header>
      {open ? (
        <>
          <ViewSwitch views={viewsOf(tab, tabsOf(state))} tab={tab} pane={pane} />
          <div className={s.body} id={pane === 'top' ? 'panel-body' : 'panel-body-bottom'} role="tabpanel" aria-labelledby={`panel-tab-${slotOf(tab)}`} onDragOver={onDragOver} onDrop={onDrop}>
            {/* A worktree being made has no folder yet: its tabs fill in once it's there. */}
            {making ? (
              <div className={s.loading} />
            ) : (
              <Suspense fallback={<div className={s.loading} />}>
                <Body tab={tab} wsId={wsId} {...(view.kind === 'project' ? { projectId: view.id } : {})} />
              </Suspense>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** The tab's content. Memoized: the panel re-renders as the conversation streams; its tabs only when their own data changes. */
const Body = memo(function Body({ tab, wsId, projectId }: { tab: PanelTab; wsId: string | undefined; projectId?: string }) {
  switch (tab) {
    case 'changes':
      return wsId ? <ChangesTab key={wsId} wsId={wsId} /> : null;
    case 'files':
      return wsId ? <FilesTab key={wsId} wsId={wsId} /> : null;
    case 'terminal':
      return <TerminalPane where="panel" />;
    case 'info':
      return (
        <div className={s.info}>
          <Inspector />
        </div>
      );
    case 'scratch':
      return wsId ? <ScratchTab key={wsId} wsId={wsId} /> : null;
    case 'background':
      return wsId ? <BackgroundTab key={wsId} wsId={wsId} /> : null;
    case 'history': {
      const target = wsId ?? projectId;
      return target ? <HistoryTab key={target} target={target} /> : null;
    }
  }
});

/**
 * Opening a file yourself (a link in the chat, Open File in a diff) shows it in the Files tab.
 * Not while a file is open full size: a link in it opens the next page right there.
 */
function useFileFollow(): void {
  const { client } = useBeluga();
  const opened = useApp((st) => (st.viewer && !st.viewer.by ? `${st.viewer.owner}\n${st.viewer.share}\n${st.viewer.path}` : ''));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    const state = client.store.getState();
    const v = state.view;
    if (!opened || v.kind !== 'workspace' || focusFor(v.id)) return;
    const [owner, share] = opened.split('\n');
    if (owner === state.selfId && share === shareNameOf(v.id)) showPanelTab(state, 'files');
  }, [opened]);
}

/**
 * The right side of the window, in two panes: what Claude made on top (Changes, Files, Scratch,
 * Info) and what runs below (Terminal, Background), split where you drag it. It slides in and out
 * (⌥⌘0), is as wide as you drag it, and remembers each pane's tab in each workspace.
 */
export function RightPanel() {
  const { client } = useBeluga();
  useWorkspaceTabBridge(client);
  useFileFollow();
  const prefs = usePrefs();
  const view = useApp((st) => st.view);
  const projects = useApp((st) => st.projects);
  const state = { view, projects };
  const windowWidth = useWindowWidth();
  const [drag, setDrag] = useState<number>();
  const inner = useRef<HTMLDivElement>(null);
  const width = clampPanelWidth(drag ?? prefs.panelWidth, windowWidth);
  // Not beside a plan: its chat is the page's right side (your choice stays for everywhere else).
  const open = prefs.inspector && panelFits(view);
  const presence = usePresence(open, SLIDE_MS);
  const hasTop = paneTabsOf(state, 'top', prefs).length > 0;
  const hasBottom = paneTabsOf(state, 'bottom', prefs).length > 0;
  const split = clampShare(prefs.paneSplit, SPLIT_MIN, SPLIT_MAX);
  const both = hasTop && hasBottom && paneShowing(state, 'bottom', prefs);
  const badges = useBadges();
  return (
    <aside className={cx(s.panel, drag !== undefined && s.dragging, !open && s.closed)} style={{ width: open ? width : 0 }} aria-label="Panel" aria-hidden={!open} inert={!open}>
      {presence.mounted ? (
        <div ref={inner} className={s.inner} style={{ width }}>
          <ResizeHandle
            axis="x"
            label="Resize the panel"
            className={s.edge}
            onMove={(x) => setDrag(window.innerWidth - x)}
            onEnd={() => {
              if (drag !== undefined)
                setPrefs({
                  panelWidth: clampPanelWidth(drag, window.innerWidth),
                });
              setDrag(undefined);
            }}
            onReset={() => setPrefs({ panelWidth: PANEL_DEFAULT })}
            onStep={(dir) =>
              setPrefs({
                panelWidth: clampPanelWidth(width + dir * STEP, window.innerWidth),
              })
            }
          />
          <Pane pane="top" lead badges={badges} style={both ? { flex: `0 0 ${Math.round(split * 100)}%` } : undefined} />
          {both ? (
            <ResizeHandle
              axis="y"
              label="Resize the panes"
              onMove={(y) => {
                const r = inner.current?.getBoundingClientRect();
                if (r)
                  setPrefs({
                    paneSplit: clampShare((y - r.top) / r.height, SPLIT_MIN, SPLIT_MAX),
                  });
              }}
              onReset={() => setPrefs({ paneSplit: PANES_DEFAULT })}
              onStep={(dir) =>
                setPrefs({
                  paneSplit: clampShare(split - dir * 0.04, SPLIT_MIN, SPLIT_MAX),
                })
              }
            />
          ) : null}
          <Pane pane="bottom" lead={!hasTop} badges={badges} />
        </div>
      ) : null}
    </aside>
  );
}
