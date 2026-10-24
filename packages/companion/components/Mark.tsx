import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated';
import Svg, { Defs, Path, Stop, LinearGradient as SvgGradient } from 'react-native-svg';
import { BELUGA } from '../lib/beluga-path';
import { brand } from '../lib/theme';

/**
 * The beluga mark (assets/logo.svg). On the pairing screen it arrives once, as on the Mac: the tile
 * rises and the beluga leaps up into it and settles. No glow, no loops.
 */
const TILE = 'M512 62C890 62 962 134 962 512S890 962 512 962 62 890 62 512 134 62 512 62Z';

export function Mark({ size = 120, delay = 0, intro = true }: { readonly size?: number; readonly delay?: number; readonly intro?: boolean }) {
  const rise = useSharedValue(intro ? 0 : 1);
  const leap = useSharedValue(intro ? 0 : 1);

  useEffect(() => {
    if (!intro) return;
    rise.value = withDelay(delay, withTiming(1, { duration: 800, easing: Easing.bezier(0.22, 1, 0.36, 1) }));
    leap.value = withDelay(delay + 350, withSpring(1, { stiffness: 140, damping: 18 }));
  }, []);

  const outer = useAnimatedStyle(() => ({ opacity: rise.value, transform: [{ translateY: (1 - rise.value) * 10 }, { scale: 0.92 + 0.08 * rise.value }] }));
  const whale = useAnimatedStyle(() => ({
    opacity: interpolate(leap.value, [0, 0.15], [0, 1], 'clamp'),
    transform: [{ translateX: (1 - leap.value) * -0.12 * size }, { translateY: (1 - leap.value) * 0.18 * size }, { rotate: `${(1 - leap.value) * -12}deg` }],
  }));

  return (
    <Animated.View style={[{ width: size, height: size }, outer]}>
      <Svg width={size} height={size} viewBox="0 0 1024 1024" style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgGradient id="mark-bg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={brand.tileTop} />
            <Stop offset="1" stopColor={brand.tileBottom} />
          </SvgGradient>
        </Defs>
        <Path d={TILE} fill="url(#mark-bg)" />
      </Svg>
      {/* The beluga leaps up from the tile's lower edge (clipped, as if out of the water). */}
      <View style={[StyleSheet.absoluteFill, { borderRadius: size * 0.27, overflow: 'hidden', margin: size * 0.06 }]}>
        <Animated.View style={[{ position: 'absolute', left: -size * 0.06, top: -size * 0.06, width: size, height: size }, whale]}>
          <Svg width={size} height={size} viewBox="0 0 1024 1024">
            <Path d={BELUGA} fill={brand.whale} fillRule="evenodd" transform="translate(512 512) scale(0.76) translate(-512 -512)" />
          </Svg>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

/** The beluga alone (no tile), for small places. */
export function Beluga({ size = 24, color = brand.whale }: { readonly size?: number; readonly color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="40 120 960 800">
      <Path d={BELUGA} fill={color} fillRule="evenodd" />
    </Svg>
  );
}
