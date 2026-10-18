import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { WorkspaceTab } from '@klaud/core/store.js';
import { findWorkspace, stateOf, workspaceTabs } from '@klaud/ui/workspace-models.js';
import { describePr } from '@klaud/shared/format.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Dot, IconButton, Segmented, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useKlaud } from '../lib/klaud.js';
import { type ToolAction, toolbarActions } from './toolbar-actions.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import { NotificationBell } from './NotificationCenter.js';
import s from './Toolbar.module.css';

/** Room the title keeps, and the window buttons on the right (dock, bell, palette, inspector). */
const TITLE_MIN = 210;
const RIGHT_FIXED = 4 * 30 + 16;

const TITLES: Partial<Record<string, string>> = { overview: 'Overview', search: 'Search', usage: 'Usage', terminal: 'Terminal', files: 'Shared files', draft: 'New chat', draft_worktree: 'New worktree' };

/** How wide the toolbar is (buttons that don't fit move under ⋯). */
function useToolbarWidth(): [React.RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e?.contentRect.width ?? 1000));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Shell({ title, subtitle, center, right, headerRef }: { title: ReactNode; subtitle?: ReactNode; center?: ReactNode; right?: ReactNode; headerRef: React.RefObject<HTMLElement | null> }) {
  const prefs = usePrefs();
  const view = useApp((st) => st.view);
  const dockable = view.kind === 'room' || view.kind === 'draft' || view.kind === 'draft_worktree' || (view.kind === 'workspace' && view.tab === 'chat');
  return (
    <header ref={headerRef} className={cx(s.toolbar, !prefs.sidebar && s.noSidebar)} data-tauri-drag-region>
      {prefs.sidebar ? null : (
        <span className={s.lead}>
          <IconButton icon="sidebar" label="Show sidebar" keys="⌃⌘S" onClick={() => setPrefs({ sidebar: true })} />
        </span>
      )}
      <div className={s.titles} data-tauri-drag-region>
        <div className={s.title}>{title}</div>
        {subtitle ? <div className={s.subtitle}>{subtitle}</div> : null}
      </div>
      <div className={s.center} data-tauri-drag-region>
        {center}
      </div>
      <div className={s.right}>
        {right}
        {dockable ? (
          <IconButton icon="terminal" label={prefs.dock === 'off' ? 'Terminal beside the chat' : 'Hide the terminal'} keys={`${mod()}J`} active={prefs.dock !== 'off'} onClick={() => setPrefs({ dock: prefs.dock === 'off' ? 'right' : 'off' })} />
        ) : null}
        <NotificationBell />
        <IconButton icon="command" label="Everything you can do" keys={`${mod()}K`} onClick={() => document.dispatchEvent(new CustomEvent('klaud:palette'))} />
        <IconButton icon="inspector" label={prefs.inspector ? 'Hide the inspector' : 'Show the inspector'} keys={`⌥${mod()}I`} active={prefs.inspector} onClick={() => setPrefs({ inspector: !prefs.inspector })} />
      </div>
    </header>
  );
}

