import { useState } from 'react';
import type { GuestCan } from '@klaud/protocol.js';
import { CAN_INFO, DAY_MS, expiresIn } from '@klaud/shared/invites.js';
import { CAN_ORDER, type InviteChoice } from '@klaud/ui/invite-menus.js';
import { Icon } from '../../components/Icon.js';
import { Avatar, Button, Tip, cx } from '../../components/ui.js';
import { toast, useApi, useApp, useKlaud } from '../../lib/klaud.js';
import { Select } from '../settings-controls.js';
import type { NativeMenuProps } from './index.js';
import { Check, Choice, Field, Section, Sheet, Tag, useFlash } from './parts.js';
import s from './sharing.module.css';
import v from './invite.module.css';

const sentence = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** What remote access is doing, when there's no link to copy yet. */
function hostingNote(phase: string | undefined, detail: string | undefined): string {
  if (phase === 'failed') return detail ?? 'Couldn’t open remote access. Try again, or pick another way in Settings › People & access.';
  if (phase === 'local') return 'Only people on this network can join right now.';
  if (phase) return 'Opening a secure link… it’s copied as soon as it’s ready.';
  return 'Klaud opens a secure link the first time you copy one.';
}

/**
 * Invite someone: where to, what they can do there, how the link behaves, then Copy. The links
 * you made are listed underneath (copy again, or revoke), with anyone waiting at the door.
 * The same choices and actions as the terminal UI's Invite menu.
 */
export function InviteSheet({ menu, close }: NativeMenuProps<'invite_link'>) {
  const host = useApp((st) => st.self?.host === true);
  if (!host) return <GuestInvite close={close} />;
  return <HostInvite menu={menu} close={close} />;
}

function HostInvite({ menu, close }: NativeMenuProps<'invite_link'>) {
  const api = useApi();
  const { client } = useKlaud();
  const projects = useApp((st) => st.projects);
  const links = useApp((st) => st.links);
  const invite = useApp((st) => st.invite);
  const hosting = useApp((st) => st.hosting);
  const [c, setC] = useState<InviteChoice>(() => ({ scope: menu.scope, can: menu.can, knock: menu.knock, singleUse: menu.singleUse, expires: menu.expires, ...(menu.from ? { from: menu.from } : {}) }));
  const [copied, flash] = useFlash();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<InviteChoice>): void => setC((x) => ({ ...x, ...patch }));
  const invitable = projects.filter((p) => p.root);
  const scopes = [{ value: 'room', label: 'Everything (the whole room)' }, ...invitable.map((p) => ({ value: p.id, label: p.id === c.from ? `This project · ${p.name}` : p.name }))];
  const fail = (err: unknown): void => toast(client, err instanceof Error ? err.message : String(err), 'error');

  const copy = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await api.invites.create({ scope: c.scope, can: c.can, knock: c.knock, singleUse: c.singleUse, expiresInMs: c.expires ? DAY_MS : 0 });
      if (id && invite) flash('new');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const copyAgain = (id: string): void => void api.invites.copyLink(id).then(() => flash(id), fail);
  const copyRoom = (): void => void api.session.copyInvite().then(() => flash('room'), fail);

  return (
    <Sheet
      title="Invite People"
      subtitle="Send a link. They see only what you invite them to."
      icon="link"
      wide
      close={close}
      onReturn={() => void copy()}
      footer={
        <>
          {invite ? (
            <Tip label="Anyone with the room’s link joins everything, without knocking">
              <Button variant="quiet" icon={copied === 'room' ? 'check' : 'copy'} className={cx(copied === 'room' && s.copied)} onClick={copyRoom}>
                {copied === 'room' ? 'Copied' : 'Copy Room Link'}
              </Button>
            </Tip>
          ) : (
            <span />
          )}
          <Button onClick={close}>Done</Button>
          <Button variant="primary" icon={copied === 'new' ? 'check' : 'link'} disabled={busy} onClick={() => void copy()} aria-keyshortcuts="Enter">
            {copied === 'new' ? 'Copied' : 'Copy Invite Link'}
          </Button>
        </>
      }
    >
      <Field label="Invite to">
        <Select label="Invite to" value={c.scope} options={scopes} onChange={(scope) => set({ scope })} />
        <span className={s.hint}>{c.scope === 'room' ? 'The room chat and everything you share.' : 'All its worktrees and chats, nothing else.'}</span>
      </Field>
      <Field label="They can">
        <Choice<GuestCan> label="They can" value={c.can} options={CAN_ORDER.map((can) => ({ value: can, label: CAN_INFO[can].label, icon: can === 'watch' ? 'eye' : can === 'prompt' ? 'chat' : 'pencil' }))} onChange={(can) => set({ can })} />
        <span className={s.hint}>{sentence(CAN_INFO[c.can].detail)}.</span>
      </Field>
      <Field label="The link">
        <Check checked={c.knock} onChange={(knock) => set({ knock })} label="Knock first" detail={c.knock ? 'You let them in from a card in the chat.' : 'They come straight in.'} />
        <Check checked={c.singleUse} onChange={(singleUse) => set({ singleUse })} label="One person only" detail={c.singleUse ? 'It stops working after the first person.' : 'Anyone with the link can come.'} />
        <Check checked={c.expires} onChange={(expires) => set({ expires })} label="Expires in 24 hours" detail={c.expires ? undefined : 'Works until you revoke it or quit Klaud.'} />
      </Field>
      {!invite ? <div className={v.status}>{hostingNote(hosting?.phase, hosting?.detail)}</div> : null}
      <HowTheyJoin knock={c.knock} />
      <Waiting />
      <Section title="Active links">
        <div className={s.list} role="list" aria-label="Active links">
          {links.length ? (
            [...links]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((l) => (
                <div key={l.id} role="listitem" className={s.item} aria-label={`Link to ${l.label}`}>
                  <Icon name="link" size={14} className={s.itemIcon} />
                  <div className={s.itemText}>
                    <span className={s.itemTitle}>
                      {l.label === 'everything' ? 'Everything' : l.label} <Tag tone="accent">{CAN_INFO[l.can].short}</Tag>
                    </span>
                    <span className={s.itemDetail}>{[sentence(expiresIn(l.expiresAt, Date.now())), l.used ? `used by ${l.used}` : 'not used yet', l.singleUse ? 'one person' : 'anyone', l.knock ? 'knocks first' : 'no knock'].join(' · ')}</span>
                  </div>
                  <div className={s.itemButtons}>
                    <Button size="small" variant="quiet" icon={copied === l.id ? 'check' : 'copy'} className={cx(copied === l.id && s.copied)} onClick={() => copyAgain(l.id)} aria-label={`Copy the link to ${l.label}`}>
                      {copied === l.id ? 'Copied' : 'Copy'}
                    </Button>
                    <Button size="small" variant="danger" onClick={() => void api.invites.revoke(l.id).catch(fail)} aria-label={`Revoke the link to ${l.label}`}>
                      Revoke
                    </Button>
                  </div>
                </div>
              ))
          ) : (
            <div className={s.empty}>No links yet. Links you copy show up here until they expire or you revoke them.</div>
          )}
        </div>
      </Section>
    </Sheet>
  );
}

