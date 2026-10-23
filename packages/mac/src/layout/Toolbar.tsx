import { planForHome } from '@klaud/core/plans/model.js';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { agentOfWorktree, agentTitle, isAgentWorktree } from '../claude-code/subagents-model.js';
import { findWorkspace, stateOf } from '@klaud/ui/workspace-models.js';
import { describePr } from '@klaud/shared/format.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Dot, IconButton, Segmented, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApp, useKlaud } from '../lib/klaud.js';
import { type ToolAction, toolbarActions } from './toolbar-actions.js';
import { isPlanAction, runPlanAction } from '../lib/plan-task.js';
import { askBeforeWork } from '../lib/work-confirm.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { togglePanel } from '../lib/panel.js';
import { panelFits } from '../lib/panel-model.js';
import { mod } from '../lib/system.js';
import { NotificationBell } from './NotificationCenter.js';
import { ContinueButton } from '../chat/AskBanner.js';
import { useConversationHeader } from '../network/ConversationHeader.js';
import { ContextNote } from '../chat/ContextMeter.js';
import s from './Toolbar.module.css';

/** Room the title keeps, and the window buttons on the right (search, bell, panel). */
const TITLE_MIN = 210;
const RIGHT_FIXED = 3 * 30 + 16;

const TITLES: Partial<Record<string, string>> = { overview: 'Overview', search: 'Search', usage: 'Usage', terminal: 'Terminal', files: 'Shared files', draft: 'New chat', draft_worktree: 'New worktree', claude_code: 'Activity', requests: 'Requests', tasks: 'Tasks', worktrees: 'Worktrees' };

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

/** Search every conversation, from any view (⇧⌘F; ⌘F finds in what's open). */
function SearchButton() {
  const actions = useActions();
  const on = useApp((st) => st.view.kind === 'search');
  return <IconButton icon="search" label="Search" keys={`⇧${mod()}F`} active={on} onClick={() => actions.run({ type: 'view', view: { kind: 'search' } })} />;
}

function Shell({ title, subtitle, center, right, headerRef }: { title: ReactNode; subtitle?: ReactNode; center?: ReactNode; right?: ReactNode; headerRef: React.RefObject<HTMLElement | null> }) {
  const prefs = usePrefs();
  const view = useApp((st) => st.view);
  // A plan's page has no panel: its chat is its right side (the plan's header shows and hides it, ⌥⌘0 too).
  const fits = panelFits(view);
  // Only what every view needs: search, what's new, the panel. The terminal (⌘J) is a panel tab,
  // and everything you can do is ⌘K and the menu bar.
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
        <SearchButton />
        <NotificationBell />
        <IconButton
          icon="panelRight"
          label={!fits ? 'No panel on a plan’s page: its chat is beside the plan' : prefs.inspector ? 'Hide the panel' : 'Show the panel: changes, files, terminal, info'}
          {...(fits ? { keys: `⌥${mod()}0` } : {})}
          active={fits && prefs.inspector}
          disabled={!fits}
          onClick={() => togglePanel(view)}
        />
      </div>
    </header>
  );
}

