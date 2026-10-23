import { router } from 'expo-router';
import { Check, CircleCheck, Flag, Hand, Monitor, MessageCircleQuestion, PenLine, SquareTerminal, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { FadeIn, interpolate, LinearTransition, useAnimatedStyle, useSharedValue, withSpring, withTiming, ZoomIn } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { ago } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import type { NeedsYou } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color, spring } from '../lib/theme';
import { Button, Card, haptic, IconBadge, More, Pill, Press, T, type Tone, toneBg, toneInk } from './ui';

/**
 * What needs you, as a stack of cards: swipe right to approve, left to decline, or tap the two
 * buttons. Everything else (Always, the whole text, open it) is behind "•••" or a long press.
 * Questions and decisions answer with their choices; a kind this phone doesn't know is a plain
 * card that says "Open on your Mac" (docs/companion.md, staying in step).
 */

export const KNOWN = new Set(['approval', 'question', 'request', 'decision', 'confirm']);

export const kindOf = (kind: string): { label: string; tone: Tone; Icon: typeof Monitor } => {
  switch (kind) {
    case 'approval':
      return { label: 'Approval', tone: 'peach', Icon: SquareTerminal };
    case 'question':
      return { label: 'Question', tone: 'sky', Icon: MessageCircleQuestion };
    case 'request':
      return { label: 'Request', tone: 'lavender', Icon: Hand };
    case 'decision':
      return { label: 'Decision', tone: 'butter', Icon: Flag };
    case 'confirm':
      return { label: 'Confirm', tone: 'mint', Icon: CircleCheck };
    default:
      return { label: 'On your Mac', tone: 'plain', Icon: Monitor };
  }
};

export const mainOf = (n: NeedsYou) => n.actions.find((a) => a.tone === 'main');
export const dangerOf = (n: NeedsYou) => n.actions.find((a) => a.tone === 'danger');
/** The action a choice makes: the Mac sends one `plain` action per option (labelled as it), or none. */
const choiceAction = (n: NeedsYou, label: string) => n.actions.find((a) => a.tone === 'plain' && (a.label === label || label.startsWith(a.label.replace(/…$/, ''))));
const isChoice = (n: NeedsYou, a: NeedsYou['actions'][number]) => !!n.choices?.some((c) => choiceAction(n, c.label) === a);
/** "Always" and the like: a plain action that isn't one of the choices. */
export const plainOf = (n: NeedsYou) => n.actions.find((a) => a.tone === 'plain' && !isChoice(n, a));

/** Several options can be picked (sent together through the `answer` template). */
export const multiPick = (n: NeedsYou): boolean => !!n.multi && !!n.answer?.picks && !!n.choices?.length;

/** Pick a choice: its own button if the Mac sent one, else through the `answer` template. */
export function choose(n: NeedsYou, label: string): boolean {
  const own = choiceAction(n, label);
  const c = own ? calls.action(n, own) : n.answer?.picks ? calls.answer(n, [label]) : undefined;
  if (!c) return false;
  haptic.success();
  void store.answer(n, c, `${label} · ${n.title}`);
  return true;
}

/** Send your own answer (picks or words) through the item's `answer` template. */
export function sendOwn(n: NeedsYou, value: string | readonly string[]): boolean {
  const c = calls.answer(n, value);
  if (!c) return false;
  haptic.success();
  void store.answer(n, c, `${n.answer?.label ?? 'Sent'} · ${n.title}`);
  return true;
}

/** Swipes decide only when the card has a yes (an approval, a request); otherwise they put it back. */
const decides = (n: NeedsYou): boolean => KNOWN.has(n.kind) && !n.choices?.length && !!mainOf(n);

export function answer(n: NeedsYou, tone: 'main' | 'danger' | 'plain'): void {
  const action = tone === 'main' ? mainOf(n) : tone === 'danger' ? dangerOf(n) : plainOf(n);
  if (!action) return;
  if (tone === 'main') haptic.success();
  else haptic.commit();
  void store.answer(n, calls.action(n, action), `${action.label} · ${n.title}`);
}

const openDetail = (n: NeedsYou) => router.push(`/need/${encodeURIComponent(n.id)}`);

