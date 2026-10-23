import { motion } from 'motion/react';
import { useRef } from 'react';
import LightTunnel from '../components/reactbits/LightTunnel.js';
import { ExitLight, type LightAt } from './ExitLight.js';
import s from './onboarding.module.css';

/**
 * The wormhole, made from React Bits' Light Tunnel: fibres of light swirling down a tunnel,
 * comets racing along them.
 *
 * On the last step it waits behind "You're all set", slow and hypnotic, leaning toward the
 * pointer (a click sends a ring of light down it). When you go, it pulls: the comets stop, turn
 * and rush at you, the tunnel speeds up and twists as you fall in, a light grows at the far
 * end, and you come out into it. Then the light clears to your Beluga.
 *
 * Everything moves on the GPU (the tunnel's shader, eased every frame through `tune`) or as a
 * transform or opacity on the compositor, so it keeps its frame rate.
 */

/** The warp's timeline (s from the click). */
export const WORMHOLE = {
  /** The welcome's page rushes past and the tunnel is all there is. */
  enter: 0.6,
  /** The far end's light fills the screen. */
  whiteout: 3.4,
  /** The light clears to the app. */
  reveal: 1.0,
} as const;
export const WORMHOLE_TOTAL = WORMHOLE.whiteout + WORMHOLE.reveal;

const clamp = (x: number): number => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const easeIn = (x: number): number => x * x * x;
const smooth = (x: number): number => x * x * (3 - 2 * x);

/** Waiting: slow, hypnotic, the comets drifting away from you down the tunnel. */
const IDLE = { speed: 0.12, flow: -1, pulseSpeed: 1.1, pulseDensity: 0.45, pulseLength: 0.3, size: 1, glow: 1, brightness: 1, bend: 0.45, mouseStrength: 0.3 };

/** The tunnel's settings `t` seconds into the warp. */
function warp(t: number) {
  const p = clamp(t / WORMHOLE.whiteout);
  const e = easeIn(p);
  return {
    speed: lerp(IDLE.speed, 2.4, e),
    // The pull: the comets slow, stop, and turn toward you within the first half second.
    flow: lerp(-1, 1, smooth(clamp(t / 0.55))),
    pulseSpeed: lerp(IDLE.pulseSpeed, 10, e),
    pulseDensity: lerp(IDLE.pulseDensity, 1, smooth(p)),
    pulseLength: lerp(IDLE.pulseLength, 0.95, e),
    size: lerp(1, 3.2, e),
    glow: lerp(1, 2.4, p),
    brightness: lerp(1, 2.6, e),
    // The tunnel straightens and lets go of the pointer in the first moments, so its far end comes
    // to rest in the middle before the light there shows: the light is always at the end.
    bend: lerp(IDLE.bend, 0, smooth(clamp(t / 0.7))),
    mouseStrength: 0,
  };
}

interface Props {
  readonly theme: 'light' | 'dark';
  /** When the warp began (performance.now()); unset while waiting. */
  readonly since: number | undefined;
  /** It's clearing to the app. */
  readonly out: boolean;
}

/** How big and how lit the light at the end is, `p` of the way through the warp (radius as a share of the window's shorter side). */
function exitLight(p: number): { r: number; glow: number } {
  const s = (a: number, b: number): number => smooth(clamp((p - a) / (b - a)));
  return { r: 0.012 + 0.07 * s(0.3, 0.75) + 1.7 * s(0.7, 1) ** 2.4, glow: s(0.22, 0.5) };
}

export function Wormhole({ theme, since, out }: Props) {
  const at = useRef(since);
  at.current = since;
  const light = theme === 'light';
  const warping = since !== undefined;
  const lightAt = useRef<LightAt>({ x: 0, y: 0, r: 0, glow: 0 });
  // The tunnel says where its far end is each frame; the light goes there (y up in the shader).
  const follow = ({ steerX, steerY, size }: { steerX: number; steerY: number; size: number }): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = Math.min(w, h) * 0.5 * size;
    const p = at.current === undefined ? 0 : clamp((performance.now() - at.current) / 1000 / WORMHOLE.whiteout);
    const { r, glow } = exitLight(p);
    lightAt.current = { x: w / 2 + steerX * scale, y: h / 2 - steerY * scale, r: r * Math.min(w, h), glow };
  };
  return (
    <motion.div
      className={s.wormhole}
      data-look={theme}
      aria-hidden="true"
      // There at once (the welcome turns see-through on top of it, and the app must never show
      // through); the fibres themselves fade in with the tunnel's own intro.
      initial={{ opacity: 1 }}
      animate={{ opacity: out ? 0 : 1 }}
      transition={{ duration: WORMHOLE.reveal, ease: [0.4, 0, 0.2, 1] }}
    >
      <LightTunnel
        className={s.tunnel}
        lightMode={light}
        cableColor={light ? '#8a8796' : '#5b5a86'}
        pulseColor={light ? '#c4623f' : '#ffb48f'}
        tunnelColor={light ? '#b9b6c9' : '#4b4aa0'}
        tunnelOpacity={light ? 0.25 : 0.35}
        cableCount={64}
        thickness={0.3}
        rimWidth={0.35}
        waviness={0.35}
        sway={0.5}
        fadeFar={2.4}
        colorVariance
        grain
        grainIntensity={0.04}
        clickSurge
        dpr={1.25}
        tune={() => (at.current === undefined ? IDLE : warp((performance.now() - at.current) / 1000))}
        onFrame={follow}
      />
      {/* The way out: a light at the far end, alive, that grows until it's everything. */}
      {warping ? <ExitLight at={lightAt} /> : null}
      <motion.span className={s.whiteout} initial={{ opacity: 0 }} animate={{ opacity: warping ? 1 : 0 }} transition={warping ? { duration: 0.55, delay: WORMHOLE.whiteout - 0.55, ease: 'easeIn' } : { duration: 0 }} />
    </motion.div>
  );
}
