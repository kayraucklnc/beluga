import { type HTMLAttributes, type ReactNode, forwardRef, useEffect, useRef, useState } from 'react';
import type { AppState } from '@klaud/core/store.js';
import type { Project, Workspace } from '@klaud/workspaces/types.js';
import { worktreeOrigin } from '@klaud/workspaces/origin.js';
import { trustOf } from '@klaud/core/trust.js';
import { activityOf, isProjectOpen, overviewNews, stateOf, workspaceButtons } from '@klaud/ui/workspace-models.js';
import { macTabs } from '../lib/go.js';
import { newShares } from '@klaud/core/store.js';
import { Icon, type IconName } from '../components/Icon.js';
import { ActionsContext, SpecContext, SpecDropdown, type ActionItem } from '../components/SpecMenu.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Avatar, Badge, Dot, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { inApp } from '../lib/boot.js';
import { useApi, useApp, useKlaud, useUi } from '../lib/klaud.js';
import { pickImage, reloadProjectIcon } from '../lib/projects.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { openPerson } from '../dialogs/native/PersonPopover.js';
import { PersonContextMenu } from '../dialogs/native/PersonMenu.js';
import { RoomStatus } from '../dialogs/native/RoomPopover.js';
import { toolbarActions } from './toolbar-actions.js';
import { GroupHeader, LooseProjects, NewGroupRow, isGroupOption, projectDrag, useGroupItems } from './ProjectGroups.js';
import s from './Sidebar.module.css';

const NAV: ReadonlyArray<{ kind: 'room' | 'files' | 'overview' | 'search' | 'usage' | 'terminal'; icon: IconName }> = [
  { kind: 'room', icon: 'chat' },
  { kind: 'overview', icon: 'grid' },
  { kind: 'files', icon: 'folder' },
  { kind: 'search', icon: 'search' },
  { kind: 'usage', icon: 'gauge' },
  { kind: 'terminal', icon: 'terminal' },
];

/**
 * What a workspace's right-click menu offers: its toolbar's actions, named and drawn the same
 * (the shortcuts show for the workspace you're in, where they work).
 */
export function workspaceItems(state: AppState, ws: Workspace, run: ReturnType<typeof useActions>['run']): ActionItem[] {
  const { primary, icons, more } = toolbarActions(state, ws);
  const here = state.view.kind === 'workspace' && state.view.id === ws.id;
  const list = [...(primary && primary.action !== 'fix_checks' ? [primary] : []), ...icons, ...more];
  const order = workspaceButtons(state, ws).map((b) => b.action as string);
  return [
    { label: 'Open', icon: 'chevronRight', onSelect: () => run({ type: 'open_ws', id: ws.id }) },
    ...[...list]
      .sort((a, b) => order.indexOf(a.action === 'stop_run' ? 'run' : a.action) - order.indexOf(b.action === 'stop_run' ? 'run' : b.action))
      .map((a, i) => ({
        label: a.label,
        icon: a.icon,
        ...(a.disabled ? { hint: a.hint, disabled: true } : {}),
        ...(here && a.keys ? { keys: a.keys } : {}),
        ...(a.danger ? { danger: true } : {}),
        ...(i === 0 ? { separate: true } : {}),
        onSelect: () => (a.action === 'fix_checks' ? undefined : run({ type: 'ws', id: ws.id, action: a.action })),
      })),
  ];
}

function Section({ id, title, children, action }: { id: string; title: string; children: ReactNode; action?: ReactNode }) {
  const prefs = usePrefs();
  const folded = prefs.folded.includes(id);
  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <button type="button" className={s.sectionTitle} onClick={() => setPrefs({ folded: folded ? prefs.folded.filter((f) => f !== id) : [...prefs.folded, id] })} aria-expanded={!folded}>
          {title}
          <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={10} className={s.sectionChevron} />
        </button>
        <span className={s.sectionAction}>{action}</span>
      </div>
      {folded ? null : children}
    </section>
  );
}

