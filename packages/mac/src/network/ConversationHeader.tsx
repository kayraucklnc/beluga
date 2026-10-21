import type { ReactNode } from 'react';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { IconButton } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useApp, useKlaud } from '../lib/klaud.js';
import { GroupAvatar, PersonAvatar, PresenceDot } from './Avatars.js';
import { MembersButton } from './GroupInfo.js';
import { conversationOf, membersLine, openGroupInvitation, presenceLine, shownState } from './net-model.js';
import { openNet } from './net-sheets.js';
import { useSay } from './use-net.js';
import { channelName } from './chat-model.js';
import s from './network.module.css';

export interface HeaderParts {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly right?: ReactNode;
}

/** The toolbar of a conversation with friends: who it's with and their status, the group's people, a ⋯ menu. */
export function useConversationHeader(id: string): HeaderParts {
  const { client } = useKlaud();
  const say = useSay();
  const net = useApp((st) => st.network);
  const target = conversationOf(id);
  if (target?.kind === 'dm') {
    const f = net.friends.find((x) => x.peerId === target.peerId);
    if (!f) return { title: 'Conversation' };
    const state = shownState(f);
    const items: ActionItem[] = [
      { label: `New Channel with ${f.name}…`, icon: 'people', onSelect: () => openNet({ kind: 'new_group', with: [f.peerId] }) },
      { label: 'Copy Name', icon: 'copy', onSelect: () => void copyText(f.name).then(() => say(`Copied “${f.name}”`)) },
      { label: `Remove ${f.name}…`, danger: true, separate: true, onSelect: () => openNet({ kind: 'remove_friend', peerId: f.peerId }) },
    ];
    return {
      title: (
        <span className={s.titleRow}>
          <PersonAvatar name={f.name} id={f.peerId} size={20} />
          <span>{f.name}</span>
        </span>
      ),
      subtitle: (
        <span className={s.subtitleDot}>
          <PresenceDot state={state} size={8} />
          {presenceLine(f)}
          {f.via === 'relay' && f.online ? ' · through another member’s Mac' : ''}
        </span>
      ),
      right: (
        <ActionsDropdown items={items}>
          <IconButton icon="more" label={`More for ${f.name}`} />
        </ActionsDropdown>
      ),
    };
  }
  if (target?.kind === 'group') {
    const g = net.groups.find((x) => x.id === target.groupId);
    if (!g) return { title: 'Channel' };
    const copyLink = async (): Promise<void> => {
      const open = openGroupInvitation(net.invitations, g.id) ?? (await client.api.network['groups.invite'](g.id));
      await copyText(open.link);
      say(`Copied the invite link to ${g.name}`);
    };
    const items: ActionItem[] = g.active
      ? [
          { label: 'Channel Info', icon: 'people', onSelect: () => openNet({ kind: 'group_info', groupId: g.id }) },
          ...(g.admin
            ? [
                { label: 'Add People…', icon: 'plus' as const, onSelect: () => openNet({ kind: 'add_people', groupId: g.id }) },
                { label: 'Copy Invite Link', icon: 'link' as const, onSelect: () => void copyLink().catch(() => undefined) },
              ]
            : []),
          { label: 'Leave Channel…', danger: true, separate: true, onSelect: () => openNet({ kind: 'leave_group', groupId: g.id }) },
        ]
      : [
          { label: 'Channel Info', icon: 'people', onSelect: () => openNet({ kind: 'group_info', groupId: g.id }) },
          { label: 'Delete Channel…', danger: true, separate: true, onSelect: () => openNet({ kind: 'delete_group', groupId: g.id }) },
        ];
    const online = g.members.filter((m) => !m.self && m.online).length;
    return {
      title: (
        <span className={s.titleRow}>
          <GroupAvatar name={g.name} id={g.id} size={20} muted={!g.active} />
          <span>{channelName(net, g)}</span>
        </span>
      ),
      subtitle: <span>{g.active ? `${membersLine(g.members)}${online ? ` · ${online} online` : ''}` : 'You’re no longer in this channel'}</span>,
      right: (
        <>
          <MembersButton g={g} />
          <ActionsDropdown items={items}>
            <IconButton icon="more" label={`More for ${g.name}`} />
          </ActionsDropdown>
        </>
      ),
    };
  }
  return { title: 'Conversation' };
}
