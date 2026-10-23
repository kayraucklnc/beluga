import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { useEffect, useState } from 'react';
import type { Presence, PresenceState } from '@beluga/net/mesh/views.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useBeluga } from '../lib/beluga.js';
import { PersonAvatar, PresenceDot } from './Avatars.js';
import { CHOICE_LABEL, DURATIONS, type Duration, presenceFor, selfLine } from './net-model.js';
import { closeNet } from './net-sheets.js';
import { useNetwork } from './use-net.js';
import sh from '../dialogs/native/sharing.module.css';
import s from './network.module.css';

const STATES: ReadonlyArray<{ state: PresenceState; hint: string }> = [
  { state: 'online', hint: '' },
  { state: 'away', hint: '' },
  { state: 'dnd', hint: 'Silences notifications' },
  { state: 'offline', hint: 'Still get messages' },
];

/** Which duration a status's end time matches (roughly), so the choice shows ticked. */
function durationOf(p: Presence, now = Date.now()): Duration {
  if (!p.until) return 'forever';
  return p.until - now <= 61 * 60_000 ? 'hour' : 'tomorrow';
}

/** Send a status (the core keeps it, tells your friends, and turns it back to Online when it ends). */
export function useSetPresence(): (p: Presence) => void {
  const { client } = useBeluga();
  return (p) => void client.api.network['presence.set'](p);
}

/**
 * Your status: a note, Online / Away / Do Not Disturb / Appear Offline, and for how long. Picking
 * one applies it at once (like the menu bar's); the note is saved on Return or when you leave it.
 */
export function StatusPanel({ onDone }: { onDone?: () => void }) {
  const net = useNetwork();
  const set = useSetPresence();
  const self = net.self;
  const presence = self?.presence ?? { state: 'online' as const };
  const [note, setNote] = useState(presence.note ?? '');
  const [duration, setDuration] = useState<Duration>(durationOf(presence));
  useEffect(() => setNote(presence.note ?? ''), [presence.note]);
  if (!self) return null;
  const apply = (state: PresenceState, opts: { note?: string; duration?: Duration } = {}): void =>
    set(presenceFor(state, { note: opts.note ?? note, duration: opts.duration ?? duration }));
  const saveNote = (): void => {
    if ((presence.note ?? '') !== note.trim()) apply(presence.state, { note });
  };
  return (
    <div>
      <div className={s.statusHead}>
        <PersonAvatar name={self.name} id={self.peerId} state={presence.state} size={34} />
        <div>
          <div className={s.statusName}>{self.name}</div>
          <div className={s.statusNow}>{selfLine(presence)}</div>
        </div>
      </div>
      <label className={s.note}>
        <Icon name="chat" size={13} />
        <input
          className={s.noteInput}
          value={note}
          maxLength={140}
          placeholder="What’s your status?"
          aria-label="Status note"
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveNote();
              onDone?.();
            }
          }}
        />
        {note ? (
          <button
            type="button"
            className={s.noteClear}
            aria-label="Clear the note"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setNote('');
              apply(presence.state, { note: '' });
            }}
          >
            <Icon name="x" size={9} />
          </button>
        ) : null}
      </label>
      <div className={s.separator} />
      <div role="radiogroup" aria-label="Status">
        {STATES.map(({ state, hint }) => (
          <button
            key={state}
            type="button"
            role="radio"
            aria-checked={presence.state === state}
            className={s.option}
            onClick={() => {
              apply(state);
              onDone?.();
            }}
          >
            <span className={s.optionCheck}>{presence.state === state ? <Icon name="check" size={12} /> : null}</span>
            <PresenceDot state={state} size={10} />
            <span className={s.optionLabel}>{CHOICE_LABEL[state]}</span>
            {hint ? <span className={s.optionHint}>{hint}</span> : null}
          </button>
        ))}
      </div>
      {presence.state !== 'online' ? (
        <>
          <div className={s.separator} />
          <div role="radiogroup" aria-label="For how long">
            {DURATIONS.map((d) => (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={duration === d.id}
                className={s.option}
                onClick={() => {
                  setDuration(d.id);
                  apply(presence.state, { duration: d.id });
                }}
              >
                <span className={s.optionCheck}>{duration === d.id ? <Icon name="check" size={12} /> : null}</span>
                <span className={s.optionLabel}>{d.label}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** You, at the bottom of the sidebar: your avatar and status; clicking changes it. */
export function SelfBar() {
  const net = useNetwork();
  const [open, setOpen] = useState(false);
  const self = net.self;
  if (!net.enabled || !self) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={s.me} aria-label={`Your status: ${selfLine(self.presence)}`}>
          <PersonAvatar name={self.name} id={self.peerId} state={self.presence.state} size={26} />
          <span className={s.meText}>
            <span className={s.meName}>{self.name}</span>
            <span className={s.meStatus}>{selfLine(self.presence)}</span>
          </span>
          <Icon name="chevronUp" size={11} className={s.meChevron} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={s.statusCard}
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={10}
          aria-label="Your status"
          // Like a menu: keys go to the card, the note field waits to be clicked.
          onOpenAutoFocus={(e) => (e.preventDefault(), (e.currentTarget as HTMLElement | null)?.focus())}
        >
          <StatusPanel onDone={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The same choices in a sheet of its own (the menu bar's Set a Status…). */
export function StatusSheet() {
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : closeNet())}>
      <Dialog.Portal>
        <Dialog.Overlay className={sh.overlay} />
        <Dialog.Content className={cx(s.statusCard)} style={{ position: 'fixed', top: '14vh', left: '50%', translate: '-50% 0' }} aria-describedby={undefined}>
          <Dialog.Title className="visually-hidden">Your status</Dialog.Title>
          <StatusPanel onDone={closeNet} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
