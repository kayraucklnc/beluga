import { useState } from 'react';
import type { WsRole } from '@klaud/protocol.js';
import { inviteChoice } from '@klaud/ui/invite-menus.js';
import { findWorkspace } from '@klaud/ui/workspace-models.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Avatar, Button } from '../../components/ui.js';
import { useApi, useApp, useKlaud } from '../../lib/klaud.js';
import { Select } from '../settings-controls.js';
import type { NativeMenuProps } from './index.js';
import { Choice, Section, Sheet, Tag } from './parts.js';
import s from './sharing.module.css';

type Access = WsRole | 'none';

const ACCESS: ReadonlyArray<{ value: Access; label: string }> = [
  { value: 'contribute', label: 'Can work here' },
  { value: 'view', label: 'Can follow' },
  { value: 'none', label: 'No access' },
];

/**
 * Share a workspace: everyone in the room with a role (work here, follow along, or nothing),
 * changed in place, plus a link for someone new. The terminal UI's Share menu, as a sheet.
 */
export function WorkspaceShareSheet({ menu, close }: NativeMenuProps<'ws_share'>) {
  const api = useApi();
  const { ui } = useKlaud();
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  const project = useApp((st) => st.projects.find((p) => p.workspaces.some((w) => w.id === menu.id)));
  const members = useApp((st) => st.members[menu.id]);
  const selfId = useApp((st) => st.selfId);
  const self = useApp((st) => st.self);
  const people = useApp((st) => st.peers).filter((p) => p.peerId !== selfId);
  if (!ws) return null;
  const set = (peerId: string, access: Access): void => {
    if (access === 'none') void api.sharing.remove(ws.id, peerId);
    else void api.sharing.invite(ws.id, peerId, access);
  };
  const byLink = (): void => ui.openMenu({ kind: 'invite_link', ...inviteChoice(project?.root ? project.id : undefined) });
  return (
    <Sheet
      title={`Share “${ws.name}”`}
      subtitle="People you add see this conversation and can browse its folder."
      icon="share"
      close={close}
      footer={
        <>
          {self?.host ? (
            <Button variant="quiet" icon="link" onClick={byLink}>
              Invite by Link…
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <Section title="People">
        <div className={s.list} role="list" aria-label="People">
          {self ? (
            <div role="listitem" className={s.item}>
              <Avatar name={self.name} id={self.peerId} size={24} />
              <div className={s.itemText}>
                <span className={s.itemTitle}>{self.name} (you)</span>
                <span className={s.itemDetail}>Your Claude does the work here, on this Mac</span>
              </div>
              <Tag>Owner</Tag>
            </div>
          ) : null}
          {people.map((p) => {
            const access: Access = members?.[p.peerId] ?? 'none';
            return (
              <div key={p.peerId} role="listitem" className={s.item}>
                <Avatar name={p.name} id={p.peerId} size={24} />
                <div className={s.itemText}>
                  <span className={s.itemTitle}>{p.name}</span>
                  <span className={s.itemDetail}>{access === 'contribute' ? 'Chats and asks your Claude here' : access === 'view' ? 'Follows along, read-only' : p.guest ? 'Guest' : 'In the room, not in this workspace'}</span>
                </div>
                <Select<Access> label={`Access for ${p.name}`} value={access} options={ACCESS} onChange={(a) => set(p.peerId, a)} />
              </div>
            );
          })}
          {people.length ? null : <div className={s.empty}>Nobody else is in the room yet. Invite someone, then add them here.</div>}
        </div>
      </Section>
      <p className={s.hint}>Your Claude runs on your computer. Risky steps still ask you, unless you fully trust the person asking.</p>
    </Sheet>
  );
}

/** From a person: put them into one of your workspaces, one click each. */
export function InvitePersonSheet({ menu, close }: NativeMenuProps<'invite_person'>) {
  const api = useApi();
  const peer = useApp((st) => st.peers.find((p) => p.peerId === menu.peerId));
  const projects = useApp((st) => st.projects);
  const members = useApp((st) => st.members);
  const [role, setRole] = useState<WsRole>('contribute');
  const [filter, setFilter] = useState('');
  if (!peer) return null;
  const list = projects
    .flatMap((p) => p.workspaces.filter((w) => !w.archived && !w.external).map((w) => ({ w, label: p.root ? `${p.name} › ${w.name}` : w.name })))
    .filter((x) => x.label.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <Sheet
      title={`Invite ${peer.name} to a Workspace`}
      subtitle={`${peer.name} sees its conversation and files${role === 'contribute' ? ', and can ask your Claude there' : ''}.`}
      badge={<Avatar name={peer.name} id={peer.peerId} size={36} />}
      close={close}
      footer={
        <>
          <span />
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <div className={s.field} style={{ gridTemplateColumns: '1fr auto' }}>
        <input className={s.input} placeholder="Filter workspaces" aria-label="Filter workspaces" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Choice<WsRole>
          label="They can"
          value={role}
          options={[
            { value: 'contribute', label: 'Work here' },
            { value: 'view', label: 'Follow' },
          ]}
          onChange={setRole}
        />
      </div>
      <div className={s.list} role="list" aria-label="Workspaces">
        {list.slice(0, 60).map(({ w, label }) => {
          const now = members[w.id]?.[peer.peerId];
          const icon: IconName = w.kind === 'chat' ? 'chat' : w.kind === 'main' ? 'folder' : 'branch';
          return (
            <div key={w.id} role="listitem" className={s.item} aria-label={label}>
              <Icon name={icon} size={14} className={s.itemIcon} />
              <div className={s.itemText}>
                <span className={s.itemTitle}>{label}</span>
                <span className={s.itemDetail}>{w.kind === 'chat' ? 'Chat' : w.kind === 'main' ? 'Main folder' : (w.branch ?? 'Worktree')}</span>
              </div>
              {now === role ? (
                <Tag tone="accent">
                  <Icon name="check" size={10} /> {now === 'contribute' ? 'Works here' : 'Follows'}
                </Tag>
              ) : (
                <Button size="small" onClick={() => void api.sharing.invite(w.id, peer.peerId, role)}>
                  {now ? (role === 'contribute' ? 'Let Work' : 'Make Follower') : 'Invite'}
                </Button>
              )}
            </div>
          );
        })}
        {list.length ? null : <div className={s.empty}>No workspaces match.</div>}
      </div>
    </Sheet>
  );
}
