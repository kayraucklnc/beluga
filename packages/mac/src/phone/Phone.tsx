import * as Popover from '@radix-ui/react-popover';
import { useState } from 'react';
import type { DeviceView } from '../../../../src/companion/protocol.js';
import { Icon } from '../components/Icon.js';
import { Button, cx } from '../components/ui.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { useClock } from '../lib/window-active.js';
import { QrCode } from '../network/QrCode.js';
import { errorText, quietly } from '../network/use-net.js';
import { Group, Row } from '../dialogs/settings-controls.js';
import { pathLabel } from '../../../../src/companion/diagnose.js';
import { leftText, markOf, seenText } from './phone-model.js';
import p from '../dialogs/native/person.module.css';
import s from './phone.module.css';

/**
 * Your phone on the Mac (docs/companion.md, "On the Mac"): a small mark in the sidebar's footer
 * while a phone is paired (lit with a dot while it's linked, outlined while it's away), its
 * popover with the phones and Pair a Phone…, and Settings › Phone with the same.
 */

/** A clock for "last seen 12 min ago" (it rests while you look away). */
const useMinute = (): number => useClock(true, 30_000);

const useDevices = (): readonly DeviceView[] => useApp((st) => st.companion.devices, sameDeep);
const usePairing = () => useApp((st) => st.companion.pairing, sameDeep);

/** The phones you paired: each with how it is now, and Remove. */
function DeviceList({ now }: { now: number }) {
  const { client } = useBeluga();
  const devices = useDevices();
  if (!devices.length) return <div className={s.empty}>No phone yet. Pair one to see what Claude is doing, answer and ask from anywhere.</div>;
  return (
    <ul className={s.devices} aria-label="Your phones">
      {devices.map((d) => (
        <li key={d.id} className={s.device}>
          <span className={cx(s.deviceMark, d.linked && s.lit)} aria-hidden="true">
            <Icon name="phone" size={16} />
          </span>
          <span className={s.deviceText}>
            <span className={s.deviceName}>{d.name}</span>
            <span className={s.dim}>
              {d.platform === 'ios' ? 'iPhone' : 'Android'}
              {d.app ? ` · app ${d.app}` : ''} · {seenText(d, now)}
            </span>
            {d.path ? (
              <span className={s.path} title={d.note}>
                {d.path === 'relay' ? (d.note ?? pathLabel(d.path)) : pathLabel(d.path)}
              </span>
            ) : null}
          </span>
          <Button size="small" variant="quiet" onClick={() => void client.api.companion['devices.remove'](d.id)}>
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Pair a Phone…: the QR and the code while a pairing is open, and "Pair this phone?" once one is waiting. */
function Pairing({ now }: { now: number }) {
  const { client } = useBeluga();
  const pairing = usePairing();
  const devices = useDevices();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const start = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await quietly(client, client.api.companion['pair.start']());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  if (!pairing) {
    return (
      <div className={s.pairRow}>
        {error ? <div className={s.error}>{error}</div> : null}
        <Button variant={devices.length ? 'plain' : 'primary'} icon="phone" disabled={busy || devices.length >= 4} onClick={() => void start()}>
          {busy ? 'Opening…' : 'Pair a Phone…'}
        </Button>
      </div>
    );
  }
  if (pairing.waiting) {
    return (
      <div className={s.pairing}>
        <div className={s.pairTitle}>Pair “{pairing.waiting.name}”?</div>
        <div className={s.fingerprint} aria-label={`Fingerprint ${pairing.waiting.fingerprint}`}>
          {pairing.waiting.fingerprint}
        </div>
        <div className={s.dim}>Your phone shows the same four pictures. If it doesn’t, don’t pair.</div>
        <div className={s.buttons}>
          <Button onClick={() => void client.api.companion['pair.cancel']()}>Don’t Pair</Button>
          <Button variant="primary" onClick={() => void client.api.companion['pair.approve']()}>
            Pair
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className={s.pairing}>
      <div className={s.qr}>
        <QrCode text={pairing.link} size={148} label="Scan with the Beluga app on your phone" />
      </div>
      <div className={s.dim}>Scan this with the Beluga app on your phone, or type the code:</div>
      <div className={s.code}>{pairing.code}</div>
      <div className={s.dim}>Works once, for {leftText(pairing.expiresAt, now)}.</div>
      <div className={s.buttons}>
        <Button onClick={() => void client.api.companion['pair.cancel']()}>Cancel</Button>
      </div>
    </div>
  );
}

/** The sidebar footer's phone mark (only once a phone is paired, or while pairing one). */
export function PhoneMark() {
  const devices = useDevices();
  const pairing = usePairing();
  const now = useMinute();
  if (!devices.length && !pairing) return null;
  const { lit, title } = markOf(devices, now);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={cx(s.mark, lit && s.lit)} title={title} aria-label={`Your phone: ${title}`}>
          <Icon name="phone" size={14} />
          {lit ? <span className={s.markDot} aria-hidden="true" /> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={cx(p.card, s.card)} side="top" align="end" sideOffset={8} collisionPadding={10} aria-label="Your phone">
          <div className={s.head}>Phone</div>
          <DeviceList now={now} />
          <Pairing now={now} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Settings › Phone. */
export function PhoneSettings() {
  const now = useMinute();
  return (
    <>
      <Group title="Your phones">
        <div className={s.inSettings}>
          <DeviceList now={now} />
        </div>
      </Group>
      <Group title="Pair a phone">
        <Row label="The Beluga app" detail="Your phone gets its own key, signed by your Mac: it shows what Claude is doing and lets you answer, ask and chat. It never sees code. Up to 4 phones; Remove cuts one off at once.">
          <span />
        </Row>
        <div className={s.inSettings}>
          <Pairing now={now} />
        </div>
      </Group>
    </>
  );
}
