import { router } from 'expo-router';
import { Bell, ChevronLeft, CircleCheck, CircleX, Info, MoonStar, RefreshCw, Smartphone, Trash2, TriangleAlert } from 'lucide-react-native';
import { type ReactNode, useState } from 'react';
import { type NativeScrollEvent, type NativeSyntheticEvent, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInUp, FadeOut, FadeOutUp, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { asOf, useLink, useOutbox, useToasts } from '../lib/hooks';
import { store } from '../lib/store';
import { color, spring } from '../lib/theme';
import { Card, IconBadge, Press, T, type Tone } from './ui';
import { WhySheet } from './WhySheet';

/**
 * Has the content scrolled under the header? For the header's hairline: a solid header, and a
 * divider only once something passes under it (no fades).
 */
export function useScrolled(): { scrolled: boolean; onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void } {
  const [scrolled, setScrolled] = useState(false);
  return { scrolled, onScroll: (e) => setScrolled(e.nativeEvent.contentOffset.y > 2) };
}

/** A screen: the warm background and the safe area. */
export function Screen({ children, style }: { readonly children: ReactNode; readonly style?: ViewStyle }) {
  return <View style={[{ flex: 1, backgroundColor: color.bg }, style]}>{children}</View>;
}

/**
 * For a screen with no header (Home): the status bar keeps a solid strip of the background, so
 * what scrolls up never runs under the clock, and a hairline shows once it has.
 */
export function StatusShade({ scrolled }: { readonly scrolled?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top, backgroundColor: color.bg, zIndex: 2 }}>
      {scrolled ? <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(160)} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: color.hairline }} /> : null}
    </View>
  );
}

/** A screen's title, a back button when it isn't a tab, and what sits at the right ("•••"). */
export function Header({ title, subtitle, back, right, eyebrow, at, scrolled, lead }: { readonly title: string; readonly subtitle?: string; readonly back?: boolean; readonly right?: ReactNode; readonly eyebrow?: string; /** When the view shown arrived (for "as of"). */ readonly at?: number; /** Content has scrolled under it: a hairline divider shows. */ readonly scrolled?: boolean; /** Before the title (a project's mark). */ readonly lead?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8, backgroundColor: color.bg, zIndex: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 40, gap: 10 }}>
        {back ? (
          <Press onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} accessibilityLabel="Back" hitSlop={12} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card, marginLeft: -4, borderWidth: StyleSheet.hairlineWidth, borderColor: color.hairline }}>
            <ChevronLeft color={color.text} size={21} strokeWidth={2.2} />
          </Press>
        ) : null}
        {lead}
        <View style={{ flex: 1 }}>
          {eyebrow ? (
            <T v="caption" numberOfLines={1}>
              {eyebrow}
            </T>
          ) : null}
          <T v={back ? 'heading' : 'title'} numberOfLines={1} style={back ? { fontSize: 18, fontWeight: '700' } : null}>
            {title}
          </T>
        </View>
        {right}
      </View>
      {subtitle ? (
        <T v="callout" style={{ marginTop: 4 }}>
          {subtitle}
        </T>
      ) : null}
      <AwayBand at={at} />
      {scrolled ? <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(150)} pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: color.hairlineStrong }} /> : null}
    </View>
  );
}

/**
 * Your Mac asleep or out of reach: the last views stay, marked "as of 10:42", and what you do waits
 * in the outbox until it answers. Also: a Mac (or app) too old to talk to.
 */
