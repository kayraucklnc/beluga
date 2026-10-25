import { useEffect } from 'react';
import Animated, { Easing, type SharedValue, useAnimatedProps, useDerivedValue, useFrameCallback, useReducedMotion, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { balls, metaPath, sheenPath } from '../lib/metaballs';

/**
 * The voice's living blob (BLG-162): metaballs, a liquid made of five balls whose fields add up, so
 * where they come close they flow into one shape and stretch a neck before they part. Quiet, it
 * settles into one softly wobbling drop; speaking, the balls swell and push out with your voice;
 * each pause buds a droplet off toward the words, which flows back in; writing down, they circle
 * close and quick. Drawn on the UI thread each frame: the field on a grid, its outline traced
 * (marching squares) and smoothed into one path. Pastel, a gradient, no glow.
 */

const AnimatedPath = Animated.createAnimatedComponent(Path);

export function Metaballs({ level, speaking, writing, pulses, size = 76 }: { readonly level: SharedValue<number>; readonly speaking: SharedValue<number>; readonly writing: boolean; readonly pulses: number; readonly size?: number }) {
  const t = useSharedValue(0);
  const still = useReducedMotion();
  useFrameCallback((f) => {
    if (!still) t.value = (f.timeSinceFirstFrame ?? 0) / 1000;
  });
  const lv = useDerivedValue(() => withSpring(level.value, { stiffness: 140, damping: 14 }));
  const sp = useDerivedValue(() => withTiming(speaking.value, { duration: 260 }));
  const wr = useDerivedValue(() => withTiming(writing ? 1 : 0, { duration: 500, easing: Easing.inOut(Easing.cubic) }), [writing]);
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (!pulses || still) return;
    pulse.value = 0;
    pulse.value = withSequence(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.cubic) }), withTiming(0, { duration: 0 }));
  }, [pulses]);
  const body = useAnimatedProps(() => {
    const p = balls(t.value, lv.value, sp.value, wr.value, pulse.value, size);
    return { d: metaPath(p.xs, p.ys, p.rs, size, 1, 0, 0) };
  });
  // A soft sheen on the core, up and to the left.
  const light = useAnimatedProps(() => {
    const p = balls(t.value, lv.value, sp.value, wr.value, pulse.value, size);
    return { d: sheenPath(p.xs[0]!, p.ys[0]!, p.rs[0]!) };
  });
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Defs>
        <LinearGradient id="voiceBlob" x1={size * 0.22} y1={size * 0.2} x2={size * 0.8} y2={size * 0.82} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#F6C3AA" />
          <Stop offset="0.36" stopColor="#F0B3C4" />
          <Stop offset="0.68" stopColor="#C9B8F2" />
          <Stop offset="1" stopColor="#AFCDF2" />
        </LinearGradient>
      </Defs>
      <AnimatedPath animatedProps={body} fill="url(#voiceBlob)" stroke="#B9A6E6" strokeOpacity={0.35} strokeWidth={0.8} />
      <AnimatedPath animatedProps={light} fill="#FFFFFF" fillOpacity={0.38} />
    </Svg>
  );
}
