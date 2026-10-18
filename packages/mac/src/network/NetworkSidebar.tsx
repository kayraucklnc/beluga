import { useEffect, useRef, useState } from 'react';
import type { FriendView, GroupView } from '@klaud/net/mesh/views.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsContext } from '../components/SpecMenu.js';
import { Avatar, Badge, Button, IconButton, Tip, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useApp, useKlaud } from '../lib/klaud.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { Row, Section } from '../layout/sidebar-parts.js';
import { GroupAvatar, PersonAvatar } from './Avatars.js';
import { dmId, groupId, membersLine, openGroupInvitation, presenceLine, shownState, sortFriends, sortGroups } from './net-model.js';
import { openNet } from './net-sheets.js';
import { errorText, openDm, openGroup, quietly, useNetwork, useSay } from './use-net.js';
import side from '../layout/Sidebar.module.css';
import s from './network.module.css';

/**
 * The sidebar's Friends and Groups: who's around (with their status), the groups you're in,
 * unread counts, and right-click menus. While the network is off, a short card turns it on.
 */

/** Turn on talking with friends: what it is in two lines, and one button. */
function Welcome() {
  const { client } = useKlaud();
  const prefs = usePrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const turnOn = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await quietly(client, client.api.network.setEnabled(true));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.welcome} role="group" aria-label="Talk with friends">
      <div className={s.welcomeArt} aria-hidden="true">
        <Avatar name="A" id="welcome-a" size={22} />
        <Avatar name="J" id="welcome-b" size={22} />
        <Avatar name="M" id="welcome-c" size={22} />
      </div>
      <div className={s.welcomeTitle}>Talk with friends directly</div>
      <div className={s.welcomeText}>Messages and groups go straight from Mac to Mac, end-to-end encrypted. No server, no account.</div>
      <div className={s.welcomeButtons}>
        <Button variant="primary" size="small" disabled={busy} onClick={() => void turnOn()}>
          {busy ? 'Turning On…' : 'Turn On'}
        </Button>
        <Button variant="quiet" size="small" onClick={() => setPrefs({ folded: [...prefs.folded.filter((f) => f !== 'friends'), 'friends'] })}>
          Not Now
        </Button>
      </div>
      {error ? (
        <div className={s.welcomeError} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function friendItems(f: FriendView, groups: readonly GroupView[], ctx: { open: () => void; say: (t: string) => void; addTo: (g: GroupView) => void }): ActionItem[] {
  const mine = sortGroups(groups).filter((g) => g.active && g.admin && !g.members.some((m) => m.peerId === f.peerId));
  return [
    { label: 'Message', icon: 'chat', onSelect: ctx.open },
    {
      label: 'Add to Group',
      icon: 'people',
      onSelect: () => undefined,
      submenu: [
        ...mine.map((g) => ({ label: g.name, onSelect: () => ctx.addTo(g) })),
        { label: `New Group with ${f.name}…`, separate: mine.length > 0, onSelect: () => openNet({ kind: 'new_group', with: [f.peerId] }) },
      ],
    },
    { label: 'Copy Name', icon: 'copy', separate: true, onSelect: () => void copyText(f.name).then(() => ctx.say(`Copied “${f.name}”`)) },
    { label: `Remove ${f.name}…`, danger: true, separate: true, onSelect: () => openNet({ kind: 'remove_friend', peerId: f.peerId }) },
  ];
}

function FriendRow({ f, groups }: { f: FriendView; groups: readonly GroupView[] }) {
  const { client } = useKlaud();
  const say = useSay();
  const selected = useApp((st) => st.view.kind === 'conversation' && st.view.id === dmId(f.peerId));
  const state = shownState(f);
  const note = state !== 'offline' ? f.presence.note?.trim() : undefined;
  const addTo = (g: GroupView): void => {
    client.api.network['groups.addMember'](g.id, f.peerId).then(
      () => say(`Added ${f.name} to ${g.name}`),
      () => undefined,
    );
  };
  return (
    <ActionsContext items={() => friendItems(f, groups, { open: () => openDm(client, f.peerId), say, addTo })}>
      <Row
        data-friend-row={f.peerId}
        selected={selected}
        icon={<PersonAvatar name={f.name} id={f.peerId} state={state} size={18} />}
        aria-label={`${f.name}, ${presenceLine(f)}${f.unread ? `, ${f.unread} unread` : ''}`}
        label={
          <span className={s.who}>
            <span className={cx(s.whoName, f.unread > 0 && s.unreadName)}>{f.name}</span>
            {note ? <span className={s.whoNote}>{note}</span> : null}
          </span>
        }
        detail={`${f.name} · ${presenceLine(f)}${f.via === 'relay' ? ' · connected through another Mac' : ''}`}
        onClick={() => openDm(client, f.peerId)}
        trailing={
          <>
            {f.via === 'relay' && f.online ? (
              <Tip label="Connected through another member’s Mac (still end-to-end encrypted)">
                <span className={s.relay}>
                  <Icon name="link" size={11} />
                </span>
              </Tip>
            ) : null}
            {f.unread ? <Badge count={f.unread} urgent /> : null}
          </>
        }
      />
    </ActionsContext>
  );
}

/** Rename a group in place (Return keeps it, Esc puts it back). */
function RenameField({ g, done }: { g: GroupView; done: () => void }) {
  const { client } = useKlaud();
  const [name, setName] = useState(g.name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const save = (): void => {
    const next = name.trim();
    done();
    if (next && next !== g.name) void client.api.network['groups.rename'](g.id, next);
  };
  return (
    <input
      ref={ref}
      className={s.rename}
      style={{ fontSize: 'inherit', textAlign: 'left', height: 22 }}
      aria-label={`New name for ${g.name}`}
      value={name}
      maxLength={64}
      onChange={(e) => setName(e.target.value)}
      onBlur={save}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') done();
      }}
    />
  );
}

function groupItems(g: GroupView, ctx: { open: () => void; rename: () => void; copyLink: () => void; read: () => void }): ActionItem[] {
  return [
    { label: 'Open', icon: 'chat', onSelect: ctx.open },
    ...(g.unread ? [{ label: 'Mark as Read', icon: 'check' as const, onSelect: ctx.read }] : []),
    ...(g.active
      ? [
          { label: 'Rename…', icon: 'pencil' as const, separate: true, onSelect: ctx.rename },
          ...(g.admin
            ? [
                { label: 'Add People…', icon: 'plus' as const, onSelect: () => openNet({ kind: 'add_people', groupId: g.id }) },
                { label: 'Copy Invite Link', icon: 'link' as const, onSelect: ctx.copyLink },
              ]
            : []),
          { label: 'Leave Group…', danger: true, separate: true, onSelect: () => openNet({ kind: 'leave_group', groupId: g.id }) },
        ]
      : []),
  ];
}

function GroupRow({ g }: { g: GroupView }) {
  const { client } = useKlaud();
  const say = useSay();
  const invitations = useApp((st) => st.network.invitations);
  const selected = useApp((st) => st.view.kind === 'conversation' && st.view.id === groupId(g.id));
  const [renaming, setRenaming] = useState(false);
  const copyLink = async (): Promise<void> => {
    const open = openGroupInvitation(invitations, g.id) ?? (await client.api.network['groups.invite'](g.id));
    await copyText(open.link);
    say(`Copied the invite link to ${g.name}`);
  };
  const requests = g.admin ? g.requests.length : 0;
  return (
    <ActionsContext items={() => groupItems(g, { open: () => openGroup(client, g.id), rename: () => setRenaming(true), copyLink: () => void copyLink().catch(() => undefined), read: () => void client.api.network.read(groupId(g.id)) })}>
      <Row
        data-group-row={g.id}
        selected={selected}
        className={g.active ? undefined : s.left}
        icon={<GroupAvatar name={g.name} id={g.id} size={18} muted={!g.active} />}
        aria-label={`Group ${g.name}${g.unread ? `, ${g.unread} unread` : ''}`}
        label={renaming ? <RenameField g={g} done={() => setRenaming(false)} /> : <span className={cx(s.whoName, g.unread > 0 && g.active && s.unreadName)}>{g.name}</span>}
        detail={g.active ? `${g.name} · ${membersLine(g.members)}` : `${g.name} · you’re no longer in this group`}
        onClick={() => (renaming ? undefined : openGroup(client, g.id))}
        onDoubleClick={() => g.active && setRenaming(true)}
        trailing={
          <>
            {requests ? (
              <Tip label={`${requests} ${requests === 1 ? 'person asks' : 'people ask'} to join`}>
                <span className={s.requests}>{requests}</span>
              </Tip>
            ) : null}
            {g.unread && g.active ? <Badge count={g.unread} urgent /> : null}
          </>
        }
      />
    </ActionsContext>
  );
}

/** Friends: everyone you've added, with their status; or the card that turns the network on. */
export function FriendsSection() {
  const net = useNetwork();
  const friends = sortFriends(net.friends);
  return (
    <Section id="friends" title="Friends" action={net.enabled ? <IconButton icon="plus" label="Add a friend" onClick={() => openNet({ kind: 'add_friend' })} /> : undefined}>
      <div className={s.sidebarList}>
        {!net.enabled ? (
          <Welcome />
        ) : (
          <>
            {friends.map((f) => (
              <FriendRow key={f.peerId} f={f} groups={net.groups} />
            ))}
            {friends.length ? null : <Row className={side.hintRow} icon={<Icon name="plus" size={13} />} label="Add a friend…" detail="Send them a link or a code; they’re a friend once they use it" onClick={() => openNet({ kind: 'add_friend' })} />}
            {net.pendingJoins.map((p) => (
              <Row key={p.groupId} className={side.hintRow} icon={<Icon name="clock" size={13} />} label={`Asked to join ${p.name}`} detail="Waiting for an admin of the group to let you in" />
            ))}
          </>
        )}
      </div>
    </Section>
  );
}

/** Groups you're in (and ones you left, dimmed, with their history). */
export function GroupsSection() {
  const net = useNetwork();
  if (!net.enabled) return null;
  const groups = sortGroups(net.groups);
  return (
    <Section id="net-groups" title="Groups" action={<IconButton icon="plus" label="New group" onClick={() => openNet({ kind: 'new_group' })} />}>
      <div className={s.sidebarList}>
        {groups.map((g) => (
          <GroupRow key={g.id} g={g} />
        ))}
        {groups.length ? null : <Row className={side.hintRow} icon={<Icon name="plus" size={13} />} label="New group…" detail="A conversation with several friends, kept on everyone’s Mac" onClick={() => openNet({ kind: 'new_group' })} />}
      </div>
    </Section>
  );
}
