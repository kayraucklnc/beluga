import { useCallback, useEffect, useRef, useState } from 'react';
import type { PhoneMirrorStatus, PhoneTouchData } from '../../../../src/ipc/client.js';
import type { DeviceView, PhoneUse } from '../../../../src/companion/protocol.js';
import type { Macro } from '../../../../src/companion/phone-macros.js';
import { Icon } from '../components/Icon.js';
import { Button, Empty, IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { openSettings } from '../lib/native-routes.js';
import { showPanelTab } from '../lib/panel.js';
import { sameDeep } from '../lib/stable.js';
import { H264Player } from './h264.js';
import { touchCaption } from './phone-model.js';
import s from './phone-view.module.css';

/**
 * "Your phone" (BLG-171): a live mirror of your paired Android phone that you can touch directly —
 * click to tap, drag to swipe, scroll to scroll — plus the hardware buttons, a line to type, and a
 * jump to ask your Mac's Claude to do something. The mirror streams from the daemon
 * (client.watchPhone): live H.264 video drawn by H264Player when the phone streams (BLG-184),
 * pictures until then; taps go back as companion.phone.act. Shown only when a phone is paired.
 * The same mirror is the right panel's Phone tab, beside any chat (BLG-186), and both show what
 * Claude does on the phone as it does it.
 */

const LEVELS: ReadonlyArray<{ value: PhoneUse; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'ask', label: 'Ask' },
  { value: 'use', label: 'Use' },
  { value: 'full', label: 'Full' },
];
const ROUTE_WORDS: Record<string, string> = { usb: 'USB', wifi: 'Wi‑Fi', link: 'through Beluga', accessibility: 'Accessibility' };

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

