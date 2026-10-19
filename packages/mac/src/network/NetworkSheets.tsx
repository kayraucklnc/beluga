import { useState } from 'react';
import type { FriendView } from '@klaud/net/mesh/views.js';
import { Alert } from '../components/Alert.js';
import { Button } from '../components/ui.js';
import { useApp, useKlaud } from '../lib/klaud.js';
import { Sheet } from '../dialogs/native/parts.js';
import { AddFriendSheet, JoinGroupSheet } from './AddFriendSheet.js';
import { PersonAvatar } from './Avatars.js';
import { addableFriends, presenceLine, shownState, sortFriends } from './net-model.js';
import { closeNet, openNet, useNetSheet } from './net-sheets.js';
import { StatusSheet } from './StatusMenu.js';
import { errorText, openGroup, quietly, useShownConversation } from './use-net.js';
import s from './network.module.css';

/** Friends with checkboxes (a new group, adding people). */
function FriendPicker({ friends, chosen, onChange }: { friends: readonly FriendView[]; chosen: ReadonlySet<string>; onChange: (next: Set<string>) => void }) {
  if (!friends.length) return <div className={`${s.picker} ${s.pickEmpty}`}>No friends to add yet. Add a friend first, or invite people with the group’s link.</div>;
  return (
    <div className={s.picker} role="group" aria-label="Friends">
      {friends.map((f) => (
        <label key={f.peerId} className={s.pick}>
          <input
            type="checkbox"
            checked={chosen.has(f.peerId)}
            onChange={(e) => {
              const next = new Set(chosen);
              if (e.target.checked) next.add(f.peerId);
              else next.delete(f.peerId);
              onChange(next);
            }}
          />
          <PersonAvatar name={f.name} id={f.peerId} state={shownState(f)} size={26} />
          <span className={s.pickText}>
            <span>{f.name}</span>
            <span className={s.dim}>{presenceLine(f)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

const chosenLine = (n: number): string => (n ? `${n} friend${n === 1 ? '' : 's'} chosen` : 'You can add people later too');

/** New Group: a name, friends to start with, Create. */
function NewGroupSheet({ preset }: { preset: readonly string[] }) {
  const { client } = useKlaud();
  const friends = sortFriends(useApp((st) => st.network.friends));
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set(preset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const create = async (): Promise<void> => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const g = await quietly(client, client.api.network['groups.create'](name.trim(), [...chosen]));
      closeNet();
      openGroup(client, g.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="New Group"
      subtitle="A conversation with several friends, kept on everyone’s Mac."
      icon="people"
      close={closeNet}
      onReturn={() => void create()}
      footer={
        <>
          <span className={s.chosen}>{error ? <span style={{ color: 'var(--error)' }}>{error}</span> : chosenLine(chosen.size)}</span>
          <Button onClick={closeNet}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <div className={s.formRow}>
        <label className={s.formLabel} htmlFor="new-group-name">
          Name
        </label>
        <input
          id="new-group-name"
          className={s.nameInput}
          value={name}
          maxLength={64}
          placeholder="Launch team"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void create();
            }
          }}
        />
      </div>
      <div className={s.formRow}>
        <span className={s.formLabel}>People</span>
        <FriendPicker friends={friends} chosen={chosen} onChange={setChosen} />
      </div>
    </Sheet>
  );
}

/** Add People: friends who aren't in the group yet. */
function AddPeopleSheet({ groupId }: { groupId: string }) {
  const { client } = useKlaud();
  const group = useApp((st) => st.network.groups.find((g) => g.id === groupId));
  const friends = useApp((st) => st.network.friends);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!group) return null;
  const add = async (): Promise<void> => {
    if (!chosen.size || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      for (const id of chosen) await quietly(client, client.api.network['groups.addMember'](group.id, id));
      closeNet();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={`Add People to ${group.name}`}
      subtitle="They can read what’s said from now on."
      icon="plus"
      close={closeNet}
      onReturn={() => void add()}
      footer={
        <>
          <span className={s.chosen}>{error ? <span style={{ color: 'var(--error)' }}>{error}</span> : chosen.size ? chosenLine(chosen.size) : ''}</span>
          <Button onClick={closeNet}>Cancel</Button>
          <Button variant="primary" disabled={!chosen.size || busy} onClick={() => void add()}>
            Add
          </Button>
        </>
      }
    >
      <div className={s.formRow}>
        <FriendPicker friends={addableFriends(friends, group)} chosen={chosen} onChange={setChosen} />
      </div>
    </Sheet>
  );
}

/** Remove a friend, leave a group, remove someone from a group: an alert each. */
function Confirmations() {
  const { client } = useKlaud();
  const sheet = useNetSheet();
  const net = useApp((st) => st.network);
  const shown = useShownConversation();
  const api = client.api.network;
  const leaveView = (id: string): void => {
    if (shown === id) client.store.dispatch({ type: 'view', view: { kind: 'room' } });
  };
  if (sheet?.kind === 'remove_friend') {
    const f = net.friends.find((x) => x.peerId === sheet.peerId);
    if (!f) return null;
    return (
      <Alert
        title={`Remove ${f.name}?`}
        message={`You won’t be connected any more, and your conversation with ${f.name} is removed from this Mac. Groups you share stay.`}
        tone="danger"
        icon="person"
        confirm={{
          label: 'Remove',
          destructive: true,
          onClick: () => {
            closeNet();
            leaveView(`dm:${f.peerId}`);
            void api['friends.remove'](f.peerId);
          },
        }}
        onCancel={closeNet}
      />
    );
  }
  if (sheet?.kind === 'leave_group') {
    const g = net.groups.find((x) => x.id === sheet.groupId);
    if (!g) return null;
    const lastAdmin = g.admin && g.members.filter((m) => m.admin).length === 1 && g.members.length > 1;
    return (
      <Alert
        title={`Leave ${g.name}?`}
        message={`You stop getting its messages. What was said stays on this Mac, read-only.${lastAdmin ? ' You’re its only admin, so the person who’s been in it longest becomes admin.' : ''}`}
        tone="danger"
        icon="people"
        confirm={{
          label: 'Leave',
          destructive: true,
          onClick: () => {
            closeNet();
            void api['groups.leave'](g.id);
          },
        }}
        onCancel={closeNet}
      />
    );
  }
  if (sheet?.kind === 'remove_member') {
    const g = net.groups.find((x) => x.id === sheet.groupId);
    const m = g?.members.find((x) => x.peerId === sheet.peerId);
    if (!g || !m) return null;
    return (
      <Alert
        title={`Remove ${m.name} from ${g.name}?`}
        message={`${m.name} stops getting new messages. What was said before stays on their Mac.`}
        tone="danger"
        confirm={{
          label: 'Remove',
          destructive: true,
          onClick: () => {
            closeNet();
            void api['groups.removeMember'](g.id, m.peerId);
          },
        }}
        onCancel={() => openNet({ kind: 'group_info', groupId: g.id })}
      />
    );
  }
  return null;
}

/** Whichever friends-and-groups sheet is open (the group info is drawn by its header). */
export function NetworkSheets() {
  const sheet = useNetSheet();
  if (!sheet) return null;
  switch (sheet.kind) {
    case 'add_friend':
      return <AddFriendSheet {...(sheet.accept ? { accept: sheet.accept } : {})} />;
    case 'join_group':
      return <JoinGroupSheet accept={sheet.accept} />;
    case 'new_group':
      return <NewGroupSheet preset={sheet.with ?? []} />;
    case 'add_people':
      return <AddPeopleSheet groupId={sheet.groupId} />;
    case 'status':
      return <StatusSheet />;
    case 'group_info':
      return null;
    default:
      return <Confirmations />;
  }
}
