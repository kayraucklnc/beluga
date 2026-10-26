import { useCallback, useEffect, useRef, useState } from 'react';
import type { PhoneMirrorStatus } from '../../../../src/ipc/client.js';
import type { DeviceView, PhoneUse } from '../../../../src/companion/protocol.js';
import type { Macro } from '../../../../src/companion/phone-macros.js';
import { Icon } from '../components/Icon.js';
import { Button, Empty, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { openSettings } from '../lib/native-routes.js';
import { sameDeep } from '../lib/stable.js';
import { H264Player } from './h264.js';
import s from './phone-view.module.css';

/**
 * "Your phone" (BLG-171): a live mirror of your paired Android phone that you can touch directly —
 * click to tap, drag to swipe, scroll to scroll — plus the hardware buttons, a line to type, and a
 * jump to ask your Mac's Claude to do something. The mirror streams from the daemon
 * (client.watchPhone): live H.264 video drawn by H264Player when the phone streams (BLG-184),
 * pictures until then; taps go back as companion.phone.act. Shown only when a phone is paired.
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
  /** Live video (BLG-184) once its first picture is drawn: the phone's screen size, for taps. */
  const [video, setVideo] = useState<{ w: number; h: number }>();
  const [status, setStatus] = useState<PhoneMirrorStatus>();
  const [typing, setTyping] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const down = useRef<{ x: number; y: number; t: number } | null>(null);

  useEffect(() => {
    // Smooth live video when this screen decodes H.264 (pictures until it flows, or instead).
    const canPlay = H264Player.supported();
    const mirror = client.watchPhone(phone.id, { fps: 6, video: canPlay });
    let player: H264Player | undefined;
    let screen = { w: 0, h: 0 };
    const offF = mirror.onFrame((f) => {
      // Pictures again (the video stalled or stopped): show them instead.
      setVideo(undefined);
      setFrame((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url: toUrl(f.b64, f.mime), w: f.w, h: f.h };
      });
    });
    const offV = mirror.onVideo((p) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      screen = { w: p.sw, h: p.sh };
      player ??= new H264Player(canvas, () => setVideo((prev) => (prev && prev.w === screen.w && prev.h === screen.h ? prev : screen)));
      player.push(p);
    });
    const offS = mirror.onStatus((srv) => setStatus(srv));
    return () => {
      offF();
      offV();
      offS();
      mirror.close();
      player?.close();
      setVideo(undefined);
      setFrame((prev) => (prev ? (URL.revokeObjectURL(prev.url), undefined) : undefined));
    };
  }, [client, phone.id]);

  /** Map a mouse point to the phone's device pixels, using what's shown and the screen's real size. */
  const toDevice = (clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const el = video ? canvasRef.current : imgRef.current;
    const size = video ?? frame;
    if (!el || !size) return undefined;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return undefined;
    const x = Math.round(((clientX - r.left) / r.width) * size.w);
    const y = Math.round(((clientY - r.top) / r.height) * size.h);
    return { x: Math.max(0, Math.min(size.w, x)), y: Math.max(0, Math.min(size.h, y)) };
  };

  const act = (op: string, args: Record<string, unknown>): Promise<unknown> => client.api.companion['phone.act'](phone.id, op as never, args);

  const onUp = (e: React.MouseEvent): void => {
    const start = down.current;
    down.current = null;
    const end = toDevice(e.clientX, e.clientY);
    if (!start || !end) return;
    const from = toDevice(start.x, start.y);
    if (!from) return;
    const far = Math.hypot(end.x - from.x, end.y - from.y) > 18;
    if (far) void act('swipe', { x1: from.x, y1: from.y, x2: end.x, y2: end.y, ms: Math.max(80, Math.min(600, Date.now() - start.t)) }).catch(() => undefined);
    else void act('tap', { x: end.x, y: end.y }).catch(() => undefined);
  };

  const onWheel = (e: React.WheelEvent): void => {
    if (Math.abs(e.deltaY) < 8) return;
    void act('scroll', { dir: e.deltaY > 0 ? 'down' : 'up' }).catch(() => undefined);
  };

  /** Type the line into the phone's field (and press its enter); kept here if it couldn't land. */
  const sendText = (enter: boolean): void => {
    if (!typing.trim()) {
      if (enter) void act('key', { key: 'enter' }).catch(() => undefined);
      return;
    }
    const text = typing;
    setTyping('');
    void act('type', { text, ...(enter ? { enter: true } : {}) }).catch(() => setTyping((now) => now || text));
  };

  const touch = {
    draggable: false,
    onMouseDown: (e: React.MouseEvent) => (down.current = { x: e.clientX, y: e.clientY, t: Date.now() }),
    onMouseUp: onUp,
    onMouseLeave: () => (down.current = null),
  };
  const route = status?.route ? ROUTE_WORDS[status.route] ?? status.route : undefined;
  const line = status?.video === 'on' && video
    ? 'Live video'
    : status?.video === 'asking'
      ? 'Tap “Start now” on your phone for smooth video'
      : status?.on
        ? `Live · ${route ?? ''}${status.note ? ` · ${status.note}` : ''}`
        : status?.error ?? 'Connecting…';
  return (
    <div className={s.page}>
      <header className={s.head}>
        <span className={s.name}>
          <Icon name="phone" size={14} /> {phone.name}
        </span>
        <span className={s.dim}>{line}</span>
        <span className={s.spacer} />
        <span className={s.levelBar}>
          {LEVELS.map((l) => (
            <button key={l.value} type="button" className={cx(s.level, (phone.control?.use ?? 'off') === l.value && s.levelOn)} onClick={() => void client.api.companion['phone.use'](phone.id, l.value)}>
              {l.label}
            </button>
          ))}
        </span>
      </header>

      <Macros />

      <div className={s.stage} onWheel={onWheel}>
        {/* The video's canvas is always there (pieces can come before the first picture), shown once it draws. */}
        <canvas ref={canvasRef} className={cx(s.screen, !video && s.hidden)} aria-label="Your phone's screen, live" {...touch} />
        {video ? null : frame ? (
          <img ref={imgRef} src={frame.url} className={s.screen} alt="Your phone's screen" {...touch} />
        ) : (
          <div className={s.waiting}>
            <span className={s.spinner} aria-hidden="true" />
            {status?.error ?? 'Waking the mirror…'}
          </div>
        )}
      </div>

      <footer className={s.controls}>
        <div className={s.keys}>
          <Button size="small" variant="quiet" onClick={() => void act('key', { key: 'back' }).catch(() => undefined)} title="Back">
            <Icon name="back" size={16} />
          </Button>
          <Button size="small" variant="quiet" onClick={() => void act('key', { key: 'home' }).catch(() => undefined)} title="Home">
            Home
          </Button>
          <Button size="small" variant="quiet" onClick={() => void act('key', { key: 'recents' }).catch(() => undefined)} title="Recent apps">
            Recents
          </Button>
        </div>
        <input
          className={s.type}
          value={typing}
          placeholder="Type on the phone…"
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') sendText(true);
          }}
        />
        <Button size="small" onClick={() => sendText(false)} disabled={!typing.trim()}>
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

/** The saved flows (BLG-175): run one, or remove it. Record new ones by asking Claude. */
function Macros() {
  const { client } = useBeluga();
  const [macros, setMacros] = useState<readonly Macro[]>([]);
  const [running, setRunning] = useState<string>();
  const load = useCallback(() => void client.api.companion['phone.macros']().then(setMacros).catch(() => undefined), [client]);
  useEffect(load, [load]);
  if (!macros.length) return null;
  return (
    <div className={s.macros}>
      <span className={s.macrosLabel}>Macros</span>
      {macros.map((m) => (
        <span key={m.name} className={s.macro}>
          <button
            type="button"
            className={s.macroRun}
            disabled={!!running}
            onClick={async () => {
              setRunning(m.name);
              await client.api.companion['phone.macroRun'](m.name).catch(() => undefined);
              setRunning(undefined);
            }}
          >
            {running === m.name ? 'Running…' : m.name}
          </button>
          <button type="button" className={s.macroX} title="Delete" onClick={() => void client.api.companion['phone.macroDelete'](m.name).then(load)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

function toUrl(b64: string, mime: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