/** The right panel's Phone tab (BLG-186): the same live mirror beside Your Mac's chat, to watch what Claude does on it (taps still land; the keys and typing are on the full size page). */
export function PhonePanel() {
  const phone = useAndroidPhone();
  if (!phone) return <Empty icon="phone" title="No phone" detail="Pair an Android phone to see it here." />;
  if ((phone.control?.use ?? 'off') === 'off') return <SetUp phone={phone} />;
  return <Mirror key={phone.id} phone={phone} compact />;
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

/** What Claude did on the phone, drawn on the mirror for a moment (BLG-186). */
interface Shown extends PhoneTouchData {
  readonly id: number;
}
const TOUCH_MS = 900;
const CAPTION_MS = 1800;

/**
 * The live mirror. Full size on the Phone page; `compact` in the right panel's Phone tab, beside
 * the chat (BLG-186): no name or macros there, the keys and the type line fitted to its width,
 * and a way to the full page.
 */
function Mirror({ phone, compact = false }: { phone: DeviceView; compact?: boolean }) {
  const { client } = useBeluga();
  const actions = useActions();
  const [frame, setFrame] = useState<{ url: string; w: number; h: number }>();
  /** Live video (BLG-184) once its first picture is drawn: the phone's screen size, for taps. */
  const [video, setVideo] = useState<{ w: number; h: number }>();
  const [status, setStatus] = useState<PhoneMirrorStatus>();
  const [typing, setTyping] = useState('');
  const [touches, setTouches] = useState<readonly Shown[]>([]);
  const [caption, setCaption] = useState<{ id: number; text: string }>();
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const down = useRef<{ x: number; y: number; t: number } | null>(null);

  // Smooth live video when this screen decodes H.264 (pictures until it flows, or instead).
  const [canPlay, setCanPlay] = useState<boolean>();
  useEffect(() => void H264Player.supported().then(setCanPlay), []);

  useEffect(() => {
    if (canPlay === undefined) return;
    const mirror = client.watchPhone(phone.id, { fps: 6, video: canPlay });
    let player: H264Player | undefined;
    let screen = { w: 0, h: 0 };
    let seq = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, run: () => void): void => {
      const t = setTimeout(() => {
        timers.delete(t);
        run();
      }, ms);
      timers.add(t);
    };
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
    // What Claude does meanwhile: a ripple where it taps, a trail where it swipes, and a word.
    const offT = mirror.onTouch((t) => {
      const id = ++seq;
      if (t.x !== undefined && t.y !== undefined) {
        setTouches((now) => [...now.slice(-4), { ...t, id }]);
        later(TOUCH_MS, () => setTouches((now) => now.filter((x) => x.id !== id)));
      }
      setCaption({ id, text: touchCaption(t) });
      later(CAPTION_MS, () => setCaption((now) => (now?.id === id ? undefined : now)));
    });
    const offS = mirror.onStatus((srv) => setStatus(srv));
    return () => {
      offF();
      offV();
      offT();
      offS();
      mirror.close();
      player?.close();
      for (const t of timers) clearTimeout(t);
      setVideo(undefined);
      setTouches([]);
      setCaption(undefined);
      setFrame((prev) => (prev ? (URL.revokeObjectURL(prev.url), undefined) : undefined));
    };
  }, [client, phone.id, canPlay]);

  /** The screen's size in its own pixels (taps and Claude's touches are in those). */
  const size = video ?? frame;

  /** Map a mouse point to the phone's device pixels, using where the screen is drawn. */
  const toDevice = (clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const el = boxRef.current;
    if (!el || !size) return undefined;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return undefined;
    const x = Math.round(((clientX - r.left) / r.width) * size.w);
    const y = Math.round(((clientY - r.top) / r.height) * size.h);
    return { x: Math.max(0, Math.min(size.w, x)), y: Math.max(0, Math.min(size.h, y)) };
  };

  const act = (op: string, args: Record<string, unknown>): Promise<unknown> => client.api.companion['phone.act'](phone.id, op as never, args);
  const press = (key: string) => (): void => void act('key', { key }).catch(() => undefined);

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

  /** Ask Claude with the phone beside the chat: Your Mac, its Phone tab open. */
  const askClaude = (): void => {
    showPanelTab({ view: { kind: 'assistant' }, projects: client.store.getState().projects }, 'phone');
    actions.run({ type: 'view', view: { kind: 'assistant' } });
  };

  const touch = {
    draggable: false,
    onMouseDown: (e: React.MouseEvent) => (down.current = { x: e.clientX, y: e.clientY, t: Date.now() }),
    onMouseUp: onUp,
    onMouseLeave: () => (down.current = null),
  };
  const route = status?.route ? ROUTE_WORDS[status.route] ?? status.route : undefined;
  const line = status?.video === 'on' && video
    ? `Live video${route ? ` · ${route}` : ''}`
    : status?.video === 'asking'
      ? 'Tap “Start now” on your phone for smooth video'
      : status?.on
        ? `Live · ${route ?? ''}${status.note ? ` · ${status.note}` : ''}`
        : status?.error ?? 'Connecting…';
  return (
    <div className={cx(s.page, compact && s.compact)}>
      <header className={s.head}>
        {compact ? null : (
          <span className={s.name}>
            <Icon name="phone" size={14} /> {phone.name}
          </span>
        )}
        <span className={cx(s.dim, s.line)} title={line}>
          {line}
        </span>
        <span className={s.spacer} />
        <span className={s.levelBar}>
          {LEVELS.map((l) => (
            <button key={l.value} type="button" className={cx(s.level, (phone.control?.use ?? 'off') === l.value && s.levelOn)} onClick={() => void client.api.companion['phone.use'](phone.id, l.value)}>
              {l.label}
            </button>
          ))}
        </span>
        {compact ? <IconButton icon="expand" label="Open Your Phone" onClick={() => actions.run({ type: 'view', view: { kind: 'phone' } })} /> : null}
      </header>

      {compact ? null : <Macros />}

      <div className={s.stage} onWheel={onWheel}>
        <div className={s.fit}>
          {/* The video's canvas is always there (pieces can come before the first picture), shown once it draws. */}
          <div ref={boxRef} className={cx(s.screenBox, !size && s.hidden)} style={size ? ({ '--ratio': size.w / size.h } as React.CSSProperties) : undefined}>
            <canvas ref={canvasRef} className={cx(s.screen, !video && s.hidden)} aria-label="Your phone's screen, live" {...touch} />
            {video || !frame ? null : <img src={frame.url} className={s.screen} alt="Your phone's screen" {...touch} />}
            {size ? <Touches touches={touches} size={size} /> : null}
            {caption ? (
              <span key={caption.id} className={s.caption}>
                {caption.text}
              </span>
            ) : null}
          </div>
          {size ? null : (
            <div className={s.waiting}>
              <span className={s.spinner} aria-hidden="true" />
              {status?.error ?? 'Waking the mirror…'}
            </div>
          )}
        </div>
      </div>

      {/* Beside the chat the phone is to watch Claude on (BLG-196); driving it yourself is the full size page. */}
      {compact ? null : (
        <footer className={s.controls}>
          <div className={s.keys}>
            <Button size="small" variant="quiet" onClick={press('back')} title="Back">
              <Icon name="back" size={16} />
            </Button>
            <Button size="small" variant="quiet" onClick={press('home')} title="Home">
              Home
            </Button>
            <Button size="small" variant="quiet" onClick={press('recents')} title="Recent apps">
              Recents
            </Button>
          </div>
          <input
            className={s.type}
            value={typing}
            placeholder={compact ? 'Type on the phone, ⏎ to send' : 'Type on the phone…'}
            onChange={(e) => setTyping(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendText(true);
            }}
          />
          {compact ? null : (
            <>
              <Button size="small" onClick={() => sendText(false)} disabled={!typing.trim()}>
                Send
              </Button>
              <span className={s.spacer} />
              <Button size="small" variant="quiet" onClick={askClaude} title="Ask your Mac's Claude, with the phone beside the chat">
                <Icon name="claude" size={14} /> Ask Claude
              </Button>
            </>
          )}
        </footer>
      )}
    </div>
  );
}

/** Claude's touches on the screen: a ripple where it tapped, a trail along a swipe (in the screen's own pixels). */
function Touches({ touches, size }: { touches: readonly Shown[]; size: { w: number; h: number } }) {
  const r = size.w / 16;
  return (
    <svg className={s.touches} viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none" aria-hidden="true">
      {touches.map((t) =>
        t.op === 'swipe' && t.x2 !== undefined && t.y2 !== undefined ? (
          <g key={t.id}>
            <line className={s.trail} x1={t.x} y1={t.y} x2={t.x2} y2={t.y2} strokeWidth={size.w / 60} />
            <circle className={s.ripple} cx={t.x2} cy={t.y2} r={r * 0.7} strokeWidth={size.w / 200} />
          </g>
        ) : (
          <circle key={t.id} className={s.ripple} cx={t.x} cy={t.y} r={r} strokeWidth={size.w / 200} />
        ),
      )}
    </svg>
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
