import { useEffect, useRef, useState } from 'react';
import { trustOf } from '@klaud/core/trust.js';
import { overviewNews } from '@klaud/ui/workspace-models.js';
import { macTabs } from '../lib/go.js';
import { newShares } from '@klaud/core/store.js';
import { Icon, type IconName } from '../components/Icon.js';
import { SpecContext } from '../components/SpecMenu.js';
import { Avatar, Badge, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { inApp } from '../lib/boot.js';
import { useApi, useApp, useKlaud } from '../lib/klaud.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { openPerson } from '../dialogs/native/PersonPopover.js';
import { PersonContextMenu } from '../dialogs/native/PersonMenu.js';
import { RoomStatus } from '../dialogs/native/RoomPopover.js';
import { Projects, ProjectsAddMenu } from './ProjectTree.js';
import { WorkspaceRow } from './workspace-row.js';
import { UnreadSection } from './UnreadSection.js';
import { signalOf } from './attention-model.js';
import { SignalMark, nameClass, signalClass } from './signal-marks.js';
import { Row, Section } from './sidebar-parts.js';
import { ActivityRow } from '../claude-code/Live.js';
import { FriendsSection, GroupsSection } from '../network/NetworkSidebar.js';
import { RequestsNav } from '../gateway/RequestsNav.js';
import { TasksNav } from '../tasks/TasksNav.js';
import { PlansNav } from '../plans/PlansNav.js';
import { WorktreesNav } from '../views/worktrees/WorktreesNav.js';
import { SelfBar } from '../network/StatusMenu.js';
import { UpdatePill } from '../components/UpdatePill.js';
import s from './Sidebar.module.css';

/**
 * The sidebar's top: three places, always. The rest are a click away without a row of their
 * own: Search in the toolbar (⇧⌘F), Usage as an icon above, the terminal in the right panel (⌘J),
 * shared folders under Shared with me; Activity and Requests show up only while there's something
 * in them. Everything is also in ⌘K and the Go menu (⌥1…7).
 */
const NAV: ReadonlyArray<{ kind: 'overview' | 'room'; icon: IconName }> = [
  { kind: 'overview', icon: 'grid' },
  { kind: 'room', icon: 'chat' },
];

export { workspaceItems } from './workspace-row.js';

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
  const files = tabs.find((t) => t.kind === 'files');
  // Folders someone else shares with you (or that went away while you weren't looking).
  const othersShare = state.peers.some((p) => p.peerId !== state.self?.peerId && p.shares.length > 0) || newShares(state) > 0;
  const badges: Partial<Record<string, { count: number; urgent?: boolean }>> = {
    room: { count: state.unread.room ?? 0, urgent: true },
    files: { count: newShares(state) },
    overview: { count: state.view.kind === 'overview' ? 0 : news.count, urgent: news.urgent },
  };
  return (
    <nav ref={drop.ref} className={cx(s.sidebar, drop.over && s.dropping)} aria-label="Sidebar">
      <div className={s.titlebar} data-tauri-drag-region>
        <span className={s.trafficSpace} data-tauri-drag-region />
        <UsageButton />
        <IconButton icon="sidebar" label="Hide sidebar" keys="⌃⌘S" onClick={() => setPrefs({ sidebar: false })} />
      </div>
      <div className={s.scroll}>
        <section className={s.section}>
          {NAV.map((n) => {
            const tab = tabs.find((t) => t.kind === n.kind);
            if (!tab) return null;
            const b = badges[n.kind];
            const row = (
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
            // Overview, Tasks, then Chat.
            return n.kind === 'overview' ? [row, <TasksNav key="tasks" />, <PlansNav key="plans" />] : row;
          })}
          <ActivityRow whenLive />
          <WorktreesNav />
          <RequestsNav whenAny />
        </section>

        <UnreadSection />

        <Section id="chats" title="Chats" action={<IconButton icon="plus" label="New chat (not tied to a project)" onClick={() => actions.run({ type: 'new_chat', projectId: 'chats' })} />}>
          {liveChats.map((w) => (
            <WorkspaceRow key={w.id} ws={w} indent={0} />
          ))}
          {liveChats.length ? null : <Row className={s.hintRow} icon={<Icon name="plus" size={13} />} label="Talk to Claude about anything" onClick={() => actions.run({ type: 'new_chat', projectId: 'chats' })} />}
        </Section>

        <Section id="projects" title="Projects" action={<ProjectsAddMenu />}>
          <Projects />
        </Section>

        {state.shared.length || othersShare ? (
          <Section id="shared" title="Shared with me">
            {othersShare ? (
              <Row
                icon={<Icon name="folder" size={14} />}
                label={files?.label ?? 'Shared files'}
                detail={files?.hint ?? 'Folders people share with you'}
                selected={state.view.kind === 'files'}
                onClick={() => actions.run({ type: 'view', view: { kind: 'files' } })}
                trailing={badges.files?.count ? <Badge count={badges.files.count} /> : null}
              />
            ) : null}
            {state.shared.map((w) => {
              const owner = state.peers.find((p) => p.peerId === w.owner)?.name ?? 'someone';
              const selected = state.view.kind === 'shared' && state.view.id === w.id;
              const signal = signalOf(state, `ws:${w.id}`);
              return (
                <SpecContext key={`${w.owner}:${w.id}`} menu={{ kind: 'shared', owner: w.owner, id: w.id }}>
                  <Row
                    selected={selected}
                    className={signalClass(signal, selected)}
                    data-signal-row={signal.level}
                    aria-label={w.name}
                    icon={<Avatar name={owner} id={w.owner} size={16} />}
                    label={<span className={nameClass(signal)}>{w.name}</span>}
                    detail={`${owner}'s ${w.project} · ${signal.tip || (w.role === 'contribute' ? 'you can work here' : 'you can follow along')}`}
                    onClick={() => actions.run({ type: 'open_shared', owner: w.owner, id: w.id, tab: 'chat' })}
                    trailing={<SignalMark signal={signal} />}
                  />
                </SpecContext>
              );
            })}
          </Section>
        ) : null}

        <FriendsSection />
        <GroupsSection />

        {/* The current room's people (today's rooms), apart from your friends on the klaud network. */}
        <Section id="people" title="In this room">
          <People />
        </Section>
      </div>
      <UpdatePill />
      <SidebarFooter />
      <SelfBar />
    </nav>
  );
}

/** Usage as an icon above the sidebar: how much of this week's Claude you've used, and the Usage page. */
function UsageButton() {
  const actions = useActions();
  const week = useApp((st) => st.self?.usage?.week?.pct);
  const selected = useApp((st) => st.view.kind === 'usage');
  return (
    <span className={s.usage} data-level={week === undefined ? undefined : week >= 90 ? 'high' : week >= 70 ? 'mid' : 'low'}>
      <IconButton icon="gauge" label="Usage" keys="⌥5" active={selected} onClick={() => actions.run({ type: 'view', view: { kind: 'usage' } })} />
    </span>
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
