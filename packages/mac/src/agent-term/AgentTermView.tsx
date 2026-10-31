import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { agentTermId, paneTermId } from '@beluga/shared/terminal-keys.js';
import { Icon } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { ResizeHandle } from '../layout/panel/ResizeHandle.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { clampVisuals } from '../lib/convo-mode.js';
import { DEFAULT_PREFS, getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { chordLabel } from '../lib/shortcuts-model.js';
import { type TermAction, termKeysOf } from '../lib/term-keys.js';
import { AGENT_TAB, MAX_PANES, MAX_TABS, type PaneTree, type TermTabs, addTab, allPaneKeys, closePane, closeTab, gotoTab, nextPaneNumber, paneKeys, resizeSplit, splitPane, stepTab, tabOf, tabsOf, toggleZoom, withTree } from '../lib/term-panes.js';
import { TermPane } from './TermPane.js';
import { type Opened, VisualsPanel, openedId } from './VisualsPanel.js';
import s from './agent-term.module.css';

const TABS_KEY = 'beluga.termTabs.v1';

/** Each conversation's tabs and panes, kept on this Mac. */
function loadTabs(wsId: string): TermTabs {
  try {
    return tabsOf((JSON.parse(localStorage.getItem(TABS_KEY) ?? '{}') as Record<string, unknown>)[wsId], agentTermId(wsId));
  } catch {
    return tabsOf(undefined, agentTermId(wsId));
  }
}

function saveTabs(wsId: string, tabs: TermTabs): void {
  try {
    const all = JSON.parse(localStorage.getItem(TABS_KEY) ?? '{}') as Record<string, unknown>;
    const { [wsId]: _was, ...rest } = all;
    localStorage.setItem(TABS_KEY, JSON.stringify(Object.fromEntries([...Object.entries(rest).slice(-49), [wsId, tabs]])));
  } catch {
    // storage unavailable: the tabs last until the window closes
  }
}

interface SplitsProps {
  readonly tree: PaneTree;
  readonly path: string;
  readonly render: (key: string) => ReactElement;
  readonly onResize: (path: string, ratio: number) => void;
}

/** The panes as their splits lay them out, each divider draggable. */
function Splits({ tree, path, render, onResize }: SplitsProps) {
  const box = useRef<HTMLDivElement>(null);
  if (tree.kind === 'pane') return render(tree.key);
  const right = tree.dir === 'right';
  return (
    <div ref={box} className={right ? s.splitRow : s.splitCol}>
      <div className={s.splitPart} style={{ flex: `${tree.ratio} 1 0` }}>
        <Splits tree={tree.a} path={`${path}a`} render={render} onResize={onResize} />
      </div>
      <ResizeHandle
        axis={right ? 'x' : 'y'}
        label={right ? 'Resize the panes side by side' : 'Resize the panes one above the other'}
        className={s.splitHandle}
        onMove={(pos) => {
          const r = box.current?.getBoundingClientRect();
          if (r) onResize(path, right ? (pos - r.left) / r.width : (pos - r.top) / r.height);
        }}
        onReset={() => onResize(path, 0.5)}
        onStep={(dir) => onResize(path, tree.ratio + dir * -0.05)}
      />
      <div className={s.splitPart} style={{ flex: `${1 - tree.ratio} 1 0` }}>
        <Splits tree={tree.b} path={`${path}b`} render={render} onResize={onResize} />
      </div>
    </div>
  );
}

/** The pane next to `from` on a side, by where they are on screen (as iTerm2's ⌥⌘← does). */
function paneToward(root: HTMLElement, from: string, side: 'left' | 'right' | 'up' | 'down'): string | undefined {
  const panes = [...root.querySelectorAll<HTMLElement>('[data-term-key]')].filter((el) => el.offsetParent !== null && el.closest('[data-tab-shown="true"]'));
  const here = panes.find((el) => el.dataset.termKey === from)?.getBoundingClientRect();
  if (!here) return undefined;
  const cx0 = here.left + here.width / 2;
  const cy0 = here.top + here.height / 2;
  let best: { key: string; d: number } | undefined;
  for (const el of panes) {
    const r = el.getBoundingClientRect();
    const key = el.dataset.termKey!;
    if (key === from) continue;
    const ok = side === 'left' ? r.right <= here.left + 2 : side === 'right' ? r.left >= here.right - 2 : side === 'up' ? r.bottom <= here.top + 2 : r.top >= here.bottom - 2;
    if (!ok) continue;
    const d = Math.hypot(r.left + r.width / 2 - cx0, r.top + r.height / 2 - cy0);
    if (!best || d < best.d) best = { key, d };
  }
  return best?.key;
}

/** Put the keyboard in a pane's terminal. */
const focusPane = (root: HTMLElement | null, key: string): void => {
  requestAnimationFrame(() => (root?.querySelector(`[data-term-key="${CSS.escape(key)}"] .xterm-helper-textarea`) as HTMLElement | null)?.focus());
};

/**
 * The terminal view of a conversation (BLG-534): the agent's own terminal app on the same
 * conversation as the chat, in its tab; shell tabs beside it (⌘T) for vim, a dev server or
 * anything else; each tab split as you like (⌘D, ⇧⌘D); and the visuals and tasks the agent's
 * links open, in a panel at the side (BLG-535). Its keys are a terminal's (lib/term-keys.ts).
 */
export function AgentTermView({ wsId }: { readonly wsId: string }) {
  const api = useApi();
  const { client } = useBeluga();
  const prefs = usePrefs();
  const cwd = useApp((st) => st.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId)?.path ?? '');
  const agentLabel = useApp((st) => st.agentTerms[wsId]?.label ?? st.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId)?.agent?.label ?? 'Your agent');
  const visuals = useApp((st) => st.termVisuals[wsId]);
  const agentKey = agentTermId(wsId);
  const [tabs, setTabsState] = useState<TermTabs>(() => loadTabs(wsId));
  const [focusKey, setFocusKey] = useState<string>(agentKey);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<readonly Opened[]>([]);
  const [active, setActive] = useState('');
  const [drag, setDrag] = useState<number | undefined>(undefined);
  const view = useRef<HTMLDivElement>(null);
  const keys = termKeysOf(prefs.termKeys?.keys, prefs.termKeys?.from);
  const keyOf = (action: TermAction): string | undefined => {
    const k = keys.find((x) => x.action === action);
    return k ? chordLabel(k.chord) : undefined;
  };

  useEffect(() => {
    setTabsState(loadTabs(wsId));
    setOpened([]);
    setFocusKey(agentTermId(wsId));
  }, [wsId]);
  // The latest tabs for handlers made before the last change.
  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  const change = (next: TermTabs): void => {
    tabsNow.current = next;
    setTabsState(next);
    saveTabs(wsId, next);
  };
  const show = (next: TermTabs, key?: string): void => {
    change(next);
    const tab = next.tabs.find((x) => x.id === next.active);
    const target = key ?? (tab ? (tab.zoom ?? paneKeys(tab.tree)[0]) : undefined);
    if (target) {
      setFocusKey(target);
      focusPane(view.current, target);
    }
  };

  const open = useCallback((o: Opened): void => {
    const id = openedId(o);
    setOpened((list) => (list.some((x) => openedId(x) === id) ? list : [...list, o].slice(-8)));
    setActive(id);
  }, []);
  const closeAll = useCallback((): void => {
    setOpened([]);
    focusPane(view.current, focusKey);
  }, [focusKey]);
  const openNewest = (): void => {
    const newest = visuals?.[visuals.length - 1];
    if (newest) open({ kind: 'visual', n: newest.n });
    else toast(client, `No visuals yet: when ${agentLabel} shows a graph or a table here, ${keyOf('newest_visual') ?? '⌘↩'} opens it`, 'info');
  };

  const newKey = (t: TermTabs): string => paneTermId(wsId, nextPaneNumber(allPaneKeys(t)));
  const newTab = (): void => {
    const t = tabsNow.current;
    if (t.tabs.length >= MAX_TABS) return toast(client, `Up to ${MAX_TABS} tabs here`, 'info');
    const key = newKey(t);
    show(addTab(t, key), key);
  };
  const split = (target: string, dir: 'right' | 'down'): void => {
    const t = tabsNow.current;
    const tab = tabOf(t, target);
    if (!tab) return;
    if (paneKeys(tab.tree).length >= MAX_PANES) return toast(client, `Up to ${MAX_PANES} panes in one tab`, 'info');
    const key = newKey(t);
    show(withTree({ ...t, tabs: t.tabs.map((x) => (x.id === tab.id ? { id: x.id, tree: x.tree } : x)) }, tab.id, splitPane(tab.tree, target, dir, key)), key);
  };
  /** Close a shell pane, and its tab when it was the last one there. The agent's stays. */
  const close = (key: string): void => {
    const t = tabsNow.current;
    const tab = tabOf(t, key);
    if (!tab) return;
    if (key === agentKey) return toast(client, `${agentLabel}’s terminal stays here: Take Over in the chat gives the conversation back to it`, 'info');
    void api.terminals.close(key).catch(() => undefined);
    const keysLeft = paneKeys(tab.tree).filter((k) => k !== key);
    if (!keysLeft.length) return show(closeTab(t, tab.id));
    show(withTree(t, tab.id, closePane(tab.tree, key)), keysLeft[0]);
  };
  const closeWholeTab = (id: string): void => {
    const t = tabsNow.current;
    const tab = t.tabs.find((x) => x.id === id);
    if (!tab || id === AGENT_TAB) return;
    for (const k of paneKeys(tab.tree)) void api.terminals.close(k).catch(() => undefined);
    show(closeTab(t, id));
  };

  /** The view's part of a key: tabs, moving between panes, zoom, text size. */
  const onAction = (action: TermAction, from: string): void => {
    const t = tabsNow.current;
    if (action === 'new_tab') return newTab();
    if (action === 'close') return close(from);
    if (action === 'next_tab' || action === 'prev_tab') return show(stepTab(t, action === 'next_tab' ? 1 : -1));
    if (action.startsWith('tab:')) return show(gotoTab(t, Number(action.slice(4))));
    if (action === 'zoom') {
      const tab = tabOf(t, from);
      if (tab) show(toggleZoom(t, tab.id, from), from);
      return;
    }
    if (action === 'focus_prev' || action === 'focus_next') {
      const tab = tabOf(t, from);
      const list = tab ? paneKeys(tab.tree) : [];
      const at = list.indexOf(from);
      const next = list[(at + (action === 'focus_next' ? 1 : -1) + list.length) % list.length];
      if (next && next !== from) show(t, next);
      return;
    }
    if (action.startsWith('focus_') && view.current) {
      const next = paneToward(view.current, from, action.slice(6) as 'left');
      if (next) show(t, next);
      return;
    }
    if (action === 'font_up' || action === 'font_down') return setPrefs({ termFontSize: Math.min(22, Math.max(9, getPrefs().termFontSize + (action === 'font_up' ? 1 : -1))) });
    if (action === 'font_reset') return setPrefs({ termFontSize: DEFAULT_PREFS.termFontSize });
  };

  const panelOpen = opened.length > 0;
  const room = view.current?.getBoundingClientRect().width ?? 1200;
  const width = clampVisuals(drag ?? prefs.visualsWidth, room);
  const tabTitle = (id: string, tree: PaneTree, zoom?: string): string => {
    if (id === AGENT_TAB) return agentLabel;
    const key = zoom ?? paneKeys(tree).find((k) => k === focusKey) ?? paneKeys(tree)[0]!;
    return titles[key] || 'Shell';
  };
  return (
    <div ref={view} className={s.view}>
      <div className={s.main}>
        <div className={s.tabs} role="tablist" aria-label="Terminal tabs">
          {tabs.tabs.map((tab, i) => {
            const on = tab.id === tabs.active;
            const title = tabTitle(tab.id, tab.tree, tab.zoom);
            return (
              <div key={tab.id} className={cx(s.tab, on && s.tabOn)}>
                <Tip label={`${title}${i < 9 ? ` · ⌘${i + 1}` : ''}`}>
                  <button type="button" role="tab" aria-selected={on} className={s.tabPick} onClick={() => show({ ...tabs, active: tab.id })}>
                    <Icon name={tab.id === AGENT_TAB ? 'claude' : 'terminal'} size={12} />
                    <span className={s.tabTitle}>{title}</span>
                    {paneKeys(tab.tree).length > 1 ? <span className={s.tabCount}>{paneKeys(tab.tree).length}</span> : null}
                  </button>
                </Tip>
                {tab.id === AGENT_TAB ? null : (
                  <button type="button" className={s.tabClose} aria-label={`Close ${title}`} onClick={() => closeWholeTab(tab.id)}>
                    <Icon name="x" size={10} />
                  </button>
                )}
              </div>
            );
          })}
          <Tip label="New Tab: a shell in this worktree" keys={keyOf('new_tab')}>
            <button type="button" className={s.tabAdd} aria-label="New Tab" onClick={newTab}>
              <Icon name="plus" size={13} />
            </button>
          </Tip>
        </div>
        <div
          className={s.panes}
          onFocusCapture={(e) => {
            const key = (e.target as HTMLElement).closest('[data-term-key]')?.getAttribute('data-term-key');
            if (key) setFocusKey(key);
          }}
        >
          {tabs.tabs.map((tab) => {
            const shown = tab.id === tabs.active;
            const several = paneKeys(tab.tree).length > 1 && !tab.zoom;
            const render = (key: string): ReactElement => (
              <TermPane
                key={key}
                wsId={wsId}
                termKey={key}
                kind={key === agentKey ? 'agent' : 'shell'}
                cwd={cwd}
                split={several}
                focusOnMount={shown && key === focusKey}
                onSplit={(dir) => split(key, dir)}
                {...(key === agentKey ? {} : { onClose: () => close(key) })}
                onAction={onAction}
                onTitle={(title) => setTitles((was) => (was[key] === title ? was : { ...was, [key]: title.slice(0, 60) }))}
                openVisual={(n) => open({ kind: 'visual', n })}
                openTask={(k) => open({ kind: 'task', key: k })}
                openImage={(p) => open({ kind: 'image', path: p })}
                openNewest={openNewest}
              />
            );
            return (
              // Every tab stays made (its programs and scrollback); the others are hidden at their size, so nothing reflows.
              <div key={tab.id} className={cx(s.tabBody, !shown && s.tabHidden)} data-tab-shown={shown} role="tabpanel" aria-hidden={!shown}>
                {tab.zoom ? render(tab.zoom) : <Splits tree={tab.tree} path="" onResize={(path, ratio) => change(withTree(tabsNow.current, tab.id, resizeSplit(tab.tree, path, ratio)))} render={render} />}
              </div>
            );
          })}
        </div>
      </div>
      {panelOpen ? (
        <>
          <ResizeHandle
            axis="x"
            label="Resize the visuals"
            className={s.visualsEdge}
            onMove={(x) => {
              const r = view.current?.getBoundingClientRect();
              if (r) setDrag(r.right - x);
            }}
            onEnd={() => {
              if (drag !== undefined) setPrefs({ visualsWidth: clampVisuals(drag, room) });
              setDrag(undefined);
            }}
            onReset={() => setPrefs({ visualsWidth: 520 })}
            onStep={(dir) => setPrefs({ visualsWidth: clampVisuals(width + dir * 40, room) })}
          />
          <div className={s.visualsWrap} style={{ width }}>
            <VisualsPanel
              wsId={wsId}
              opened={opened}
              active={active}
              onPick={setActive}
              onClose={(id) => {
                const rest = opened.filter((o) => openedId(o) !== id);
                if (!rest.length) return closeAll();
                setOpened(rest);
                if (active === id) setActive(openedId(rest[rest.length - 1]!));
              }}
              onCloseAll={closeAll}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
