import { Mic, Square } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { cancelAnimation, Easing, FadeIn, FadeOut, interpolate, interpolateColor, LinearTransition, type SharedValue, useAnimatedStyle, useDerivedValue, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { VOICE_MODELS, voiceSize } from '../../../src/shared/voice-models';
import type { Phrase, VoiceSession, VoiceView } from '../lib/voice-session';
import { alpha, color, ink, scheme, spring, tint } from '../lib/theme';
import { Metaballs } from './Metaballs';
import { haptic, Press, T } from './ui';

/**
 * Speaking on the phone, drawn (BLG-162): calm and alive, pastel, no glow.
 * - The mic button morphs into a soft rose square while it listens, a ring breathing with your voice.
 * - The stage over the controls: a liquid pastel blob (metaballs, components/Metaballs.tsx) that
 *   breathes with your voice and buds a droplet off at each pause, and beside it the words arriving phrase
 *   by phrase as they're written down (each word rising in), a shimmering pill where a phrase is
 *   still being written, a caret while it listens. A light tick each time a pause cuts a phrase.
 */

const ROSE = (): string => (scheme === 'dark' ? alpha(ink.rose, 0.28) : tint.rose);

/** The microphone: tap to talk; listening, tap to put it in the box. Busy (getting ready, writing the last of it): three hopping dots. */
export function VoiceButton({ voice, size = 44, onPress }: { readonly voice: VoiceSession; readonly size?: number; readonly onPress: () => void }) {
  const phase = voice.view.phase;
  const on = useDerivedValue(() => withSpring(phase === 'listening' ? 1 : 0, spring.bouncy), [phase]);
  const busy = phase === 'getting' || phase === 'writing';
  // Worked out here, not in the worklet: a plain JS function called on the UI thread crashes the app.
  const rose = ROSE();
  const sunken = color.sunken;
  const face = useAnimatedStyle(() => ({
    borderRadius: interpolate(on.value, [0, 1], [size / 2, size * 0.3]),
    backgroundColor: interpolateColor(on.value, [0, 1], [sunken, rose]),
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
          <Animated.View key="stop" entering={FadeIn.duration(140)} exiting={FadeOut.duration(120)}>
            <Square color={ink.rose} fill={ink.rose} size={size * 0.3} />
          </Animated.View>
        ) : (
          <Animated.View key="mic" entering={FadeIn.duration(140)} exiting={FadeOut.duration(120)}>
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

/** A word rising into place, after the ones before it (a mount animation, not a layout one: words flow inline). */
/** The type of the field the stage stands in for: the Ask sheet's big one, or a conversation's box. */
type Type = { readonly fontSize: number; readonly lineHeight: number };

function Word({ w, i, type }: { readonly w: string; readonly i: number; readonly type: Type }) {
  const v = useSharedValue(0);
  const still = useReducedMotion();
  useEffect(() => {
    v.value = still ? 1 : withDelay(Math.min(i, 30) * 26, withTiming(1, { duration: 340, easing: Easing.out(Easing.cubic) }));
  }, []);
  const st = useAnimatedStyle(() => ({ opacity: v.value, transform: [{ translateY: (1 - v.value) * 7 }, { scale: 0.96 + v.value * 0.04 }] }));
  return (
    <Animated.View style={st}>
      <T v="callout" c={color.text} style={type}>
        {w}
      </T>
    </Animated.View>
  );
}

/** The words so far: written phrases word by word, a shimmering pill where one is being written, a caret while it listens. */
function Words({ before, phrases, listening, type }: { readonly before: string; readonly phrases: readonly Phrase[]; readonly listening: boolean; readonly type: Type }) {
  // What you'd typed stays first, as it was; the spoken words arrive after it.
  const typed = before.trim() ? before.trim().split(/\s+/) : [];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: type.fontSize * 0.28, rowGap: 0 }}>
      {typed.map((w, i) => (
        <T key={`t${i}`} v="callout" c={color.text} style={type}>
          {w}
        </T>
      ))}
      {phrases.map((p) =>
        p.status === 'writing' ? (
          <Shimmer key={`w${p.id}`} />
        ) : p.status === 'failed' ? (
          <T key={`f${p.id}`} v="callout" c={color.text3}>
            …
          </T>
        ) : (
          (p.text ?? '').split(/\s+/).filter(Boolean).map((w, i) => <Word key={`${p.id}:${i}`} w={w} i={i} type={type} />)
        ),
      )}
      {listening ? <Caret height={type.lineHeight * 0.8} /> : null}
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
function Caret({ height }: { readonly height: number }) {
  const o = useSharedValue(1);
  useEffect(() => {
    o.value = withRepeat(withSequence(withTiming(0.15, { duration: 520 }), withTiming(1, { duration: 520 })), -1);
    return () => cancelAnimation(o);
  }, []);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ width: 2, height, borderRadius: 1, backgroundColor: ink.rose }, st]} />;
}

/** One quiet line: how long, and what the two buttons do. */
function Line({ view, compact }: { readonly view: Extract<VoiceView, { phase: 'listening' | 'writing' }>; readonly compact?: boolean }) {
  // The time, twice a second while it listens.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (view.phase !== 'listening') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [view.phase]);
  const secs = view.phase === 'listening' ? Math.max(0, Math.floor((now - view.since) / 1000)) : 0;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: compact ? 2 : 6 }}>
      {view.phase === 'listening' ? (
        <T v="caption" c={ink.rose} style={{ fontVariant: ['tabular-nums'] }}>
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        </T>
      ) : null}
      <T v="caption" numberOfLines={1} style={{ flex: 1 }}>
        {view.phase === 'listening' ? (compact ? '■ edit · ↑ send' : '■ edit it first · ↑ send it as you said it') : view.send ? 'Sending as soon as it’s written down…' : 'Writing down the last of it…'}
      </T>
      {view.note ? (
        <T v="caption" c={color.text3} numberOfLines={1} style={{ maxWidth: '45%' }}>
          {view.note}
        </T>
      ) : null}
    </View>
  );
}
/** It's getting ready, listening or writing down: the stage stands in for the text field. */
export const voiceActive = (v: VoiceView): boolean => v.phase === 'getting' || v.phase === 'listening' || v.phase === 'writing';

