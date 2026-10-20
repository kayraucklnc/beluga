import { type MotionValue, motion, useTransform } from 'motion/react';
import { useEffect, useRef } from 'react';
import { BANG_AT } from './finale-sound.js';
import s from './onboarding.module.css';

/**
 * The welcome's last moment, once you're done: light gathers to a point, bursts (a flash,
 * shockwaves, rays and a few hundred sparks), and the welcome tears open from the middle onto
 * the app, its edge glowing as it goes. The effects sit over the app, not inside the welcome, so
 * the sparks fly on across your Klaud as it appears.
 */

/** When each part starts (s from the click). */
export const FINALE = { bang: BANG_AT, open: BANG_AT + 0.12, openFor: 0.95, done: BANG_AT + 1.45 } as const;

type Rgb = readonly [number, number, number];
interface Palette {
  readonly sparks: readonly Rgb[];
  readonly ring: Rgb;
  readonly blend: GlobalCompositeOperation;
}
const PALETTES: Record<'light' | 'dark', Palette> = {
  dark: { sparks: [[255, 255, 255], [229, 140, 108], [246, 199, 168], [255, 236, 220]], ring: [255, 226, 208], blend: 'lighter' },
  light: { sparks: [[207, 106, 72], [229, 140, 108], [60, 60, 66], [180, 105, 63]], ring: [207, 106, 72], blend: 'source-over' },
};

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  age: number;
  size: number;
  color: Rgb;
}

const rgba = ([r, g, b]: Rgb, a: number): string => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

function burst(cx: number, cy: number, palette: Palette): Spark[] {
  return Array.from({ length: 320 }, () => {
    const angle = Math.random() * Math.PI * 2;
    // Most sparks go fast and far, a few drift: speed skewed toward the top.
    const speed = 260 + Math.random() ** 0.6 * 1500;
    return {
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.6 + Math.random() * 1.1,
      age: 0,
      size: 0.7 + Math.random() * 2.2,
      color: palette.sparks[Math.floor(Math.random() * palette.sparks.length)]!,
    };
  });
}

/** Shockwaves, rays and sparks, all on one canvas, from the bang on. */
function Burst({ theme }: { readonly theme: 'light' | 'dark' }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext('2d');
    if (!el || !g) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    el.width = w * dpr;
    el.height = h * dpr;
    g.scale(dpr, dpr);
    const cx = w / 2;
    const cy = h / 2;
    const far = Math.hypot(w, h) / 2;
    const palette = PALETTES[theme];
    const rays = Array.from({ length: 26 }, (_, i) => ({ angle: (i / 26) * Math.PI * 2 + Math.random() * 0.2, length: far * (0.45 + Math.random() * 0.6), width: 0.6 + Math.random() * 1.6 }));
    let sparks: Spark[] = [];
    const start = performance.now();
    let last = start;
    let frame = 0;
    const draw = (now: number): void => {
      const t = (now - start) / 1000 - FINALE.bang;
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      g.clearRect(0, 0, w, h);
      if (t >= 0) {
        if (!sparks.length) sparks = burst(cx, cy, palette);
        g.globalCompositeOperation = palette.blend;
        // Three shockwaves, one after another, thinning as they spread.
        for (let i = 0; i < 3; i++) {
          const k = (t - i * 0.09) / 0.95;
          if (k <= 0 || k >= 1) continue;
          g.beginPath();
          g.arc(cx, cy, easeOut(k) * far * (1.05 - i * 0.12), 0, Math.PI * 2);
          g.strokeStyle = rgba(palette.ring, (1 - k) ** 1.6 * (0.9 - i * 0.22));
          g.lineWidth = (1 - k) * (6 - i * 1.5) + 0.5;
          g.stroke();
        }
        // Rays: thin streaks of light out from the middle, there and gone.
        const rk = t / 0.6;
        if (rk < 1) {
          for (const ray of rays) {
            const len = easeOut(rk) * ray.length;
            const x2 = cx + Math.cos(ray.angle) * len;
            const y2 = cy + Math.sin(ray.angle) * len;
            const grad = g.createLinearGradient(cx, cy, x2, y2);
            grad.addColorStop(0, rgba(palette.ring, 0));
            grad.addColorStop(0.35, rgba(palette.ring, (1 - rk) * 0.75));
            grad.addColorStop(1, rgba(palette.ring, 0));
            g.strokeStyle = grad;
            g.lineWidth = ray.width;
            g.beginPath();
            g.moveTo(cx, cy);
            g.lineTo(x2, y2);
            g.stroke();
          }
        }
        // Sparks, each drawn as a short streak along its path, slowing as it goes.
        const drag = Math.exp(-dt * 2.4);
        g.lineCap = 'round';
        for (const p of sparks) {
          p.age += dt;
          if (p.age >= p.life) continue;
          const px = p.x;
          const py = p.y;
          p.vx *= drag;
          p.vy = p.vy * drag + 60 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          const fade = 1 - p.age / p.life;
          g.strokeStyle = rgba(p.color, fade);
          g.lineWidth = p.size * (0.6 + fade * 0.6);
          g.beginPath();
          g.moveTo(px - p.vx * 0.018, py - p.vy * 0.018);
          g.lineTo(p.x, p.y);
          g.stroke();
        }
      }
      if (t < 2) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <canvas ref={canvas} className={s.finaleCanvas} aria-hidden="true" />;
}

/** Everything over the app while the welcome opens: the gathering light, the flash, the burst, the opening's rim. */
export function Finale({ theme, hole }: { readonly theme: 'light' | 'dark'; readonly hole: MotionValue<number> }) {
  const rim = useTransform(hole, (r) => r * 2);
  const rimOpacity = useTransform(hole, [0, 40, 600, 1400], [0, 1, 0.8, 0]);
  return (
    <div className={s.finale} data-look={theme} aria-hidden="true">
      {/* The light gathers to a point (the breath in), then pops. */}
      <motion.span
        className={s.core}
        initial={{ scale: 0.2, opacity: 0 }}
        animate={{ scale: [0.2, 1, 0.6, 5], opacity: [0, 1, 1, 0] }}
        transition={{ duration: FINALE.bang + 0.35, times: [0, 0.55, FINALE.bang / (FINALE.bang + 0.35), 1], ease: ['easeOut', 'easeIn', 'easeOut'] }}
      />
      <motion.span className={s.flash} initial={{ opacity: 0, scale: 0.4 }} animate={{ opacity: [0, 0.95, 0], scale: [0.4, 1.4, 2.2] }} transition={{ duration: 0.75, delay: FINALE.bang, times: [0, 0.12, 1], ease: 'easeOut' }} />
      <Burst theme={theme} />
      <motion.span className={s.rim} style={{ width: rim, height: rim, opacity: rimOpacity }} />
    </div>
  );
}
