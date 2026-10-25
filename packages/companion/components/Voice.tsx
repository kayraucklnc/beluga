import { Mic, Square } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  interpolate,
  interpolateColor,
  LinearTransition,
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  ZoomIn,
  ZoomOut,
} from 'react-native-reanimated';
import { VOICE_MODELS, voiceSize } from '../../../src/shared/voice-models';
import type { Phrase, VoiceSession, VoiceView } from '../lib/voice-session';
import { alpha, color, ink, scheme, spring, tint } from '../lib/theme';
import { haptic, Press, T } from './ui';

/**
 * Speaking on the phone, drawn (BLG-162): calm and alive, pastel, no glow.
 * - The mic button morphs into a soft rose square while it listens, a ring breathing with your voice.
 * - The stage over the controls: three pastel blobs that drift and swell with your voice (still
 *   when you're quiet, a little restless when you speak), and beside them the words arriving phrase
 *   by phrase as they're written down (each word rising in), a shimmering pill where a phrase is
 *   still being written, a caret while it listens. A light tick each time a pause cuts a phrase.
 */

const ROSE = (): string => (scheme === 'dark' ? alpha(ink.rose, 0.28) : tint.rose);

/** The microphone: tap to talk; listening, tap to put it in the box. Busy (getting ready, writing the last of it): three hopping dots. */
export function VoiceButton({ voice, size = 44, onPress }: { readonly voice: VoiceSession; readonly size?: number; readonly onPress: () => void }) {
  const phase = voice.view.phase;
  const on = useDerivedValue(() => withSpring(phase === 'listening' ? 1 : 0, spring.bouncy), [phase]);
  const busy = phase === 'getting' || phase === 'writing';
  const face = useAnimatedStyle(() => ({
    borderRadius: interpolate(on.value, [0, 1], [size / 2, size * 0.3]),
    backgroundColor: interpolateColor(on.value, [0, 1], [color.sunken, ROSE()]),
    transform: [{ scale: 1 + on.value * 0.04 }],
  }));
  const breath = useDerivedValue(() => withSpring(voice.level.value, { stiffness: 260, damping: 18 }));
  const ring = useAnimatedStyle(() => ({ opacity: on.value * 0.75, transform: [{ scale: 1 + breath.value * 0.55 * on.value }] }));
  return (
    <Press
      onPress={onPress}
      disabled={phase === 'writing'}
      accessibilityLabel={phase === 'listening' ? 'Put it in the box' : 'Speak instead of typing'}
      accessibilityHint={phase === 'listening' ? 'Then edit it; the send button sends it as you said it' : 'Written down on this phone or your Mac (Settings › Voice)'}
      hitSlop={4}
      style={{ width: size, height: size }}
    >
      <Animated.View style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: ROSE() }, ring]} />
      <Animated.View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, face]}>
        {busy ? (
          <Dots />
        ) : phase === 'listening' ? (
          <Animated.View key="stop" entering={ZoomIn.springify().damping(14)} exiting={ZoomOut.duration(120)}>
            <Square color={ink.rose} fill={ink.rose} size={size * 0.3} />
          </Animated.View>
        ) : (
          <Animated.View key="mic" entering={ZoomIn.springify().damping(14)} exiting={ZoomOut.duration(120)}>
            <Mic color={color.text2} size={size * 0.45} />
          </Animated.View>
        )}
      </Animated.View>
    </Press>
  );
}

/** Three dots taking turns. */
function Dots({ c = ink.lavender }: { readonly c?: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 3, alignItems: 'center' }}>
      {[0, 1, 2].map((i) => (
        <Hop key={i} delay={i * 130} c={c} />
      ))}
    </View>
  );
}
function Hop({ delay, c }: { readonly delay: number; readonly c: string }) {
  const y = useSharedValue(0);
  const still = useReducedMotion();
  useEffect(() => {
    if (still) return;
    const t = setTimeout(() => (y.value = withRepeat(withSequence(withTiming(-3, { duration: 260, easing: Easing.out(Easing.quad) }), withTiming(0, { duration: 260, easing: Easing.in(Easing.quad) }), withTiming(0, { duration: 380 })), -1)), delay);
    return () => (clearTimeout(t), cancelAnimation(y));
  }, []);
  const st = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }], opacity: 0.55 + (-y.value / 3) * 0.45 }));
  return <Animated.View style={[{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: c }, st]} />;
}

