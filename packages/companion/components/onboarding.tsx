import { LinearGradient } from 'expo-linear-gradient';
import { Check, Hourglass, Smartphone, SquareTerminal, X } from 'lucide-react-native';
import { useEffect } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, { Easing, FadeInDown, interpolate, type SharedValue, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { alpha, brand, color, ink, scheme, tint, type } from '../lib/theme';
import { Mark } from './Mark';
import { Card, IconBadge, T, toneBg, toneInk } from './ui';

/**
 * The pairing screens' pieces, staged like the Mac's onboarding (packages/mac/src/onboarding)
 * in the phone's pastel language: a soft wash of color, the mark arriving and floating on water,
 * small illustrations made of the app's own cards, and a once-only burst when you're paired.
 */

/** A soft pastel wash from the top of the screen into the background. */
export function Wash({ tones = ['sky', 'lavender'] as const, height = 420 }: { readonly tones?: readonly ['sky' | 'lavender' | 'mint' | 'peach', 'sky' | 'lavender' | 'mint' | 'peach']; readonly height?: number }) {
  const a = tint[tones[0]];
  const b = tint[tones[1]];
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { height }]}>
      <LinearGradient colors={[a, b, color.bg]} locations={[0, 0.5, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0.4 }} style={StyleSheet.absoluteFill} />
      {/* Fades into the page below, so the wash has no edge. */}
      <LinearGradient colors={[alpha(color.bg, 0), color.bg]} start={{ x: 0, y: 0.45 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
    </View>
  );
}

/** The mark on still water: rings open out once as it arrives, then it floats, very gently. */
export function FloatingMark({ size = 112, delay = 0 }: { readonly size?: number; readonly delay?: number }) {
  const bob = useSharedValue(0);
  useEffect(() => {
    bob.value = withDelay(delay + 1400, withRepeat(withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }), -1, true));
  }, []);
  const float = useAnimatedStyle(() => ({ transform: [{ translateY: interpolate(bob.value, [0, 1], [0, -6]) }] }));
  const box = size * 2.4;
  return (
    <View style={{ width: box, height: box, alignItems: 'center', justifyContent: 'center' }}>
      {[0, 1, 2].map((i) => (
        <Ring key={i} i={i} size={size * (1.25 + i * 0.42)} delay={delay + 500 + i * 160} />
      ))}
      <Animated.View style={float}>
        <Mark size={size} delay={delay} />
      </Animated.View>
    </View>
  );
}

function Ring({ i, size, delay }: { i: number; size: number; delay: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withDelay(delay, withTiming(1, { duration: 1400, easing: Easing.bezier(0.22, 1, 0.36, 1) }));
  }, []);
  const s = useAnimatedStyle(() => ({ opacity: p.value * (0.9 - i * 0.25), transform: [{ scale: 0.7 + 0.3 * p.value }] }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: color.hairlineStrong }, s]} />;
}

/** One intro page's illustration, built from the app's own pieces. */
export function Illustration({ page }: { readonly page: 0 | 1 | 2 }) {
  if (page === 0) return <FloatingMark size={104} />;
  if (page === 1) {
    return (
      <View style={{ width: 290, gap: 10 }}>
        <Card style={{ padding: 14, gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <IconBadge Icon={SquareTerminal} tone="peach" size={30} />
            <View style={{ flex: 1 }}>
              <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
                Approval
              </T>
              <T v="caption">Your Claude · now</T>
            </View>
          </View>
          <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
            Deploy to staging?
          </T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Chip label="Decline" Icon={X} tone="plain" />
            <Chip label="Approve" Icon={Check} tone="mint" flex />
          </View>
        </Card>
        <SwipeHint />
      </View>
    );
  }
  return (
    <View style={{ width: 290, gap: 10 }}>
      <Bubble mine text="Run the tests and send me a screenshot" />
      <Card style={{ padding: 12, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: tint.peach }}>
            <Text style={{ color: ink.peach, fontSize: 12, fontWeight: '800' }}>✳</Text>
          </View>
          <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
            Claude
          </T>
          <View style={{ flex: 1 }} />
          <Hourglass color={ink.peach} size={14} />
        </View>
        <T v="callout">All 40 tests pass. Here it is:</T>
        <View style={{ height: 70, borderRadius: 12, backgroundColor: tint.sky, padding: 10, gap: 6 }}>
          <View style={{ width: '60%', height: 8, borderRadius: 4, backgroundColor: ink.sky, opacity: 0.35 }} />
          <View style={{ width: '85%', height: 8, borderRadius: 4, backgroundColor: ink.sky, opacity: 0.25 }} />
          <View style={{ width: '40%', height: 8, borderRadius: 4, backgroundColor: ink.sky, opacity: 0.25 }} />
        </View>
      </Card>
    </View>
  );
}

function Chip({ label, Icon, tone, flex }: { label: string; Icon: typeof X; tone: 'plain' | 'mint'; flex?: boolean }) {
  return (
    <View style={{ flex: flex ? 1.3 : 1, height: 36, borderRadius: 18, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: toneBg(tone) }}>
      <Icon color={toneInk(tone)} size={15} strokeWidth={1.9} />
      <T v="caption" c={toneInk(tone)} style={{ fontWeight: '700' }}>
        {label}
      </T>
    </View>
  );
}

/** A finger's swipe drawn as an arrow that slides right, once, then rests. */
function SwipeHint() {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withDelay(700, withSequence(withTiming(1, { duration: 900, easing: Easing.bezier(0.22, 1, 0.36, 1) }), withDelay(300, withTiming(0.5, { duration: 500 }))));
  }, []);
  const s = useAnimatedStyle(() => ({ transform: [{ translateX: interpolate(p.value, [0, 1], [-30, 30]) }], opacity: interpolate(p.value, [0, 0.2, 1], [0, 1, 1]) }));
  return (
    <Animated.View style={[{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6 }, s]}>
      <T v="caption" c={ink.mint} style={{ fontWeight: '700' }}>
        swipe to approve
      </T>
      <Text style={{ color: ink.mint, fontSize: 16 }}>→</Text>
    </Animated.View>
  );
}