type RowProps = Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> & {
  icon?: ReactNode;
  label: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  trailing?: ReactNode;
  detail?: string;
  tone?: string;
  indent?: number;
  className?: string;
};

/**
 * A sidebar row. It passes its ref and other props through, so a right-click menu (or a
 * tooltip) wrapped around it can attach.
 */
const Row = forwardRef<HTMLDivElement, RowProps>(function Row({ icon, label, selected, onClick, trailing, detail, tone, indent = 0, className, onDoubleClick, style, onKeyDown, ...rest }, ref) {
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      {...rest}
      className={cx(s.row, selected && s.selected, className)}
      style={{ paddingLeft: 8 + indent * 14, ...style }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        // Only the row itself: Enter on a button inside it presses that button.
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick?.();
        }
      }}
      title={detail}
    >
      {icon ? <span className={cx(s.rowIcon, tone)}>{icon}</span> : null}
      <span className={s.rowLabel}>{label}</span>
      {trailing ? <span className={s.trailing}>{trailing}</span> : null}
    </div>
  );
});

function WorkspaceRow({ ws, indent }: { ws: Workspace; indent: number }) {
  const actions = useActions();
  const state = useApp((st) => st);
  const selected = state.view.kind === 'workspace' && state.view.id === ws.id;
  const st = stateOf(state, ws, 0);
  const act = activityOf(state.log, `ws:${ws.id}`);
  const unread = state.unread[`ws:${ws.id}`] ?? 0;
  const icon: IconName = ws.kind === 'chat' ? 'chat' : ws.kind === 'main' ? 'folder' : 'branch';
  return (
    <ActionsContext items={workspaceItems(state, ws, actions.run)}>
      <Row
        indent={indent}
        selected={selected}
        icon={<Icon name={icon} size={14} />}
        label={<span className={ws.external ? s.external : undefined}>{ws.name}</span>}
        detail={`${ws.name}: ${st.label}`}
        onClick={() => actions.run({ type: 'open_ws', id: ws.id })}
        trailing={
          <>
            {unread ? <Badge count={unread} urgent /> : null}
            {act.running || act.awaiting || st.tone === 'error' || st.tone === 'warn' || st.tone === 'info' ? <Dot tone={st.tone === 'claude' ? 'claude' : st.tone === 'muted' ? 'muted' : st.tone} live={act.running} /> : null}
          </>
        }
      />
    </ActionsContext>
  );
}

