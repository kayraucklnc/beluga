import { router } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/build/layouts/Tabs';
import { House, Layers, MessageCircle, Plus, Users } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useView, useVisibleNeeds } from '../lib/hooks';
import type { HomeView } from '../lib/link/protocol';
import { color, ink, scheme, spring, tint } from '../lib/theme';
import { haptic, Press } from './ui';

/**
 * The tab bar, drawn by the app: Home · Work · [Ask] · Chats · People. A soft card floating at
 * the bottom; a tinted capsule slides to the tab you pick; badges count what's waiting. Ask sits
 * in the middle, always there.
 */
const ICONS = { index: House, work: Layers, chats: MessageCircle, people: Users } as const;
const LABELS = { index: 'Home', work: 'Work', chats: 'Chats', people: 'People' } as const;

export function TabBar({ state, navigateToTab, insets }: BottomTabBarProps) {
  const [width, setWidth] = useState(0);
  const home = useView<HomeView>('home');
  const needs = useVisibleNeeds(home?.data.needsYou);
  const badges: Record<string, number> = { index: needs.length, work: home?.data.unread.work ?? 0, chats: home?.data.unread.chats ?? 0, people: 0 };

  // Five slots: two tabs, Ask, two tabs.
  const slot = (width - 12) / 5;
  const slotOf = (i: number): number => (i < 2 ? i : i + 1);
  const x = useSharedValue(0);
  useEffect(() => {
    if (width) x.value = withSpring(6 + slotOf(state.index) * slot, spring.snappy);
  }, [state.index, width]);
  const capsule = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  const tab = (route: (typeof state.routes)[number], i: number) => {
    const name = route.name as keyof typeof ICONS;
    const Icon = ICONS[name] ?? House;
    const on = state.index === i;
    const badge = badges[name] ?? 0;
    return (
      <Press key={route.key} scaleTo={0.9} onPress={() => !on && navigateToTab(route.key)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={LABELS[name]} style={{ width: slot, height: 58, alignItems: 'center', justifyContent: 'center', gap: 3 }}>
        <View>
          <Icon color={on ? color.text : color.text3} size={22} strokeWidth={on ? 2.3 : 2} />
          {badge > 0 ? (
            <View style={{ position: 'absolute', top: -5, right: -11, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: name === 'index' ? tint.peach : tint.sky, borderWidth: 2, borderColor: color.bar }}>
              <Text style={{ color: name === 'index' ? ink.peach : ink.sky, fontSize: 10, fontWeight: '800' }}>{badge > 9 ? '9+' : badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={{ fontSize: 11, fontWeight: on ? '700' : '500', color: on ? color.text : color.text3 }}>{LABELS[name]}</Text>
      </Press>
    );
  };

  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14, paddingBottom: Math.max(insets.bottom, 10) }}>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={[{ height: 64, borderRadius: 32, backgroundColor: color.bar, justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: color.hairline }, barShadow()]}>
        {width ? <Animated.View style={[{ position: 'absolute', top: 5, left: 0, width: slot, height: 54, borderRadius: 27, backgroundColor: color.sunken }, capsule]} /> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 }}>
          {state.routes.slice(0, 2).map((r, i) => tab(r, i))}
          <View style={{ width: slot, alignItems: 'center' }}>
            <Press
              scaleTo={0.9}
              haptics={false}
              onPress={() => {
                haptic.commit();
                router.push('/ask');
              }}
              accessibilityLabel="Ask your Mac"
              style={{ width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: tint.peach }}
            >
              <Plus color={ink.peach} size={26} strokeWidth={2.4} />
            </Press>
          </View>
          {state.routes.slice(2).map((r, i) => tab(r, i + 2))}
        </View>
      </View>
    </View>
  );
}

const barShadow = (): ViewStyle =>
  Platform.select({
    web: { boxShadow: color.shadowCssBar } as ViewStyle,
    default: { shadowColor: color.shadowInk, shadowOpacity: 0.1, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  })!;