export function Toolbar() {
  const [headerRef, width] = useToolbarWidth();
  const actions = useActions();
  const api = useApi();
  const klaud = useKlaud();
  const { client } = klaud;
  const state = useApp((st) => st);
  const view = state.view;

  if (view.kind === 'workspace') {
    const ws = findWorkspace(state.projects, view.id);
    if (!ws) return <Shell headerRef={headerRef} title="Workspace" />;
    const project = state.projects.find((p) => p.id === ws.projectId);
    const st = stateOf(state, ws, 0);
    const { primary, icons, more } = toolbarActions(state, ws);
    const tabs = workspaceTabs(ws);
    // A narrow window: the view switcher shows icons only (so the everyday actions keep their
    // place), then icons move under ⋯.
    const fixed = TITLE_MIN + RIGHT_FIXED + (primary ? primary.label.length * 7.4 + 48 : 0) + 34;
    const roomWith = (segment: number): number => Math.floor((width - fixed - segment) / 30);
    const compact = roomWith(tabs.length * 84 + 6) < Math.min(icons.length, 4);
    const fit = Math.max(0, Math.min(icons.length, roomWith(compact ? tabs.length * 34 + 6 : tabs.length * 84 + 6)));
    const overflow = [...icons.slice(fit), ...more];
    const run = (a: ToolAction): void => {
      if (a.disabled) return toast(client, a.hint, 'info');
      if (a.action === 'fix_checks') return void api.workbench.fixChecks(ws.id);
      actions.run({ type: 'ws', id: ws.id, action: a.action });
    };
    const pr = state.prs[ws.id];
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            {project?.root ? <span className={s.crumb}>{project.name}</span> : null}
            <span className={s.name}>{ws.name}</span>
          </>
        }
        subtitle={
          <>
            <span className={cx(s.meta, s.metaState, s[`tone_${st.tone}`])}>
              <Dot tone={st.tone === 'claude' ? 'claude' : st.tone === 'muted' ? 'muted' : st.tone} live={st.tone === 'claude'} />
              {st.label}
            </span>
            {ws.branch ? (
              <span className={cx(s.meta, s.metaBranch)} title={ws.branch}>
                <Icon name="branch" size={11} />
                <span className={s.ellipsis}>{ws.branch}</span>
              </span>
            ) : ws.kind === 'chat' ? (
              <span className={s.meta}>Claude chat</span>
            ) : null}
            {pr ? (
              <span className={cx(s.meta, s.metaPr)} title={describePr(pr)}>
                <Icon name="pr" size={11} />
                <span className={s.ellipsis}>{describePr(pr)}</span>
              </span>
            ) : null}
          </>
        }
        center={
          <Segmented<WorkspaceTab>
            label="Workspace views"
            value={view.tab}
            iconOnly={compact}
            onChange={(tab) => actions.run({ type: 'open_ws', id: ws.id, tab })}
            options={tabs.map((t) => ({ value: t.tab, label: t.label, hint: t.hint, icon: t.tab === 'chat' ? 'chat' : t.tab === 'files' ? 'folder' : t.tab === 'review' ? 'diff' : 'terminal' }))}
          />
        }
        right={
          <>
            {primary ? (
              <Tip label={primary.hint} keys={primary.keys}>
                <span className={s.primaryWrap}>
                  <Button variant="primary" icon={primary.icon} className={cx(s.primary, primary.tone === 'error' && s.primaryError)} aria-disabled={primary.disabled} onClick={() => run(primary)}>
                    {primary.label}
                  </Button>
                </span>
              </Tip>
            ) : null}
            <span className={s.tools} role="group" aria-label="Workspace actions">
              {icons.slice(0, fit).map((a) => (
                <IconButton key={a.id} icon={a.icon} label={a.disabled ? `${a.label}: ${a.hint}` : `${a.label} · ${a.hint}`} keys={a.keys} aria-disabled={a.disabled} className={cx(a.disabled && s.off, a.tone === 'error' && s.toolError)} onClick={() => run(a)} />
              ))}
              {overflow.length ? (
                <ActionsDropdown items={overflow.map((a, i) => ({ label: a.label, icon: a.icon, hint: a.disabled ? a.hint : undefined, keys: a.keys, disabled: a.disabled, danger: a.danger, separate: i > 0 && i === icons.length - fit, onSelect: () => run(a) }))}>
                  <IconButton icon="more" label="More for this workspace" />
                </ActionsDropdown>
              ) : null}
            </span>
            <span className={s.divider} />
          </>
        }
      />
    );
  }

  if (view.kind === 'shared') {
    const w = state.shared.find((x) => x.id === view.id);
    const ui = klaud.ui;
    const owner = state.peers.find((p) => p.peerId === view.owner)?.name ?? 'Someone';
    return (
      <Shell
        headerRef={headerRef}
        title={w?.name ?? 'Shared workspace'}
        subtitle={<span className={s.meta}>{`${owner}'s ${w?.project ?? 'project'} · ${w?.role === 'contribute' ? 'you can work here' : 'you’re following along'}`}</span>}
        center={
          <Segmented
            label="Views"
            value={view.tab === 'terminal' ? 'files' : view.tab}
            onChange={(tab) => actions.run({ type: 'open_shared', owner: view.owner, id: view.id, tab })}
            options={[
              { value: 'chat', label: 'Chat', icon: 'chat' },
              { value: 'files', label: 'Files', icon: 'folder', hint: 'Browse and search the files' },
              { value: 'diff', label: 'Diff', icon: 'diff' },
            ]}
          />
        }
        right={<IconButton icon="people" label={`About ${w?.name ?? 'this workspace'}: who's here, leave`} onClick={() => ui.openMenu({ kind: 'shared', owner: view.owner, id: view.id })} />}
      />
    );
  }

  if (view.kind === 'room') {
    const solo = state.peers.length <= 1;
    return <Shell headerRef={headerRef} title={solo ? 'Chat' : state.room} subtitle={<span className={s.meta}>{solo ? 'You and your Claude' : `${state.peers.length} people · everyone’s Claude can join in`}</span>} />;
  }

  if (view.kind === 'draft' || view.kind === 'draft_worktree') {
    const project = state.projects.find((p) => p.id === view.projectId && p.root);
    const worktree = view.kind === 'draft_worktree';
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            {project ? <span className={s.crumb}>{project.name}</span> : null}
            <span className={s.name}>{worktree ? 'New Worktree' : 'New Chat'}</span>
          </>
        }
        subtitle={<span className={s.meta}>{worktree ? 'Its own branch and folder; Claude starts on your task right away' : project ? `Claude works in ${project.name}’s main folder` : 'Nothing is created until you send the first message'}</span>}
      />
    );
  }

  return <Shell headerRef={headerRef} title={TITLES[view.kind] ?? 'klaud'} />;
}
