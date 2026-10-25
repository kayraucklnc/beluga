import { useEffect, useRef, useState } from 'react';
import type { DeviceView, PhoneUse } from '../../../../src/companion/protocol.js';
import { Icon } from '../components/Icon.js';
import { Button, Empty, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { openSettings } from '../lib/native-routes.js';
import { sameDeep } from '../lib/stable.js';
import s from './phone-view.module.css';

/**
 * "Your phone" (BLG-171): a live mirror of your paired Android phone that you can touch directly —
 * click to tap, drag to swipe, scroll to scroll — plus the hardware buttons, a line to type, and a
 * jump to ask your Mac's Claude to do something. The mirror streams frames from the daemon
 * (client.watchPhone); taps go back as companion.phone.act. Shown only when a phone is paired.
 */

const LEVELS: ReadonlyArray<{ value: PhoneUse; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'ask', label: 'Ask' },
  { value: 'use', label: 'Use' },
  { value: 'full', label: 'Full' },
];
const ROUTE_WORDS: Record<string, string> = { usb: 'USB', wifi: 'Wi‑Fi debugging', link: 'Wi‑Fi debugging', accessibility: 'Accessibility' };

function useAndroidPhone(): DeviceView | undefined {
  return useApp((st) => {
    const android = st.companion.devices.filter((d) => d.platform !== 'ios');
    return android.find((d) => d.control && d.control.routes.length > 0) ?? android[0];
  }, sameDeep);
}

export function PhoneView() {
  const phone = useAndroidPhone();
  if (!phone) return <Empty icon="phone" title="No phone" detail="Pair a phone to see it here." />;
  const use = phone.control?.use ?? 'off';
  if (use === 'off') return <SetUp phone={phone} />;
  return <Mirror key={phone.id} phone={phone} />;
}

/** Before Claude may use it: pick a level right here, or open Settings. */
function SetUp({ phone }: { phone: DeviceView }) {
  const { client, ui } = useBeluga();
  return (
    <div className={s.setup}>
      <Empty
        icon="phone"
        title={`Let Claude use ${phone.name}`}
        detail="Pick how freely Claude can act on this phone. You can always change it in Settings › Phone, and Stop it from the phone any time."
        action={
          <div className={s.levels}>
            {LEVELS.filter((l) => l.value !== 'off').map((l) => (
              <Button key={l.value} onClick={() => void client.api.companion['phone.use'](phone.id, l.value)}>
                {l.label === 'Ask' ? 'Ask each time' : l.label === 'Use' ? 'Use' : 'Full (shell too)'}
              </Button>
            ))}
            <Button variant="quiet" onClick={() => openSettings(ui, 'phone')}>
              Open Settings
            </Button>
          </div>
        }
      />
      {phone.control?.note ? <div className={s.note}>{phone.control.note}</div> : null}
    </div>
  );
}