function ProjectBlock({ p }: { p: Project }) {
  const actions = useActions();
  const state = useApp((st) => st);
  const collapsed = useUi((u) => u.collapsed);
  const open = isProjectOpen(state, p, new Set(collapsed));
  const busy = p.workspaces.some((w) => activityOf(state.log, `ws:${w.id}`).running);
  const live = p.workspaces.filter((w) => !w.archived);
  const mine = live.filter((w) => worktreeOrigin(w) === 'klaud');
  const external = live.filter((w) => worktreeOrigin(w) === 'external');
  const archived = p.workspaces.filter((w) => w.archived);
  const showExternal = collapsed.includes(`external:${p.id}`) || external.some((w) => state.view.kind === 'workspace' && state.view.id === w.id);
  const showArchived = collapsed.includes(`archive:${p.id}`);
  const iconItems = useIconItems(p);
  const groupItems = useGroupItems(p);
  const extra = [...groupItems, ...iconItems];
  return (
    <div className={s.project}>
      <SpecContext menu={{ kind: 'project', id: p.id }} extra={extra} hide={isGroupOption}>
        <Row
          {...projectDrag(p)}
          className={s.projectRow}
          icon={
            <span className={s.projectIcon}>
              <Icon name={open ? 'chevronDown' : 'chevronRight'} size={9} className={s.disclosure} />
              <ProjectIcon id={p.id} name={p.name} size={16} />
            </span>
          }
          label={p.name}
          detail={p.root}
          onClick={() => actions.run({ type: 'toggle_project', id: p.id })}
          trailing={
            <span className={s.hoverTools}>
              {busy ? <Dot tone="claude" live /> : null}
              <IconButton icon="branch" label={`New worktree in ${p.name}`} onClick={(e) => (e.stopPropagation(), actions.run({ type: 'new_worktree', projectId: p.id }))} />
              <IconButton icon="plus" label={`New chat in ${p.name}`} onClick={(e) => (e.stopPropagation(), actions.run({ type: 'new_chat', projectId: p.id }))} />
              <SpecDropdown menu={{ kind: 'project', id: p.id }} align="end" extra={extra} hide={isGroupOption}>
                <IconButton icon="more" label={`More for ${p.name}`} onClick={(e) => e.stopPropagation()} />
              </SpecDropdown>
            </span>
          }
        />
      </SpecContext>
      {open ? (
        <>
          {mine.map((w) => (
            <WorkspaceRow key={w.id} ws={w} indent={1} />
          ))}
          {mine.some((w) => w.kind === 'worktree') ? null : (
            <Row indent={1} className={s.hintRow} icon={<Icon name="plus" size={13} />} label="New worktree…" detail={`A branch and folder of its own in ${p.name}, with Claude on your task`} onClick={() => actions.run({ type: 'new_worktree', projectId: p.id })} />
          )}
          {external.length ? (
            <Row indent={1} className={s.fold} label={`Other worktrees`} trailing={<Badge count={external.length} />} icon={<Icon name={showExternal ? 'chevronDown' : 'chevronRight'} size={10} />} onClick={() => actions.run({ type: 'toggle_fold', key: `external:${p.id}` })} detail="Worktrees made outside klaud" />
          ) : null}
          {showExternal ? external.map((w) => <WorkspaceRow key={w.id} ws={w} indent={2} />) : null}
          {archived.length ? (
            <Row indent={1} className={s.fold} label="Archived" trailing={<Badge count={archived.length} />} icon={<Icon name={showArchived ? 'chevronDown' : 'chevronRight'} size={10} />} onClick={() => actions.run({ type: 'toggle_archive', projectId: p.id })} />
          ) : null}
          {showArchived
            ? archived.map((w) => (
                <SpecContext key={w.id} menu={{ kind: 'archived', id: w.id }}>
                  <Row indent={2} className={s.fold} icon={<Icon name="archive" size={13} />} label={w.name} onClick={() => actions.run({ type: 'archived_menu', id: w.id })} />
                </SpecContext>
              ))
            : null}
        </>
      ) : null}
    </div>
  );
}

/** "Change Icon…" for a project, and going back to the one it ships. */
function useIconItems(p: Project): readonly ActionItem[] {
  const api = useApi();
  const { client } = useKlaud();
  const change = async (image: string | undefined): Promise<void> => {
    try {
      await api.projects.setIcon(p.id, image);
      reloadProjectIcon(p.id);
    } catch (err) {
      client.store.dispatch({ type: 'toast', text: err instanceof Error ? err.message : String(err), level: 'error' });
    }
  };
  return [
    {
      label: 'Change Icon…',
      onSelect: () => {
        void pickImage(`An icon for ${p.name}`).then((image) => (image ? change(image) : undefined));
      },
      disabled: !inApp(),
    },
    { label: 'Use the Project’s Own Icon', onSelect: () => void change(undefined) },
  ];
}

