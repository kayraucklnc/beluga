import { useEffect, useId } from 'react';
import Animated, { Easing, type SharedValue, useAnimatedProps, useDerivedValue, useFrameCallback, useReducedMotion, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';
import { advance, balls, hueDrift, metaPath, startAngles } from '../lib/metaballs';
import { scheme } from '../lib/theme';

/**
 * The voice's living blob (BLG-162): metaballs, a liquid made of five balls whose fields add up
 * (lib/metaballs.ts), so where they come close they flow into one shape and stretch a neck before
 * they part. Quiet, it's one softly wobbling drop; speaking, it swells and stretches with your
 * voice; each pause pinches a droplet off toward the words that flows back in; writing down, the
 * balls gather and circle quick. It grows from a drop when it starts.
 *
 * Lit like a liquid, not a sticker: two pastel gradients drifting into each other, a soft light that
 * stays put while the liquid moves under it, a little depth toward the far edge, a fine rim. Every
 * motion is continuous (angles integrated from their speed, springs for the voice), so nothing jumps.
 */

const AnimatedPath = Animated.createAnimatedComponent(Path);

export function Metaballs({ level, speaking, writing, pulses, size = 88 }: { readonly level: SharedValue<number>; readonly speaking: SharedValue<number>; readonly writing: boolean; readonly pulses: number; readonly size?: number }) {
  const id = useId().replace(/[^\w-]/g, '');
  const still = useReducedMotion();
  const t = useSharedValue(0);
  const angles = useSharedValue<number[]>(startAngles());
  const lv = useDerivedValue(() => withSpring(level.value, { stiffness: 140, damping: 14 }));
  const sp = useDerivedValue(() => withTiming(speaking.value, { duration: 260 }));
  const wr = useDerivedValue(() => withTiming(writing ? 1 : 0, { duration: 500, easing: Easing.inOut(Easing.cubic) }), [writing]);
  const born = useSharedValue(still ? 1 : 0);
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (!still) born.value = withSpring(1, { stiffness: 120, damping: 11 });
  }, []);
  useEffect(() => {
    if (!pulses || still) return;
    pulse.value = 0;
    pulse.value = withSequence(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.cubic) }), withTiming(0, { duration: 0 }));
  }, [pulses]);
  // Time and the satellites' angles, a step each frame (a dropped frame never makes them leap).
  useFrameCallback((f) => {
    if (still) return;
    const dt = Math.min(0.05, (f.timeSincePreviousFrame ?? 16) / 1000);
    t.value += dt;
    angles.value = advance(angles.value, dt, wr.value);
  });
  const shape = useDerivedValue(() => {
    const p = balls(t.value, angles.value, lv.value, sp.value, wr.value, pulse.value, born.value, size);
    return metaPath(p.xs, p.ys, p.rs, size, 1);
  });
  const base = useAnimatedProps(() => ({ d: shape.value }));
  const hue = useAnimatedProps(() => ({ d: shape.value, fillOpacity: 0.55 * hueDrift(t.value) }));
  const depth = useAnimatedProps(() => ({ d: shape.value }));
  const light = useAnimatedProps(() => ({ d: shape.value }));
  const rim = useAnimatedProps(() => ({ d: shape.value }));
  const dark = scheme === 'dark';
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Defs>
        <LinearGradient id={`a${id}`} x1={size * 0.2} y1={size * 0.15} x2={size * 0.85} y2={size * 0.85} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#F6C3AA" />
          <Stop offset="0.4" stopColor="#F0B3C4" />
          <Stop offset="0.72" stopColor="#C9B8F2" />
          <Stop offset="1" stopColor="#AFCDF2" />
        </LinearGradient>
        <LinearGradient id={`b${id}`} x1={size * 0.85} y1={size * 0.2} x2={size * 0.2} y2={size * 0.85} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#B9D9F3" />
          <Stop offset="0.4" stopColor="#CDBDF4" />
          <Stop offset="0.75" stopColor="#F3BCCB" />
          <Stop offset="1" stopColor="#F7CDB2" />
        </LinearGradient>
        <RadialGradient id={`d${id}`} cx={size * 0.42} cy={size * 0.4} r={size * 0.5} gradientUnits="userSpaceOnUse">
          <Stop offset="0.5" stopColor="#6E5ABE" stopOpacity={0} />
          <Stop offset="1" stopColor="#6E5ABE" stopOpacity={0.24} />
        </RadialGradient>
        <RadialGradient id={`l${id}`} cx={size * 0.36} cy={size * 0.3} r={size * 0.36} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.62} />
          <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity={0.18} />
          <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <AnimatedPath animatedProps={base} fill={`url(#a${id})`} />
      <AnimatedPath animatedProps={hue} fill={`url(#b${id})`} />
      <AnimatedPath animatedProps={depth} fill={`url(#d${id})`} />
      <AnimatedPath animatedProps={light} fill={`url(#l${id})`} />
      <AnimatedPath animatedProps={rim} fill="none" stroke={dark ? '#B7A6EE' : '#A897E2'} strokeOpacity={dark ? 0.45 : 0.32} strokeWidth={0.9} />
    </Svg>
  );
}