/** The card's face (also used whole on the need/[id] sheet). */
export function NeedFace({ item, full = false, onAnswered, more }: { readonly item: NeedsYou; readonly full?: boolean; /** After a choice was sent (the card can leave). */ readonly onAnswered?: () => void; readonly more?: boolean }) {
  const k = kindOf(item.kind);
  // Known kinds, and anything the Mac gave buttons or an answer template for, can be answered here.
  const known = KNOWN.has(item.kind) || item.actions.length > 0 || !!item.answer;
  const multi = multiPick(item);
  const [picked, setPicked] = useState<string[]>([]);
  const tap = (label: string) => {
    if (multi) {
      haptic.tap();
      setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
      return;
    }
    if (choose(item, label)) onAnswered?.();
    else openDetail(item);
  };
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <IconBadge Icon={k.Icon} tone={k.tone} size={34} />
        <View style={{ flex: 1 }}>
          <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
            {k.label}
          </T>
          <T v="caption" numberOfLines={1}>
            {[item.from, ago(item.askedAt)].filter(Boolean).join(' · ')}
          </T>
        </View>
        {more ? <More onPress={() => openDetail(item)} label="More options" /> : null}
      </View>
      <T v="heading" numberOfLines={full ? undefined : 3} style={{ fontSize: 18, lineHeight: 24 }}>
        {item.title}
      </T>
      {item.detail ? (
        <T v="callout" numberOfLines={full ? undefined : 2}>
          {full ? item.detail : item.detail.replace(/\s*\n+\s*/g, ' · ')}
        </T>
      ) : null}
      {!known ? <Pill label="Open on your Mac" Icon={Monitor} style={{ alignSelf: 'flex-start' }} /> : null}
      {known && item.choices?.length ? (
        <View style={{ gap: 8, marginTop: 2 }}>
          {multi ? <T v="caption">Pick any</T> : null}
          {item.choices.slice(0, full ? 12 : 3).map((c) => {
            const on = picked.includes(c.label);
            return (
              <Press key={c.label} onPress={() => tap(c.label)} accessibilityLabel={c.label} accessibilityState={multi ? { checked: on } : undefined} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 14, backgroundColor: toneBg(k.tone) }}>
                {multi ? (
                  <View style={{ width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? toneInk(k.tone) : 'transparent', borderWidth: on ? 0 : 1.5, borderColor: toneInk(k.tone) }}>
                    {on ? <Check color={color.card} size={14} strokeWidth={3} /> : null}
                  </View>
                ) : null}
                <View style={{ flex: 1 }}>
                  <T v="callout" c={toneInk(k.tone)} style={{ fontWeight: '600' }}>
                    {c.label}
                  </T>
                  {c.description && full ? (
                    <T v="caption" c={toneInk(k.tone)} style={{ marginTop: 2, opacity: 0.8 }}>
                      {c.description}
                    </T>
                  ) : null}
                </View>
              </Press>
            );
          })}
          {!full && item.choices.length > 3 ? (
            <Press onPress={() => openDetail(item)} style={{ alignSelf: 'flex-start', paddingVertical: 4 }}>
              <T v="caption" c={color.info} style={{ fontWeight: '600' }}>
                {item.choices.length - 3} more
              </T>
            </Press>
          ) : null}
          {multi ? <Button label={`${item.answer?.label ?? 'Send'}${picked.length ? ` · ${picked.length}` : ''}`} Icon={Check} disabled={!picked.length} onPress={() => sendOwn(item, picked) && onAnswered?.()} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** Approve and Decline: the only buttons on the surface. */
export function NeedButtons({ item, onAnswer }: { readonly item: NeedsYou; readonly onAnswer: (tone: 'main' | 'danger') => void }) {
  const known = KNOWN.has(item.kind) || item.actions.length > 0;
  // With choices on the card, only the way out (Skip) stays as a button.
  const main = item.choices?.length ? undefined : mainOf(item);
  const danger = dangerOf(item);
  // Words only (no options, no yes): Reply opens the item's sheet to write them.
  const reply = !main && !item.choices?.length && item.answer?.text;
  if (!known || (!main && !danger && !reply)) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      {danger ? <Button quiet flex={1} Icon={X} label={danger.label} onPress={() => onAnswer('danger')} /> : null}
      {main ? <Button flex={1} Icon={Check} label={main.label} onPress={() => onAnswer('main')} /> : null}
      {reply ? <Button flex={1} Icon={PenLine} label="Reply" onPress={() => openDetail(item)} /> : null}
    </View>
  );
}

function SwipeCard({ item, depth, height, onGone }: { readonly item: NeedsYou; readonly depth: number; readonly height: number; readonly onGone: (item: NeedsYou, dir: 1 | -1, answered: boolean) => void }) {
  const { width } = useWindowDimensions();
  const W = Math.min(width, 520);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const armed = useSharedValue(0);
  const d = useSharedValue(depth);
  useEffect(() => {
    d.value = withSpring(depth, spring.soft);
    // Put back for later: it comes in again from behind the deck.
    if (depth > 0) {
      tx.value = withSpring(0, spring.soft);
      ty.value = 0;
    }
  }, [depth]);
  const top = depth === 0;

  const gone = (dir: 1 | -1) => onGone(item, dir, false);
  const tick = () => haptic.tap();
  const fling = (dir: 1 | -1) => {
    tx.value = withTiming(dir * W * 1.3, { duration: 240 });
    setTimeout(() => onGone(item, dir, true), 180);
  };

  const pan = usePanGesture({
    enabled: top,
    activeOffsetX: [-12, 12],
    failOffsetY: [-16, 16],
    onUpdate: (e) => {
      'worklet';
      tx.value = e.translationX;
      ty.value = e.translationY * 0.1;
      const over = Math.abs(e.translationX) > W * 0.3 ? 1 : 0;
      if (over !== armed.value) {
        armed.value = over;
        scheduleOnRN(tick);
      }
    },
    onDeactivate: (e) => {
      'worklet';
      const dir = tx.value > 0 ? 1 : -1;
      if (Math.abs(tx.value) > W * 0.3 || Math.abs(e.velocityX) > 900) {
        tx.value = withSpring(dir * W * 1.4, { velocity: e.velocityX, stiffness: 200, damping: 28, overshootClamping: true });
        scheduleOnRN(gone, dir as 1 | -1);
      } else {
        tx.value = withSpring(0, spring.snappy);
        ty.value = withSpring(0, spring.snappy);
      }
      armed.value = 0;
    },
  });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: d.value * 10 + ty.value }, { translateX: tx.value }, { rotate: `${interpolate(tx.value, [-W, 0, W], [-6, 0, 6])}deg` }, { scale: 1 - d.value * 0.04 }],
    opacity: interpolate(d.value, [0, 2, 3], [1, 0.85, 0]),
  }));
  const yes = useAnimatedStyle(() => ({ opacity: interpolate(tx.value, [0, W * 0.25], [0, 1], 'clamp') }));
  const no = useAnimatedStyle(() => ({ opacity: interpolate(tx.value, [-W * 0.25, 0], [1, 0], 'clamp') }));
  const decide = decides(item);
  const main = mainOf(item);
  const danger = dangerOf(item);

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: 0, height, zIndex: 10 - depth }, style]} pointerEvents={top ? 'auto' : 'none'}>
        <Pressable style={{ flex: 1 }} onPress={() => openDetail(item)} onLongPress={() => (haptic.commit(), openDetail(item))} delayLongPress={400}>
          <Card style={{ flex: 1, padding: 18, gap: 14, overflow: 'hidden' }}>
            <NeedFace
              item={item}
              more
              onAnswered={() => fling(1)}
            />
            <View style={{ flex: 1 }} />
            <NeedButtons item={item} onAnswer={(t) => (answer(item, t), fling(t === 'main' ? 1 : -1))} />
          </Card>
          <Animated.View pointerEvents="none" style={[styles.stamp, { left: 18 }, yes]}>
            <Pill label={decide ? (main?.label ?? 'Yes') : 'Later'} tone={decide ? 'mint' : 'plain'} Icon={decide ? Check : undefined} />
          </Animated.View>
          <Animated.View pointerEvents="none" style={[styles.stamp, { right: 18 }, no]}>
            <Pill label={decide ? (danger?.label ?? 'No') : 'Later'} tone={decide ? 'rose' : 'plain'} Icon={decide ? X : undefined} />
          </Animated.View>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