function Groups() {
  const actions = useActions();
  const projects = useApp((st) => st.projects);
  const groups = useApp((st) => st.projectGroups);
  const collapsed = useUi((u) => u.collapsed);
  const repos = projects.filter((p) => p.root);
  const grouped = new Map<string, Project[]>();
  const loose: Project[] = [];
  for (const p of repos) {
    const g = groups.find((x) => x.projects.includes(p.root));
    if (g) grouped.set(g.name, [...(grouped.get(g.name) ?? []), p]);
    else loose.push(p);
  }
  return (
    <>
      <LooseProjects>
        {loose.map((p) => (
          <ProjectBlock key={p.id} p={p} />
        ))}
      </LooseProjects>
      <NewGroupRow />
      {[...grouped].map(([name, list]) => {
        const open = !collapsed.includes(`group:${name}`);
        return (
          <div key={name} className={s.group}>
            <GroupHeader name={name} count={list.length} open={open} onToggle={() => actions.run({ type: 'toggle_group', name })} />
            {open ? list.map((p) => <ProjectBlock key={p.id} p={p} />) : null}
          </div>
        );
      })}
      {repos.length ? null : (
        <Row className={s.hintRow} icon={<Icon name="plus" size={13} />} label="Add a project…" onClick={() => actions.run({ type: 'add_project' })} />
      )}
    </>
  );
}

