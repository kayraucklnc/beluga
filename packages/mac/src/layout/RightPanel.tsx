import { type KeyboardEvent, memo, Suspense, useEffect, useRef, useState } from 'react';
import { shareNameOf } from '@klaud/shared/share-names.js';
import { runId, setupId } from '@klaud/shared/terminal-keys.js';
import { findWorkspace } from '@klaud/ui/workspace-models.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { useApp, useKlaud } from '../lib/klaud.js';
import { currentTab, setPanelTab, showPanelTab, tabsOf, useWorkspaceTabBridge } from '../lib/panel.js';
import { PANEL_DEFAULT, PANEL_LABELS, type PanelTab, clampPanelWidth, panelDigit } from '../lib/panel-model.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { Inspector } from './Inspector.js';
import { ResizeHandle, usePresence, useWindowWidth } from './panel/ResizeHandle.js';
import { ChangesTab } from './panel/ChangesTab.js';
import { FilesTab } from './panel/FilesTab.js';
import { TerminalPane } from './panel/TerminalPane.js';
import s from './panel/panel.module.css';


const ICONS: Record<PanelTab, IconName> = { changes: 'diff', files: 'folder', terminal: 'terminal', info: 'inspector' };
const SLIDE_MS = 200;
const STEP = 24;

/** What a tab's label carries: the number of changed files, a running Run, something waiting on you. */
function useBadges(): Partial<Record<PanelTab, { count?: number; tone?: 'ok' | 'error' | 'warn' | 'accent' }>> {
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
  const looking = ws && prefs.inspector && currentTab({ view, projects }, prefs) === 'changes';
  if (ws && (looking || !seen.current.has(ws.id))) seen.current.set(ws.id, changed);
  const fresh = ws ? changed > 0 && changed !== seen.current.get(ws.id) : false;
  const running = (k: string): boolean => k in terminals && !(k in exits);
  const failed = ws ? [runId(ws.id), setupId(ws.id)].some((k) => (exits[k] ?? 0) !== 0) : false;
  return {
    ...(changed ? { changes: { count: changed, ...(fresh ? { tone: 'accent' as const } : {}) } } : {}),
    ...(ws && (running(runId(ws.id)) || running(setupId(ws.id))) ? { terminal: { tone: 'ok' as const } } : failed ? { terminal: { tone: 'error' as const } } : {}),
    ...(waiting ? { info: { tone: 'warn' as const } } : {}),
  };
}

function TabStrip({ tabs, tab, width }: { tabs: readonly PanelTab[]; tab: PanelTab; width: number }) {
  const view = useApp((st) => st.view);
  const badges = useBadges();
  const list = useRef<HTMLDivElement>(null);
  // Wide: icon and name; narrower: the name; narrowest: the icon (named in its tooltip).
  const look = width >= 430 || tabs.length < 3 ? 'full' : width >= 352 ? 'label' : 'icon';
  const pick = (t: PanelTab): void => setPanelTab(view, t);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!;
    pick(next);
    list.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };
  return (
    <div ref={list} className={s.tabs} role="tablist" aria-label="Panel" onKeyDown={onKey}>
      {tabs.map((t) => {
        const b = badges[t];
        const on = t === tab;
        return (
          <Tip key={t} label={PANEL_LABELS[t]} keys={`⌥⌘${panelDigit(t)}`}>
            <button type="button" role="tab" data-tab={t} id={`panel-tab-${t}`} aria-controls="panel-body" aria-selected={on} aria-label={PANEL_LABELS[t]} tabIndex={on ? 0 : -1} className={cx(s.tab, on && s.tabOn)} onClick={() => pick(t)}>
              {look !== 'label' ? <Icon name={ICONS[t]} size={13} /> : null}
              {look !== 'icon' ? <span>{PANEL_LABELS[t]}</span> : null}
              {b?.count ? <span className={cx(s.count, b.tone === 'accent' && s.countFresh)}>{b.count > 99 ? '99+' : b.count}</span> : b?.tone ? <span className={cx(s.tabDot, s[`tabDot_${b.tone}`])} /> : null}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** The tab's content. Memoized: the panel re-renders as the conversation streams; its tabs only when their own data changes. */
const Body = memo(function Body({ tab, wsId }: { tab: PanelTab; wsId: string | undefined }) {
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
  }
});

/** Opening a file yourself (a link in the chat, Open File in a diff) shows it in the Files tab. */
function useFileFollow(): void {
  const { client } = useKlaud();
  const opened = useApp((st) => (st.viewer && !st.viewer.by ? `${st.viewer.owner}\n${st.viewer.share}\n${st.viewer.path}` : ''));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    const state = client.store.getState();
    const v = state.view;
    if (!opened || v.kind !== 'workspace') return;
    const [owner, share] = opened.split('\n');
    if (owner === state.selfId && share === shareNameOf(v.id)) showPanelTab(state, 'files');
  }, [opened]);
}

/**
 * The right side of the window: what changed, the files, a terminal, and the details (the
 * inspector), as tabs. It slides in and out (⌥⌘0), is as wide as you drag it, and remembers
 * the tab you last picked in each workspace.
 */
export function RightPanel() {
  const { client } = useKlaud();
  useWorkspaceTabBridge(client);
  useFileFollow();
  const prefs = usePrefs();
  const view = useApp((st) => st.view);
  const projects = useApp((st) => st.projects);
  const state = { view, projects };
  const tabs = tabsOf(state);
  const tab = currentTab(state, prefs);
  const windowWidth = useWindowWidth();
  const [drag, setDrag] = useState<number>();
  const width = clampPanelWidth(drag ?? prefs.panelWidth, windowWidth);
  const open = prefs.inspector;
  const presence = usePresence(open, SLIDE_MS);
  const wsId = view.kind === 'workspace' ? view.id : undefined;
  return (
    <aside className={cx(s.panel, drag !== undefined && s.dragging, !open && s.closed)} style={{ width: open ? width : 0 }} aria-label="Panel" aria-hidden={!open} inert={!open}>
      {presence.mounted ? (
        <div className={s.inner} style={{ width }}>
          <ResizeHandle
            axis="x"
            label="Resize the panel"
            className={s.edge}
            onMove={(x) => setDrag(window.innerWidth - x)}
            onEnd={() => {
              if (drag !== undefined) setPrefs({ panelWidth: clampPanelWidth(drag, window.innerWidth) });
              setDrag(undefined);
            }}
            onReset={() => setPrefs({ panelWidth: PANEL_DEFAULT })}
            onStep={(dir) => setPrefs({ panelWidth: clampPanelWidth(width + dir * STEP, window.innerWidth) })}
          />
          <header className={s.head} data-tauri-drag-region>
            <TabStrip tabs={tabs} tab={tab} width={width} />
          </header>
          <div className={s.body} id="panel-body" role="tabpanel" aria-labelledby={`panel-tab-${tab}`}>
            <Suspense fallback={<div className={s.loading} />}>
              <Body tab={tab} wsId={wsId} />
            </Suspense>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
