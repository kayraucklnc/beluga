import { useState } from 'react';
import type { SharedTab } from '@klaud/core/store.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Avatar, Button } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { useApi, useApp } from '../../lib/klaud.js';
import type { NativeMenuProps } from './index.js';
import { Alert, Section, Sheet, Tag } from './parts.js';
import s from './sharing.module.css';
import v from './shared.module.css';

const OPEN: ReadonlyArray<{ tab: SharedTab; label: string; icon: IconName; detail: string }> = [
  { tab: 'chat', label: 'Chat', icon: 'chat', detail: 'The conversation' },
  { tab: 'files', label: 'Files', icon: 'folder', detail: 'Browse and search' },
  { tab: 'diff', label: 'Changes', icon: 'diff', detail: 'What changed' },
];

/** A workspace someone shared with you: what you can do there, who's in it, and leaving. */
export function SharedSheet({ menu, close }: NativeMenuProps<'shared'>) {
  const api = useApi();
  const actions = useActions();
  const w = useApp((st) => st.shared.find((x) => x.owner === menu.owner && x.id === menu.id));
  const peers = useApp((st) => st.peers);
  const roster = useApp((st) => st.roster[menu.id]) ?? [];
  const selfId = useApp((st) => st.selfId);
  const [leaving, setLeaving] = useState(false);
  if (!w) return null;
  const owner = peers.find((p) => p.peerId === w.owner)?.name ?? 'Someone';
  const nameOf = (id: string): string => (id === selfId ? 'You' : (peers.find((p) => p.peerId === id)?.name ?? 'someone'));
  if (leaving) {
    return (
      <Alert
        title={`Leave ${w.name}?`}
        message={`It disappears from your sidebar. ${owner} can invite you again.`}
        confirm="Leave"
        onCancel={() => setLeaving(false)}
        onConfirm={() => {
          void api.sharing.leave(w.owner, w.id);
          close();
        }}
      />
    );
  }
  const open = (tab: SharedTab): void => {
    close();
    actions.run({ type: 'open_shared', owner: w.owner, id: w.id, tab });
  };
  return (
    <Sheet
      title={`${owner}’s ${w.name}`}
      subtitle={`${w.project}${w.branch ? ` · ${w.branch}` : ''}`}
      badge={<Avatar name={owner} id={w.owner} size={36} />}
      close={close}
      footer={
        <>
          <Button variant="danger" onClick={() => setLeaving(true)}>
            Leave…
          </Button>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <div className={v.role}>
        <Tag tone={w.role === 'contribute' ? 'claude' : 'muted'}>{w.role === 'contribute' ? 'You can work here' : 'Following along'}</Tag>
        <span>{w.role === 'contribute' ? `Talk to ${owner}’s Claude here. It runs on ${owner}’s computer.` : 'Read-only: you see the conversation and the files.'}</span>
      </div>
      <div className={v.tiles}>
        {OPEN.map((o) => (
          <button key={o.tab} type="button" className={v.tile} onClick={() => open(o.tab)}>
            <Icon name={o.icon} size={18} />
            <span className={v.tileLabel}>{o.label}</span>
            <span className={v.tileDetail}>{o.detail}</span>
          </button>
        ))}
      </div>
      <Section title="In this workspace">
        <div className={s.list} role="list" aria-label="In this workspace">
          <div role="listitem" className={s.item}>
            <Avatar name={owner} id={w.owner} size={22} />
            <span className={s.itemText}>
              <span className={s.itemTitle}>{owner}</span>
            </span>
            <Tag>Owner</Tag>
          </div>
          {roster
            .filter((r) => r.peerId !== w.owner)
            .map((r) => (
              <div key={r.peerId} role="listitem" className={s.item}>
                <Avatar name={nameOf(r.peerId)} id={r.peerId} size={22} />
                <span className={s.itemText}>
                  <span className={s.itemTitle}>{nameOf(r.peerId)}</span>
                </span>
                <Tag tone="muted">{r.role === 'contribute' ? 'Works here' : 'Follows'}</Tag>
              </div>
            ))}
        </div>
      </Section>
    </Sheet>
  );
}