function Bubble({ text, mine }: { text: string; mine?: boolean }) {
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: 240, paddingVertical: 9, paddingHorizontal: 13, borderRadius: 18, borderBottomRightRadius: mine ? 6 : 18, backgroundColor: mine ? tint.sky : color.card }}>
      <T v="callout" c={mine ? ink.sky : color.text}>
        {text}
      </T>
    </View>
  );
}

/** The pager's dots: the current one stretches into a pill as you swipe. */
export function Dots({ progress, count }: { readonly progress: SharedValue<number>; readonly count: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
      {Array.from({ length: count }, (_, i) => (
        <Dot key={i} i={i} progress={progress} />
      ))}
    </View>
  );
}
function Dot({ i, progress }: { i: number; progress: SharedValue<number> }) {
  const s = useAnimatedStyle(() => {
    const d = Math.min(1, Math.abs(progress.value - i));
    return { width: interpolate(d, [0, 1], [22, 7]), opacity: interpolate(d, [0, 1], [1, 0.35]) };
  });
  return <Animated.View style={[{ height: 7, borderRadius: 4, backgroundColor: color.text }, s]} />;
}

/** "On your Mac": a small drawing of Beluga's Settings › Phone with the pairing code showing. */
export function MacPairing({ style }: { readonly style?: ViewStyle }) {
  // A QR-like code: three finder squares and a scatter of modules (a drawing, not a real code).
  const N = 21;
  const finder = (r: number, c: number): boolean | undefined => {
    for (const [fr, fc] of [[0, 0], [0, N - 7], [N - 7, 0]] as const) {
      if (r >= fr && r < fr + 7 && c >= fc && c < fc + 7) {
        const y = r - fr;
        const x = c - fc;
        return y === 0 || y === 6 || x === 0 || x === 6 || (y >= 2 && y <= 4 && x >= 2 && x <= 4);
      }
      if (r >= fr - 1 && r <= fr + 7 && c >= fc - 1 && c <= fc + 7) return false;
    }
    return undefined;
  };
  const cells = Array.from({ length: N * N }, (_, i) => {
    const r = Math.floor(i / N);
    const c = i % N;
    return finder(r, c) ?? ((r * 31 + c * 17 + r * c) % 7 < 3);
  });
  const dark = scheme === 'dark';
  return (
    <Card style={[{ width: 300, overflow: 'hidden' }, style]}>
      <View style={{ height: 28, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, backgroundColor: color.sunken }}>
        {[tint.rose, tint.butter, tint.mint].map((c, i) => (
          <View key={i} style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: c }} />
        ))}
        <T v="caption" style={{ marginLeft: 8, fontSize: 11 }}>
          Settings › Phone
        </T>
      </View>
      <View style={{ flexDirection: 'row', padding: 12, gap: 12 }}>
        <View style={{ width: 70, gap: 7, paddingTop: 2 }}>
          {[0.8, 0.6, 1, 0.7].map((w, i) => (
            <View key={i} style={{ height: 7, borderRadius: 4, width: `${w * 100}%`, backgroundColor: i === 2 ? tint.sky : color.sunken }} />
          ))}
        </View>
        <View style={{ flex: 1, alignItems: 'center', gap: 8 }}>
          <View style={{ padding: 6, borderRadius: 10, backgroundColor: dark ? color.white : color.card, borderWidth: StyleSheet.hairlineWidth, borderColor: color.hairline }}>
            <View style={{ width: N * 4, height: N * 4, flexDirection: 'row', flexWrap: 'wrap' }}>
              {cells.map((on, i) => (
                <View key={i} style={{ width: 4, height: 4, backgroundColor: on ? brand.tileBottom : 'transparent' }} />
              ))}
            </View>
          </View>
          <Text style={{ ...type.mono, fontSize: 11, letterSpacing: 1, color: color.text2 }}>K7QM-4XPA-R2TD</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 24, borderRadius: 12, backgroundColor: tint.sky }}>
            <Smartphone color={ink.sky} size={12} />
            <T v="caption" c={ink.sky} style={{ fontSize: 11, fontWeight: '700' }}>
              Pair a Phone
            </T>
          </View>
        </View>
      </View>
    </Card>
  );
}

