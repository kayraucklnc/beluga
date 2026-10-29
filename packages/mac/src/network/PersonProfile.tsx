import * as Popover from '@radix-ui/react-popover';
import { type ReactNode, useState } from 'react';
import { TRUST_INFO, trustOf } from '@beluga/core/trust.js';
import type { PersonView } from '@beluga/net/mesh/views.js';
import { ZoomAvatar } from '../components/ZoomAvatar.js';
import { cx } from '../components/ui.js';
import { openPerson } from '../dialogs/native/PersonPopover.js';
import { Action, AskMeFor } from '../dialogs/native/PersonCards.js';
import { Tag } from '../dialogs/native/parts.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { PresenceDot } from './Avatars.js';
import { belugaLine, presenceLine, shownState } from './net-model.js';
import { openDm, openFriendCard } from './use-net.js';
import p from '../dialogs/native/person.module.css';

/** Someone you know on the network (a friend, or someone in one of your groups), by their id. */
function usePerson(peerId: string): { person?: PersonView; friend: boolean } {
  return useApp((st) => {
    const friend = st.network.friends.find((f) => f.peerId === peerId);
    if (friend) return { person: friend, friend: true };
    for (const g of st.network.groups) {
      const m = g.members.find((x) => x.peerId === peerId && !x.self);
      if (m) return { person: m, friend: false };
    }
    return { friend: false };
  }, sameDeep);
}

/**
 * A person's name or avatar that opens their profile: their room card when they're in your room
 * (what you do together there), else their profile from the network (who they are, their status,
 * what they're happy to be asked for, how much you trust them). Nobody known: plain, not a button.
 */
export function PersonButton({ peerId, name, className, children }: { peerId: string; name: string; className?: string; children: ReactNode }) {
  const { ui } = useBeluga();
  const room = useApp((st) => st.peers.findIndex((x) => x.peerId === peerId && x.peerId !== st.selfId));
  const { person, friend } = usePerson(peerId);
  const [open, setOpen] = useState(false);
  if (room < 0 && !person) return <>{children}</>;
  const button = (
    <button
      type="button"
      className={cx(p.personButton, className)}
      aria-label={`${name}’s profile`}
      onClick={(e) => {
        e.stopPropagation();
        if (room >= 0) openPerson(ui, room, e.currentTarget);
        else setOpen((v) => !v);
      }}
    >
      {children}
    </button>
  );
  if (room >= 0 || !person) return button;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>{button}</Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className={p.card}
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          aria-label={name}
          // React passes clicks in a portal on up its tree: keep them from the row it sits in (a friend row opens their chat).
          onClick={(e) => e.stopPropagation()}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <Popover.Arrow className={p.arrow} width={14} height={7} />
          <ProfileCard person={person} friend={friend} close={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Someone on the network as a card: picture (click to see it large), status, their note, trust. */
function ProfileCard({ person, friend, close }: { person: PersonView; friend: boolean; close: () => void }) {
  const { client } = useBeluga();
  const trust = useApp((st) => trustOf(st, person.peerId));
  const state = shownState(person);
  return (
    <>
      <div className={p.head}>
        <ZoomAvatar name={person.name} id={person.peerId} size={56} />
        <div className={p.who}>
          <div className={p.name}>{person.name}</div>
          <div className={p.tags}>{friend ? <Tag tone="accent">Friend</Tag> : <Tag tone="muted">In your group</Tag>}</div>
          <div className={cx(p.line, p.presence)}>
            <PresenceDot state={state} size={8} />
            {presenceLine(person)}
          </div>
          {person.beluga || person.update ? <div className={p.line}>Beluga {belugaLine(person)}</div> : null}
        </div>
      </div>
      {friend ? (
        <div className={p.actions}>
          <Action
            icon="chat"
            label="Message"
            onClick={() => {
              close();
              openDm(client, person.peerId);
            }}
          />
        </div>
      ) : null}
      <AskMeFor peerId={person.peerId} name={person.name} />
      <div className={p.block}>
        <div className={p.blockLabel}>Trust</div>
        <div className={p.blockDetail}>
          <strong>{TRUST_INFO[trust].label}.</strong> {TRUST_INFO[trust].detail}
        </div>
        {friend ? (
          <div className={p.blockDetail}>
            <button
              type="button"
              className={p.linkButton}
              onClick={() => {
                close();
                openFriendCard(client, person.peerId);
              }}
            >
              Change in their card…
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