/** After it: one quiet line under the field (an error, or where it was written). */
export function VoiceNote({ voice }: { readonly voice: VoiceSession }) {
  const v = voice.view;
  if (v.phase !== 'off') return null;
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

/**
 * In place of the text field while it gets ready, listens or writes: the blob, and beside it what
 * you'd typed followed by the words arriving, in the field's own type, so the words land where
 * they'll stay. `box`: a conversation's box (a smaller blob, one quiet line); else the Ask sheet's.
 */
export function VoiceStage({ voice, before = '', box, minHeight }: { readonly voice: VoiceSession; readonly before?: string; readonly box?: boolean; readonly minHeight?: number }) {
  const v = voice.view;
  // A light tick each time a pause cuts a phrase: you feel it hearing you.
  const count = v.phase === 'listening' || v.phase === 'writing' ? v.phrases.length : 0;
  const last = useRef(0);
  useEffect(() => {
    if (count > last.current) haptic.tap();
    last.current = count;
  }, [count]);
  const type: Type = box ? { fontSize: 16.5, lineHeight: 22 } : { fontSize: 19, lineHeight: 26 };
  const blob = box ? 44 : 76;
  if (v.phase === 'getting') {
    const f = VOICE_MODELS[v.model].files.phone;
    return (
      <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(140)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight, paddingVertical: box ? 4 : 8 }}>
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
  if (v.phase !== 'listening' && v.phase !== 'writing') return null;
  const listening = v.phase === 'listening';
  return (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(160)} layout={LinearTransition.duration(180)} style={{ minHeight, justifyContent: 'center' }}>
      <View style={{ flexDirection: 'row', gap: box ? 6 : 8, alignItems: 'center', marginLeft: box ? -4 : -10 }}>
        <Metaballs level={voice.level} speaking={voice.speaking} writing={!listening} pulses={count} size={blob} />
        <View style={{ flex: 1, minHeight: blob, justifyContent: 'center', paddingVertical: box ? 4 : 0 }}>
          {v.phrases.length || before.trim() ? (
            <Words before={before} phrases={v.phrases} listening={listening} type={type} />
          ) : (
            <Animated.View entering={FadeIn.delay(200).duration(400)}>
              <T v="callout" c={color.text3} style={type}>
                {listening ? (box ? 'Listening…' : 'Listening… say it the way you’d tell a colleague.') : 'Writing it down…'}
              </T>
            </Animated.View>
          )}
          {box ? <Line view={v} compact /> : null}
        </View>
      </View>
      {box ? null : <Line view={v} />}
    </Animated.View>
  );
}
