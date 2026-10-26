import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { type ReactNode, useState } from 'react';
import type { Guest } from '@beluga/core/collab-store.js';
import { TRUST_INFO, canRunOn, trustOf } from '@beluga/core/trust.js';
import type { GuestCan, PeerInfo, Usage } from '@beluga/protocol.js';
import { CAN_INFO } from '@beluga/shared/invites.js';
import type { TrustLevel } from '@beluga/shared/settings-schema.js';
import { CAN_ORDER } from '@beluga/ui/invite-menus.js';
import type { MenuKind } from '@beluga/ui/menus.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Avatar, cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { Select } from '../settings-controls.js';
import type { Confirm } from './PersonPopover.js';
import { Choice, Tag, optionIndex } from './parts.js';
import { addressTo } from './PeerSheets.js';
import { presetShareWith } from './ShareFolderSheet.js';
import { offerSent } from '../../network/net-model.js';
import { befriend, openFriendCard } from '../../network/use-net.js';
import m from '../../components/SpecMenu.module.css';
import p from './person.module.css';

interface CardProps {
  readonly peer: PeerInfo;
  readonly close: () => void;
  readonly confirm: (c: Confirm) => void;
  /** Show the Run a Command sheet (instead of the card). */
  readonly onRun?: () => void;
}

/** What a friend's trust lets you do on their side, in a line. */
const GRANTED: Record<TrustLevel, string> = {
  blocked: 'Doesn’t let you use their Claude',
  ask: 'Approves each of your requests',
  trusted: 'Lets you use their Claude without asking',
  full: 'Fully trusts you',
};

/** Run a person-menu option by its id. */
function usePick(menu: MenuKind) {
  const { client } = useBeluga();
  const actions = useActions();
  return (id: string): void => {
    const i = optionIndex(client.store.getState(), menu, id);
    if (i >= 0) actions.pick(menu, i);
  };
}