function Mirror({ phone }: { phone: DeviceView }) {
  const { client } = useBeluga();
  const actions = useActions();
  const [frame, setFrame] = useState<{ url: string; w: number; h: number }>();
  const [status, setStatus] = useState<{ on: boolean; route?: string; error?: string }>();
  const [typing, setTyping] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const down = useRef<{ x: number; y: number; t: number } | null>(null);

  useEffect(() => {
    const mirror = client.watchPhone(phone.id, { fps: 6 });
    const offF = mirror.onFrame((f) => setFrame((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { url: toUrl(f.b64, f.mime), w: f.w, h: f.h };
    }));
    const offS = mirror.onStatus((srv) => setStatus(srv));
    return () => {
      offF();
      offS();
      mirror.close();
      setFrame((prev) => (prev ? (URL.revokeObjectURL(prev.url), undefined) : undefined));
    };
  }, [client, phone.id]);

  /** Map a mouse point to the phone's device pixels, using the frame's real size. */
  const toDevice = (clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const img = imgRef.current;
    if (!img || !frame) return undefined;
    const r = img.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return undefined;
    const x = Math.round(((clientX - r.left) / r.width) * frame.w);
    const y = Math.round(((clientY - r.top) / r.height) * frame.h);
    return { x: Math.max(0, Math.min(frame.w, x)), y: Math.max(0, Math.min(frame.h, y)) };
  };

  const act = (op: string, args: Record<string, unknown>): void => void client.api.companion['phone.act'](phone.id, op as never, args).catch(() => undefined);

  const onUp = (e: React.MouseEvent): void => {
    const start = down.current;
    down.current = null;
    const end = toDevice(e.clientX, e.clientY);
    if (!start || !end) return;
    const from = toDevice(start.x, start.y);
    if (!from) return;
    const far = Math.hypot(end.x - from.x, end.y - from.y) > 18;
    if (far) act('swipe', { x1: from.x, y1: from.y, x2: end.x, y2: end.y, ms: Math.max(80, Math.min(600, Date.now() - start.t)) });
    else act('tap', { x: end.x, y: end.y });
  };

  const onWheel = (e: React.WheelEvent): void => {
    if (Math.abs(e.deltaY) < 8) return;
    act('scroll', { dir: e.deltaY > 0 ? 'down' : 'up' });
  };

  const sendText = (): void => {
    if (!typing.trim()) return;
    act('type', { text: typing });
    setTyping('');
  };

  const route = status?.route ? ROUTE_WORDS[status.route] ?? status.route : undefined;
  return (
    <div className={s.page}>
      <header className={s.head}>
        <span className={s.name}>
          <Icon name="phone" size={14} /> {phone.name}
        </span>
        <span className={s.dim}>{status?.on ? `Live · ${route ?? ''}` : status?.error ? status.error : 'Connecting…'}</span>
        <span className={s.spacer} />
        <span className={s.levelBar}>
          {LEVELS.map((l) => (
            <button key={l.value} type="button" className={cx(s.level, (phone.control?.use ?? 'off') === l.value && s.levelOn)} onClick={() => void client.api.companion['phone.use'](phone.id, l.value)}>
              {l.label}
            </button>
          ))}
        </span>
      </header>

      <div className={s.stage} onWheel={onWheel}>
        {frame ? (
          <img
            ref={imgRef}
            src={frame.url}
            className={s.screen}
            alt="Your phone's screen"
            draggable={false}
            onMouseDown={(e) => (down.current = { x: e.clientX, y: e.clientY, t: Date.now() })}
            onMouseUp={onUp}
            onMouseLeave={() => (down.current = null)}
          />
        ) : (
          <div className={s.waiting}>
            <span className={s.spinner} aria-hidden="true" />
            {status?.error ?? 'Waking the mirror…'}
          </div>
        )}
      </div>

      <footer className={s.controls}>
        <div className={s.keys}>
          <Button size="small" variant="quiet" onClick={() => act('key', { key: 'back' })} title="Back">
            <Icon name="back" size={16} />
          </Button>
          <Button size="small" variant="quiet" onClick={() => act('key', { key: 'home' })} title="Home">
            Home
          </Button>
          <Button size="small" variant="quiet" onClick={() => act('key', { key: 'recents' })} title="Recent apps">
            Recents
          </Button>
        </div>
        <input
          className={s.type}
          value={typing}
          placeholder="Type on the phone…"
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              sendText();
              act('key', { key: 'enter' });
            }
          }}
        />
        <Button size="small" onClick={sendText} disabled={!typing.trim()}>
          Send
        </Button>
        <span className={s.spacer} />
        <Button size="small" variant="quiet" onClick={() => actions.run({ type: 'view', view: { kind: 'assistant' } })} title="Ask your Mac's Claude">
          <Icon name="claude" size={14} /> Ask Claude
        </Button>
      </footer>
    </div>
  );
}

function toUrl(b64: string, mime: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
