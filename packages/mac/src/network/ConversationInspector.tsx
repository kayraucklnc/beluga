import type { ReactNode } from 'react';
import { Button, Tip } from '../components/ui.js';
import { TRUST_INFO } from '@klaud/core/trust.js';
import { TRUST_LEVELS, type TrustLevel } from '@klaud/shared/settings-schema.js';
import { PersonRules } from '../gateway/AccessSettings.js';
import { Select } from '../dialogs/settings-controls.js';
import { useApi, useApp, useKlaud } from '../lib/klaud.js';
import { PersonAvatar } from './Avatars.js';
import { conversationOf, presenceLine, shownState, sortMembers } from './net-model.js';
import { openNet } from './net-sheets.js';
import s from '../layout/Inspector.module.css';
import n from './network.module.css';

function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className={s.panel}>
      <div className={s.panelHead}>
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.field}>
      <span className={s.fieldLabel}>{label}</span>
      <span className={s.fieldValue}>{children}</span>
    </div>
  );
}

/** What this friend's Claude may do here: your trust in them, and your rules for their requests. */
function FriendAccess({ peerId, name }: { peerId: string; name: string }) {
  const api = useApi();
  const { client } = useKlaud();
  const gateway = useApp((st) => st.gateway.enabled);
  const level = useApp((st): TrustLevel => st.levels[peerId] ?? st.remembered[peerId]?.trust ?? (st.policy === 'deny' ? 'blocked' : st.policy === 'auto' ? 'trusted' : 'ask'));
  if (!gateway) return null;
  const set = (v: TrustLevel): void =>
    void api.people.setTrust(peerId, v).catch((err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn't change it: ${err instanceof Error ? err.message : String(err)}`, level: 'error' }));
  return (
    <Panel title="Their requests">
      <Field label="Trust">
        <Select<TrustLevel> label={`Trust ${name}`} value={level} onChange={set} options={TRUST_LEVELS.map((l) => ({ value: l, label: TRUST_INFO[l].label }))} />
      </Field>
      <PersonRules peerId={peerId} compact />
    </Panel>
  );
}

const since = (ts: number): string => new Date(ts).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });

/** The inspector beside a conversation with friends: who it's with (a friend, or a group's members). */
export function ConversationDetails({ id }: { id: string }) {
  const net = useApp((st) => st.network);
  const target = conversationOf(id);
  if (target?.kind === 'dm') {
    const f = net.friends.find((x) => x.peerId === target.peerId);
    if (!f) return null;
    return (
      <>
        <Panel title="Friend">
          <Field label="Name">{f.name}</Field>
          <Field label="Status">{presenceLine(f)}</Field>
          <Field label="Connection">{!f.online ? 'Not connected' : f.via === 'relay' ? 'Through another member’s Mac' : 'Direct'}</Field>
          <Field label="Added">{since(f.addedAt)}</Field>
        </Panel>
        <FriendAccess peerId={f.peerId} name={f.name} />
      </>
    );
  }
  if (target?.kind === 'group') {
    const g = net.groups.find((x) => x.id === target.groupId);
    if (!g) return null;
    return (
      <Panel
        title="Channel"
        action={
          <Button size="small" variant="quiet" icon="people" onClick={() => openNet({ kind: 'group_info', groupId: g.id })}>
            Info
          </Button>
        }
      >
        <Field label="Name">{g.name}</Field>
        <Field label="Members">
          <span className={n.stack} style={{ ['--ring' as string]: 'var(--bg-sunken)', flexWrap: 'wrap', rowGap: 4 }}>
            {sortMembers(g.members).map((m) => (
              <Tip key={m.peerId} label={m.self ? `${m.name} (you)` : `${m.name} · ${presenceLine(m)}${m.admin ? ' · admin' : ''}`}>
                <span style={{ marginRight: 4 }}>
                  <PersonAvatar name={m.name} id={m.peerId} {...(m.self ? {} : { state: shownState(m) })} size={20} />
                </span>
              </Tip>
            ))}
          </span>
        </Field>
        <Field label="You">{g.active ? (g.admin ? 'Admin' : 'Member') : 'Left'}</Field>
        <Field label="Created">{since(g.createdAt)}</Field>
      </Panel>
    );
  }
  return null;
}