/** Three pastel blobs that drift around each other and swell with your voice. */
function Orb({ voice, size = 60, writing }: { readonly voice: VoiceSession; readonly size?: number; readonly writing: boolean }) {
  const t = useSharedValue(0);
  const still = useReducedMotion();
  useEffect(() => {
    if (still) return;
    t.value = withRepeat(withTiming(Math.PI * 2, { duration: 7000, easing: Easing.linear }), -1);
    return () => cancelAnimation(t);
  }, [still]);
  const level = useDerivedValue(() => withSpring(writing ? 0.15 : voice.level.value, { stiffness: 220, damping: 16 }));
  const speak = useDerivedValue(() => withTiming(voice.speaking.value, { duration: 220 }));
  const blobs = [
    { c: 'peach' as const, k: 0, w: 1 },
    { c: 'lavender' as const, k: (Math.PI * 2) / 3, w: 0.8 },
    { c: 'sky' as const, k: (Math.PI * 4) / 3, w: 0.65 },
  ];
  return (
    <View style={{ width: size, height: size }}>
      {blobs.map((b, i) => (
        <Blob key={b.c} t={t} level={level} speak={speak} size={size} phase={b.k} weight={b.w} color={scheme === 'dark' ? alpha(ink[b.c], 0.38) : tint[b.c]} index={i} />
      ))}
    </View>
  );
}
function Blob({ t, level, speak, size, phase, weight, color: c, index }: { readonly t: SharedValue<number>; readonly level: SharedValue<number>; readonly speak: SharedValue<number>; readonly size: number; readonly phase: number; readonly weight: number; readonly color: string; readonly index: number }) {
  const d = size * 0.62;
  const st = useAnimatedStyle(() => {
    // Quiet: a slow drift. Speaking: they spread a little and swell with the voice.
    const a = t.value * (index === 1 ? -1 : 1) + phase;
    const orbit = size * (0.08 + 0.1 * speak.value + 0.06 * level.value);
    const scale = 0.82 + level.value * 0.42 * weight + Math.sin(t.value * 2 + phase) * 0.03;
    return { transform: [{ translateX: Math.cos(a) * orbit }, { translateY: Math.sin(a) * orbit }, { scale }] };
  });
  return <Animated.View style={[{ position: 'absolute', left: (size - d) / 2, top: (size - d) / 2, width: d, height: d, borderRadius: d / 2, backgroundColor: c, opacity: 0.92 }, st]} />;
}

/** A word rising into place, after the ones before it (a mount animation, not a layout one: words flow inline). */
function Word({ w, i }: { readonly w: string; readonly i: number }) {
  const v = useSharedValue(0);
  const still = useReducedMotion();
  useEffect(() => {
    v.value = still ? 1 : withDelay(Math.min(i, 30) * 26, withTiming(1, { duration: 340, easing: Easing.out(Easing.cubic) }));
  }, []);
  const st = useAnimatedStyle(() => ({ opacity: v.value, transform: [{ translateY: (1 - v.value) * 7 }, { scale: 0.96 + v.value * 0.04 }] }));
  return (
    <Animated.View style={st}>
      <T v="callout" c={color.text} style={{ fontSize: 15.5, lineHeight: 21 }}>
        {w}
      </T>
    </Animated.View>
  );
}

/** The words so far: written phrases word by word, a shimmering pill where one is being written, a caret while it listens. */
function Words({ phrases, listening }: { readonly phrases: readonly Phrase[]; readonly listening: boolean }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 4.5, rowGap: 2 }}>
      {phrases.map((p) =>
        p.status === 'writing' ? (
          <Shimmer key={`w${p.id}`} />
        ) : p.status === 'failed' ? (
          <T key={`f${p.id}`} v="callout" c={color.text3}>
            …
          </T>
        ) : (
          (p.text ?? '').split(/\s+/).filter(Boolean).map((w, i) => <Word key={`${p.id}:${i}`} w={w} i={i} />)
        ),
      )}
      {listening ? <Caret /> : null}
    </View>
  );
}
function Shimmer() {
  const o = useSharedValue(0.35);
  useEffect(() => {
    o.value = withRepeat(withSequence(withTiming(0.85, { duration: 520 }), withTiming(0.35, { duration: 520 })), -1);
    return () => cancelAnimation(o);
  }, []);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ width: 54, height: 13, borderRadius: 7, backgroundColor: scheme === 'dark' ? alpha(ink.lavender, 0.4) : tint.lavender }, st]} />;
}
function Caret() {
  const o = useSharedValue(1);
  useEffect(() => {
    o.value = withRepeat(withSequence(withTiming(0.15, { duration: 520 }), withTiming(1, { duration: 520 })), -1);
    return () => cancelAnimation(o);
  }, []);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ width: 2, height: 17, borderRadius: 1, backgroundColor: ink.rose }, st]} />;
}