function People() {
  const { ui } = useKlaud();
  const state = useApp((st) => st);
  const people = state.peers;
  if (people.length <= 1) {
    return <Row className={s.hintRow} icon={<Icon name="link" size={13} />} label="Invite someone…" onClick={() => document.dispatchEvent(new CustomEvent('klaud:invite'))} />;
  }
  return (
    <>
      {people.map((p, index) => {
        const me = p.peerId === state.self?.peerId;
        const trust = me ? undefined : trustOf(state, p.peerId);
        const following = state.follow === p.peerId;
        return (
          <PersonContextMenu key={p.peerId} index={index}>
            <Row
              data-person-row={p.peerId}
              icon={<Avatar name={p.name} id={p.peerId} size={18} />}
              label={
                <span>
                  {p.name}
                  {me ? <span className={s.dim}> (you)</span> : null}
                  {p.guest ? <span className={s.dim}> · guest</span> : null}
                </span>
              }
              detail={me ? 'You' : `${p.name}${p.agent ? ' · Claude on' : ''}${trust ? ` · trust: ${trust}` : ''}`}
              onClick={() => openPerson(ui, index, document.querySelector<HTMLElement>(`[data-person-row="${CSS.escape(p.peerId)}"]`))}
              trailing={
                <>
                  {following ? <Tip label="Following their screen"><Icon name="eye" size={12} /></Tip> : null}
                  {p.agent ? <Tip label={`${me ? 'Your' : `${p.name}'s`} Claude is on`}><Icon name="claude" size={12} className={s.claudeMark} /></Tip> : null}
                  {trust === 'full' ? <Tip label="Full trust"><Icon name="lock" size={11} /></Tip> : null}
                </>
              }
            />
          </PersonContextMenu>
        );
      })}
    </>
  );
}

/**
 * Folders dragged from Finder onto the sidebar become projects (a git project, or a folder of
 * them). The Add Projects sheet takes drops itself while it's open.
 */
function useFolderDrop(): { ref: React.RefObject<HTMLElement | null>; over: boolean } {
  const api = useApi();
  const { ui } = useKlaud();
  const ref = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!inApp()) return;
    let off: (() => void) | undefined;
    let alive = true;
    const inside = (x: number, y: number): boolean => {
      const r = ref.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      return !!r && x / scale >= r.left && x / scale <= r.right && y / scale >= r.top && y / scale <= r.bottom;
    };
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent((e) => {
        if (ui.get().addProject) return setOver(false);
        const p = e.payload;
        if (p.type === 'leave') return setOver(false);
        const here = inside(p.position.x, p.position.y);
        if (p.type === 'drop') {
          setOver(false);
          if (here) for (const path of p.paths) void api.projects.add(path);
        } else setOver(here);
      });
      if (alive) off = un;
      else un();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return { ref, over };
}

export function Sidebar() {
  const actions = useActions();
  const drop = useFolderDrop();
  const state = useApp((st) => st);
  const tabs = macTabs(state);
  const chats = state.projects.find((p) => !p.root);
  const liveChats = chats?.workspaces.filter((w) => !w.archived) ?? [];
  const news = overviewNews(state);
  const badges: Partial<Record<string, { count: number; urgent?: boolean }>> = {
    room: { count: state.unread.room ?? 0, urgent: true },
    files: { count: newShares(state) },
    overview: { count: state.view.kind === 'overview' ? 0 : news.count, urgent: news.urgent },
  };
  return (
    <nav ref={drop.ref} className={cx(s.sidebar, drop.over && s.dropping)} aria-label="Sidebar">
      <div className={s.titlebar} data-tauri-drag-region>
        <span className={s.trafficSpace} data-tauri-drag-region />
        <IconButton icon="sidebar" label="Hide sidebar" keys="⌃⌘S" onClick={() => setPrefs({ sidebar: false })} />
      </div>
      <div className={s.scroll}>
        <section className={s.section}>
          {NAV.map((n) => {
            const tab = tabs.find((t) => t.kind === n.kind)!;
            const b = badges[n.kind];
            return (
              <Row
                key={n.kind}
                icon={<Icon name={n.icon} size={14} />}
                label={tab.label}
                detail={tab.hint}
                selected={state.view.kind === n.kind}
                onClick={() => actions.run({ type: 'view', view: { kind: n.kind } })}
                trailing={b?.count ? <Badge count={b.count} urgent={b.urgent} /> : null}
              />
            );
          })}
        </section>

        <Section id="chats" title="Chats" action={<IconButton icon="plus" label="New chat (not tied to a project)" onClick={() => actions.run({ type: 'new_chat', projectId: 'chats' })} />}>
          {liveChats.map((w) => (
            <WorkspaceRow key={w.id} ws={w} indent={0} />
          ))}
          {liveChats.length ? null : <Row className={s.hintRow} icon={<Icon name="plus" size={13} />} label="Talk to Claude about anything" onClick={() => actions.run({ type: 'new_chat', projectId: 'chats' })} />}
        </Section>

        <Section id="projects" title="Projects" action={<IconButton icon="plus" label="Add a project, or a folder of projects" onClick={() => actions.run({ type: 'add_project' })} />}>
          <Groups />
        </Section>

        {state.shared.length ? (
          <Section id="shared" title="Shared with me">
            {state.shared.map((w) => {
              const owner = state.peers.find((p) => p.peerId === w.owner)?.name ?? 'someone';
              const selected = state.view.kind === 'shared' && state.view.id === w.id;
              return (
                <SpecContext key={`${w.owner}:${w.id}`} menu={{ kind: 'shared', owner: w.owner, id: w.id }}>
                  <Row
                    selected={selected}
                    icon={<Avatar name={owner} id={w.owner} size={16} />}
                    label={w.name}
                    detail={`${owner}'s ${w.project} · ${w.role === 'contribute' ? 'you can work here' : 'you can follow along'}`}
                    onClick={() => actions.run({ type: 'open_shared', owner: w.owner, id: w.id, tab: 'chat' })}
                    trailing={state.unread[`ws:${w.id}`] ? <Badge count={state.unread[`ws:${w.id}`]!} urgent /> : null}
                  />
                </SpecContext>
              );
            })}
          </Section>
        ) : null}

        <Section id="people" title="People">
          <People />
        </Section>
      </div>
      <SidebarFooter />
    </nav>
  );
}

function SidebarFooter() {
  const state = useApp((st) => st);
  const status = state.status;
  const hosting = state.hosting;
  const label =
    status === 'connected'
      ? state.peers.length > 1
        ? `${state.peers.length} people in ${state.room}`
        : hosting?.phase === 'ready'
          ? 'Invite ready'
          : 'Just you'
      : status === 'connecting'
        ? 'Connecting…'
        : 'Offline';
  return (
    <div className={s.footer}>
      <RoomStatus label={label} tone={status === 'connected' ? 'ok' : status === 'connecting' ? 'warn' : 'error'} />
      <button type="button" className={s.invite} onClick={() => document.dispatchEvent(new CustomEvent('klaud:invite'))}>
        Invite
      </button>
    </div>
  );
}
