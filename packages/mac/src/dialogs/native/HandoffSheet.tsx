import { useState } from 'react';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { handoffPeople } from '@beluga/ui/worktree-share.js';
import { Field, FormSheet, PickList, formStyles as f } from '../../components/FormSheet.js';
import { Icon } from '../../components/Icon.js';
import { Avatar } from '../../components/ui.js';
import { useApp } from '../../lib/beluga.js';
import { openNet } from '../../network/net-sheets.js';
import type { NativeMenuProps } from './index.js';
import { usePick } from './pick.js';
import s from './menus.module.css';

/**
 * Hand a workspace to someone: who, and what happens, then one button. Anyone in your room with
 * their Claude, or any friend over the Beluga network, room or not (BLG-341).
 */
export function HandoffSheet({ menu, close }: NativeMenuProps<'handoff'>) {
  const pick = usePick(menu);
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  const peers = useApp((st) => st.peers);
  const self = useApp((st) => st.self);
  const network = useApp((st) => st.network);
  const people = handoffPeople({ peers, self, network });
  const [who, setWho] = useState<string | undefined>((people.find((p) => !p.why && p.online) ?? people.find((p) => !p.why))?.peerId);
  if (!ws) return null;
  const person = people.find((p) => p.peerId === who);
  const handOff = (peerId = who): void => {
    if (peerId && !people.find((p) => p.peerId === peerId)?.why) pick(`ho:${peerId}`);
  };
  const detail = (p: (typeof people)[number]): string => p.why ?? `${p.name}’s agent continues on ${p.name}’s computer${p.online ? '' : '. They’re offline: it waits for them'}`;
  return (
    <FormSheet
      title={`Hand Off “${ws.name}”`}
      icon="hand"
      intro="A friend takes over this work on their computer, with their own agent. They need the same repository. To work on it together instead, use Share."
      submitLabel={person ? `Hand Off to ${person.name}` : 'Hand Off'}
      canSubmit={Boolean(person && !person.why)}
      onSubmit={() => handOff()}
      onCancel={close}
      width={540}
      footer={
        people.length ? undefined : (
          <button type="button" className={f.linkButton} onClick={() => (close(), openNet({ kind: 'add_friend' }))}>
            Add a Friend…
          </button>
        )
      }
    >
      <Field label="To">
        {people.length ? (
          <PickList
            label="Who takes over"
            value={who}
            onChange={setWho}
            onChoose={handOff}
            rows={people.map((p) => ({ value: p.peerId, name: p.name, detail: detail(p), leading: <Avatar name={p.name} id={p.peerId} size={22} /> }))}
          />
        ) : (
          <div className={s.note}>
            <Icon name="people" size={14} />
            {network.enabled ? 'No friends yet. Add a friend, then hand this off to them.' : 'Turn on the Beluga network in Settings to hand this to a friend, or invite someone to your room.'}
          </div>
        )}
      </Field>
      <Field label="What happens">
        <ol className={s.steps}>
          <li>Your agent writes a short handoff note: what’s done, what’s left.</li>
          <li>Uncommitted work is committed, and the branch is sent to them, encrypted.</li>
          <li>They accept and get a worktree with the branch and this chat. Their agent carries on, and you can follow along.</li>
        </ol>
      </Field>
    </FormSheet>
  );
}