export function AwayBand({ at }: { readonly at?: number }) {
  const link = useLink();
  const outbox = useOutbox();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState(false);
  if (link.outdated) {
    return (
      <Animated.View entering={FadeInDown.springify()} style={{ marginTop: 12 }}>
        <Card tone="butter" r={18} style={{ padding: 12, flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <TriangleAlert color={color.warn} size={18} />
          <T v="callout" c={color.warn} style={{ flex: 1, fontWeight: '500' }}>
            {link.outdated === 'mac' ? 'Update Beluga on your Mac' : 'Update the app'}
          </T>
        </Card>
      </Animated.View>
    );
  }
  const retrying = link.phase === 'dialing' && link.diagnosis?.auto === true;
  const away = link.phase === 'asleep' || retrying || (link.phase === 'closed' && outbox.length > 0) || (link.phase === 'refused' && link.diagnosis !== undefined);
  if (!away) return null;
  // Said in words when we know why (no internet, a network that won't connect, the Mac away…).
  const d = link.phase === 'closed' ? undefined : link.diagnosis;
  return (
    <Animated.View entering={FadeInDown.springify().stiffness(spring.snappy.stiffness).damping(spring.snappy.damping)} exiting={FadeOutUp} layout={LinearTransition.springify()} style={{ marginTop: 12 }}>
      <Card tone="sky" r={18} style={{ paddingVertical: 10, paddingHorizontal: 12 }}>
        <Press haptics={false} onPress={() => setOpen((o) => !o)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <MoonStar color={color.info} size={18} />
          <View style={{ flex: 1 }}>
            <T v="callout" c={color.info} style={{ fontWeight: '600' }}>
              {d?.title ?? 'Mac asleep'}
            </T>
            <T v="caption" c={color.info} style={{ opacity: 0.8 }}>
              {[d?.auto ? (retrying ? 'Connecting…' : 'Trying again by itself') : undefined, at ? asOf(at) : undefined, outbox.length ? `${outbox.length} waiting` : undefined].filter(Boolean).join(' · ') || 'Last views'}
            </T>
          </View>
          {d ? (
            <Press onPress={() => setWhy(true)} accessibilityLabel="Why?" hitSlop={8} style={{ height: 32, paddingHorizontal: 10, justifyContent: 'center' }}>
              <T v="caption" c={color.info} style={{ fontWeight: '600' }}>
                Why?
              </T>
            </Press>
          ) : null}
          {d?.action === 'pair-again' ? (
            <Press
              onPress={async () => {
                await store.signOut();
                router.replace('/pair');
              }}
              accessibilityLabel="Pair again"
              hitSlop={8}
              style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: color.card, flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <Smartphone color={color.info} size={14} />
              <T v="caption" c={color.info} style={{ fontWeight: '600' }}>
                Pair again
              </T>
            </Press>
          ) : (
          <Press onPress={() => store.retry()} accessibilityLabel="Try again" hitSlop={8} style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: color.card, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <RefreshCw color={color.info} size={14} />
            <T v="caption" c={color.info} style={{ fontWeight: '600' }}>
              Retry
            </T>
          </Press>
          )}
        </Press>
        {open && outbox.length ? (
          <Animated.View entering={FadeInUp} style={{ marginTop: 10, gap: 6 }}>
            {outbox.map((o) => (
              <View key={o.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T v="caption" c={color.info} style={{ flex: 1 }} numberOfLines={1}>
                  {o.call.label}
                </T>
                <Press onPress={() => store.discard(o.id)} accessibilityLabel="Discard" hitSlop={8}>
                  <Trash2 color={color.info} size={15} />
                </Press>
              </View>
            ))}
          </Animated.View>
        ) : null}
      </Card>
      <WhySheet diagnosis={d} visible={why} onDismiss={() => setWhy(false)} onRetry={() => store.retry()} window />
    </Animated.View>
  );
}

const TOAST_ICON = { ok: CircleCheck, error: CircleX, warn: Bell, info: Info } as const;
const TOAST_TONE: Record<string, Tone> = { ok: 'mint', error: 'rose', warn: 'butter', info: 'sky' };

/** In-app notices (a nudge while linked, a queued action, an answer sent). */
export function Toasts() {
  const toasts = useToasts();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { paddingTop: insets.top + 6, alignItems: 'center' }]}>
      {toasts.map((t) => (
        <Animated.View key={t.id} entering={FadeInUp.springify().stiffness(300).damping(28)} exiting={FadeOutUp.duration(200)} layout={LinearTransition.springify()} style={{ width: '92%', marginBottom: 8 }}>
          <Press
            onPress={() => {
              store.dismissToast(t.id);
              if (t.topic?.startsWith('conv:')) router.push(`/conv/${encodeURIComponent(t.topic.slice(5))}`);
              else if (t.topic?.startsWith('chat:')) router.push(`/chat/${encodeURIComponent(t.topic.slice(5))}`);
              else if (t.topic?.startsWith('sentinel:')) router.push(`/sentinel/${encodeURIComponent(t.topic.slice(9))}`);
            }}
          >
            <Card r={18} style={{ paddingVertical: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <IconBadge Icon={TOAST_ICON[t.tone ?? 'info']!} tone={TOAST_TONE[t.tone ?? 'info'] ?? 'sky'} size={30} />
              <T v="callout" c={color.text} numberOfLines={2} style={{ flex: 1 }}>
                {t.text}
              </T>
            </Card>
          </Press>
        </Animated.View>
      ))}
    </View>
  );
}
