import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { type ReactNode, useState } from 'react';
import type { PeerInfo } from '@klaud/protocol.js';
import { useApp } from '../../lib/klaud.js';
import type { UiStore } from '../../lib/klaud.js';
import type { NativeMenuProps } from './index.js';
import { Alert } from './parts.js';
import { RunCommandSheet } from './PeerSheets.js';
import { AccountCard, FriendCard, GuestCard } from './PersonCards.js';
import p from './person.module.css';

// The row (or avatar) that opened the card, so it shows beside it.
let lastAnchor: HTMLElement | null = null;

/**
 * Open someone's card next to `anchor` (a row in People, an avatar…); without one it shows in
 * the middle of the window. Clicking the same row again closes it.
 */
export function openPerson(ui: UiStore, index: number, anchor?: HTMLElement | null): void {
  const open = ui.get().menu?.menu;
  if (open?.kind === 'person' && open.index === index && anchor && anchor === lastAnchor) {
    lastAnchor = null;
    return ui.patch({ menu: undefined });
  }
  lastAnchor = anchor ?? null;
  ui.openMenu({ kind: 'person', index });
}

export interface Confirm {
  readonly title: string;
  readonly message: string;
  readonly confirm: string;
  readonly run: () => void;
}

/** A person, as a card: who they are, how much you trust them, and what you can do together. */
export function PersonPopover({ menu, close }: NativeMenuProps<'person'>) {
  const peer = useApp((st) => st.peers[menu.index]);
  const selfId = useApp((st) => st.selfId);
  const guest = useApp((st) => (peer ? st.guests[peer.peerId] : undefined));
  const [asking, setAsking] = useState<Confirm>();
  const [running, setRunning] = useState(false);
  if (!peer) return null;
  if (running) return <RunCommandSheet peer={peer} close={close} />;
  if (asking) {
    return (
      <Alert
        title={asking.title}
        message={asking.message}
        confirm={asking.confirm}
        onCancel={() => setAsking(undefined)}
        onConfirm={() => {
          setAsking(undefined);
          asking.run();
        }}
      />
    );
  }
  const card = peer.peerId === selfId ? <AccountCard peer={peer} menu={menu} close={close} confirm={setAsking} /> : guest ? <GuestCard peer={peer} guest={guest} close={close} confirm={setAsking} /> : <FriendCard peer={peer} menu={menu} close={close} confirm={setAsking} onRun={() => setRunning(true)} />;
  return <Frame peer={peer} close={close}>{card}</Frame>;
}

/** Beside the row it came from, or a centred card when there's none (the palette). */
function Frame({ peer, close, children }: { peer: PeerInfo; close: () => void; children: ReactNode }) {
  const row = document.querySelector<HTMLElement>(`[data-person-row="${CSS.escape(peer.peerId)}"]`);
  const anchor = lastAnchor?.isConnected ? lastAnchor : row?.offsetParent ? row : null;
  if (!anchor) {
    return (
      <Dialog.Root open onOpenChange={(v) => (v ? undefined : close())}>
        <Dialog.Portal>
          <Dialog.Overlay className={p.overlay} />
          <Dialog.Content className={`${p.card} ${p.centered}`} aria-label={peer.name} aria-describedby={undefined}>
            <Dialog.Title className="visually-hidden">{peer.name}</Dialog.Title>
            {children}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
  return (
    <Popover.Root open onOpenChange={(v) => (v ? undefined : close())}>
      <Popover.Anchor virtualRef={{ current: anchor }} />
      <Popover.Portal>
        <Popover.Content
          className={p.card}
          side={anchor.closest('nav') ? 'right' : 'left'}
          align="start"
          sideOffset={10}
          collisionPadding={12}
          aria-label={peer.name}
          // Keys go to the card (Tab reaches its buttons), without a ring on the first one.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          // A click on the row it came from toggles it (the row closes it), rather than closing and reopening.
          onPointerDownOutside={(e) => {
            if (anchor.contains(e.target as Node)) e.preventDefault();
          }}
        >
          <Popover.Arrow className={p.arrow} width={14} height={7} />
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
