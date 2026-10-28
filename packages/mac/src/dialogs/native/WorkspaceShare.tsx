import { useState } from 'react';
import type { WsRole } from '@beluga/protocol.js';
import { inviteChoice } from '@beluga/ui/invite-menus.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { shareRowDetail, worktreeShareRows, type WorktreeShareRow } from '@beluga/ui/worktree-share.js';
import { cannotTake } from '@beluga/net/mesh/features.js';
import { presenceOf } from '@beluga/core/friend-share-people.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Avatar, Button } from '../../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { openNet } from '../../network/net-sheets.js';
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
 * Share a workspace with just this one worktree's people (BLG-340): your friends, over the Beluga
 * network with nobody in a room, and anyone in your room. Each with a role (work here, follow along,
 * or nothing), changed in place, plus a way to add someone new.
 */
export function WorkspaceShareSheet({ menu, close }: NativeMenuProps<'ws_share'>) {
  const api = useApi();
  const { ui, client } = useBeluga();
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  const project = useApp((st) => st.projects.find((p) => p.workspaces.some((w) => w.id === menu.id)));
  const self = useApp((st) => st.self);
  const network = useApp((st) => st.network);
  const peers = useApp((st) => st.peers);
  const members = useApp((st) => st.members);
  const projectShares = useApp((st) => st.projectShares);
  const projects = useApp((st) => st.projects);
  if (!ws) return null;
  const rows = worktreeShareRows({ peers, self, members, network, projectShares, projects }, ws.id);
  const said = (p: Promise<unknown>): void => void p.catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'warn'));
  const set = (row: WorktreeShareRow, access: Access): void => {
    const where = { peerId: row.peerId, workspaceId: ws.id, ...(project ? { projectId: project.id } : {}) };
    if (row.via === 'room') said(access === 'none' ? api.sharing.remove(ws.id, row.peerId) : api.sharing.invite(ws.id, row.peerId, access));
    else said(access === 'none' ? api.sharing.unshareFriend(where) : api.sharing.shareWithFriend({ ...where, role: access }));
  };
  const byLink = (): void => ui.openMenu({ kind: 'invite_link', ...inviteChoice(project?.root ? project.id : undefined) });
  const addFriend = (): void => (close(), openNet({ kind: 'add_friend' }));
  return (
    <Sheet
      title={`Share “${ws.name}”`}
      subtitle="Only this worktree: people you add see its conversation, files and Scratch, and can ask your Claude here. Friends get it over the Beluga network, so nobody needs to be in your room."
      icon="share"
      close={close}
      footer={
        <>
          {self?.host ? (
            <Button variant="quiet" icon="link" onClick={byLink}>
              Invite by Link…
            </Button>
          ) : (
            <Button variant="quiet" icon="people" onClick={addFriend}>
              Add a Friend…
            </Button>
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
          {rows.map((row) => {
            const friend = network.friends.find((f) => f.peerId === row.peerId);
            const presence = friend ? presenceOf({ network, peers }, row.peerId) : undefined;
            const why = row.via === 'network' && row.access === 'none' && friend ? cannotTake(friend.name, friend.beluga, 'share.project', friend.online) : undefined;
            const inRoom = peers.some((p) => p.peerId === row.peerId);
            return (
              <div key={row.peerId} role="listitem" className={s.item}>
                <Avatar name={row.name} id={row.peerId} size={24} />
                <div className={s.itemText}>
                  <span className={s.itemTitle}>
                    {row.name} {presence && presence.state !== 'online' ? <Tag tone="muted">{presence.label}</Tag> : null}
                  </span>
                  <span className={s.itemDetail}>{why ?? shareRowDetail(row, inRoom)}</span>
                </div>
                <Select<Access> label={`Access for ${row.name}`} value={row.access} options={ACCESS} onChange={(a) => set(row, a)} />
              </div>
            );
          })}
          {rows.length ? null : (
            <div className={s.empty}>
              {network.enabled ? 'No friends yet. Add a friend, then share this worktree with them here.' : 'Turn on the Beluga network in Settings to share with friends, or invite someone to your room.'}
            </div>
          )}
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