/** The three steps, for you to pass on. */
function HowTheyJoin({ knock }: { knock: boolean }) {
  return (
    <ol className={v.steps} aria-label="How they join">
      <li>
        <span className={v.stepIcon}><Icon name="send" size={13} /></span>
        <span><strong>Send the link</strong> any way you like: Messages, Slack, email.</span>
      </li>
      <li>
        <span className={v.stepIcon}><Icon name="claude" size={13} /></span>
        <span>
          <strong>They open it in Klaud.</strong> With Klaud for Mac a click on the link is enough; in a terminal they paste it (it starts with <code>klaud join</code>).
        </span>
      </li>
      <li>
        <span className={v.stepIcon}><Icon name={knock ? 'hand' : 'check'} size={13} /></span>
        <span>{knock ? <><strong>They knock</strong> and you let them in from the card in your chat.</> : <><strong>They come straight in.</strong> Secrets like .env files and keys never leave this Mac.</>}</span>
      </li>
    </ol>
  );
}

/** People at the door with one of your links. */
function Waiting() {
  const api = useApi();
  const knocks = useApp((st) => st.knocks);
  const peers = useApp((st) => st.peers);
  const links = useApp((st) => st.links);
  if (!knocks.length) return null;
  return (
    <Section title="Waiting to come in">
      <div className={s.list} role="list" aria-label="Waiting to come in">
        {knocks.map((k) => {
          const name = peers.find((p) => p.peerId === k.peerId)?.name ?? 'Someone';
          const link = links.find((l) => l.id === k.linkId);
          return (
            <div key={k.peerId} role="listitem" className={s.item}>
              <Avatar name={name} id={k.peerId} size={24} />
              <div className={s.itemText}>
                <span className={s.itemTitle}>{name}</span>
                <span className={s.itemDetail}>{link ? `wants to join ${link.label} · ${CAN_INFO[link.can].short}` : 'is at the door'}</span>
              </div>
              <div className={s.itemButtons}>
                <Button size="small" variant="quiet" onClick={() => void api.invites.decline(k.peerId)}>
                  Decline
                </Button>
                <Button size="small" variant="primary" onClick={() => void api.invites.letIn(k.peerId)}>
                  Let In
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** In someone else's room you can pass on its invite, not make links of your own. */
function GuestInvite({ close }: { close: () => void }) {
  const api = useApi();
  const invite = useApp((st) => st.invite);
  const room = useApp((st) => st.room);
  const [copied, flash] = useFlash();
  const copy = (): void => void api.session.copyInvite().then(() => flash('room'));
  return (
    <Sheet
      title="Invite People"
      subtitle={`To ${room}`}
      icon="link"
      close={close}
      onReturn={invite ? copy : undefined}
      footer={
        <>
          <span />
          <Button onClick={close}>Done</Button>
          {invite ? (
            <Button variant="primary" icon={copied ? 'check' : 'copy'} onClick={copy}>
              {copied ? 'Copied' : 'Copy Room Invite'}
            </Button>
          ) : null}
        </>
      }
    >
      <p className={v.lead}>
        {invite
          ? 'You joined someone else’s room, so you can pass on its invite: whoever you send it to joins the whole room.'
          : 'You joined someone else’s room. Ask its host for an invite to pass on; links for one project only work in rooms you host.'}
      </p>
      {invite ? <HowTheyJoin knock={false} /> : null}
    </Sheet>
  );
}
