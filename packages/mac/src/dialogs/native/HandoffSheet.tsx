import { useState } from 'react';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Field, FormSheet, PickList, formStyles as f } from '../../components/FormSheet.js';
import { Icon } from '../../components/Icon.js';
import { Avatar } from '../../components/ui.js';
import { useApp } from '../../lib/beluga.js';
import type { NativeMenuProps } from './index.js';
import { usePick } from './pick.js';
import s from './menus.module.css';

/** Hand a workspace to someone: who, and what happens, then one button. */
export function HandoffSheet({ menu, close }: NativeMenuProps<'handoff'>) {
  const pick = usePick(menu);
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  const peers = useApp((st) => st.peers);
  const selfId = useApp((st) => st.self?.peerId);
  const people = peers.filter((p) => p.peerId !== selfId && p.agent);
  const [who, setWho] = useState<string | undefined>(people[0]?.peerId);
  if (!ws) return null;
  const person = people.find((p) => p.peerId === who);
  const handOff = (peerId = who): void => {
    if (peerId) pick(`ho:${peerId}`);
  };
  return (
    <FormSheet
      title={`Hand Off “${ws.name}”`}
      icon="hand"
      intro="Someone else takes over this work on their computer, with their own Claude. They need the same repository."
      submitLabel={person ? `Hand Off to ${person.name}` : 'Hand Off'}
      canSubmit={Boolean(person)}
      onSubmit={() => handOff()}
      onCancel={close}
      width={540}
      footer={
        people.length ? undefined : (
          <button type="button" className={f.linkButton} onClick={() => (close(), document.dispatchEvent(new CustomEvent('beluga:invite')))}>
            Invite Someone…
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
            rows={people.map((p) => ({ value: p.peerId, name: p.name, detail: `${p.name}’s Claude continues on ${p.name}’s computer`, leading: <Avatar name={p.name} id={p.peerId} size={22} /> }))}
          />
        ) : (
          <div className={s.note}>
            <Icon name="people" size={14} />
            Nobody with Claude is in the room yet. Invite someone first.
          </div>
        )}
      </Field>
      <Field label="What happens">
        <ol className={s.steps}>
          <li>Your Claude writes a short handoff note: what’s done, what’s left.</li>
          <li>Uncommitted work is committed, and the branch is sent to them, encrypted.</li>
          <li>They accept and get a worktree with the branch and this chat. Their Claude carries on, and you can follow along.</li>
        </ol>
      </Field>
    </FormSheet>
  );
}
