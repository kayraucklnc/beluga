import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { WorkspaceTab } from '@klaud/core/store.js';
import { findWorkspace, stateOf, workspaceButtons, workspaceTabs } from '@klaud/ui/workspace-models.js';
import { describePr } from '@klaud/shared/format.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Dot, IconButton, Segmented, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/klaud.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import s from './Toolbar.module.css';

/** Buttons that stay on the toolbar; the rest go under ⋯ (in the same order). */
const PRIMARY = new Set(['run', 'review_claude', 'commit', 'pr', 'merge', 'merge_claude', 'share', 'restore']);

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
        <IconButton icon="command" label="Everything you can do" keys={`${mod()}K`} onClick={() => document.dispatchEvent(new CustomEvent('klaud:palette'))} />
        <IconButton icon="inspector" label={prefs.inspector ? 'Hide the inspector' : 'Show the inspector'} keys={`${mod()}⌥I`} active={prefs.inspector} onClick={() => setPrefs({ inspector: !prefs.inspector })} />
      </div>
    </header>
  );
}

export function Toolbar() {
  const [headerRef, width] = useToolbarWidth();
  const actions = useActions();
  const state = useApp((st) => st);
  const view = state.view;

  if (view.kind === 'workspace') {
    const ws = findWorkspace(state.projects, view.id);
    if (!ws) return <Shell headerRef={headerRef} title="Workspace" />;
    const project = state.projects.find((p) => p.id === ws.projectId);
    const st = stateOf(state, ws, 0);
    const buttons = workspaceButtons(state, ws);
    // Room for the title (~240), the view switcher (~380) and the window buttons (~90); the rest is for actions.
    let room = width - 240 - 380 - 90;
    const primary = buttons.filter((b) => {
      if (!PRIMARY.has(b.action) && b.action !== 'merge_claude') return false;
      const w = b.label.length * 7.5 + 24;
      if (room < w && b.action !== 'merge_claude') return false;
      room -= w;
      return true;
    });
    const rest = buttons.filter((b) => !primary.includes(b));
    const pr = state.prs[ws.id];
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            {project?.root ? <span className={s.crumb}>{project.name}</span> : null}
            {ws.name}
          </>
        }
        subtitle={
          <>
            {ws.branch ? (
              <span className={s.meta}>
                <Icon name="branch" size={11} />
                {ws.branch}
              </span>
            ) : ws.kind === 'chat' ? (
              <span className={s.meta}>Claude chat</span>
            ) : null}
            <span className={cx(s.meta, s[`tone_${st.tone}`])}>
              <Dot tone={st.tone === 'claude' ? 'claude' : st.tone === 'muted' ? 'muted' : st.tone} live={st.tone === 'claude'} />
              {st.label}
            </span>
            {pr ? <span className={s.meta}>{describePr(pr)}</span> : null}
          </>
        }
        center={
          <Segmented<WorkspaceTab>
            label="Workspace views"
            value={view.tab}
            onChange={(tab) => actions.run({ type: 'open_ws', id: ws.id, tab })}
            options={workspaceTabs(ws).map((t) => ({ value: t.tab, label: t.label, hint: t.hint, icon: t.tab === 'chat' ? 'chat' : t.tab === 'files' ? 'folder' : t.tab === 'review' ? 'diff' : 'terminal' }))}
          />
        }
        right={
          <>
            {primary.map((b) => (
              <Tip key={b.action} label={b.hint}>
                <span>
                  <Button variant="quiet" tone={b.tone} disabled={b.disabled} onClick={() => actions.run({ type: 'ws', id: ws.id, action: b.action })}>
                    {b.label}
                  </Button>
                </span>
              </Tip>
            ))}
            {rest.length ? (
              <ActionsDropdown items={rest.map((b) => ({ label: b.label, hint: b.hint, disabled: b.disabled, danger: b.action === 'archive' || b.action === 'delete', onSelect: () => actions.run({ type: 'ws', id: ws.id, action: b.action }) }))}>
                <IconButton icon="more" label="More for this workspace" />
              </ActionsDropdown>
            ) : null}
            <span className={s.divider} />
          </>
        }
      />
    );
  }

  if (view.kind === 'shared') {
    const w = state.shared.find((x) => x.id === view.id);
    const owner = state.peers.find((p) => p.peerId === view.owner)?.name ?? 'Someone';
    return (
      <Shell
        headerRef={headerRef}
        title={w?.name ?? 'Shared workspace'}
        subtitle={<span className={s.meta}>{`${owner}'s ${w?.project ?? 'project'} · ${w?.role === 'contribute' ? 'you can work here' : 'you’re following along'}`}</span>}
        center={
          <Segmented
            label="Views"
            value={view.tab}
            onChange={(tab) => actions.run({ type: 'open_shared', owner: view.owner, id: view.id, tab })}
            options={[
              { value: 'chat', label: 'Chat', icon: 'chat' },
              { value: 'files', label: 'Files', icon: 'folder' },
              { value: 'diff', label: 'Diff', icon: 'diff' },
              { value: 'terminal', label: 'Terminal', icon: 'terminal' },
            ]}
          />
        }
      />
    );
  }

  if (view.kind === 'room') {
    const solo = state.peers.length <= 1;
    return <Shell headerRef={headerRef} title={solo ? 'Chat' : state.room} subtitle={<span className={s.meta}>{solo ? 'You and your Claude' : `${state.peers.length} people · everyone’s Claude can join in`}</span>} />;
  }

  return <Shell headerRef={headerRef} title={TITLES[view.kind] ?? 'klaud'} />;
}