export function Toolbar() {
  const [headerRef, width] = useToolbarWidth();
  const actions = useActions();
  const klaud = useKlaud();
  const { client } = klaud;
  const state = useApp((st) => st);
  const view = state.view;

  if (view.kind === 'workspace') {
    const ws = findWorkspace(state.projects, view.id);
    if (!ws) return <Shell headerRef={headerRef} title="Workspace" />;
    const project = state.projects.find((p) => p.id === ws.projectId);
    // A sub-agent's own worktree is the agent: its name, no worktree actions (it's Claude's, not yours).
    if (isAgentWorktree(ws)) {
      const sub = agentOfWorktree(state.claudeCode.sessions, ws);
      return (
        <Shell
          headerRef={headerRef}
          title={
            <>
              {project?.root ? <span className={s.crumb}>{project.name}</span> : null}
              <span className={s.name}>{sub ? agentTitle(sub.agent) : 'Sub-agent'}</span>
            </>
          }
          subtitle={<span className={s.meta}>Sub-agent · its own worktree{ws.branch ? ` · ${ws.branch}` : ''}</span>}
        />
      );
    }
    const st = stateOf(state, ws, 0);
    const { primary, icons, more } = toolbarActions(state, ws);
    // A narrow window: the icons that don't fit move under ⋯ (the everyday action keeps its place).
    const fixed = TITLE_MIN + RIGHT_FIXED + (primary ? primary.label.length * 7.4 + 48 : 0) + 34;
    const fit = Math.max(0, Math.min(icons.length, Math.floor((width - fixed) / 30)));
    // Icons that don't fit lead ⋯ as a section of their own.
    const overflow = [...(fit < icons.length ? [icons.slice(fit)] : []), ...more];
    const menu = overflow.flatMap((section, k) => section.map((a, i) => ({ a, separate: k > 0 && i === 0 })));
    const run = (a: ToolAction): void => {
      if (a.disabled) return toast(client, a.hint, 'info');
      if (a.action === 'fix_checks') return askBeforeWork(ws.id, 'fix_checks');
      if (isPlanAction(a.action)) return runPlanAction(state, ws.id, a.action, actions.run);
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
            {/* Never cut: past 70% it's worth seeing (the branch and the rest give way). */}
            <ContextNote channel={`ws:${ws.id}`} className={s.meta} />
            {ws.branch ? (
              <span className={cx(s.meta, s.metaBranch)} title={ws.branch}>
                <Icon name="branch" size={11} />
                <span className={s.ellipsis}>{ws.branch}</span>
              </span>
            ) : ws.kind === 'chat' ? (
              <span className={s.meta}>{ws.askOnly ? 'Questions only · main folder' : 'Claude chat'}</span>
            ) : null}
            {pr ? (
              <span className={cx(s.meta, s.metaPr, pr.state === 'MERGED' && s.metaMerged)} title={describePr(pr)} data-pr-state={pr.state}>
                <Icon name={pr.state === 'MERGED' ? 'merge' : 'pr'} size={11} />
                <span className={s.ellipsis}>{pr.state === 'MERGED' ? `PR #${pr.number}` : describePr(pr)}</span>
              </span>
            ) : null}
          </>
        }
        right={
          <>
            {/* A main folder is questions only: what it needs next is a worktree to work in. */}
            {ws.askOnly && !planForHome(state.plans, `ws:${ws.id}`) ? (
              <span className={s.primaryWrap}>
                <ContinueButton wsId={ws.id} className={s.primary} />
              </span>
            ) : primary ? (
              <Tip label={primary.hint} keys={primary.keys}>
                <span className={s.primaryWrap}>
                  <Button variant={primary.action === 'merge' ? 'merge' : 'primary'} icon={primary.icon} className={cx(s.primary, primary.tone === 'error' && s.primaryError)} aria-disabled={primary.disabled} data-tool={primary.action} data-tool-ws={ws.id} onClick={() => run(primary)}>
                    {primary.label}
                  </Button>
                </span>
              </Tip>
            ) : null}
            <span className={s.tools} role="group" aria-label="Workspace actions">
              {icons.slice(0, fit).map((a) => (
                <IconButton key={a.id} icon={a.icon} label={a.disabled ? `${a.label}: ${a.hint}` : (a.tip ?? `${a.label} · ${a.hint}`)} keys={a.keys} aria-disabled={a.disabled} data-tool={a.action} data-tool-ws={ws.id} className={cx(a.disabled && s.off, a.tone === 'error' && s.toolError)} onClick={() => run(a)} />
              ))}
              {overflow.length ? (
                <ActionsDropdown items={menu.map(({ a, separate }) => ({ label: a.label, icon: a.icon, hint: a.disabled ? a.hint : undefined, keys: a.keys, disabled: a.disabled, danger: a.danger, separate, onSelect: () => requestAnimationFrame(() => run(a)) }))}>
                  <IconButton icon="more" label="More for this workspace" data-tool="more" data-tool-ws={ws.id} />
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

  if (view.kind === 'conversation') return <ConversationBar id={view.id} headerRef={headerRef} />;

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

  if (view.kind === 'tasks') {
    // One project's tasks (its name is the switcher at the top of the view).
    return <Shell headerRef={headerRef} title={<span className={s.name}>Tasks</span>} />;
  }

  if (view.kind === 'plans') return <Shell headerRef={headerRef} title={<span className={s.name}>Plans</span>} />;

  if (view.kind === 'plan') {
    const plan = state.plans.plans.find((x) => x.id === view.id);
    const project = plan ? state.projects.find((p) => p.id === plan.projectId) : undefined;
    // Where it runs: its project, and the branch its work comes together on (the panel's Info used to say).
    const branch = plan?.branch ?? (plan?.home.startsWith('ws:') ? findWorkspace(state.projects, plan.home.slice(3))?.branch : undefined) ?? project?.base;
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            <span className={s.crumb}>{project?.name ?? 'Plans'}</span>
            <span className={s.name}>Plan</span>
          </>
        }
        {...(branch ? { subtitle: branch } : {})}
      />
    );
  }

  if (view.kind === 'task') {
    const issue = state.board.issues.find((i) => i.id === view.id);
    const project = issue ? state.projects.find((p) => p.id === issue.projectId) : undefined;
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            <span className={s.crumb}>{project?.name ?? 'Tasks'}</span>
            <span className={s.name}>{issue?.key ?? 'Task'}</span>
          </>
        }
        subtitle={issue ? <span className={s.meta}>{issue.title}</span> : undefined}
      />
    );
  }

  if (view.kind === 'project') {
    const project = state.projects.find((p) => p.id === view.id);
    if (view.page === 'history') {
      return (
        <Shell
          headerRef={headerRef}
          title={
            <>
              {project ? <span className={s.crumb}>{project.name}</span> : null}
              <span className={s.name}>History</span>
            </>
          }
          subtitle={<span className={s.meta}>Who committed what, and when · every branch</span>}
        />
      );
    }
    return <Shell headerRef={headerRef} title={project?.name ?? 'Project'} subtitle={<span className={s.meta}>Work happens in worktrees · the main folder is for questions</span>} />;
  }

  return <Shell headerRef={headerRef} title={TITLES[view.kind] ?? 'Klaud'} />;
}

/** A conversation with friends or a group: who it's with, their status, the group's people. */
function ConversationBar({ id, headerRef }: { id: string; headerRef: React.RefObject<HTMLElement | null> }) {
  const parts = useConversationHeader(id);
  return <Shell headerRef={headerRef} title={parts.title} subtitle={parts.subtitle} right={parts.right} />;
}