/** A numbered step ("1  Open Beluga on your Mac"). */
export function Step({ n, text, delay }: { readonly n: number; readonly text: string; readonly delay: number }) {
  return (
    <Animated.View entering={FadeInDown.delay(delay).duration(420)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: tint.lavender }}>
        <Text style={{ color: ink.lavender, fontWeight: '800', fontSize: 13 }}>{n}</Text>
      </View>
      <T v="body" style={{ flex: 1 }}>
        {text}
      </T>
    </Animated.View>
  );
}

/** You're paired: the check springs in, rings open out and pastel dots fly, once. */
export function Burst() {
  const pop = useSharedValue(0);
  useEffect(() => {
    pop.value = withSpring(1, { stiffness: 220, damping: 14 });
  }, []);
  const check = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  const dots = Array.from({ length: 14 }, (_, i) => i);
  const tones = [tint.mint, tint.sky, tint.peach, tint.lavender, tint.butter, tint.rose];
  return (
    <View style={{ width: 240, height: 240, alignItems: 'center', justifyContent: 'center' }}>
      {[0, 1].map((i) => (
        <BurstRing key={i} i={i} />
      ))}
      {dots.map((i) => (
        <Flyer key={i} angle={(i / dots.length) * Math.PI * 2} color={tones[i % tones.length]!} distance={90 + (i % 3) * 14} />
      ))}
      <Animated.View style={[{ width: 92, height: 92, borderRadius: 46, alignItems: 'center', justifyContent: 'center', backgroundColor: tint.mint }, check]}>
        <Check color={ink.mint} size={46} strokeWidth={2} />
      </Animated.View>
    </View>
  );
}
function BurstRing({ i }: { i: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withDelay(80 + i * 160, withTiming(1, { duration: 900, easing: Easing.out(Easing.quad) }));
  }, []);
  const s = useAnimatedStyle(() => ({ opacity: 1 - p.value, transform: [{ scale: 0.6 + p.value * 1.6 }] }));
  return <Animated.View style={[{ position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: ink.mint }, s]} />;
}
function Flyer({ angle, color: c, distance }: { angle: number; color: string; distance: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withDelay(60, withTiming(1, { duration: 1000, easing: Easing.bezier(0.22, 1, 0.36, 1) }));
  }, []);
  const s = useAnimatedStyle(() => ({
    opacity: interpolate(p.value, [0, 0.15, 0.8, 1], [0, 1, 1, 0]),
    transform: [{ translateX: Math.cos(angle) * distance * p.value }, { translateY: Math.sin(angle) * distance * p.value }, { scale: 1 - p.value * 0.4 }],
  }));
  return <Animated.View style={[{ position: 'absolute', width: 12, height: 12, borderRadius: 6, backgroundColor: c }, s]} />;
}

/** Phone and Mac with dots travelling between them: finding your Mac. */
export function Finding() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <IconBadge Icon={Smartphone} tone="sky" size={64} square />
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {[0, 1, 2, 3].map((i) => (
          <Travel key={i} i={i} />
        ))}
      </View>
      <View style={{ width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card }}>
        <Mark size={44} intro={false} />
      </View>
    </View>
  );
}
function Travel({ i }: { i: number }) {
  const p = useSharedValue(0.25);
  useEffect(() => {
    p.value = withDelay(i * 160, withRepeat(withSequence(withTiming(1, { duration: 420 }), withTiming(0.25, { duration: 420 })), -1, false));
  }, []);
  const s = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ scale: 0.7 + p.value * 0.3 }] }));
  return <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: ink.sky }, s]} />;
}