function Head({ peer, tags, lines, title }: { peer: PeerInfo; tags: ReactNode; lines: ReadonlyArray<string | undefined>; title?: ReactNode }) {
  return (
    <div className={p.head}>
      <Avatar name={peer.name} id={peer.peerId} size={44} />
      <div className={p.who}>
        {title ?? <div className={p.name}>{peer.name}</div>}
        <div className={p.tags}>{tags}</div>
        {lines.filter(Boolean).map((l) => (
          <div key={l} className={p.line}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A round button with its name under it (like a contact card's). */
function Action({ icon, label, onClick, on }: { icon: IconName; label: string; onClick: () => void; on?: boolean }) {
  return (
    <button type="button" className={cx(p.action, on && p.actionOn)} onClick={onClick} aria-pressed={on}>
      <span className={p.actionIcon}>
        <Icon name={icon} size={15} />
      </span>
      <span className={p.actionLabel}>{label}</span>
    </button>
  );
}

function Row({ icon, label, onClick, danger }: { icon: IconName; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" className={cx(p.row, danger && p.danger)} onClick={onClick}>
      <Icon name={icon} size={13} />
      <span>{label}</span>
    </button>
  );
}

function Meter({ label, pct }: { label: string; pct: number }) {
  return (
    <div className={p.meter}>
      <span>{label}</span>
      <span className={p.bar}>
        <span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} className={pct >= 85 ? p.barHot : undefined} />
      </span>
      <span className={p.pct}>{pct}%</span>
    </div>
  );
}

function UsageMeters({ usage }: { usage: Usage | undefined }) {
  if (!usage?.fiveHour && !usage?.week) return null;
  return (
    <div className={p.usage} aria-label="Claude usage">
      {usage.fiveHour ? <Meter label="5-hour" pct={usage.fiveHour.pct} /> : null}
      {usage.week ? <Meter label="Week" pct={usage.week.pct} /> : null}
    </div>
  );
}

/**
 * Someone in your room (not a guest): what you do together there, their trust as a line (it's set
 * on their friend card, BLG-202), and (for the host) removing them.
 */
export function RoomPeerCard({ peer, menu, close, confirm, onRun }: CardProps & { menu: Extract<MenuKind, { kind: 'person' }> }) {
  const actions = useActions();
  const { client, ui } = useBeluga();
  const address = (claude: boolean): void => addressTo(ui, actions, client.store.getState().view, { peerId: peer.peerId, name: peer.name, claude });
  const pick = usePick(menu);
  const trust = useApp((st) => trustOf(st, peer.peerId));
  const friend = useApp((st) => st.network.friends.some((f) => f.peerId === peer.peerId));
  const asked = useApp((st) => offerSent(st.network.offers, peer.peerId));
  const grant = useApp((st) => st.granted[peer.peerId]);
  const following = useApp((st) => st.follow === peer.peerId);
  const host = useApp((st) => st.self?.host === true);
  const share = peer.shares[0];
  return (
    <>
      <Head
        peer={peer}
        tags={
          <>
            {peer.host ? <Tag tone="accent">Host</Tag> : null}
            <Tag tone={peer.agent ? 'claude' : 'muted'}>{peer.agent ? 'Claude on' : 'No Claude'}</Tag>
            {following ? <Tag>Following</Tag> : null}
          </>
        }
        lines={[peer.shares.length ? `Shares ${peer.shares.map((x) => x.name).join(', ')}` : 'Shares nothing yet', grant ? GRANTED[grant.level] : undefined]}
      />
      <UsageMeters usage={peer.usage} />
      <div className={p.actions}>
        <Action icon="chat" label="Message" onClick={() => address(false)} />
        {peer.agent ? <Action icon="claude" label="Ask Claude" onClick={() => address(true)} /> : null}
        {canRunOn(grant?.level) && onRun ? <Action icon="terminal" label="Run" onClick={onRun} /> : null}
        <Action icon="eye" label={following ? 'Following' : 'Follow'} on={following} onClick={() => pick(following ? 'unfollow' : 'follow')} />
        {share ? <Action icon="folder" label="Files" onClick={() => pick('browse')} /> : null}
      </div>
      <div className={p.block}>
        <div className={p.blockLabel}>Trust</div>
        <div className={p.blockDetail}>
          <strong>{TRUST_INFO[trust].label}.</strong> {TRUST_INFO[trust].detail}
        </div>
        <div className={p.blockDetail}>
          {friend ? (
            <button
              type="button"
              className={p.linkButton}
              onClick={() => {
                close();
                openFriendCard(client, peer.peerId);
              }}
            >
              Change in their card…
            </button>
          ) : asked ? (
            'Friend request sent. You set their trust on their card once they accept.'
          ) : (
            <button type="button" className={p.linkButton} onClick={() => void befriend(client, peer.peerId, peer.name)}>
              Add {peer.name} as a friend
            </button>
          )}
        </div>
      </div>
      <div className={p.rows}>
        <Row icon="branch" label="Invite to a Workspace…" onClick={() => pick('person-invite-ws')} />
        <Row
          icon="share"
          label={`Share a Folder with ${peer.name}…`}
          onClick={() => {
            presetShareWith(peer.peerId);
            pick('person-share');
          }}
        />
        {peer.projects?.length ? <Row icon="branch" label={`Start a Worktree on ${peer.name}’s Mac…`} onClick={() => pick('person-remote-ws')} /> : null}
        {host ? (
          <Row
            icon="x"
            danger
            label="Remove from Room…"
            onClick={() => confirm({ title: `Remove ${peer.name}?`, message: `${peer.name} is disconnected and the room’s invite link changes, so the old one stops working.`, confirm: 'Remove', run: () => pick('person-remove') })}
          />
        ) : null}
      </div>
    </>
  );
}

/** Someone who came in with a link: what they can do, where, and giving them more (or less). */
export function GuestCard({ peer, guest, close, confirm }: CardProps & { guest: Guest }) {
  const api = useApi();
  const projects = useApp((st) => st.projects).filter((x) => x.root);
  const name = (id: string): string => projects.find((x) => x.id === id)?.name ?? 'a project';
  const more = projects.filter((x) => !guest.projects.includes(x.id));
  return (
    <>
      <Head peer={peer} tags={<Tag tone="warn">Guest</Tag>} lines={[guest.room ? 'Invited to everything: the room chat and what you share.' : 'Came in with a link: sees only what you invited them to.']} />
      <div className={p.block}>
        <div className={p.blockLabel}>Has access to</div>
        <div className={p.chips}>
          {guest.room ? <Tag tone="accent">Everything</Tag> : guest.projects.map((id) => <Tag key={id}>{name(id)}</Tag>)}
          {!guest.room && more.length ? (
            <Dropdown.Root modal={false}>
              <Dropdown.Trigger asChild>
                <button type="button" className={p.addChip} aria-label="Add to a project">
                  <Icon name="plus" size={10} /> Add
                </button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content className={m.menu} align="start" sideOffset={4}>
                  {more.map((x) => (
                    <Dropdown.Item key={x.id} className={m.item} onSelect={() => void api.invites.change(peer.peerId, { addProject: x.id })}>
                      <span className={m.label}>{x.name}</span>
                    </Dropdown.Item>
                  ))}
                  <Dropdown.Separator className={m.separator} />
                  <Dropdown.Item className={m.item} onSelect={() => void api.invites.change(peer.peerId, { room: true })}>
                    <span className={m.label}>Everything</span>
                    <span className={m.hint}>the room chat and what you share</span>
                  </Dropdown.Item>
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          ) : null}
        </div>
      </div>
      <div className={p.block}>
        <div className={p.blockLabel}>{peer.name} can</div>
        <Choice<GuestCan> wide label={`${peer.name} can`} value={guest.can} options={CAN_ORDER.map((c) => ({ value: c, label: CAN_INFO[c].label }))} onChange={(can) => void api.invites.change(peer.peerId, { can })} />
        <div className={p.blockDetail}>{CAN_INFO[guest.can].detail.charAt(0).toUpperCase() + CAN_INFO[guest.can].detail.slice(1)}.</div>
      </div>
      <div className={p.rows}>
        <Row
          icon="x"
          danger
          label={`Remove ${peer.name}…`}
          onClick={() =>
            confirm({
              title: `Remove ${peer.name}?`,
              message: 'They are disconnected and lose access to everything you invited them to.',
              confirm: 'Remove',
              run: () => {
                void api.invites.remove(peer.peerId);
                close();
              },
            })
          }
        />
      </div>
    </>
  );
}

/** You: your name (edit it here), your Claude and who may use it. */
export function AccountCard({ peer, menu, close, confirm }: CardProps & { menu: Extract<MenuKind, { kind: 'person' }> }) {
  const api = useApi();
  const actions = useActions();
  const { client, ui } = useBeluga();
  const pick = usePick(menu);
  const room = useApp((st) => st.room);
  const host = useApp((st) => st.self?.host === true);
  const policy = useApp((st) => st.policy);
  const [name, setName] = useState(peer.name);
  const rename = (): void => {
    const next = name.trim();
    if (next && next !== peer.name) void api.session.rename(next);
    else setName(peer.name);
  };
  return (
    <>
      <Head
        peer={peer}
        title={
          <input
            className={p.nameInput}
            value={name}
            aria-label="Your name"
            maxLength={32}
            spellCheck={false}
            onChange={(e) => setName(e.target.value.replace(/[^\w.-]/g, ''))}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        }
        tags={
          <>
            <Tag>{host ? `You host ${room}` : `You’re in ${room}`}</Tag>
            <Tag tone={peer.agent ? 'claude' : 'muted'}>{peer.agent ? 'Claude on' : 'No Claude'}</Tag>
          </>
        }
        lines={['This is how friends see you.']}
      />
      <UsageMeters usage={peer.usage} />
      <div className={p.block}>
        <div className={p.inline}>
          <span className={p.blockLabel}>Friends may use your Claude</span>
          <Select
            label="Friends may use your Claude"
            value={policy}
            onChange={(v) => void api.session.setClaudeSharing(v)}
            options={[
              { value: 'ask', label: 'Ask me each time' },
              { value: 'auto', label: 'Without asking' },
              { value: 'deny', label: 'Never' },
            ]}
          />
        </div>
        <div className={p.blockDetail}>For people you haven’t picked a trust level for. Click someone in People to set theirs.</div>
      </div>
      <div className={p.rows}>
        <Row icon="claude" label="Ask My Claude" onClick={() => addressTo(ui, actions, client.store.getState().view, { peerId: peer.peerId, name: peer.name, claude: true, self: true })} />
        <Row icon="share" label="Share a Folder…" onClick={() => pick('share-folder')} />
        <Row
          icon="gear"
          label="Settings…"
          onClick={() => {
            close();
            ui.patch({ settings: 'general' });
          }}
        />
        {host ? null : <Row icon="x" danger label="Leave the Room…" onClick={() => confirm({ title: `Leave ${room}?`, message: 'Beluga closes and you leave the room. Your projects and chats stay on this Mac.', confirm: 'Leave', run: () => pick('leave-room') })} />}
      </div>
    </>
  );
}