/** One quiet line: how long, and what the two buttons do. */
function Line({ view }: { readonly view: Extract<VoiceView, { phase: 'listening' | 'writing' }> }) {
  // The time, twice a second while it listens.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (view.phase !== 'listening') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [view.phase]);
  const secs = view.phase === 'listening' ? Math.max(0, Math.floor((now - view.since) / 1000)) : 0;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
      {view.phase === 'listening' ? (
        <T v="caption" c={ink.rose} style={{ fontVariant: ['tabular-nums'] }}>
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        </T>
      ) : null}
      <T v="caption" numberOfLines={1} style={{ flex: 1 }}>
        {view.phase === 'listening' ? '■ edit it first · ↑ send it as you said it' : view.send ? 'Sending as soon as it’s written down…' : 'Writing down the last of it…'}
      </T>
      {view.note ? (
        <T v="caption" c={color.text3} numberOfLines={1} style={{ maxWidth: '45%' }}>
          {view.note}
        </T>
      ) : null}
    </View>
  );
}
/** Over the controls while it gets ready, listens or writes; a quiet line after (an error, or where it was written). */
export function VoiceStage({ voice }: { readonly voice: VoiceSession }) {
  const v = voice.view;
  // A light tick each time a pause cuts a phrase: you feel it hearing you.
  const count = v.phase === 'listening' || v.phase === 'writing' ? v.phrases.length : 0;
  const last = useRef(0);
  useEffect(() => {
    if (count > last.current) haptic.tap();
    last.current = count;
  }, [count]);
  if (v.phase === 'off') {
    const line = v.error ?? v.note;
    if (!line) return null;
    return (
      <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 6 }}>
        <Mic color={v.error ? ink.rose : color.text3} size={12} />
        <T v="caption" numberOfLines={2} style={{ flex: 1 }}>
          {line}
        </T>
      </Animated.View>
    );
  }
  if (v.phase === 'getting') {
    const f = VOICE_MODELS[v.model].files.phone;
    return (
      <Animated.View entering={FadeInDown.springify().damping(18)} exiting={FadeOutDown.duration(160)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10 }}>
        <Dots />
        <View style={{ flex: 1, gap: 6 }}>
          <T v="caption">{`Getting ${VOICE_MODELS[v.model].label}${f ? ` · ${voiceSize(f.bytes)}, once` : ''}`}</T>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: color.sunken, overflow: 'hidden' }}>
            <Animated.View layout={LinearTransition} style={{ width: `${Math.round(v.progress * 100)}%`, height: 4, borderRadius: 2, backgroundColor: ink.lavender }} />
          </View>
        </View>
      </Animated.View>
    );
  }
  const listening = v.phase === 'listening';
  return (
    <Animated.View entering={FadeInDown.springify().damping(17)} exiting={FadeOutDown.duration(180)} layout={LinearTransition.springify().damping(20)} style={{ paddingTop: 10 }}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
        <Orb voice={voice} writing={!listening} />
        <View style={{ flex: 1, minHeight: 60, justifyContent: 'center' }}>
          {v.phrases.length ? (
            <Words phrases={v.phrases} listening={listening} />
          ) : (
            <Animated.View entering={FadeIn.delay(250).duration(400)}>
              <T v="callout" c={color.text3}>
                {listening ? 'Listening… pauses are fine: each one is written down while you go on.' : 'Writing it down…'}
              </T>
            </Animated.View>
          )}
        </View>
      </View>
      <Line view={v} />
    </Animated.View>
  );
}