/** The stack. `height` fits the cards; the deck shows three. */
export function NeedsStack({ items }: { readonly items: readonly NeedsYou[] }) {
  const [order, setOrder] = useState<string[]>([]);
  // New items join at the back of the deck; answered ones leave it.
  const deck = useMemo(() => {
    const ids = items.map((n) => n.id);
    const kept = order.filter((id) => ids.includes(id));
    for (const id of ids) if (!kept.includes(id)) kept.push(id);
    return kept.map((id) => items.find((n) => n.id === id)!).filter(Boolean);
  }, [items, order]);

  const onGone = (item: NeedsYou, dir: 1 | -1, answered: boolean) => {
    // Answered by a button or a choice: the store hides it already.
    if (answered) return;
    if (decides(item)) {
      answer(item, dir === 1 ? 'main' : 'danger');
      return;
    }
    // Nothing to decide by swiping: it goes to the back for later.
    haptic.tap();
    setOrder([...deck.map((n) => n.id).filter((id) => id !== item.id), item.id]);
  };

  // Tall enough for the top card: approvals are short; questions carry their choices.
  const top = deck[0];
  const height = top?.choices?.length && KNOWN.has(top.kind) ? 214 + Math.min(3, top.choices.length) * 50 + (top && multiPick(top) ? 86 : 0) + (top.choices.length > 3 ? 24 : 0) : 236;

  if (!deck.length) {
    return (
      <Animated.View entering={ZoomIn.springify()} style={{ marginHorizontal: 16 }}>
        <Card style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <IconBadge Icon={CircleCheck} tone="mint" />
          <View style={{ flex: 1 }}>
            <T v="heading">All clear</T>
            <T v="callout">Nothing needs you.</T>
          </View>
        </Card>
      </Animated.View>
    );
  }
  return (
    <Animated.View entering={FadeIn} layout={LinearTransition.springify()} style={{ height: height + 22, marginHorizontal: 16 }}>
      {deck
        .slice(0, 3)
        .map((n, i) => <SwipeCard key={n.id} item={n} depth={i} height={height} onGone={onGone} />)
        .reverse()}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  stamp: { position: 'absolute', top: -10 },
});
